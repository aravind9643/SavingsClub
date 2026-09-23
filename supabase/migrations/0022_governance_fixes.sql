-- 0022_governance_fixes.sql
--
-- Governance gaps -- who may vote, and how a decision is recorded.
--
--   1. The guarantor could vote on the loan they guarantee.
--   2. A borrower withdrawing their own request was recorded as a group
--      rejection, which is a different fact about a different person.
--   3. A vote could deadlock permanently when members left mid-vote.

-- ---------------------------------------------------------------------------
-- 1. Tell a withdrawal apart from a refusal.
--
-- cancel_loan_request() and cancel_expense() both set status = 'rejected',
-- because that is the only terminal state the enum offers before approval.
-- But "I changed my mind" and "the group said no" are different facts, and
-- the second one follows a member around: a history of rejected requests
-- reads as a record of the group's distrust.
--
-- A boolean rather than a new enum label, for the same reason as 0020:
-- ALTER TYPE ... ADD VALUE cannot be referenced by later statements in the
-- same transaction, and the CLI wraps each migration in one.
-- ---------------------------------------------------------------------------
alter table loans
  add column if not exists withdrawn_by_requester boolean not null default false;
alter table expenses
  add column if not exists withdrawn_by_requester boolean not null default false;

comment on column loans.withdrawn_by_requester is
  'True when the borrower withdrew the request themselves. The status is '
  'still ''rejected'' (the enum has no cancelled state), but this separates '
  'a withdrawal from a refusal by the group.';

-- ---------------------------------------------------------------------------
-- 2. cast_loan_vote -- the guarantor may not vote.
--
-- The guarantor is the one member besides the borrower with a direct stake in
-- the loan being approved: they are liable if it defaults. request_loan()
-- already refuses self-guarantee, so the conflict was clearly understood --
-- it just was not carried through to the vote.
--
-- Everything else here is unchanged from 0009.
-- ---------------------------------------------------------------------------
create or replace function cast_loan_vote(
  p_loan_id uuid,
  p_vote vote_enum,
  p_note text default null
) returns loans
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group     uuid := current_group_id();
  v_actor     uuid := fn_assert_active_member();
  v_cfg       groups;
  v_loan      loans;
  v_approvals int;
  v_rejections int;
  v_lendable  bigint;
  v_out       bigint;
  v_live      int;
  v_needed    int;
begin
  select * into v_cfg from groups where id = v_group for no key update;
  select * into v_loan from loans
  where id = p_loan_id and group_id = v_group for update;

  if v_loan.id is null then
    raise exception 'Loan not found' using errcode = 'no_data_found';
  end if;
  if v_loan.status <> 'requested' then
    raise exception 'This loan is already %', v_loan.status
      using errcode = 'check_violation';
  end if;
  if v_actor = v_loan.borrower_id then
    raise exception 'You cannot vote on your own loan request'
      using errcode = 'insufficient_privilege';
  end if;
  if v_actor = v_loan.guarantor_id then
    raise exception 'You stood guarantor for this loan, so you cannot vote on it'
      using errcode = 'insufficient_privilege';
  end if;

  insert into loan_votes (group_id, loan_id, voter_id, vote, note)
  values (v_group, p_loan_id, v_actor, p_vote, p_note)
  on conflict (loan_id, voter_id)
  do update set vote = excluded.vote, note = excluded.note, voted_at = now();

  select
    count(*) filter (where vote = 'approve'),
    count(*) filter (where vote = 'reject')
  into v_approvals, v_rejections
  from loan_votes where loan_id = p_loan_id and group_id = v_group;

  -- The snapshot normally governs. It is only relaxed when members have left
  -- and made it unreachable -- otherwise a request would sit in 'requested'
  -- forever, unable to be approved or rejected by anyone.
  v_live   := fn_live_eligible_voters(p_loan_id);
  v_needed := least(v_loan.required_approvals, greatest(1, v_live));

  if v_approvals >= v_needed then
    v_lendable := fn_fund_total_paise(v_group) * (10000 - v_cfg.reserve_pct_bp) / 10000;
    v_out      := total_outstanding_paise(v_group);

    if v_out + v_loan.principal_paise > v_lendable then
      raise exception
        'The fund can no longer cover this loan: only Rs.% is lendable now',
        (greatest(0, v_lendable - v_out)::numeric / 100)::text
        using errcode = 'check_violation';
    end if;

    update loans set status = 'approved', decided_at = now()
    where id = p_loan_id returning * into v_loan;

  elsif v_rejections > greatest(0, least(v_loan.eligible_voter_count, v_live) - v_needed) then
    update loans set status = 'rejected', decided_at = now()
    where id = p_loan_id returning * into v_loan;
  end if;

  return v_loan;
end $$;

