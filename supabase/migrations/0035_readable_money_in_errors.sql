-- 0035_readable_money_in_errors.sql
--
-- Error messages were quoting amounts like "Rs.1050.0000000000000000".
--
-- Seen for real: running pay_out_member against a live database produced
--     "This member is still owed about Rs.1050.0000000000000000 - pay them
--      out first"
-- A member reads that. It is the app speaking, at the exact moment someone has
-- been told no, in the one place this codebase had already decided plain
-- language matters most (see 0023).
--
-- THE CAUSE
--
--   (v_owed::numeric / 100)::text
--
-- bigint::numeric has no scale, so dividing by 100 gives numeric with full
-- default scale, and ::text prints every trailing zero. It was written 42
-- times across the project, so it was never a slip -- it was a missing
-- helper that everyone then open-coded.
--
-- No behaviour changes: same checks, same errcodes, same order. Only the
-- rendering of the number moves. Every function below is its current live
-- definition with the formatting expression substituted programmatically,
-- never retyped.

create or replace function fmt_rupees(p_paise bigint)
returns text
language sql immutable set search_path = public, pg_temp as $$
  -- FM strips the padding; the fixed two decimals keep paise visible, because
  -- a late fee of Rs.0.50 must not print as "Rs.1" or "Rs.0".
  select to_char(p_paise / 100.0, 'FM999999999990.00')
$$;

-- A numeric overload, because sum() over bigint returns numeric.
--
-- Without it, fn_enforce_cash_float_limit() -- whose r.bal comes straight from
-- a sum() -- raised "function fmt_rupees(numeric) does not exist" INSTEAD of
-- the over-limit message it was trying to produce. The guard still stopped the
-- write, so no money was at risk, but the cashier was shown a Postgres type
-- error where the app meant to say the cash in hand had gone over the limit.
--
-- Caught by running supabase/tests/isolation.sql against a real database.
create or replace function fmt_rupees(p_paise numeric)
returns text
language sql immutable set search_path = public, pg_temp as $$
  select to_char(p_paise / 100.0, 'FM999999999990.00')
$$;

grant execute on function fmt_rupees(bigint)  to authenticated;
grant execute on function fmt_rupees(numeric) to authenticated;

create or replace function fn_enforce_cash_float_limit() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  r record;
begin
  for r in
    select cl.group_id,
           sum(case when cl.direction = 'in' then cl.amount_paise
                    else -cl.amount_paise end) as bal,
           g.cash_float_limit_paise as lim
    from cash_ledger cl join groups g on g.id = cl.group_id
    group by cl.group_id, g.cash_float_limit_paise
  loop
    if r.bal > r.lim then
      raise exception
        'Cash float would reach % but the limit is % -- deposit into the bank first',
        fmt_rupees(r.bal), fmt_rupees(r.lim)
        using errcode = 'check_violation';
    end if;
    if r.bal < 0 then
      raise exception 'Cash float cannot go negative (would be %)',
        fmt_rupees(r.bal) using errcode = 'check_violation';
    end if;
  end loop;
  return null;
end $$;

