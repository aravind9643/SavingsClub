-- 0021_date_guards.sql
--
-- Every RPC that accepts a date accepted ANY date. A fat-fingered year puts a
-- contribution in 2027, where it silently stops counting toward this year's
-- caps, sits outside every period, and quietly distorts overdue arithmetic.
-- Nothing raises, because a date is a date.
--
-- The rule applied throughout: money moves when it moves. A ledger may record
-- the past -- an entry written up a few days late is normal bookkeeping -- but
-- it may never record the future. Backdating is additionally bounded where a
-- natural floor exists (a repayment cannot predate its disbursal).
--
-- record_repayment and propose_expense get the same treatment in 0020, where
-- they were already being rewritten.

-- ---------------------------------------------------------------------------
-- 1. record_contribution
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
  if p_paid_on > current_date then
    raise exception 'A contribution cannot be dated in the future'
      using errcode = 'check_violation';
  end if;

  select * into v_cfg from groups where id = v_group;
  select * into v_period from contribution_periods
  where id = p_period_id and group_id = v_group;
  if v_period.id is null then
    raise exception 'Unknown contribution period' using errcode = 'foreign_key_violation';
  end if;

  -- A closed period is settled history. Without this, a late entry could
  -- reopen a month the group has already reconciled and signed off.
  if v_period.closed_at is not null then
    raise exception 'That period is closed — record this in the current month instead'
      using errcode = 'check_violation';
  end if;

  -- The payment cannot predate the month it is being credited to.
  if p_paid_on < v_period.period_month then
    raise exception 'Payment date % is before the period it is being recorded against (%)',
      p_paid_on, to_char(v_period.period_month, 'Mon YYYY')
      using errcode = 'check_violation';
  end if;

  if not exists (select 1 from members
                 where id = p_member_id and group_id = v_group) then
    raise exception 'That member is not in this group' using errcode = 'check_violation';
  end if;

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
-- 2. disburse_loan
--
-- A future disbursal date is worse than untidy: due_on is derived from it, so
-- the whole overdue schedule and every interest calculation shift with it.
-- ---------------------------------------------------------------------------
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
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose,
                             counterparty, recorded_by, reported_at, reported_by)
    values (v_group, 'out', v_loan.principal_paise, p_disbursed_on::timestamptz,
            'Loan disbursed',
            (select full_name from members where id = v_loan.borrower_id),
            v_actor, now(), v_actor);
  end if;

  return v_loan;
end $$;

-- ---------------------------------------------------------------------------
-- 3. record_bank_statement
--
-- `as_of` is the key this upserts on, and the expected balance is snapshotted
-- against it. A future statement would freeze today's expectation under
-- tomorrow's date and quietly win the conflict when the real one arrives.
-- ---------------------------------------------------------------------------
create or replace function record_bank_statement(
  p_as_of date,
  p_closing_balance_paise bigint,
  p_note text default null
) returns bank_statements
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group    uuid := current_group_id();
  v_actor    uuid := fn_assert_active_member();
  v_expected bigint;
  v_row      bank_statements;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may record a bank statement'
      using errcode = 'insufficient_privilege';
  end if;
  if p_as_of > current_date then
    raise exception 'A bank statement cannot be dated in the future'
      using errcode = 'check_violation';
  end if;
  if p_closing_balance_paise < 0 then
    raise exception 'A closing balance cannot be negative'
      using errcode = 'check_violation';
  end if;

  v_expected := fn_fund_total_paise(v_group)
              - total_outstanding_paise(v_group)
              - cash_float_balance_paise(v_group);

  insert into bank_statements (group_id, as_of, closing_balance_paise,
                               expected_balance_paise, difference_paise, note, uploaded_by)
  values (v_group, p_as_of, p_closing_balance_paise, v_expected,
          p_closing_balance_paise - v_expected, p_note, v_actor)
  on conflict (group_id, as_of) do update
    set closing_balance_paise = excluded.closing_balance_paise,
        expected_balance_paise = excluded.expected_balance_paise,
        difference_paise = excluded.difference_paise,
        note = excluded.note,
        uploaded_by = excluded.uploaded_by
  returning * into v_row;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 4. mark_expense_paid
-- ---------------------------------------------------------------------------
create or replace function mark_expense_paid(
  p_expense_id uuid,
  p_paid_on date default current_date
) returns expenses
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_exp   expenses;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may mark an expense paid'
      using errcode = 'insufficient_privilege';
  end if;
  if p_paid_on > current_date then
    raise exception 'An expense cannot be dated as paid in the future'
      using errcode = 'check_violation';
  end if;

  select * into v_exp from expenses
  where id = p_expense_id and group_id = v_group for update;
  if v_exp.id is null then
    raise exception 'Expense not found' using errcode = 'no_data_found';
  end if;
  if v_exp.status <> 'approved' then
    raise exception 'Only an approved expense can be paid (this one is %)', v_exp.status
      using errcode = 'check_violation';
  end if;
  if p_paid_on < v_exp.incurred_on then
    raise exception 'Payment date % is before the expense was incurred (%)',
      p_paid_on, v_exp.incurred_on
      using errcode = 'check_violation';
  end if;

  -- expense_id links the cash row back to what it paid for; the audit trail
  -- depends on it, so it is carried through unchanged.
  if v_exp.method = 'cash' then
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose,
                             expense_id, recorded_by, reported_at, reported_by)
    values (v_group, 'out', v_exp.amount_paise, p_paid_on::timestamptz,
            v_exp.description, v_exp.id, v_actor, now(), v_actor);
  end if;

  update expenses set status = 'paid', paid_on = p_paid_on
  where id = p_expense_id returning * into v_exp;

  return v_exp;
end $$;

-- ---------------------------------------------------------------------------
-- 5. record_cash_movement
--
-- This one takes a timestamptz, and the cash-reporting deadline is measured
-- from it -- so a future timestamp would push the "report within N hours"
-- window forward and mask a late report as on-time.
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
  -- A minute of slack absorbs clock skew between the client and the server
  -- without allowing a meaningfully future entry.
  if p_occurred_at > now() + interval '1 minute' then
    raise exception 'A cash movement cannot be dated in the future'
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
