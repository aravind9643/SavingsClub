-- 0018_critical_fixes.sql
--
-- Six critical fixes identified in audit:
--   1. open_period: missing serialisation lock on groups
--   2. record_contribution: no upper-bound sanity check on amount
--   3. record_repayment: does not auto-close a fully-repaid loan
--   4. record_repayment: accepts negative interest/penalty amounts
--   5. propose_expense: any member can auto-approve admin expenses (no role check)
--   6. cast_expense_vote: proposer can vote on their own expense
--   7. record_cash_movement: no positive-amount validation

-- ---------------------------------------------------------------------------
-- 1. open_period — add serialisation lock and allow president
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
  if current_role_of() not in ('cashier', 'accountant', 'president') then
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

-- ---------------------------------------------------------------------------
-- 2. record_contribution — sanity-cap at 10× the period amount
-- ---------------------------------------------------------------------------
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
  v_group  uuid := current_group_id();
  v_actor  uuid := fn_assert_active_member();
  v_cfg    groups;
  v_period contribution_periods;
  v_fee    bigint := 0;
  v_row    contributions;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may record contributions'
      using errcode = 'insufficient_privilege';
  end if;
  if p_amount_paise <= 0 then
    raise exception 'Amount must be positive' using errcode = 'check_violation';
  end if;

  select * into v_cfg from groups where id = v_group;
  select * into v_period from contribution_periods
  where id = p_period_id and group_id = v_group;
  if v_period.id is null then
    raise exception 'Unknown contribution period' using errcode = 'foreign_key_violation';
  end if;
  if not exists (select 1 from members
                 where id = p_member_id and group_id = v_group) then
    raise exception 'That member is not in this group' using errcode = 'check_violation';
  end if;

  -- Sanity check: no single contribution should exceed 10× the period amount.
  -- This catches fat-finger entries that would inflate the fund total.
  if p_amount_paise > v_period.amount_paise * 10 then
    raise exception 'Amount Rs.% is far above the expected Rs.% — double-check before recording',
      (p_amount_paise::numeric / 100)::text, (v_period.amount_paise::numeric / 100)::text
      using errcode = 'check_violation';
  end if;

  if p_paid_on > v_period.grace_date then
    v_fee := v_cfg.late_fee_paise;
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
            'Contribution received in cash',
            (select full_name from members where id = p_member_id),
            v_actor, now(), v_actor);
  end if;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 3 & 4. record_repayment — negative-amount guards + auto-close loan
-- ---------------------------------------------------------------------------
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
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may record a repayment'
      using errcode = 'insufficient_privilege';
  end if;

  -- Negative amounts would shrink fund totals and create phantom money.
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

  select * into v_loan from loans
  where id = p_loan_id and group_id = v_group for update;
  if v_loan.id is null then
    raise exception 'Loan not found' using errcode = 'no_data_found';
  end if;
  if v_loan.status <> 'disbursed' then
    raise exception 'Only a disbursed loan can be repaid (this one is %)', v_loan.status
      using errcode = 'check_violation';
  end if;

  v_out := loan_outstanding_principal_paise(p_loan_id);
  if p_principal_paise > v_out then
    raise exception 'Principal repayment Rs.% exceeds the outstanding Rs.%',
      (p_principal_paise::numeric / 100)::text, (v_out::numeric / 100)::text
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

  -- Auto-close: if the principal is fully repaid, mark the loan closed.
  -- Without this the loan stays 'disbursed' forever, blocks member removal,
  -- and pollutes overdue queries.
  v_remaining := loan_outstanding_principal_paise(p_loan_id);
  if v_remaining = 0 then
    update loans set status = 'closed', closed_on = p_paid_on
    where id = p_loan_id;
  end if;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 5. propose_expense — restrict auto-approved categories to officers
-- ---------------------------------------------------------------------------
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
  v_row      expenses;
begin
  select * into v_cfg from groups where id = v_group for no key update;

  if p_amount_paise <= 0 then
    raise exception 'Amount must be positive' using errcode = 'check_violation';
  end if;

  v_fund  := fn_fund_total_paise(v_group);
  v_needs := p_category not in ('bank_charge', 'admin');
  v_eligible := active_member_count(v_group);

  -- Auto-approved categories (bank_charge, admin) skip voting entirely, so
  -- only officers may propose them. Otherwise any member could record an
  -- approved expense with no vote.
  if not v_needs and current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an officer may record admin or bank-charge expenses'
      using errcode = 'insufficient_privilege';
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

-- ---------------------------------------------------------------------------
-- 6. cast_expense_vote — block self-voting (proposer cannot vote)
-- ---------------------------------------------------------------------------
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
        ((v_ytd + v_exp.amount_paise)::numeric / 100)::text,
        (v_cap::numeric / 100)::text
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

-- ---------------------------------------------------------------------------
-- 7. record_cash_movement — positive-amount validation
-- ---------------------------------------------------------------------------
create or replace function record_cash_movement(
  p_direction cash_direction_enum,
  p_amount_paise bigint,
  p_purpose text,
  p_occurred_at timestamptz default now(),
  p_counterparty text default null,
  p_report_now boolean default false
) returns cash_ledger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := fn_assert_active_member();
  v_row   cash_ledger;
begin
  if current_role_of() <> 'cashier' then
    raise exception 'Only the cashier holds the float'
      using errcode = 'insufficient_privilege';
  end if;
  if p_amount_paise <= 0 then
    raise exception 'Cash amount must be positive'
      using errcode = 'check_violation';
  end if;

  insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose,
                           counterparty, recorded_by, reported_at, reported_by)
  values (current_group_id(), p_direction, p_amount_paise, p_occurred_at, p_purpose,
          p_counterparty, v_actor,
          case when p_report_now then now() end,
          case when p_report_now then v_actor end)
  returning * into v_row;

  return v_row;
end $$;
