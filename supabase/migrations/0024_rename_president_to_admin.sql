-- 0024_rename_president_to_admin.sql
--
-- Completes the rename: the enum LABEL itself becomes 'admin', not just what
-- the app prints. After this there is no "president" left anywhere -- database,
-- API or screen.
--
-- HOW THIS IS SAFE
--
-- ALTER TYPE ... RENAME VALUE renames the label in place. The enum's OID and
-- sort order do not change, so every stored row, index and constraint stays
-- valid and no data is rewritten. Unlike ADD VALUE, RENAME VALUE carries no
-- same-transaction restriction, because it creates nothing later statements
-- must see.
--
-- WHAT IT DOES NOT DO, AND WHY THE REST OF THIS FILE EXISTS
--
-- The rename does not touch string literals inside function bodies. Those are
-- plpgsql source text, compared against the enum at RUN time -- so the moment
-- the label is gone, every `current_role_of() in ('cashier','accountant',
-- 'president')` starts raising "invalid input value for enum role_enum". The
-- functions must be redefined in the same transaction as the rename, or the
-- app breaks between the two migrations.
--
-- Every function below is its previous definition with the literal swapped and
-- nothing else touched. They were generated from the installed sources rather
-- than retyped: hand-copying 17 functions is how a check quietly goes missing.
-- A diff with string literals normalised away confirms zero logic changes.

alter type role_enum rename value 'president' to 'admin';

-- ---------------------------------------------------------------------------
-- The policy that names the role.
-- ---------------------------------------------------------------------------
drop policy if exists invites_read on group_invites;
create policy invites_read on group_invites for select to authenticated
  using (group_id = current_group_id()
         and in_current_group()
         and current_role_of() in ('cashier', 'accountant', 'admin'));

-- ---------------------------------------------------------------------------
-- Every function whose body compares against the old label.
-- ---------------------------------------------------------------------------
create or replace function open_period(p_month date)
returns contribution_periods
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_cfg   groups;
  v_start date := date_trunc('month', p_month)::date;
  v_row   contribution_periods;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only an officer may open a period'
      using errcode = 'insufficient_privilege';
  end if;

  -- Serialise against concurrent config changes. Every other money RPC does
  -- this; open_period was missing it since 0012.
  select * into v_cfg from groups where id = v_group for no key update;

  insert into contribution_periods (group_id, period_month, due_date, grace_date, amount_paise)
  values (v_group, v_start, v_start + (v_cfg.due_day - 1),
          v_start + (v_cfg.grace_day - 1), v_cfg.monthly_contribution_paise)
  on conflict (group_id, period_month) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from contribution_periods
    where group_id = v_group and period_month = v_start;
  end if;
  return v_row;
end $$;

create or replace function propose_expense(
  p_category expense_category_enum,
  p_description text,
  p_amount_paise bigint,
  p_incurred_on date default current_date,
  p_method payment_method_enum default 'bank'
) returns expenses
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group    uuid := current_group_id();
  v_actor    uuid := fn_assert_active_member();
  v_cfg      groups;
  v_fund     bigint;
  v_eligible int;
  v_needs    boolean;
  v_cap      bigint;
  v_ytd      bigint;
  v_row      expenses;
begin
  select * into v_cfg from groups where id = v_group for no key update;

  if p_amount_paise <= 0 then
    raise exception 'Amount must be positive' using errcode = 'check_violation';
  end if;
  if p_incurred_on > current_date then
    raise exception 'An expense cannot be dated in the future'
      using errcode = 'check_violation';
  end if;

  v_fund  := fn_fund_total_paise(v_group);
  v_needs := p_category not in ('bank_charge', 'admin');
  v_eligible := active_member_count(v_group);

  if not v_needs and current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only an officer may record admin or bank-charge expenses'
      using errcode = 'insufficient_privilege';
  end if;

  -- The auto-approved path never reaches cast_expense_vote(), so the cap has
  -- to be applied here instead. Expenses that DO go to a vote are checked at
  -- approval time, when the fund total is current, rather than now.
  if not v_needs then
    v_cap := v_fund * v_cfg.expense_annual_pct_bp / 10000;
    v_ytd := fn_expenses_ytd_paise(extract(year from p_incurred_on)::int, v_group);
    if v_ytd + p_amount_paise > v_cap then
      raise exception
        'Group expenses for % would reach Rs.% but the yearly limit is Rs.%',
        extract(year from p_incurred_on)::int,
        ((v_ytd + p_amount_paise)::numeric / 100)::text,
        (v_cap::numeric / 100)::text
        using errcode = 'check_violation';
    end if;
  end if;

  insert into expenses (
    group_id, category, description, amount_paise, incurred_on, method,
    requires_vote, fund_total_at_request_paise, required_approvals,
    eligible_voter_count, created_by, status, decided_at
  )
  values (
    v_group, p_category, p_description, p_amount_paise, p_incurred_on, p_method,
    v_needs, v_fund,
    case when v_needs then required_expense_approvals(v_group) else 0 end,
    v_eligible, v_actor,
    case when v_needs then 'proposed'::expense_status_enum
         else 'approved'::expense_status_enum end,
    case when v_needs then null else now() end
  )
  returning * into v_row;

  return v_row;
