-- 0010_onboarding.sql
-- Group setup from inside the app: claim the empty group, add members by
-- email, and link each person to their member row when they first sign in.
--
-- THE SECURITY PROPERTY THIS FILE MUST GUARANTEE:
-- `claim_group()` may succeed exactly once, ever. It is the one moment when
-- someone with no membership can write to `members`. If a second caller could
-- ever succeed -- through a race, or after a member is later removed -- a
-- stranger who found the URL could insert themselves into a group that already
-- holds real money.
--
-- Two mechanisms, deliberately belt-and-braces:
--   1. `app_config.claimed_at` is set by the claim and is never cleared. Every
--      later call returns early on it, so the door stays shut even if the
--      group is emptied.
--   2. The claim takes `app_config FOR UPDATE` before it checks, so two
--      simultaneous first-callers are serialized and the second one sees the
--      first one's `claimed_at`.
-- A check on `count(*) from members` alone would satisfy neither.

alter table app_config
  add column if not exists claimed_at timestamptz,
  add column if not exists setup_complete boolean not null default false;

-- ---------------------------------------------------------------------------
-- Email on the member row is what a new sign-in is matched against. It is
-- stored lowercase so matching cannot fail on capitalisation.
-- ---------------------------------------------------------------------------
alter table members
  add column if not exists email text;

create unique index if not exists members_email_key
  on members (lower(email)) where email is not null;

-- ---------------------------------------------------------------------------
-- is_group_claimed(): safe for a signed-in user with no member row to call,
-- so the app can decide between the setup screen and "not a member yet".
-- ---------------------------------------------------------------------------
create or replace function is_group_claimed() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select claimed_at is not null from app_config where id), false)
$$;

-- The gate screen needs the group's name and setup state before the viewer is
-- a member, so it cannot read app_config (whose policy requires membership).
-- This returns only those three harmless fields -- never the money rules.
create or replace function group_status()
returns table (group_name text, claimed boolean, setup_complete boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.group_name, c.claimed_at is not null, c.setup_complete
  from app_config c where c.id
$$;

-- ---------------------------------------------------------------------------
-- claim_group(): the first signed-in person becomes the first member and is
-- given all three offices so they can finish setup alone. Roles are reassigned
-- properly in add_member()/assign_role() afterwards.
-- ---------------------------------------------------------------------------
create or replace function claim_group(
  p_group_name text,
  p_full_name text,
  p_phone text default null
) returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := (select auth.uid());
  v_email text;
  v_cfg   app_config;
  v_row   members;
begin
  if v_uid is null then
    raise exception 'You must be signed in to set up the group'
      using errcode = 'insufficient_privilege';
  end if;

  -- Lock first, check second: this is what makes two simultaneous claims safe.
  select * into v_cfg from app_config where id for update;

  if v_cfg.claimed_at is not null then
    raise exception 'This group has already been set up'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from members) then
    raise exception 'This group already has members'
      using errcode = 'insufficient_privilege';
  end if;

  select email into v_email from auth.users where id = v_uid;

  insert into members (auth_user_id, full_name, phone, email, joined_on)
  values (v_uid, p_full_name, p_phone, lower(v_email), current_date)
  returning * into v_row;

  -- The founder becomes PRESIDENT only -- deliberately not cashier and
  -- accountant as well.
  --
  -- One person cannot hold both of those: fn_check_cashier_ne_accountant()
  -- rejects it, and DEFERRABLE does not change that. Deferring only moves the
  -- check to commit time; it never permits the end state. (An earlier version
  -- of this function tried to grant all three and failed at signup with
  -- "Cashier and Accountant must be different people".)
  --
  -- President is also the right answer on its own terms: it carries everything
  -- setup needs -- add members, assign roles, edit the rules -- while the
  -- money operations still require cashier or accountant, which is exactly the
  -- separation the group's agreement is built on.
  insert into role_assignments (member_id, role, start_date)
  values (v_row.id, 'president', current_date);

  update app_config
  set group_name = coalesce(nullif(btrim(p_group_name), ''), group_name),
      claimed_at = now()
  where id;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- add_member(): officers add the rest of the group by name and email.