create or replace function record_contribution(
  p_period_id uuid,
  p_member_id uuid,
  p_amount_paise bigint,
  p_paid_on date default current_date,
  p_method payment_method_enum default 'bank',
  p_note text default null
) returns contributions
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group    uuid := current_group_id();
  v_actor    uuid := fn_assert_active_member();
  v_cfg      groups;
  v_period   contribution_periods;
  v_fee      bigint := 0;
  v_already  bigint;
  v_fees_yet bigint;
  v_row      contributions;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may record a payment'
      using errcode = 'insufficient_privilege';
  end if;
  if p_amount_paise <= 0 then
    raise exception 'Amount must be more than zero' using errcode = 'check_violation';
  end if;
  if p_paid_on > current_date then
    raise exception 'A payment cannot be dated in the future'
      using errcode = 'check_violation';
  end if;

  select * into v_cfg from groups where id = v_group;
  select * into v_period from contribution_periods
  where id = p_period_id and group_id = v_group;
  if v_period.id is null then
    raise exception 'Unknown month' using errcode = 'foreign_key_violation';
  end if;

  if v_period.closed_at is not null then
    raise exception 'That month is closed - record this in the current month instead'
      using errcode = 'check_violation';
  end if;

  if p_paid_on < v_period.period_month then
    raise exception 'Payment date % is before the month it is being recorded against (%)',
      p_paid_on, to_char(v_period.period_month, 'Mon YYYY')
      using errcode = 'check_violation';
  end if;

  if not exists (select 1 from members
                 where id = p_member_id and group_id = v_group) then
    raise exception 'That person is not in this group' using errcode = 'check_violation';
  end if;

  -- Lock the member's existing rows for this period so two cashiers recording
  -- the same payment cannot both see the same "already paid" figure and let
  -- the total sail past the expected amount.
  perform 1 from contributions
  where period_id = p_period_id and member_id = p_member_id
  for update;

  v_already := member_period_paid_paise(p_period_id, p_member_id, v_group);

  if v_already + p_amount_paise > v_period.amount_paise then
    raise exception 'That is more than is due. Rs.% is still owed for %',
      fmt_rupees((v_period.amount_paise - v_already)),
      to_char(v_period.period_month, 'Mon YYYY')
      using errcode = 'check_violation';
  end if;

  -- The 10x sanity ceiling from 0021 is deliberately NOT repeated here. The
  -- overpayment check above is strictly tighter -- it refuses anything over
  -- 1x the expected amount, so nothing could ever reach 10x. Keeping both
  -- would leave a branch that can never run, which reads like a guard and
  -- protects nothing.

  -- Late once is late once, however many instalments follow.
  if p_paid_on > v_period.grace_date then
    select coalesce(sum(late_fee_paise), 0) into v_fees_yet
    from contributions
    where period_id = p_period_id and member_id = p_member_id;

    if v_fees_yet = 0 then
      v_fee := v_cfg.late_fee_paise;
    end if;
  end if;

  insert into contributions (
    group_id, period_id, member_id, amount_paise, late_fee_paise,
    paid_on, method, note, recorded_by
  )
  values (v_group, p_period_id, p_member_id, p_amount_paise, v_fee,
          p_paid_on, p_method, p_note, v_actor)
  returning * into v_row;

  if p_method = 'cash' then
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose,
                             counterparty, recorded_by, reported_at, reported_by)
    values (v_group, 'in', p_amount_paise + v_fee, p_paid_on::timestamptz,
            'Payment received in cash',
            (select full_name from members where id = p_member_id),
            v_actor, now(), v_actor);
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
        fmt_rupees((v_ytd + p_amount_paise)),
        fmt_rupees(v_cap)
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

create or replace function cast_expense_vote(
  p_expense_id uuid,
  p_vote vote_enum,
  p_note text default null
) returns expenses
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group      uuid := current_group_id();
  v_actor      uuid := fn_assert_active_member();
  v_cfg        groups;
  v_exp        expenses;
  v_approvals  int;
  v_rejections int;
  v_cap        bigint;
  v_ytd        bigint;
begin
  select * into v_cfg from groups where id = v_group for no key update;
  select * into v_exp from expenses
  where id = p_expense_id and group_id = v_group for update;

  if v_exp.id is null then
    raise exception 'Expense not found' using errcode = 'no_data_found';
  end if;
  if v_exp.status <> 'proposed' then
    raise exception 'This expense is already %', v_exp.status
      using errcode = 'check_violation';
  end if;
  -- The proposer should not approve their own expense, same as loan voting.
  if v_actor = v_exp.created_by then
    raise exception 'You cannot vote on an expense you proposed'
      using errcode = 'insufficient_privilege';
  end if;

  insert into expense_votes (group_id, expense_id, voter_id, vote, note)
  values (v_group, p_expense_id, v_actor, p_vote, p_note)
  on conflict (expense_id, voter_id)
  do update set vote = excluded.vote, note = excluded.note, voted_at = now();

  select
    count(*) filter (where vote = 'approve'),
    count(*) filter (where vote = 'reject')
  into v_approvals, v_rejections
  from expense_votes where expense_id = p_expense_id and group_id = v_group;

  if v_approvals >= v_exp.required_approvals then
    v_cap := fn_fund_total_paise(v_group) * v_cfg.expense_annual_pct_bp / 10000;
    v_ytd := fn_expenses_ytd_paise(extract(year from v_exp.incurred_on)::int, v_group);

    if v_ytd + v_exp.amount_paise > v_cap then
      raise exception
        'Group expenses for % would reach Rs.% but the yearly limit is Rs.%',
        extract(year from v_exp.incurred_on)::int,
        fmt_rupees((v_ytd + v_exp.amount_paise)),
        fmt_rupees(v_cap)
        using errcode = 'check_violation';
    end if;

    update expenses set status = 'approved', decided_at = now()
    where id = p_expense_id returning * into v_exp;

  elsif v_rejections > v_exp.eligible_voter_count - v_exp.required_approvals then
    update expenses set status = 'rejected', decided_at = now()
    where id = p_expense_id returning * into v_exp;
  end if;

  return v_exp;