end $$;

create or replace function add_member(
  p_full_name text,
  p_email text default null,
  p_phone text default null,
  p_nominee_name text default null,
  p_nominee_phone text default null
) returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_row   members;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only an office holder may add members'
      using errcode = 'insufficient_privilege';
  end if;
  if length(btrim(coalesce(p_full_name, ''))) = 0 then
    raise exception 'Name is required' using errcode = 'check_violation';
  end if;

  insert into members (group_id, full_name, email, phone, nominee_name,
                       nominee_phone, joined_on, status)
  values (v_group, btrim(p_full_name), lower(nullif(btrim(p_email), '')), p_phone,
          p_nominee_name, p_nominee_phone, current_date, 'active')
  returning * into v_row;

  return v_row;
end $$;

create or replace function update_member(
  p_member_id uuid,
  p_full_name text default null,
  p_email text default null,
  p_phone text default null,
  p_nominee_name text default null,
  p_nominee_phone text default null
) returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := fn_assert_active_member();
  v_row   members;
begin
  if p_member_id <> v_actor
     and current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'You may only edit your own details'
      using errcode = 'insufficient_privilege';
  end if;

  update members set
    full_name     = coalesce(nullif(btrim(p_full_name), ''), full_name),
    email         = coalesce(lower(nullif(btrim(p_email), '')), email),
    phone         = coalesce(nullif(btrim(p_phone), ''), phone),
    nominee_name  = coalesce(nullif(btrim(p_nominee_name), ''), nominee_name),
    nominee_phone = coalesce(nullif(btrim(p_nominee_phone), ''), nominee_phone)
  where id = p_member_id and group_id = current_group_id()
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Member not found in this group' using errcode = 'no_data_found';
  end if;
  return v_row;
end $$;

create or replace function assign_role(p_member_id uuid, p_role role_enum)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_other role_enum;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may change who does what'
      using errcode = 'insufficient_privilege';
  end if;
  if p_role = 'member' then
    raise exception 'To clear a job, choose Nobody instead'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from members
                 where id = p_member_id and group_id = v_group
                   and left_on is null and status = 'active') then
    raise exception 'That person is not an active member of this group'
      using errcode = 'check_violation';
  end if;

  -- The one rule that cannot bend: the person who takes the money in must not
  -- also be the person who keeps the record of it.
  v_other := case when p_role = 'cashier' then 'accountant'
                  when p_role = 'accountant' then 'cashier' end;
  if v_other is not null and exists (
    select 1 from role_assignments
    where member_id = p_member_id and group_id = v_group
      and role = v_other and end_date is null
  ) then
    raise exception
      'The cashier and the accountant must be two different people — move the other job first'
      using errcode = 'check_violation';
  end if;

  update role_assignments set end_date = current_date
  where group_id = v_group and role = p_role
    and end_date is null and start_date < current_date;

  delete from role_assignments
  where group_id = v_group and role = p_role
    and end_date is null and start_date >= current_date;

  insert into role_assignments (group_id, member_id, role, start_date)
  values (v_group, p_member_id, p_role, current_date);
end $$;