-- No auth account is created here -- the person is linked when they first
-- sign in, by link_signed_in_member() below.
-- ---------------------------------------------------------------------------
create or replace function add_member(
  p_full_name text,
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
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may add members'
      using errcode = 'insufficient_privilege';
  end if;
  if length(btrim(coalesce(p_full_name, ''))) = 0 then
    raise exception 'Name is required' using errcode = 'check_violation';
  end if;

  insert into members (full_name, email, phone, nominee_name, nominee_phone, joined_on)
  values (btrim(p_full_name), lower(nullif(btrim(p_email), '')), p_phone,
          p_nominee_name, p_nominee_phone, current_date)
  returning * into v_row;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- update_member(): edit details, including the email a person will sign in
-- with. Editing your own contact details needs no office.
-- ---------------------------------------------------------------------------
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
     and current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'You may only edit your own details'
      using errcode = 'insufficient_privilege';
  end if;

  update members set
    full_name     = coalesce(nullif(btrim(p_full_name), ''), full_name),
    email         = coalesce(lower(nullif(btrim(p_email), '')), email),
    phone         = coalesce(nullif(btrim(p_phone), ''), phone),
    nominee_name  = coalesce(nullif(btrim(p_nominee_name), ''), nominee_name),
    nominee_phone = coalesce(nullif(btrim(p_nominee_phone), ''), nominee_phone)
  where id = p_member_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Member not found' using errcode = 'no_data_found';
  end if;
  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- assign_role(): hand an office to someone, ending the current holder's term.
-- This is the yearly rotation, done in the app instead of in SQL.
-- ---------------------------------------------------------------------------
create or replace function assign_role(
  p_member_id uuid,
  p_role role_enum
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := fn_assert_active_member();
  v_other role_enum;
begin
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may change roles'
      using errcode = 'insufficient_privilege';
  end if;
  if p_role = 'member' then
    raise exception 'Use release_role() to remove an office'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from members where id = p_member_id and left_on is null) then
    raise exception 'That member is not active' using errcode = 'check_violation';
  end if;

  -- The cashier and the accountant must be different people. Reject the swap
  -- here with a message a member can act on, rather than letting the deferred
  -- constraint fire an opaque error at commit.
  v_other := case when p_role = 'cashier' then 'accountant'
                  when p_role = 'accountant' then 'cashier' end;
  if v_other is not null and exists (
    select 1 from role_assignments
    where member_id = p_member_id and role = v_other and end_date is null
  ) then
    raise exception
      'The cashier and the accountant must be different people -- move the other office first'
      using errcode = 'check_violation';
  end if;

  -- End the current holder's term, then start the new one.
  update role_assignments
  set end_date = current_date
  where role = p_role and end_date is null and start_date < current_date;

  delete from role_assignments
  where role = p_role and end_date is null and start_date >= current_date;

  insert into role_assignments (member_id, role, start_date)
  values (p_member_id, p_role, current_date);
end $$;

create or replace function release_role(p_role role_enum)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may change roles'
      using errcode = 'insufficient_privilege';
  end if;

  update role_assignments
  set end_date = current_date
  where role = p_role and end_date is null and start_date < current_date;

  delete from role_assignments
  where role = p_role and end_date is null and start_date >= current_date;
end $$;

-- ---------------------------------------------------------------------------
-- link_signed_in_member(): called by the app right after sign-in.
--
-- Matches the signed-in email against an unlinked member row and links them.
-- This is what replaces "run an UPDATE in the SQL editor" -- and it is safe
-- because the email it matches on comes from auth.users, which the user cannot
-- forge, not from anything the client sends.
-- ---------------------------------------------------------------------------
create or replace function link_signed_in_member() returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := (select auth.uid());
  v_email text;
  v_row   members;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;

  -- Already linked: nothing to do.
  select * into v_row from members where auth_user_id = v_uid;
  if v_row.id is not null then
    return v_row;
  end if;

  select lower(email) into v_email from auth.users where id = v_uid;
  if v_email is null then
    return null;
  end if;

  -- Only an *unclaimed* row may be taken, so a second person signing in with
  -- the same address cannot hijack a member who is already linked.
  update members
  set auth_user_id = v_uid
  where lower(email) = v_email
    and auth_user_id is null
    and left_on is null
  returning * into v_row;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- remove_member(): a member leaves. Never a DELETE -- their contributions and
-- loan history must survive. Blocked while they still owe money.
-- ---------------------------------------------------------------------------
create or replace function remove_member(
  p_member_id uuid,
  p_left_on date default current_date
) returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := fn_assert_active_member();
  v_owed  bigint;
  v_row   members;
begin
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may remove a member'
      using errcode = 'insufficient_privilege';
  end if;

  v_owed := member_outstanding_paise(p_member_id);
  if v_owed > 0 then
    raise exception 'This member still owes Rs.% -- settle the loan first',
      (v_owed::numeric / 100)::text
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from loans
    where guarantor_id = p_member_id and status in ('approved', 'disbursed')
  ) then
    raise exception 'This member is guarantor on a running loan -- replace them first'
      using errcode = 'check_violation';
  end if;

  update role_assignments
  set end_date = p_left_on
  where member_id = p_member_id and end_date is null;

  update members set left_on = p_left_on
  where id = p_member_id and left_on is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Member not found or already left' using errcode = 'no_data_found';
  end if;
  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- update_config(): the group's rules, editable in the app.
