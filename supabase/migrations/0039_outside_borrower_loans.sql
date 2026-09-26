-- 0039_outside_borrower_loans.sql
-- Support lending to outside (non-member) borrowers guaranteed by an active group member.

-- 1. Alter loans table to support outside borrowers
alter table loans
  add column if not exists is_outside_borrower boolean not null default false,
  add column if not exists outside_borrower_name text,
  add column if not exists outside_borrower_phone text,
  add column if not exists outside_borrower_address text;

alter table loans alter column borrower_id drop not null;
alter table loans alter column borrower_role_at_request drop not null;

alter table loans drop constraint if exists borrower_is_not_guarantor;
alter table loans add constraint borrower_is_not_guarantor
  check (borrower_id is null or borrower_id <> guarantor_id);

alter table loans drop constraint if exists check_borrower_identity;
alter table loans add constraint check_borrower_identity check (
  (not is_outside_borrower and borrower_id is not null and borrower_role_at_request is not null)
  or
  (is_outside_borrower and borrower_id is null and outside_borrower_name is not null and length(btrim(outside_borrower_name)) > 0)
);

create index if not exists loans_outside_borrower_idx on loans (group_id, is_outside_borrower)
  where is_outside_borrower = true;

-- 2. Update fn_live_eligible_voters to handle null borrower_id
create or replace function fn_live_eligible_voters(p_loan_id uuid)
returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int
  from members m
  join loans l on l.id = p_loan_id
  where m.group_id = l.group_id
    and m.left_on is null
    and m.status = 'active'
    and (l.borrower_id is null or m.id <> l.borrower_id)
    and m.id <> l.guarantor_id
$$;

-- 3. request_outside_loan
create or replace function request_outside_loan(
  p_borrower_name text,
  p_principal_paise bigint,
  p_term_months int,
  p_borrower_phone text default null,
  p_borrower_address text default null,
  p_rate_bp int default null,
  p_guarantor_id uuid default null,
  p_purpose text default null,
  p_repayment_plan text default 'monthly'
) returns loans
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group     uuid := current_group_id();
  v_actor     uuid := fn_assert_active_member();
  v_guarantor uuid;
  v_cfg       groups;
  v_fund      bigint;
  v_cap       bigint;
  v_lendable  bigint;
  v_out       bigint;
  v_eligible  int;
  v_needed    int;
  v_rate      int;
  v_row       loans;
begin
  select * into v_cfg from groups where id = v_group for no key update;

  v_guarantor := coalesce(p_guarantor_id, v_actor);

  if not exists (select 1 from members
                 where id = v_guarantor and group_id = v_group
                   and left_on is null and status = 'active') then
    raise exception 'Guarantor must be an active member of this group'
      using errcode = 'check_violation';
  end if;

  if p_borrower_name is null or length(btrim(p_borrower_name)) = 0 then
    raise exception 'Borrower name is required' using errcode = 'check_violation';
  end if;

  if p_principal_paise <= 0 then
    raise exception 'Loan amount must be positive' using errcode = 'check_violation';
  end if;

  if p_term_months < 1 or p_term_months > v_cfg.max_loan_months then
    raise exception 'Repayment term must be between 1 and % months', v_cfg.max_loan_months
      using errcode = 'check_violation';
  end if;

  v_rate := coalesce(p_rate_bp, v_cfg.loan_rate_bp);
  if v_rate < 0 then
    raise exception 'Interest rate cannot be negative' using errcode = 'check_violation';
  end if;

  v_fund     := fn_fund_total_paise(v_group);
  v_cap      := v_fund * v_cfg.max_loan_pct_bp / 10000;
  v_lendable := v_fund * (10000 - v_cfg.reserve_pct_bp) / 10000;
  v_out      := total_outstanding_paise(v_group);
  v_needed   := required_loan_approvals(v_group);

  if p_principal_paise > v_cap then
    raise exception
      'This loan of Rs.% exceeds the maximum single loan limit of Rs.%',
      fmt_rupees(p_principal_paise),
      fmt_rupees(v_cap)
      using errcode = 'check_violation';
  end if;

  if v_out + p_principal_paise > v_lendable then
    raise exception
      'Only Rs.% is available to lend (the reserve must stay in the bank)',
      fmt_rupees(greatest(0, v_lendable - v_out))
      using errcode = 'check_violation';
  end if;

  -- Active members other than the guarantor.
  select count(*)::int into v_eligible
  from members
  where group_id = v_group and left_on is null and status = 'active'
    and id <> v_guarantor;

  if v_eligible < 1 then
    raise exception
      'Nobody is left to vote on this loan — the group needs another member'
      using errcode = 'check_violation';
  end if;

  v_needed := least(v_needed, v_eligible);

  insert into loans (
    group_id, borrower_id, guarantor_id, is_outside_borrower,
    outside_borrower_name, outside_borrower_phone, outside_borrower_address,
    principal_paise, purpose, rate_bp, overdue_rate_bp, term_months, status,
    fund_total_at_request_paise, eligible_voter_count,
    required_approvals, borrower_role_at_request, repayment_plan
  )
  values (
    v_group, null, v_guarantor, true,
    btrim(p_borrower_name),
    case when p_borrower_phone is not null and length(btrim(p_borrower_phone)) > 0 then btrim(p_borrower_phone) else null end,
    case when p_borrower_address is not null and length(btrim(p_borrower_address)) > 0 then btrim(p_borrower_address) else null end,
    p_principal_paise, p_purpose, v_rate, v_cfg.overdue_rate_bp, p_term_months, 'requested',
    v_fund, v_eligible, v_needed, null, coalesce(p_repayment_plan, 'monthly')
  )
  returning * into v_row;

  return v_row;