create or replace function release_role(p_role role_enum) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may change who does what'
      using errcode = 'insufficient_privilege';
  end if;
  -- A group must never be left headless: the admin hands over, never simply
  -- resigns.
  if p_role = 'admin' then
    raise exception 'Make someone else the admin instead of leaving the job empty'
      using errcode = 'check_violation';
  end if;

  update role_assignments set end_date = current_date
  where group_id = v_group and role = p_role
    and end_date is null and start_date < current_date;

  delete from role_assignments
  where group_id = v_group and role = p_role
    and end_date is null and start_date >= current_date;
end $$;

create or replace function remove_member(
  p_member_id uuid,
  p_left_on date default current_date
) returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_owed  bigint;
  v_row   members;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may remove a member'
      using errcode = 'insufficient_privilege';
  end if;

  if role_of(p_member_id) = 'admin' then
    raise exception 'Make someone else the admin before removing this person'
      using errcode = 'check_violation';
  end if;

  v_owed := member_outstanding_paise(p_member_id);
  if v_owed > 0 then
    raise exception 'This member still owes Rs.% — the loan must be settled first',
      (v_owed::numeric / 100)::text using errcode = 'check_violation';
  end if;

  if exists (select 1 from loans
             where guarantor_id = p_member_id and group_id = v_group
               and status in ('approved', 'disbursed')) then
    raise exception 'This member vouched for a running loan — someone else must take that on first'
      using errcode = 'check_violation';
  end if;

  update role_assignments set end_date = p_left_on
  where member_id = p_member_id and group_id = v_group and end_date is null;

  update members set left_on = p_left_on, status = 'left'
  where id = p_member_id and group_id = v_group and left_on is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Member not found or already left' using errcode = 'no_data_found';
  end if;

  return v_row;
end $$;

create or replace function update_config(
  p_group_name text default null,
  p_monthly_contribution_paise bigint default null,
  p_due_day int default null,
  p_grace_day int default null,
  p_late_fee_paise bigint default null,
  p_loan_rate_bp int default null,
  p_overdue_rate_bp int default null,
  p_max_loan_months int default null,
  p_max_loan_pct_bp int default null,
  p_reserve_pct_bp int default null,
  p_loan_required_approvals int default null,
  p_expense_required_approvals int default null,
  p_expense_annual_pct_bp int default null,
  p_cash_float_limit_paise bigint default null,
  p_cash_report_hours int default null,
  p_setup_complete boolean default null
) returns groups
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row groups;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may change the group rules'
      using errcode = 'insufficient_privilege';
  end if;

  if p_monthly_contribution_paise is not null and p_monthly_contribution_paise <= 0 then
    raise exception 'The monthly amount must be more than zero'
      using errcode = 'check_violation';
  end if;
  if p_due_day is not null and p_due_day not between 1 and 28 then
    raise exception 'The pay-by day must be between 1 and 28'
      using errcode = 'check_violation';
  end if;
  if p_grace_day is not null and p_grace_day not between 1 and 28 then
    raise exception 'The late-after day must be between 1 and 28'
      using errcode = 'check_violation';
  end if;
  if p_late_fee_paise is not null and p_late_fee_paise < 0 then
    raise exception 'The late fee cannot be less than zero'
      using errcode = 'check_violation';
  end if;
  if p_loan_rate_bp is not null and p_loan_rate_bp < 0 then
    raise exception 'The interest rate cannot be less than zero'
      using errcode = 'check_violation';
  end if;
  if p_overdue_rate_bp is not null and p_overdue_rate_bp < 0 then
    raise exception 'The late interest rate cannot be less than zero'
      using errcode = 'check_violation';
  end if;
  if p_max_loan_months is not null and p_max_loan_months < 1 then
    raise exception 'A loan must run for at least one month'
      using errcode = 'check_violation';
  end if;
  if p_cash_report_hours is not null and p_cash_report_hours < 1 then
    raise exception 'The group must be told within at least one hour'
      using errcode = 'check_violation';
  end if;
  if p_cash_float_limit_paise is not null and p_cash_float_limit_paise < 0 then
    raise exception 'The cash limit cannot be less than zero'
      using errcode = 'check_violation';
  end if;
  if p_loan_required_approvals is not null and p_loan_required_approvals < 0 then
    raise exception 'The number of yes votes cannot be less than zero'
      using errcode = 'check_violation';
  end if;
  if p_expense_required_approvals is not null and p_expense_required_approvals < 0 then
    raise exception 'The number of yes votes cannot be less than zero'
      using errcode = 'check_violation';
  end if;

  update groups set
    name = coalesce(nullif(btrim(p_group_name), ''), name),
    monthly_contribution_paise =
      coalesce(p_monthly_contribution_paise, monthly_contribution_paise),
    due_day                   = coalesce(p_due_day, due_day),
    grace_day                 = coalesce(p_grace_day, grace_day),
    late_fee_paise            = coalesce(p_late_fee_paise, late_fee_paise),
    loan_rate_bp              = coalesce(p_loan_rate_bp, loan_rate_bp),
    overdue_rate_bp           = coalesce(p_overdue_rate_bp, overdue_rate_bp),
    max_loan_months           = coalesce(p_max_loan_months, max_loan_months),
    max_loan_pct_bp           = coalesce(p_max_loan_pct_bp, max_loan_pct_bp),
    reserve_pct_bp            = coalesce(p_reserve_pct_bp, reserve_pct_bp),
    loan_required_approvals   =
      coalesce(p_loan_required_approvals, loan_required_approvals),
    expense_required_approvals =
      coalesce(p_expense_required_approvals, expense_required_approvals),
    expense_annual_pct_bp     = coalesce(p_expense_annual_pct_bp, expense_annual_pct_bp),
    cash_float_limit_paise    = coalesce(p_cash_float_limit_paise, cash_float_limit_paise),
    cash_report_hours         = coalesce(p_cash_report_hours, cash_report_hours),
    setup_complete            = coalesce(p_setup_complete, setup_complete)
  where id = current_group_id()
  returning * into v_row;

  return v_row;