-- Null means "leave unchanged", so the UI can send only what it edited.
-- ---------------------------------------------------------------------------
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
) returns app_config
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := fn_assert_active_member();
  v_row   app_config;
begin
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may change the group rules'
      using errcode = 'insufficient_privilege';
  end if;

  update app_config set
    group_name = coalesce(nullif(btrim(p_group_name), ''), group_name),
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
  where id
  returning * into v_row;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- Grants. is_group_claimed and link_signed_in_member must be callable by a
-- signed-in user who is NOT yet a member -- that is their whole purpose.
-- ---------------------------------------------------------------------------
revoke execute on function is_group_claimed() from public, anon;
revoke execute on function group_status() from public, anon;
revoke execute on function claim_group(text, text, text) from public, anon;
revoke execute on function add_member(text, text, text, text, text) from public, anon;
revoke execute on function update_member(uuid, text, text, text, text, text) from public, anon;
revoke execute on function assign_role(uuid, role_enum) from public, anon;
revoke execute on function release_role(role_enum) from public, anon;
revoke execute on function link_signed_in_member() from public, anon;
revoke execute on function remove_member(uuid, date) from public, anon;
revoke execute on function update_config(text, bigint, int, int, bigint, int, int,
  int, int, int, int, int, int, bigint, int, boolean) from public, anon;

grant execute on function is_group_claimed() to authenticated;
grant execute on function group_status() to authenticated;
grant execute on function claim_group(text, text, text) to authenticated;
grant execute on function add_member(text, text, text, text, text) to authenticated;
grant execute on function update_member(uuid, text, text, text, text, text) to authenticated;
grant execute on function assign_role(uuid, role_enum) to authenticated;
grant execute on function release_role(role_enum) to authenticated;
grant execute on function link_signed_in_member() to authenticated;
grant execute on function remove_member(uuid, date) to authenticated;
grant execute on function update_config(text, bigint, int, int, bigint, int, int,
  int, int, int, int, int, int, bigint, int, boolean) to authenticated;

-- Pick up audit triggers for anything added here.
select fn_attach_audit_triggers();
