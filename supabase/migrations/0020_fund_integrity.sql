-- 0020_fund_integrity.sql
--
-- Three fund-correctness bugs. All three share a failure mode: nothing raises,
-- nothing looks broken, and the number on the screen is simply wrong.
--
--   1. write_off_loan left the written-off principal counted as an asset, so
--      reconciliation carried a permanent gap exactly equal to the loss, and
--      the group kept lending against money it had already lost.
--   2. Auto-approved expenses (admin, bank_charge) never passed through
--      cast_expense_vote(), which is the only place the yearly cap is
--      enforced -- so they bypassed it entirely.
--   3. record_repayment closed a loan when PRINCIPAL hit zero, discarding any
--      interest still owed; the accrued memo line only walks disbursed loans,
--      so that debt vanished from the books rather than showing as owed.

-- ---------------------------------------------------------------------------
-- 0. Mark loan losses so they can be told apart from spending.
--
-- A write-off has to reduce the fund, and the only mechanism that reduces the
-- fund is fn_expenses_paid_paise() -- so it is recorded as an expense row.
-- But it is a LOSS, not a purchase, and counting it against the group's
-- discretionary yearly cap would mean one defaulting borrower could freeze
-- every legitimate expense for the rest of the year.
--
-- This is a boolean column rather than a new expense_category_enum value on
-- purpose: `ALTER TYPE ... ADD VALUE` cannot be referenced by other statements
-- in the same transaction, and the Supabase CLI wraps each migration file in
-- one. A new enum label would abort this migration on the very next statement.
-- ---------------------------------------------------------------------------
alter table expenses
  add column if not exists is_loan_write_off boolean not null default false;

comment on column expenses.is_loan_write_off is
  'True for the expense row that books a written-off loan. Reduces the fund '
  'like any expense, but is excluded from the yearly discretionary cap.';

-- ---------------------------------------------------------------------------
-- 1. The yearly cap governs CHOSEN spending, so exclude write-offs from it.
-- ---------------------------------------------------------------------------
create or replace function fn_expenses_ytd_paise(
  p_year int,
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from expenses
  where group_id = p_group_id
    and status in ('approved', 'paid')
    and not is_loan_write_off
    and extract(year from incurred_on)::int = p_year
$$;

-- ---------------------------------------------------------------------------
-- 2. write_off_loan -- book the loss so the books still balance.
--
-- Before this, the reconciliation identity
--     expected_bank = fund - outstanding - float
-- broke the moment a loan was written off: `outstanding` dropped by the
-- principal (written_off is excluded from total_outstanding_paise) while
-- `fund` did not move. The result was a permanent unexplained gap of exactly
-- the written-off amount, and an inflated fund that every member's share_pct
-- and every loan cap was then computed against.
--
-- Booking an expense for the UNRECOVERED principal makes both sides fall by
-- the same amount, so the identity holds across the write-off.
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
  v_lost  bigint;
  v_name  text;
begin
  if current_role_of() not in ('cashier', 'accountant', 'president') then
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

-- ---------------------------------------------------------------------------
-- 3. propose_expense -- enforce the yearly cap on the auto-approved path too.
--
-- admin and bank_charge skip voting, and cast_expense_vote() was the ONLY
-- place the cap was checked. An officer could therefore book unlimited admin
-- expenses. 0018 fixed who may do this; it did not fix how much.
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

  if not v_needs and current_role_of() not in ('cashier', 'accountant', 'president') then
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

-- ---------------------------------------------------------------------------
-- 4. record_repayment -- do not close a loan that still owes interest.
--
-- The old auto-close fired on principal alone. Because the accrued-interest
-- memo line in v_fund_summary only walks loans with status = 'disbursed', the
-- unpaid interest did not move to some "overdue" bucket -- it stopped being
-- counted anywhere at all. The borrower's debt disappeared silently.
--
-- Now it closes only when principal AND accrued interest are both settled,
-- and says what is left when it does not.
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
        (v_owed_int::numeric / 100)::text;
    end if;
  end if;

  return v_row;
end $$;