end $$;

-- 4. Update cancel_loan_request to recognize guarantor of outside loans
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

  v_self := (v_actor = v_loan.borrower_id) or (v_loan.is_outside_borrower and v_actor = v_loan.guarantor_id);

  if not v_self
     and current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the requester or an officer may cancel a loan request'
      using errcode = 'insufficient_privilege';
  end if;

  update loans
  set status = 'rejected',
      decided_at = now(),
      withdrawn_by_requester = v_self
  where id = p_loan_id returning * into v_loan;

  return v_loan;
end $$;

-- 5. Update disburse_loan counterparty for cash ledger
create or replace function disburse_loan(
  p_loan_id uuid,
  p_disbursed_on date default current_date,
  p_method payment_method_enum default 'bank'
) returns loans
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group    uuid := current_group_id();
  v_actor    uuid := fn_assert_active_member();
  v_cfg      groups;
  v_loan     loans;
  v_lendable bigint;
  v_out      bigint;
  v_name     text;
begin
  select * into v_cfg from groups where id = v_group for no key update;
  select * into v_loan from loans
  where id = p_loan_id and group_id = v_group for update;

  if v_loan.id is null then
    raise exception 'Loan not found' using errcode = 'no_data_found';
  end if;
  if v_loan.status <> 'approved' then
    raise exception 'Only an approved loan can be disbursed (this one is %)', v_loan.status
      using errcode = 'check_violation';
  end if;
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may disburse a loan'
      using errcode = 'insufficient_privilege';
  end if;
  if v_actor = v_loan.borrower_id then
    raise exception 'You cannot disburse your own loan -- ask the other office holder'
      using errcode = 'insufficient_privilege';
  end if;
  if p_disbursed_on > current_date then
    raise exception 'A loan cannot be dated as disbursed in the future'
      using errcode = 'check_violation';
  end if;
  if p_disbursed_on < v_loan.requested_at::date then
    raise exception 'Disbursal date % is before the loan was requested (%)',
      p_disbursed_on, v_loan.requested_at::date
      using errcode = 'check_violation';
  end if;

  v_lendable := fn_fund_total_paise(v_group) * (10000 - v_cfg.reserve_pct_bp) / 10000;
  v_out      := total_outstanding_paise(v_group);
  if v_out + v_loan.principal_paise > v_lendable then
    raise exception 'Disbursing now would break the reserve'
      using errcode = 'check_violation';
  end if;

  update loans
  set status = 'disbursed',
      disbursed_on = p_disbursed_on,
      due_on = (p_disbursed_on + make_interval(months => v_loan.term_months))::date
  where id = p_loan_id
  returning * into v_loan;

  if p_method = 'cash' then
    v_name := coalesce(v_loan.outside_borrower_name, (select full_name from members where id = v_loan.borrower_id));
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose,
                             counterparty, recorded_by, reported_at, reported_by)
    values (v_group, 'out', v_loan.principal_paise, p_disbursed_on::timestamptz,
            'Loan disbursed',
            v_name,
            v_actor, now(), v_actor);
  end if;

  return v_loan;
end $$;

-- 6. Update write_off_loan for counterparty naming and status = 'paid'
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

  v_lost := loan_outstanding_principal_paise(p_loan_id);
  v_name := coalesce(v_loan.outside_borrower_name, (select full_name from members where id = v_loan.borrower_id));

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

