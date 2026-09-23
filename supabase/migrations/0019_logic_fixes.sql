-- 0019_logic_fixes.sql
--
-- Logic and integrity improvements:
--   1. close_period: block closing future/current months
--   2. cancel_loan_request: borrower can withdraw a pending request
--   3. write_off_loan: officer can write off an uncollectable loan
--   4. cancel_expense: proposer or officer can cancel a proposed expense
--   5. update_config: field range validation

-- ---------------------------------------------------------------------------
-- 1. close_period — prevent closing a month that hasn't ended
-- ---------------------------------------------------------------------------
create or replace function close_period(p_period_id uuid)
returns contribution_periods
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row contribution_periods;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may close a period'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from contribution_periods
  where id = p_period_id and group_id = current_group_id() and closed_at is null;

  if v_row.id is null then
    raise exception 'Period not found or already closed' using errcode = 'check_violation';
  end if;

  -- Don't close a month that hasn't ended yet. The grace date is the last day
  -- contributions are expected; closing before it cuts off members who haven't
  -- paid and are still within their window.
  if current_date <= v_row.grace_date then
    raise exception 'Cannot close this period yet — the grace date (%) has not passed',
      v_row.grace_date using errcode = 'check_violation';
  end if;

  update contribution_periods set closed_at = now()
  where id = p_period_id and group_id = current_group_id()
  returning * into v_row;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 2. cancel_loan_request — borrower can withdraw before the vote concludes
-- ---------------------------------------------------------------------------
create or replace function cancel_loan_request(p_loan_id uuid)
returns loans
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_loan  loans;
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

  -- Only the borrower or an officer may cancel.
  if v_actor <> v_loan.borrower_id
     and current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only the borrower or an officer may cancel a loan request'
      using errcode = 'insufficient_privilege';
  end if;

  update loans set status = 'rejected', decided_at = now()
  where id = p_loan_id returning * into v_loan;

  return v_loan;
end $$;

-- ---------------------------------------------------------------------------
-- 3. write_off_loan — for loans that will never be repaid
-- ---------------------------------------------------------------------------
create or replace function write_off_loan(
  p_loan_id uuid,
  p_reason text default null
) returns loans
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_loan  loans;
begin
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an officer may write off a loan'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_loan from loans
  where id = p_loan_id and group_id = v_group for update;

  if v_loan.id is null then
    raise exception 'Loan not found' using errcode = 'no_data_found';
  end if;
  if v_loan.status <> 'disbursed' then
    raise exception 'Only a disbursed loan can be written off (this one is %)', v_loan.status
      using errcode = 'check_violation';
  end if;

  update loans
  set status = 'written_off',
      closed_on = current_date,
      purpose = case when p_reason is not null
                     then coalesce(purpose || ' | ', '') || 'Written off: ' || p_reason
                     else purpose end
  where id = p_loan_id returning * into v_loan;

  return v_loan;
end $$;

-- ---------------------------------------------------------------------------
-- 4. cancel_expense — withdraw a proposed expense before it's approved
-- ---------------------------------------------------------------------------
create or replace function cancel_expense(p_expense_id uuid)
returns expenses
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_exp   expenses;
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

  -- Only the proposer or an officer may cancel.
  if v_actor <> v_exp.created_by
     and current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only the proposer or an officer may cancel an expense'
      using errcode = 'insufficient_privilege';
  end if;

  update expenses set status = 'rejected', decided_at = now()
  where id = p_expense_id returning * into v_exp;

  return v_exp;
end $$;

-- ---------------------------------------------------------------------------
-- 5. update_config — input validation on dangerous fields
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
) returns groups
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row groups;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may change the group rules'
      using errcode = 'insufficient_privilege';
  end if;

  -- Validate ranges that the DB constraints don't catch (or catch too late).
  if p_monthly_contribution_paise is not null and p_monthly_contribution_paise <= 0 then
    raise exception 'Monthly contribution must be positive'
      using errcode = 'check_violation';
  end if;
  if p_due_day is not null and p_due_day not between 1 and 28 then
    raise exception 'Due day must be between 1 and 28'
      using errcode = 'check_violation';
  end if;
  if p_grace_day is not null and p_grace_day not between 1 and 28 then
    raise exception 'Grace day must be between 1 and 28'
      using errcode = 'check_violation';
  end if;
  if p_late_fee_paise is not null and p_late_fee_paise < 0 then
    raise exception 'Late fee cannot be negative'
      using errcode = 'check_violation';
  end if;
  if p_loan_rate_bp is not null and p_loan_rate_bp < 0 then
    raise exception 'Loan interest rate cannot be negative'
      using errcode = 'check_violation';
  end if;
  if p_overdue_rate_bp is not null and p_overdue_rate_bp < 0 then
    raise exception 'Overdue interest rate cannot be negative'
      using errcode = 'check_violation';
  end if;
  if p_max_loan_months is not null and p_max_loan_months < 1 then
    raise exception 'Maximum loan term must be at least 1 month'
      using errcode = 'check_violation';
  end if;
  if p_cash_report_hours is not null and p_cash_report_hours < 1 then
    raise exception 'Cash report window must be at least 1 hour'
      using errcode = 'check_violation';
  end if;
  if p_cash_float_limit_paise is not null and p_cash_float_limit_paise < 0 then
    raise exception 'Cash float limit cannot be negative'
      using errcode = 'check_violation';
  end if;
  if p_loan_required_approvals is not null and p_loan_required_approvals < 0 then
    raise exception 'Loan approvals cannot be negative'
      using errcode = 'check_violation';
  end if;
  if p_expense_required_approvals is not null and p_expense_required_approvals < 0 then
    raise exception 'Expense approvals cannot be negative'
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

-- ---------------------------------------------------------------------------
-- 6. Grant execute on the new RPCs
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
  fns text[] := array[
    'cancel_loan_request(uuid)',
    'write_off_loan(uuid,text)',
    'cancel_expense(uuid)'
  ];
begin
  foreach fn in array fns loop
    execute format('revoke execute on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;
