-- 0007_fund_math.sql
-- THE single source of truth for every money figure in the app.
--
-- Both the dashboard views and the approval triggers call fn_fund_total().
-- If the number a member sees on screen and the number the cap check uses were
-- computed by two different pieces of code, they would eventually disagree,
-- and the disagreement would surface as a loan that the UI said was fine and
-- the database refused. One implementation, two callers.
--
-- Two distinct figures that are easy to confuse -- named apart deliberately:
--   total_fund            = what the group is worth (contributions + interest
--                           received - expenses). Does NOT subtract loans:
--                           money on loan is still an asset.
--   expected_bank_balance = what should be sitting in the bank right now
--                           (total_fund - outstanding loans - cash float).

create or replace function fn_contributions_received_paise() returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise + late_fee_paise), 0)::bigint from contributions
$$;

-- Interest RECEIVED, not accrued. See the note at the top of 0005.
create or replace function fn_interest_received_paise() returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(interest_paise + penalty_paise), 0)::bigint from loan_repayments
$$;

create or replace function fn_expenses_paid_paise() returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from expenses where status = 'paid'
$$;

create or replace function fn_fund_total_paise() returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select fn_contributions_received_paise()
       + fn_interest_received_paise()
       - fn_expenses_paid_paise()
$$;

-- ---------------------------------------------------------------------------
-- Headline dashboard figures.
-- security_invoker so the caller's RLS still applies to the underlying tables.
-- ---------------------------------------------------------------------------
create or replace view v_fund_summary
with (security_invoker = true) as
select
  fn_contributions_received_paise()                       as contributions_paise,
  fn_interest_received_paise()                            as interest_received_paise,
  fn_expenses_paid_paise()                                as expenses_paise,
  fn_fund_total_paise()                                   as total_fund_paise,
  (fn_fund_total_paise() * c.reserve_pct_bp / 10000)      as reserve_paise,
  (fn_fund_total_paise() * (10000 - c.reserve_pct_bp) / 10000) as lendable_paise,
  total_outstanding_paise()                               as outstanding_paise,
  greatest(0,
    (fn_fund_total_paise() * (10000 - c.reserve_pct_bp) / 10000)
    - total_outstanding_paise())                          as still_lendable_paise,
  (fn_fund_total_paise() * c.max_loan_pct_bp / 10000)     as per_member_cap_paise,
  cash_float_balance_paise()                              as cash_float_paise,
  c.cash_float_limit_paise,
  (fn_fund_total_paise()
     - total_outstanding_paise()
     - cash_float_balance_paise())                        as expected_bank_balance_paise,
  -- Accrued-but-unpaid interest is a receivable, shown as a memo line. It is
  -- deliberately NOT part of total_fund, so reconciliation can reach zero.
  (select coalesce(sum(a.interest_paise + a.penalty_paise), 0)::bigint
   from loans l
   cross join lateral loan_accrued_interest_paise(l.id) a
   where l.status = 'disbursed')                          as accrued_receivable_paise
from app_config c
where c.id;

-- ---------------------------------------------------------------------------
-- Per-member position, including the 30% cap breach flag.
-- ---------------------------------------------------------------------------
create or replace view v_member_positions
with (security_invoker = true) as
select
  m.id                                          as member_id,
  m.full_name,
  m.is_active,
  role_of(m.id)                                 as role,
  coalesce(ct.paid_paise, 0)                    as contributed_paise,
  coalesce(ct.late_fees_paise, 0)               as late_fees_paise,
  coalesce(ct.periods_paid, 0)                  as periods_paid,
  member_outstanding_paise(m.id)                as outstanding_paise,
  (select per_member_cap_paise from v_fund_summary) as cap_paise,
  (member_outstanding_paise(m.id)
     > (select per_member_cap_paise from v_fund_summary)) as cap_breached,
  case
    when (select total_fund_paise from v_fund_summary) = 0 then 0::numeric
    else round(coalesce(ct.paid_paise, 0)::numeric
               / (select total_fund_paise from v_fund_summary) * 100, 2)
  end                                           as share_pct
from members m
left join (
  select member_id,
         sum(amount_paise)   as paid_paise,
         sum(late_fee_paise) as late_fees_paise,
         count(*)            as periods_paid
  from contributions
  group by member_id
) ct on ct.member_id = m.id;

-- ---------------------------------------------------------------------------
-- Unpaid contributions: periods x active members minus what was paid.
-- Only periods that have actually opened are counted, so a fresh year does not
-- report eleven months of "unpaid".
-- ---------------------------------------------------------------------------
create or replace view v_unpaid_contributions
with (security_invoker = true) as
select
  p.id           as period_id,
  p.period_month,
  p.due_date,
  p.grace_date,
  m.id           as member_id,
  m.full_name,
  p.amount_paise as expected_paise,
  (current_date > p.grace_date) as is_overdue
from contribution_periods p
cross join members m
left join contributions c on c.period_id = p.id and c.member_id = m.id
where c.id is null
  and m.left_on is null
  and m.joined_on <= (p.period_month + interval '1 month' - interval '1 day')::date;

-- ---------------------------------------------------------------------------
-- Loan status, including everything the voting UI needs.
-- can_i_vote is computed HERE so the button and the RPC agree on eligibility;
-- if they ever disagree, the UI is the one that is wrong.
-- ---------------------------------------------------------------------------
create or replace view v_loan_status
with (security_invoker = true) as
select
  l.id,
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
  case
    when l.status = 'disbursed' and l.due_on is not null and current_date > l.due_on
      then current_date - l.due_on
    else 0
  end                             as days_overdue,
  (l.status = 'disbursed' and l.due_on is not null and current_date > l.due_on)
                                  as is_overdue,
  coalesce(v.approvals, 0)        as approvals,
  coalesce(v.rejections, 0)       as rejections,
  -- A member may vote when: the loan is still open, they are an active member,
  -- they are not the borrower, and they have not already voted.
  (l.status = 'requested'
    and current_member_id() is not null
    and current_member_id() <> l.borrower_id
    and not exists (
      select 1 from loan_votes lv
      where lv.loan_id = l.id and lv.voter_id = current_member_id()
    ))                            as can_i_vote,
  (select lv.vote from loan_votes lv
   where lv.loan_id = l.id and lv.voter_id = current_member_id()) as my_vote
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
) v on v.loan_id = l.id;

-- ---------------------------------------------------------------------------
-- Cash alerts: over-limit float and spends not reported within the window.
-- ---------------------------------------------------------------------------
create or replace view v_cash_alerts
with (security_invoker = true) as
select
  cl.id,
  cl.direction,
  cl.amount_paise,
  cl.occurred_at,
  cl.purpose,
  cl.counterparty,
  cl.reported_at,
  m.full_name as recorded_by_name,
  case
    when cl.reported_at is null
      then now() > cl.occurred_at + make_interval(hours => c.cash_report_hours)
    else cl.reported_at > cl.occurred_at + make_interval(hours => c.cash_report_hours)
  end as reporting_breached,
  (cl.reported_at is null) as unreported
from cash_ledger cl
join members m on m.id = cl.recorded_by
cross join app_config c
where c.id and cl.direction = 'out';

grant select on v_fund_summary, v_member_positions, v_unpaid_contributions,
                v_loan_status, v_cash_alerts to authenticated;
revoke all on v_fund_summary, v_member_positions, v_unpaid_contributions,
              v_loan_status, v_cash_alerts from anon;