end $$;

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
      fmt_rupees((v_mine + p_principal_paise)),
      fmt_rupees(v_cap)
      using errcode = 'check_violation';
  end if;

  if v_out + p_principal_paise > v_lendable then
    raise exception
      'Only Rs.% is available to lend (the reserve must stay in the bank)',
      fmt_rupees(greatest(0, v_lendable - v_out))
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
        fmt_rupees(greatest(0, v_lendable - v_out))
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
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose,
                             counterparty, recorded_by, reported_at, reported_by)
    values (v_group, 'in', p_principal_paise + p_interest_paise + p_penalty_paise,
            p_paid_on::timestamptz, 'Loan repayment received in cash',
            (select full_name from members where id = v_loan.borrower_id),
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
      -- Left open deliberately. Closing here would drop the outstanding
      -- interest out of every view, because the accrual memo only walks
      -- disbursed loans -- the debt would not become overdue, it would
      -- become invisible.
      raise notice
        'Principal cleared but Rs.% interest is still owed; loan stays open',
        fmt_rupees(v_owed_int);
    end if;
  end if;

  return v_row;
end $$;

create or replace function remove_member(
  p_member_id uuid,
  p_left_on date default current_date
) returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_owed  bigint;
  v_share bigint;
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
    raise exception 'This member still owes Rs.% - the loan must be settled first',
      fmt_rupees(v_owed) using errcode = 'check_violation';
  end if;

  if exists (select 1 from loans
             where guarantor_id = p_member_id and group_id = v_group
               and status in ('approved', 'disbursed')) then
    raise exception 'This member vouched for a running loan - someone else must take that on first'
      using errcode = 'check_violation';
  end if;

  -- The new rule. Rs.1 of slack absorbs the truncating division in
  -- member_share_paise(), so a fully paid member is never blocked by a
  -- rounding remainder.
  v_share := member_share_paise(p_member_id, v_group);
  if v_share > 100 then
    raise exception 'This member is still owed about Rs.% - pay them out first',
      fmt_rupees(v_share) using errcode = 'check_violation';
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

create or replace function pay_out_member(
  p_member_id uuid,
  p_amount_paise bigint default null,
  p_kind payout_kind_enum default 'exit',
  p_paid_on date default current_date,
  p_method payment_method_enum default 'bank',
  p_note text default null
) returns member_payouts
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group  uuid := current_group_id();
  v_actor  uuid := fn_assert_active_member();
  v_amount bigint;
  v_owed   bigint;
  v_avail  bigint;
  v_name   text;
  v_row    member_payouts;
begin
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may pay a member out'
      using errcode = 'insufficient_privilege';
  end if;

  -- Lock order is groups -> everything else, as in every other money RPC.
  -- Two payouts racing could each see enough money for one of them.
  perform 1 from groups where id = v_group for no key update;

  if not exists (select 1 from members
                 where id = p_member_id and group_id = v_group) then
    raise exception 'That person is not in this group' using errcode = 'check_violation';
  end if;

  if p_paid_on > current_date then
    raise exception 'A payment cannot be dated in the future'
      using errcode = 'check_violation';
  end if;

  v_amount := coalesce(p_amount_paise, member_share_paise(p_member_id, v_group));

  if v_amount <= 0 then
    raise exception 'There is nothing to pay this member'
      using errcode = 'check_violation';
  end if;

  -- A member with a running loan is holding group money already. Paying them
  -- their savings while they owe would hand over the same rupees twice.
  v_owed := member_outstanding_paise(p_member_id);
  if v_owed > 0 then
    raise exception 'This member still owes Rs.% - the loan must be settled first',
      fmt_rupees(v_owed) using errcode = 'check_violation';
  end if;

  -- The fund cannot pay out money that is lent out. Cash on loan is an asset,
  -- not something the cashier can transfer.
  v_avail := fn_fund_total_paise(v_group) - total_outstanding_paise(v_group);
  if v_amount > v_avail then
    raise exception 'Only Rs.% is available to pay out right now - the rest is out on loan',
      fmt_rupees(greatest(0, v_avail)) using errcode = 'check_violation';
  end if;

  select full_name into v_name from members where id = p_member_id;

  insert into member_payouts (
    group_id, member_id, kind, amount_paise, paid_on, method, note, recorded_by
  )
  values (v_group, p_member_id, p_kind, v_amount, p_paid_on, p_method,
          p_note, v_actor)
  returning * into v_row;

  -- Cash leaving the tin is a cash event, exactly as a cash contribution
  -- arriving is. Skipping this would break the "every rupee is in exactly one
  -- bucket" invariant reconciliation depends on.
  if p_method = 'cash' then
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at,
                             purpose, counterparty, recorded_by,
                             reported_at, reported_by)
    values (v_group, 'out', v_amount, p_paid_on::timestamptz,
            case p_kind
              when 'exit' then 'Savings returned to member'
              when 'dividend' then 'Profit share paid'
              else 'Part payment to member'
            end,
            v_name, v_actor, now(), v_actor);
  end if;

  return v_row;
end $$;