-- ---------------------------------------------------------------------------
-- 3. request_loan -- the guarantor is no longer an eligible voter.
--
-- eligible_voter_count is the snapshot the rejection threshold is measured
-- against (`rejections > eligible - required`). Now that the guarantor cannot
-- vote, leaving them in that count would misstate the arithmetic: the group
-- would need one more rejection than there are people able to cast one.
--
-- required_approvals is ALSO capped at the eligible count here. Without the
-- cap a 3-member group -- borrower and guarantor excluded, one voter left --
-- would carry a required count of 2 and the loan could never be approved or
-- rejected. It would simply sit there.
--
-- NOTE: required_loan_approvals() keeps its original signature. Adding a
-- parameter would create a second function beside the old one rather than
-- replacing it, and the old one would stay callable -- the exact overload
-- trap documented in AGENTS.md.
-- ---------------------------------------------------------------------------
create or replace function request_loan(
  p_guarantor_id uuid,
  p_principal_paise bigint,
  p_term_months int,
  p_purpose text default null
) returns loans
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group    uuid := current_group_id();
  v_actor    uuid := fn_assert_active_member();
  v_cfg      groups;
  v_fund     bigint;
  v_cap      bigint;
  v_lendable bigint;
  v_out      bigint;
  v_mine     bigint;
  v_eligible int;
  v_needed   int;
  v_row      loans;
begin
  -- Lock this group's row before reading any fund figure.
  select * into v_cfg from groups where id = v_group for no key update;

  if p_principal_paise <= 0 then
    raise exception 'Loan amount must be positive' using errcode = 'check_violation';
  end if;
  if p_term_months < 1 or p_term_months > v_cfg.max_loan_months then
    raise exception 'Repayment term must be between 1 and % months', v_cfg.max_loan_months
      using errcode = 'check_violation';
  end if;
  if p_guarantor_id = v_actor then
    raise exception 'You cannot stand guarantor for your own loan'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from members
                 where id = p_guarantor_id and group_id = v_group
                   and left_on is null and status = 'active') then
    raise exception 'Guarantor must be an active member of this group'
      using errcode = 'check_violation';
  end if;

  v_fund     := fn_fund_total_paise(v_group);
  v_cap      := v_fund * v_cfg.max_loan_pct_bp / 10000;
  v_lendable := v_fund * (10000 - v_cfg.reserve_pct_bp) / 10000;
  v_out      := total_outstanding_paise(v_group);
  v_mine     := member_outstanding_paise(v_actor);
  v_needed   := required_loan_approvals(v_group);

  if v_mine + p_principal_paise > v_cap then
    raise exception
      'This would take your total borrowing to Rs.% but your limit is Rs.%',
      ((v_mine + p_principal_paise)::numeric / 100)::text,
      (v_cap::numeric / 100)::text
      using errcode = 'check_violation';
  end if;

  if v_out + p_principal_paise > v_lendable then
    raise exception
      'Only Rs.% is available to lend (the reserve must stay in the bank)',
      (greatest(0, v_lendable - v_out)::numeric / 100)::text
      using errcode = 'check_violation';
  end if;

  -- Active members other than the borrower AND the guarantor: both have a
  -- direct stake in approval, and neither may vote.
  select count(*)::int into v_eligible
  from members
  where group_id = v_group and left_on is null and status = 'active'
    and id <> v_actor and id <> p_guarantor_id;

  if v_eligible < 1 then
    raise exception
      'Nobody is left to vote on this loan — the group needs another member'
      using errcode = 'check_violation';
  end if;

  -- Never require more approvals than there are people who can give them.
  v_needed := least(v_needed, v_eligible);

  insert into loans (
    group_id, borrower_id, guarantor_id, principal_paise, purpose,
    rate_bp, overdue_rate_bp, term_months, status,
    fund_total_at_request_paise, eligible_voter_count,
    required_approvals, borrower_role_at_request
  )
  values (
    v_group, v_actor, p_guarantor_id, p_principal_paise, p_purpose,
    v_cfg.loan_rate_bp, v_cfg.overdue_rate_bp, p_term_months, 'requested',
    v_fund, v_eligible, v_needed, role_of(v_actor)
  )
  returning * into v_row;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 3b. Break the deadlock when voters leave mid-vote.
--
-- required_approvals is a snapshot, deliberately: it stops a role rotation or
-- a departure from moving the goalposts during a vote. But if enough members
-- leave, the snapshot can become unreachable -- the loan then sits in
-- 'requested' forever with no path to approval OR rejection.
--
-- This does not move the goalposts in the normal case. It only lowers the bar
-- when the bar has become impossible, and never below one approval.
-- ---------------------------------------------------------------------------
create or replace function fn_live_eligible_voters(p_loan_id uuid)
returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int
  from members m
  join loans l on l.id = p_loan_id
  where m.group_id = l.group_id
    and m.left_on is null
    and m.status = 'active'
    and m.id <> l.borrower_id
    and m.id <> l.guarantor_id
