-- 0027_loan_schedule.sql
--
-- A loan was one balloon payment at the end of the term.
--
-- term_months and due_on existed; instalments did not. Nothing was overdue
-- until the ENTIRE term expired, so a borrower nine months delinquent on a
-- twelve-month loan showed as perfectly healthy -- on the dashboard, in
-- v_loan_status.is_overdue, and in the overdue interest, which could not apply
-- to a missed monthly instalment because no monthly instalment existed.
--
-- Real groups collect monthly, usually alongside the contribution. The app
-- modelled a product the group does not sell.
--
-- WHAT THIS DOES NOT CHANGE
--
-- Interest accrual. loan_accrued_interest_paise() already walks the repayment
-- history on a reducing balance and splits each segment at due_on -- which is
-- correct, and stays. The schedule tells you what SHOULD have arrived by now;
-- accrual tells you what interest the money actually outstanding has earned.
-- Those are different questions and keeping them apart is deliberate.
--
-- The schedule is therefore EXPECTATION, not ledger. Repayments are still
-- recorded against the loan, not against a row of the schedule: forcing a
-- cashier to allocate a part payment across instalments is how a simple app
-- becomes an accounting package nobody in the group can operate.

create table loan_instalments (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references groups (id),
  loan_id         uuid not null references loans (id) on delete cascade,
  seq             int  not null check (seq > 0),
  due_on          date not null,
  principal_paise bigint not null check (principal_paise >= 0),
  created_at      timestamptz not null default now(),
  unique (loan_id, seq)
);

create index loan_instalments_loan_idx on loan_instalments (loan_id, due_on);
create index loan_instalments_due_idx  on loan_instalments (group_id, due_on);

alter table loans
  add column if not exists repayment_plan text not null default 'monthly'
    check (repayment_plan in ('monthly', 'end_of_term'));

comment on column loans.repayment_plan is
  'monthly: equal principal instalments. end_of_term: the old balloon shape, '
  'kept because some groups genuinely lend that way for short bridging loans.';

-- ---------------------------------------------------------------------------
-- Build the schedule at disbursal.
--
-- EQUAL PRINCIPAL, not equal EMI. The instalment is principal/term, and
-- interest is charged on the reducing balance on top -- so the early payments
-- are larger. This matches how these groups actually calculate, and unlike a
-- true EMI it can be checked on paper at the meeting.
--
-- The rounding remainder goes on the FIRST instalment, not the last. If a
-- borrower stops paying partway, the group has collected more principal, not
-- less. Rounding should never favour the debtor.
-- ---------------------------------------------------------------------------
create or replace function fn_build_loan_schedule(p_loan_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_loan  loans;
  v_base  bigint;
  v_rem   bigint;
  i       int;
begin
  select * into v_loan from loans where id = p_loan_id;
  if v_loan.id is null or v_loan.disbursed_on is null then
    return;
  end if;

  delete from loan_instalments where loan_id = p_loan_id;

  if v_loan.repayment_plan = 'end_of_term' then
    insert into loan_instalments (group_id, loan_id, seq, due_on, principal_paise)
    values (v_loan.group_id, p_loan_id, 1, v_loan.due_on, v_loan.principal_paise);
    return;
  end if;

  v_base := v_loan.principal_paise / v_loan.term_months;
  v_rem  := v_loan.principal_paise - (v_base * v_loan.term_months);

  for i in 1 .. v_loan.term_months loop
    insert into loan_instalments (group_id, loan_id, seq, due_on, principal_paise)
    values (
      v_loan.group_id, p_loan_id, i,
      (v_loan.disbursed_on + make_interval(months => i))::date,
      v_base + case when i = 1 then v_rem else 0 end
    );
  end loop;
end $$;

create or replace function fn_schedule_on_disburse() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.status = 'disbursed'
     and (old.status is distinct from 'disbursed')
     and new.disbursed_on is not null then
    perform fn_build_loan_schedule(new.id);
  end if;
  return new;
end $$;

drop trigger if exists trg_schedule_on_disburse on loans;
create trigger trg_schedule_on_disburse
  after update on loans
  for each row execute function fn_schedule_on_disburse();

-- ---------------------------------------------------------------------------
-- How far behind is this loan?
--
-- Principal that should have arrived by now, minus principal that has. This
-- is the figure that was missing: it goes positive the month a payment is
-- missed, instead of waiting for the whole term to run out.
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER bypasses RLS, so these name the group explicitly rather
-- than trusting the loan id to belong to the caller's tenant.
create or replace function loan_arrears_paise(
  p_loan_id uuid,
  p_as_of date default current_date,
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(0,
    coalesce((select sum(i.principal_paise) from loan_instalments i
              where i.loan_id = p_loan_id and i.group_id = p_group_id
                and i.due_on <= p_as_of), 0)
    - coalesce((select sum(r.principal_paise) from loan_repayments r
                where r.loan_id = p_loan_id and r.group_id = p_group_id
                  and r.paid_on <= p_as_of), 0)
  )::bigint
$$;

create or replace function loan_next_due(
  p_loan_id uuid,
  p_as_of date default current_date,
  p_group_id uuid default current_group_id()
) returns date
language sql stable security definer set search_path = public, pg_temp as $$
  select min(due_on) from loan_instalments
  where loan_id = p_loan_id and group_id = p_group_id and due_on > p_as_of
$$;

create or replace function member_arrears_paise(p_member_id uuid)
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(loan_arrears_paise(l.id, current_date, l.group_id)), 0)::bigint
  from loans l
  where l.borrower_id = p_member_id
    and l.group_id = current_group_id()
    and l.status = 'disbursed'
$$;

-- ---------------------------------------------------------------------------
-- Backfill: loans already running get a schedule too.
--
-- Without this, every loan disbursed before today keeps the old balloon
-- behaviour forever and the arrears figure reads zero for exactly the loans
-- most likely to be in trouble.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select id from loans where status = 'disbursed' and disbursed_on is not null
  loop
    perform fn_build_loan_schedule(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- v_loan_status learns about arrears.
--
-- is_overdue changes meaning: it is now true when a SCHEDULED payment has been
-- missed, not only when the final due date has passed. That is the behaviour
-- the dashboard always claimed to have.
--
-- Rebuilt rather than replaced -- the new columns are not all at the end.
-- ---------------------------------------------------------------------------
drop view if exists v_loan_status;
create view v_loan_status
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
  -- Behind on the plan, or past the final date. Either one is overdue.
  (l.status = 'disbursed'
    and (loan_arrears_paise(l.id, current_date, l.group_id) > 0
         or (l.due_on is not null and current_date > l.due_on)))
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
) v on v.loan_id = l.id
where l.group_id = current_group_id() and in_current_group();

grant select on v_loan_status to authenticated;
revoke all on v_loan_status from anon;

alter table loan_instalments enable row level security;

drop policy if exists loan_instalments_read on loan_instalments;
create policy loan_instalments_read on loan_instalments
  for select to authenticated
  using (group_id = current_group_id() and in_current_group());

revoke insert, update, delete on loan_instalments from authenticated, anon;

grant execute on function loan_arrears_paise(uuid, date, uuid) to authenticated;
grant execute on function loan_next_due(uuid, date, uuid)      to authenticated;
grant execute on function member_arrears_paise(uuid)       to authenticated;