-- 7. Update record_recovery for outside borrower naming
drop function if exists recover_writeoff(uuid, bigint, bigint, date, payment_method_enum, text);

create or replace function record_recovery(
  p_loan_id uuid,
  p_principal_paise bigint default 0,
  p_interest_paise bigint default 0,
  p_paid_on date default current_date,
  p_method payment_method_enum default 'bank',
  p_note text default null
) returns loan_repayments
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_loan  loans;
  v_lost  bigint;
  v_back  bigint;
  v_name  text;
  v_row   loan_repayments;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may record money coming back'
      using errcode = 'insufficient_privilege';
  end if;

  perform 1 from groups where id = v_group for no key update;

  select * into v_loan from loans
  where id = p_loan_id and group_id = v_group for update;

  if v_loan.id is null then
    raise exception 'Loan not found' using errcode = 'no_data_found';
  end if;
  if v_loan.status <> 'written_off' then
    raise exception 'This loan was not written off - record a normal repayment instead'
      using errcode = 'check_violation';
  end if;
  if p_principal_paise < 0 or p_interest_paise < 0 then
    raise exception 'An amount cannot be less than zero' using errcode = 'check_violation';
  end if;
  if p_principal_paise + p_interest_paise <= 0 then
    raise exception 'Enter an amount' using errcode = 'check_violation';
  end if;
  if p_paid_on > current_date then
    raise exception 'A payment cannot be dated in the future'
      using errcode = 'check_violation';
  end if;

  v_lost := loan_outstanding_principal_paise(p_loan_id);
  if p_principal_paise > v_lost then
    raise exception 'Only Rs.% of this loan was written off',
      fmt_rupees(v_lost) using errcode = 'check_violation';
  end if;

  v_name := coalesce(v_loan.outside_borrower_name, (select full_name from members where id = v_loan.borrower_id));

  insert into loan_repayments (
    group_id, loan_id, paid_on, principal_paise, interest_paise, penalty_paise,
    method, note, recorded_by
  )
  values (v_group, p_loan_id, p_paid_on, p_principal_paise, p_interest_paise, 0,
          p_method, coalesce(p_note, 'Recovered after write-off'), v_actor)
  returning * into v_row;

  if p_principal_paise > 0 then
    insert into expenses (
      group_id, category, description, amount_paise, incurred_on, method,
      requires_vote, fund_total_at_request_paise, required_approvals,
      eligible_voter_count, created_by, status, decided_at, paid_on,
      is_loan_write_off, is_writeoff_recovery
    )
    values (
      v_group, 'other',
      'Recovered from ' || coalesce(v_name, 'borrower')
        || ' on a loan written off earlier',
      -p_principal_paise, p_paid_on, p_method,
      false, fn_fund_total_paise(v_group), 0,
      active_member_count(v_group), v_actor, 'paid', now(), p_paid_on,
      false, true
    );
  end if;

  if p_method = 'cash' then
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at,
                             purpose, counterparty, recorded_by,
                             reported_at, reported_by)
    values (v_group, 'in', p_principal_paise + p_interest_paise,
            p_paid_on::timestamptz, 'Recovered on a written-off loan',
            v_name, v_actor, now(), v_actor);
  end if;

  v_back := loan_outstanding_principal_paise(p_loan_id);
  if v_back = 0 then
    update loans set status = 'closed', closed_on = p_paid_on
    where id = p_loan_id;
  end if;

  return v_row;
end $$;