$$;

-- ---------------------------------------------------------------------------
-- 4. cancel_loan_request -- record it as a withdrawal.
-- ---------------------------------------------------------------------------
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
     and current_role_of() not in ('cashier', 'accountant', 'president') then
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

-- ---------------------------------------------------------------------------
-- 5. cancel_expense -- same distinction.
-- ---------------------------------------------------------------------------
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
     and current_role_of() not in ('cashier', 'accountant', 'president') then
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

-- ---------------------------------------------------------------------------
-- 6. Grants for the new helper.
--
-- fn_live_eligible_voters is called from inside cast_loan_vote (a SECURITY
-- DEFINER function), so `authenticated` does not strictly need EXECUTE. It is
-- granted anyway so the UI can show "3 of 4 members can still vote" rather
-- than leaving people guessing why a threshold moved.
-- ---------------------------------------------------------------------------
revoke execute on function fn_live_eligible_voters(uuid) from public, anon;
grant execute on function fn_live_eligible_voters(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Views must expose the new columns, and must agree with the RPCs.
--
-- Two separate problems here:
--
--   * A view stores its select list EXPANDED at creation time. v_expense_status
--     was created with `e.*` back in 0012, so the columns added in 0020/0022 are
--     simply absent from it -- present in the table, invisible to the app.
--
--   * can_i_vote told the UI who may vote, and it did not know about the new
--     guarantor rule. The button would appear and then the RPC would refuse it,
--     which reads as a broken app rather than as a rule.
--
-- v_loan_status names its columns, so appending one is legal in place.
-- v_expense_status re-expands `e.*`, which shifts the column list, so it has to
-- be dropped first -- CREATE OR REPLACE VIEW cannot reorder columns.
-- ---------------------------------------------------------------------------
create or replace view v_loan_status
with (security_invoker = true) as
select
  l.id,
  l.group_id,
  l.borrower_id,
  b.full_name                     as borrower_name,
  l.guarantor_id,
  g.full_name                     as guarantor_name,
  l.principal_paise,
  l.purpose,
  l.rate_bp,
  l.overdue_rate_bp,
  l.term_months,
  l.status,
  l.requested_at,
  l.disbursed_on,
  l.due_on,
  l.closed_on,
  l.required_approvals,
  l.eligible_voter_count,
  loan_outstanding_principal_paise(l.id) as outstanding_principal_paise,
  acc.interest_paise              as accrued_interest_paise,
  acc.penalty_paise               as accrued_penalty_paise,
  coalesce(rp.principal_paid, 0)  as principal_paid_paise,
  coalesce(rp.interest_paid, 0)   as interest_paid_paise,
  (loan_outstanding_principal_paise(l.id)
    + acc.interest_paise + acc.penalty_paise
    - coalesce(rp.interest_paid, 0))     as total_due_paise,
  case when l.status = 'disbursed' and l.due_on is not null and current_date > l.due_on
       then current_date - l.due_on else 0 end as days_overdue,
  (l.status = 'disbursed' and l.due_on is not null and current_date > l.due_on)
                                  as is_overdue,
  coalesce(v.approvals, 0)        as approvals,
  coalesce(v.rejections, 0)       as rejections,
  (l.status = 'requested'
    and current_member_id() is not null
    and current_member_id() <> l.borrower_id
    and current_member_id() <> l.guarantor_id
    and not exists (
      select 1 from loan_votes lv
      where lv.loan_id = l.id and lv.voter_id = current_member_id()
    ))                            as can_i_vote,
  (select lv.vote from loan_votes lv
   where lv.loan_id = l.id and lv.voter_id = current_member_id()) as my_vote,
  l.withdrawn_by_requester
from loans l
join members b on b.id = l.borrower_id
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

drop view if exists v_expense_status;

create or replace view v_expense_status
with (security_invoker = true) as
select
  e.*,
  m.full_name as created_by_name,
  coalesce(v.approvals, 0)  as approvals,
  coalesce(v.rejections, 0) as rejections,
  (e.status = 'proposed'
    and current_member_id() is not null
    and current_member_id() <> e.created_by
    and not exists (
      select 1 from expense_votes ev
      where ev.expense_id = e.id and ev.voter_id = current_member_id()
    )) as can_i_vote,
  (select ev.vote from expense_votes ev
   where ev.expense_id = e.id and ev.voter_id = current_member_id()) as my_vote
from expenses e
join members m on m.id = e.created_by
left join (
  select expense_id,
         count(*) filter (where vote = 'approve') as approvals,
         count(*) filter (where vote = 'reject')  as rejections
  from expense_votes group by expense_id
) v on v.expense_id = e.id
where e.group_id = current_group_id() and in_current_group();

grant select on v_loan_status, v_expense_status to authenticated;