end $$;

create or replace function create_group(
  p_group_name text,
  p_full_name text,
  p_phone text default null
) returns groups
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := (select auth.uid());
  v_email text;
  v_group groups;
  v_member uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to create a group'
      using errcode = 'insufficient_privilege';
  end if;
  if length(btrim(coalesce(p_group_name, ''))) = 0 then
    raise exception 'The group needs a name' using errcode = 'check_violation';
  end if;

  select email into v_email from auth.users where id = v_uid;

  insert into groups (name, created_by) values (btrim(p_group_name), v_uid)
  returning * into v_group;

  insert into members (group_id, auth_user_id, full_name, phone, email, joined_on, status)
  values (v_group.id, v_uid, btrim(p_full_name), p_phone, lower(v_email),
          current_date, 'active')
  returning id into v_member;

  -- President only. One person cannot hold cashier and accountant at once --
  -- the constraint trigger refuses it, and DEFERRABLE does not change that.
  -- President carries everything setup needs anyway.
  insert into role_assignments (group_id, member_id, role, start_date)
  values (v_group.id, v_member, 'admin', current_date);

  insert into profiles (id, last_group_id) values (v_uid, v_group.id)
  on conflict (id) do update set last_group_id = excluded.last_group_id;

  return v_group;
end $$;

create or replace function create_invite(
  p_max_uses int default null,
  p_days_valid int default 7
) returns group_invites
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := fn_assert_active_member();
  v_group uuid := current_group_id();
  v_row   group_invites;
begin
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only an office holder may invite people'
      using errcode = 'insufficient_privilege';
  end if;

  -- One live code at a time: issuing a new one retires the old, so a code
  -- that has been forwarded around stops working.
  update group_invites set revoked_at = now()
  where group_id = v_group and revoked_at is null;

  insert into group_invites (code, group_id, created_by, expires_at, max_uses)
  values (fn_new_invite_code(), v_group, v_actor,
          now() + make_interval(days => greatest(1, p_days_valid)), p_max_uses)
  returning * into v_row;

  return v_row;
end $$;