-- 7b. Update record_repayment for outside borrower counterparty in cash_ledger
create or replace function record_repayment(
  p_loan_id uuid,
  p_principal_paise bigint,
  p_interest_paise bigint default 0,
  p_penalty_paise bigint default 0,
  p_paid_on date default current_date,
  p_method payment_method_enum default 'bank',
  p_note text default null
) returns loan_repayments
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_loan  loans;
  v_out   bigint;
  v_row   loan_repayments;
  v_remaining bigint;
  v_accrued   bigint;
  v_paid_int  bigint;
  v_owed_int  bigint;
  v_name      text;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may record a repayment'
      using errcode = 'insufficient_privilege';
  end if;

  if p_principal_paise < 0 then
    raise exception 'Principal repayment cannot be negative'
      using errcode = 'check_violation';
  end if;
  if p_interest_paise < 0 then
    raise exception 'Interest amount cannot be negative'
      using errcode = 'check_violation';
  end if;
  if p_penalty_paise < 0 then
    raise exception 'Penalty amount cannot be negative'
      using errcode = 'check_violation';
  end if;
  if p_principal_paise = 0 and p_interest_paise = 0 and p_penalty_paise = 0 then
    raise exception 'At least one amount must be greater than zero'
      using errcode = 'check_violation';
  end if;
  if p_paid_on > current_date then
    raise exception 'A repayment cannot be dated in the future'
      using errcode = 'check_violation';
  end if;

  select * into v_loan from loans
  where id = p_loan_id and group_id = v_group for update;
  if v_loan.id is null then
    raise exception 'Loan not found' using errcode = 'no_data_found';
  end if;
  if v_loan.status <> 'disbursed' then
    raise exception 'Only a disbursed loan can be repaid (this one is %)', v_loan.status
      using errcode = 'check_violation';
  end if;
  if p_paid_on < v_loan.disbursed_on then
    raise exception 'A repayment cannot predate the disbursal (%)', v_loan.disbursed_on
      using errcode = 'check_violation';
  end if;

  v_out := loan_outstanding_principal_paise(p_loan_id);
  if p_principal_paise > v_out then
    raise exception 'Principal repayment Rs.% exceeds the outstanding Rs.%',
      fmt_rupees(p_principal_paise), fmt_rupees(v_out)
      using errcode = 'check_violation';
  end if;

  insert into loan_repayments (group_id, loan_id, paid_on, principal_paise,
                               interest_paise, penalty_paise, method, note, recorded_by)
  values (v_group, p_loan_id, p_paid_on, p_principal_paise, p_interest_paise,
          p_penalty_paise, p_method, p_note, v_actor)
  returning * into v_row;

  if p_method = 'cash' then
    v_name := coalesce(v_loan.outside_borrower_name, (select full_name from members where id = v_loan.borrower_id));
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose,
                             counterparty, recorded_by, reported_at, reported_by)
    values (v_group, 'in', p_principal_paise + p_interest_paise + p_penalty_paise,
            p_paid_on::timestamptz, 'Loan repayment received in cash',
            v_name,
            v_actor, now(), v_actor);
  end if;

  -- Close only when nothing is left on EITHER side.
  v_remaining := loan_outstanding_principal_paise(p_loan_id);
  if v_remaining = 0 then
    select coalesce(a.interest_paise + a.penalty_paise, 0) into v_accrued
    from loan_accrued_interest_paise(p_loan_id, p_paid_on) a;

    select coalesce(sum(r.interest_paise + r.penalty_paise), 0)::bigint
    into v_paid_int
    from loan_repayments r where r.loan_id = p_loan_id;

    v_owed_int := greatest(0, v_accrued - v_paid_int);

    if v_owed_int = 0 then
      update loans set status = 'closed', closed_on = p_paid_on
      where id = p_loan_id;
    else
      raise notice
        'Principal cleared but Rs.% interest is still owed; loan stays open',
        fmt_rupees(v_owed_int);
    end if;
  end if;

  return v_row;
end $$;


-- 8. Rebuild v_loan_status and v_reminders
drop view if exists v_reminders;
drop view if exists v_loan_status;

create view v_loan_status
with (security_invoker = true) as
select
  l.id,
  l.group_id,
  l.borrower_id,
  coalesce(b.full_name, l.outside_borrower_name) as borrower_name,
  l.guarantor_id,
  g.full_name                     as guarantor_name,
  l.principal_paise,
  l.purpose,
  l.rate_bp,
  l.overdue_rate_bp,
  l.term_months,
  l.repayment_plan,
  l.status,
  l.requested_at,
  l.disbursed_on,
  l.due_on,
  l.closed_on,
  l.required_approvals,
  l.eligible_voter_count,
  l.withdrawn_by_requester,
  loan_outstanding_principal_paise(l.id) as outstanding_principal_paise,
  acc.interest_paise              as accrued_interest_paise,
  acc.penalty_paise               as accrued_penalty_paise,
  coalesce(rp.principal_paid, 0)  as principal_paid_paise,
  coalesce(rp.interest_paid, 0)   as interest_paid_paise,
  (loan_outstanding_principal_paise(l.id)
    + acc.interest_paise + acc.penalty_paise
    - coalesce(rp.interest_paid, 0))     as total_due_paise,
  loan_arrears_paise(l.id, current_date, l.group_id) as arrears_paise,
  loan_next_due(l.id, current_date, l.group_id)      as next_due_on,
  case
    when l.status = 'disbursed' and l.due_on is not null and current_date > l.due_on
      then current_date - l.due_on
    else 0
  end                             as days_overdue,
  (l.status = 'disbursed'
    and (loan_arrears_paise(l.id, current_date, l.group_id) > 0
         or (l.due_on is not null and current_date > l.due_on)))
                                  as is_overdue,
  coalesce(v.approvals, 0)        as approvals,
  coalesce(v.rejections, 0)       as rejections,
  (l.status = 'requested'
    and current_member_id() is not null
    and (l.borrower_id is null or current_member_id() <> l.borrower_id)
    and current_member_id() <> l.guarantor_id
    and not exists (
      select 1 from loan_votes lv
      where lv.loan_id = l.id and lv.voter_id = current_member_id()
    ))                            as can_i_vote,
  (select lv.vote from loan_votes lv
   where lv.loan_id = l.id and lv.voter_id = current_member_id()) as my_vote,
  l.is_outside_borrower,
  l.outside_borrower_name,
  l.outside_borrower_phone,
  l.outside_borrower_address