create or replace function propose_distribution(
  p_kind distribution_kind_enum default 'profit',
  p_amount_paise bigint default null,
  p_as_of date default current_date,
  p_note text default null
) returns distributions
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_avail bigint;
  v_total bigint;
  v_base  bigint;
  v_given bigint := 0;
  v_row   distributions;
  r       record;
  v_last  uuid;
begin
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may propose a share-out'
      using errcode = 'insufficient_privilege';
  end if;

  perform 1 from groups where id = v_group for no key update;

  if p_as_of > current_date then
    raise exception 'A share-out cannot be dated in the future'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from distributions
             where group_id = v_group and status = 'proposed') then
    raise exception 'There is already a share-out waiting to be agreed'
      using errcode = 'check_violation';
  end if;

  -- Money still out on loan has to come back before the group can split up.
  if p_kind = 'final' and total_outstanding_paise(v_group) > 0 then
    raise exception 'Every loan must be settled before the group can close'
      using errcode = 'check_violation';
  end if;

  v_avail := fn_distributable_paise(p_kind, v_group);
  v_total := coalesce(p_amount_paise, v_avail);

  if v_total <= 0 then
    raise exception 'There is nothing to share out'
      using errcode = 'check_violation';
  end if;
  if v_total > v_avail then
    raise exception 'Only Rs.% can be shared out right now',
      fmt_rupees(v_avail) using errcode = 'check_violation';
  end if;

  -- The total of what everyone holds. Each member's slice is their part of it.
  select coalesce(sum(c.amount_paise + c.late_fee_paise), 0)
       + fn_opening_balance_paise(v_group)
  into v_base
  from contributions c where c.group_id = v_group;

  if v_base = 0 then
    raise exception 'Nobody has paid anything in yet'
      using errcode = 'check_violation';
  end if;

  insert into distributions (
    group_id, kind, fund_at_proposal_paise, total_paise, as_of, note, proposed_by
  )
  values (v_group, p_kind, fn_fund_total_paise(v_group), v_total, p_as_of,
          p_note, v_actor)
  returning * into v_row;

  -- Truncating division leaves a remainder of up to (members - 1) paise. It
  -- goes to the last member rather than being dropped, so the lines sum to
  -- the total exactly and the group's books close at zero.
  for r in
    select m.id,
           (coalesce((select sum(c.amount_paise + c.late_fee_paise)
                      from contributions c
                      where c.member_id = m.id and c.group_id = v_group), 0)
            + m.opening_balance_paise) as held
    from members m
    where m.group_id = v_group and m.status = 'active' and m.left_on is null
    order by m.full_name, m.id
  loop
    insert into distribution_lines (distribution_id, group_id, member_id, amount_paise)
    values (v_row.id, v_group, r.id, v_total * r.held / v_base);
    v_given := v_given + (v_total * r.held / v_base);
    v_last  := r.id;
  end loop;

  if v_last is null then
    raise exception 'There are no active members to share out to'
      using errcode = 'check_violation';
  end if;

  if v_total > v_given then
    update distribution_lines
    set amount_paise = amount_paise + (v_total - v_given)
    where distribution_id = v_row.id and member_id = v_last;
  end if;

  return v_row;
end $$;

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

  -- The group cannot recover more principal than it wrote off.
  v_lost := loan_outstanding_principal_paise(p_loan_id);
  if p_principal_paise > v_lost then
    raise exception 'Only Rs.% of this loan was written off',
      fmt_rupees(v_lost) using errcode = 'check_violation';
  end if;

  select full_name into v_name from members where id = v_loan.borrower_id;

  -- The trigger that auto-closes a settled loan only fires for 'disbursed',
  -- so a written-off loan is not closed behind our back here. The close is
  -- decided explicitly below.
  insert into loan_repayments (
    group_id, loan_id, paid_on, principal_paise, interest_paise, penalty_paise,
    method, note, recorded_by
  )
  values (v_group, p_loan_id, p_paid_on, p_principal_paise, p_interest_paise, 0,
          p_method, coalesce(p_note, 'Recovered after write-off'), v_actor)
  returning * into v_row;

  -- Reverse the loss, to the extent it came back.
  if p_principal_paise > 0 then
    insert into expenses (
      group_id, category, description, amount_paise, incurred_on, method,
      requires_vote, fund_total_at_request_paise, required_approvals,
      eligible_voter_count, created_by, status, decided_at, paid_on,
      is_loan_write_off, is_writeoff_recovery
    )
    values (
      v_group, 'other',
      'Recovered from ' || coalesce(v_name, 'a member')
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

  -- Fully recovered: the loan is closed rather than written off, and the
  -- record shows it came good in the end.
  v_back := loan_outstanding_principal_paise(p_loan_id);
  if v_back = 0 then
    update loans set status = 'closed', closed_on = p_paid_on
    where id = p_loan_id;
  end if;

  return v_row;
end $$;