create or replace function revoke_invite(p_code text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only an office holder may revoke an invite'
      using errcode = 'insufficient_privilege';
  end if;

  update group_invites set revoked_at = now()
  where group_id = current_group_id()
    and fn_normalize_code(code) = fn_normalize_code(p_code)
    and revoked_at is null;
end $$;

create or replace function approve_pending_member(p_member_id uuid)
returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row members;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only an office holder may approve a new member'
      using errcode = 'insufficient_privilege';
  end if;

  update members set status = 'active'
  where id = p_member_id
    and group_id = current_group_id()
    and status = 'pending'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'No pending member with that id in this group'
      using errcode = 'no_data_found';
  end if;
  return v_row;
end $$;

create or replace function reject_pending_member(p_member_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only an office holder may reject a request'
      using errcode = 'insufficient_privilege';
  end if;

  delete from members
  where id = p_member_id and group_id = current_group_id() and status = 'pending';
end $$;

create or replace function pending_members()
returns table (id uuid, full_name text, email text, joined_on date)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.id, m.full_name, m.email, m.joined_on
  from members m
  where m.group_id = current_group_id()
    and m.status = 'pending'
    and in_current_group()
    and current_role_of() in ('cashier', 'accountant', 'admin')
  order by m.joined_on
$$;

create or replace function cancel_loan_request(p_loan_id uuid)
returns loans
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_loan  loans;
  v_self  boolean;
begin
  select * into v_loan from loans
  where id = p_loan_id and group_id = v_group for update;

  if v_loan.id is null then
    raise exception 'Loan not found' using errcode = 'no_data_found';
  end if;
  if v_loan.status <> 'requested' then
    raise exception 'Only a pending request can be cancelled (this one is %)', v_loan.status
      using errcode = 'check_violation';
  end if;

  v_self := v_actor = v_loan.borrower_id;

  if not v_self
     and current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the borrower or an officer may cancel a loan request'
      using errcode = 'insufficient_privilege';
  end if;

  update loans
  set status = 'rejected',
      decided_at = now(),
      withdrawn_by_requester = v_self
  where id = p_loan_id returning * into v_loan;

  return v_loan;
end $$;

create or replace function write_off_loan(
  p_loan_id uuid,
  p_reason text default null
) returns loans
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_loan  loans;
  v_lost  bigint;
  v_name  text;
begin
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only an officer may write off a loan'
      using errcode = 'insufficient_privilege';
  end if;

  -- Lock order is groups -> loans, the same as every other money RPC. The
  -- expense insert below reads the fund, so it must not race a config change.
  perform 1 from groups where id = v_group for no key update;

  select * into v_loan from loans
  where id = p_loan_id and group_id = v_group for update;

  if v_loan.id is null then
    raise exception 'Loan not found' using errcode = 'no_data_found';
  end if;
  if v_loan.status <> 'disbursed' then
    raise exception 'Only a disbursed loan can be written off (this one is %)', v_loan.status
      using errcode = 'check_violation';
  end if;

  -- Only the principal still outstanding is lost. Anything already repaid was
  -- collected and is legitimately part of the fund.
  v_lost := loan_outstanding_principal_paise(p_loan_id);
  select full_name into v_name from members where id = v_loan.borrower_id;

  update loans
  set status = 'written_off',
      closed_on = current_date,
      purpose = case when p_reason is not null
                     then coalesce(purpose || ' | ', '') || 'Written off: ' || p_reason
                     else purpose end
  where id = p_loan_id returning * into v_loan;

  if v_lost > 0 then
    insert into expenses (
      group_id, category, description, amount_paise, incurred_on, method,
      requires_vote, fund_total_at_request_paise, required_approvals,
      eligible_voter_count, created_by, status, decided_at, paid_on,
      is_loan_write_off
    )
    values (
      v_group, 'other',
      'Loan written off: ' || coalesce(v_name, 'unknown member')
        || coalesce(' — ' || p_reason, ''),
      v_lost, current_date, 'bank',
      false, fn_fund_total_paise(v_group), 0,
      active_member_count(v_group), v_actor, 'paid', now(), current_date,
      true
    );
  end if;

  return v_loan;
end $$;

create or replace function cancel_expense(p_expense_id uuid)
returns expenses
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_exp   expenses;
  v_self  boolean;
begin
  select * into v_exp from expenses
  where id = p_expense_id and group_id = v_group for update;

  if v_exp.id is null then
    raise exception 'Expense not found' using errcode = 'no_data_found';
  end if;
  if v_exp.status <> 'proposed' then
    raise exception 'Only a proposed expense can be cancelled (this one is %)', v_exp.status
      using errcode = 'check_violation';
  end if;

  v_self := v_actor = v_exp.created_by;

  if not v_self
     and current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the proposer or an officer may cancel an expense'
      using errcode = 'insufficient_privilege';
  end if;

  update expenses
  set status = 'rejected',
      decided_at = now(),
      withdrawn_by_requester = v_self
  where id = p_expense_id returning * into v_exp;

  return v_exp;
end $$;