from loans l
left join members b on b.id = l.borrower_id
join members g on g.id = l.guarantor_id
cross join lateral loan_accrued_interest_paise(l.id) acc
left join (
  select loan_id,
         sum(principal_paise) as principal_paid,
         sum(interest_paise + penalty_paise) as interest_paid
  from loan_repayments group by loan_id
) rp on rp.loan_id = l.id
left join (
  select loan_id,
         count(*) filter (where vote = 'approve') as approvals,
         count(*) filter (where vote = 'reject')  as rejections
  from loan_votes group by loan_id
) v on v.loan_id = l.id
where l.group_id = current_group_id() and in_current_group();

grant select on v_loan_status to authenticated;
revoke all on v_loan_status from anon;

create view v_reminders
with (security_invoker = true) as
-- Money owed for a month, including part payments -- the shortfall, not the
-- whole amount, because telling someone who has paid half that they owe the
-- full sum is how a group loses faith in the app.
select
  u.member_id,
  u.group_id,
  u.full_name,
  (case when u.is_overdue then 'contribution_overdue'
        else 'contribution_due' end)::reminder_kind_enum as kind,
  u.shortfall_paise                                       as amount_paise,
  u.grace_date                                            as due_on,
  to_char(u.period_month, 'Mon YYYY')                     as subject
from v_unpaid_contributions u

union all

-- Loan instalments. This is the reminder that could not exist at all before
-- there was a schedule to be behind on.
select
  coalesce(l.borrower_id, l.guarantor_id) as member_id,
  l.group_id,
  l.borrower_name                         as full_name,
  (case when l.arrears_paise > 0 then 'loan_overdue'
        else 'loan_instalment_due' end)::reminder_kind_enum as kind,
  (case when l.arrears_paise > 0 then l.arrears_paise
        else coalesce((select i.principal_paise from loan_instalments i
                       where i.loan_id = l.id and i.due_on > current_date
                       order by i.due_on limit 1), 0) end)  as amount_paise,
  coalesce(l.next_due_on, l.due_on)                         as due_on,
  'Loan repayment'                                          as subject
from v_loan_status l
where l.status = 'disbursed'
  and (l.arrears_paise > 0
       or l.next_due_on is not null and l.next_due_on <= current_date + 7);

grant select on v_reminders to authenticated;
revoke all on v_reminders from anon;

revoke execute on function request_outside_loan(text, bigint, int, text, text, int, uuid, text, text) from public, anon;
grant execute on function request_outside_loan(text, bigint, int, text, text, int, uuid, text, text) to authenticated;

revoke execute on function record_repayment(uuid, bigint, bigint, bigint, date, payment_method_enum, text) from public, anon;
grant execute on function record_repayment(uuid, bigint, bigint, bigint, date, payment_method_enum, text) to authenticated;

revoke execute on function record_recovery(uuid, bigint, bigint, date, payment_method_enum, text) from public, anon;
grant execute on function record_recovery(uuid, bigint, bigint, date, payment_method_enum, text) to authenticated;

revoke execute on function disburse_loan(uuid, date, payment_method_enum) from public, anon;
grant execute on function disburse_loan(uuid, date, payment_method_enum) to authenticated;

revoke execute on function write_off_loan(uuid, text) from public, anon;
grant execute on function write_off_loan(uuid, text) to authenticated;

revoke execute on function cancel_loan_request(uuid) from public, anon;
grant execute on function cancel_loan_request(uuid) to authenticated;

