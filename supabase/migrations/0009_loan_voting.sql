-- 0009_loan_voting.sql
-- The loan lifecycle RPCs. This file carries the rules that someone could gain
-- money by bypassing, so every one of them is enforced here rather than in the
-- client.
--
-- CONCURRENCY. Under READ COMMITTED, two simultaneous votes each running
-- `select count(*) from loan_votes` both see three approvals, both insert a
-- fourth, and both conclude the threshold was crossed. Two simultaneous loan
-- approvals can likewise each pass a reserve check that only one of them
-- should. Both classes are removed by taking locks in a fixed order:
--   1. app_config  FOR UPDATE  -- serializes everything that moves the fund
--   2. loans       FOR UPDATE  -- serializes votes on one loan
-- Always config first, then loan, so two sessions cannot deadlock.
--
-- VOTING RULE. The group decided: nobody votes on their own loan, whatever
-- office they hold. The agreement's written exclusion names only the Cashier
-- and Accountant, but a uniform rule is stricter and avoids arguing about
-- which reading applies. required_approvals stays 4; the eligible pool is
-- everyone active except the borrower.

-- fn_assert_active_member() lives in 0001 alongside the other identity
-- helpers, because the expense RPCs in 0008 need it too.

-- ---------------------------------------------------------------------------
-- request_loan
--
-- Validates the caps up front so a member gets an immediate, explained "no"
-- instead of a request that could never be approved.
-- ---------------------------------------------------------------------------
create or replace function request_loan(
  p_guarantor_id uuid,
  p_principal_paise bigint,
  p_term_months int,
  p_purpose text default null
) returns loans
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor    uuid := fn_assert_active_member();
  v_cfg      app_config;
  v_fund     bigint;
  v_cap      bigint;
  v_lendable bigint;
  v_out      bigint;
  v_mine     bigint;
  v_eligible int;
  v_row      loans;
begin
  -- Lock the fund first: the numbers below must not move while we validate.
  select * into v_cfg from app_config where id for update;

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
                 where id = p_guarantor_id and left_on is null) then
    raise exception 'Guarantor must be an active member'
      using errcode = 'check_violation';
  end if;

  v_fund     := fn_fund_total_paise();
  v_cap      := v_fund * v_cfg.max_loan_pct_bp / 10000;
  v_lendable := v_fund * (10000 - v_cfg.reserve_pct_bp) / 10000;
  v_out      := total_outstanding_paise();
  v_mine     := member_outstanding_paise(v_actor);

  -- Per-member cap is measured on AGGREGATE outstanding, not per loan --
  -- otherwise three loans of 29% each would slip through.
  if v_mine + p_principal_paise > v_cap then
    raise exception
      'This would take your total borrowing to Rs.% but your limit is Rs.% (30%% of the fund)',
      ((v_mine + p_principal_paise)::numeric / 100)::text, (v_cap::numeric / 100)::text
      using errcode = 'check_violation';
  end if;

  -- The 25% reserve must survive the loan.
  if v_out + p_principal_paise > v_lendable then
    raise exception
      'Only Rs.% is available to lend (25%% reserve must stay in the bank)',
      (greatest(0, v_lendable - v_out)::numeric / 100)::text
      using errcode = 'check_violation';
  end if;

  -- Everyone active except the borrower.
  select count(*)::int into v_eligible
  from members where left_on is null and id <> v_actor;

  if v_eligible < v_cfg.loan_required_approvals then
    raise exception
      'Not enough eligible voters (% available, % approvals required)',
      v_eligible, v_cfg.loan_required_approvals
      using errcode = 'check_violation';
  end if;

  insert into loans (
    borrower_id, guarantor_id, principal_paise, purpose,
    rate_bp, overdue_rate_bp, term_months, status,
    fund_total_at_request_paise, eligible_voter_count,
    required_approvals, borrower_role_at_request
  )
  values (
    v_actor, p_guarantor_id, p_principal_paise, p_purpose,
    v_cfg.loan_rate_bp, v_cfg.overdue_rate_bp, p_term_months, 'requested',
    v_fund, v_eligible, v_cfg.loan_required_approvals, role_of(v_actor)
  )
  returning * into v_row;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- cast_loan_vote
--
-- The self-approval guard and the threshold transition both live here, inside
-- one transaction holding a row lock on the loan.
-- ---------------------------------------------------------------------------
create or replace function cast_loan_vote(
  p_loan_id uuid,
  p_vote vote_enum,
  p_note text default null
) returns loans
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor     uuid := fn_assert_active_member();
  v_loan      loans;
  v_approvals int;
  v_rejections int;
  v_cfg       app_config;
  v_lendable  bigint;
  v_out       bigint;
begin
  -- Lock order: config, then loan. See the header note.
  select * into v_cfg from app_config where id for update;
  select * into v_loan from loans where id = p_loan_id for update;

  if v_loan.id is null then
    raise exception 'Loan not found' using errcode = 'no_data_found';
  end if;
  if v_loan.status <> 'requested' then
    raise exception 'This loan is already %', v_loan.status
      using errcode = 'check_violation';
  end if;

  -- The rule this whole app exists for.
  if v_actor = v_loan.borrower_id then
    raise exception 'You cannot vote on your own loan request'
      using errcode = 'insufficient_privilege';
  end if;

  insert into loan_votes (loan_id, voter_id, vote, note)
  values (p_loan_id, v_actor, p_vote, p_note)
  on conflict (loan_id, voter_id)
  do update set vote = excluded.vote, note = excluded.note, voted_at = now();

  select
    count(*) filter (where vote = 'approve'),
    count(*) filter (where vote = 'reject')
  into v_approvals, v_rejections
  from loan_votes where loan_id = p_loan_id;

  -- Approval threshold crossed: transition inside this same transaction, with
  -- the caps re-checked against the fund as it stands right now (it may have
  -- moved since the request).
  if v_approvals >= v_loan.required_approvals then
    v_lendable := fn_fund_total_paise() * (10000 - v_cfg.reserve_pct_bp) / 10000;
    v_out      := total_outstanding_paise();

    if v_out + v_loan.principal_paise > v_lendable then
      raise exception
        'The fund can no longer cover this loan: only Rs.% is lendable now',
        (greatest(0, v_lendable - v_out)::numeric / 100)::text
        using errcode = 'check_violation';
    end if;

    update loans
    set status = 'approved', decided_at = now()
    where id = p_loan_id
    returning * into v_loan;

  -- Enough rejections that the threshold can no longer be reached.
  elsif v_rejections > v_loan.eligible_voter_count - v_loan.required_approvals then
    update loans
    set status = 'rejected', decided_at = now()
    where id = p_loan_id
    returning * into v_loan;
  end if;

  return v_loan;
end $$;

-- ---------------------------------------------------------------------------
-- disburse_loan: cashier/accountant only, caps re-checked at payout time.
-- ---------------------------------------------------------------------------
create or replace function disburse_loan(
  p_loan_id uuid,
  p_disbursed_on date default current_date,
  p_method payment_method_enum default 'bank'
) returns loans
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor    uuid := fn_assert_active_member();
  v_cfg      app_config;
  v_loan     loans;
  v_lendable bigint;
  v_out      bigint;
begin
  select * into v_cfg from app_config where id for update;
  select * into v_loan from loans where id = p_loan_id for update;

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
  -- Belt and braces: the money handler must not pay out to themselves.
  if v_actor = v_loan.borrower_id then
    raise exception 'You cannot disburse your own loan -- ask the other office holder'
      using errcode = 'insufficient_privilege';
  end if;

  v_lendable := fn_fund_total_paise() * (10000 - v_cfg.reserve_pct_bp) / 10000;
  v_out      := total_outstanding_paise();
  if v_out + v_loan.principal_paise > v_lendable then
    raise exception 'Disbursing now would break the 25%% reserve'
      using errcode = 'check_violation';
  end if;

  update loans
  set status = 'disbursed',
      disbursed_on = p_disbursed_on,
      due_on = (p_disbursed_on + make_interval(months => v_loan.term_months))::date
  where id = p_loan_id
  returning * into v_loan;

  if p_method = 'cash' then
    insert into cash_ledger (direction, amount_paise, occurred_at, purpose,
                             counterparty, recorded_by, reported_at, reported_by)
    values ('out', v_loan.principal_paise, p_disbursed_on::timestamptz,
            'Loan disbursed',
            (select full_name from members where id = v_loan.borrower_id),
            v_actor, now(), v_actor);
  end if;

  return v_loan;
end $$;

-- ---------------------------------------------------------------------------
-- record_repayment
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
  v_actor uuid := fn_assert_active_member();
  v_loan  loans;
  v_out   bigint;
  v_row   loan_repayments;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may record a repayment'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_loan from loans where id = p_loan_id for update;
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

  insert into loan_repayments (loan_id, paid_on, principal_paise, interest_paise,
                               penalty_paise, method, note, recorded_by)
  values (p_loan_id, p_paid_on, p_principal_paise, p_interest_paise,
          p_penalty_paise, p_method, p_note, v_actor)
  returning * into v_row;

  if p_method = 'cash' then
    insert into cash_ledger (direction, amount_paise, occurred_at, purpose,
                             counterparty, recorded_by, reported_at, reported_by)
    values ('in', p_principal_paise + p_interest_paise + p_penalty_paise,
            p_paid_on::timestamptz, 'Loan repayment received in cash',
            (select full_name from members where id = v_loan.borrower_id),
            v_actor, now(), v_actor);
  end if;

  return v_row;
end $$;

revoke execute on function request_loan(uuid, bigint, int, text) from public, anon;
revoke execute on function cast_loan_vote(uuid, vote_enum, text) from public, anon;
revoke execute on function disburse_loan(uuid, date, payment_method_enum) from public, anon;
revoke execute on function record_repayment(uuid, bigint, bigint, bigint, date,
  payment_method_enum, text) from public, anon;

grant execute on function request_loan(uuid, bigint, int, text) to authenticated;
grant execute on function cast_loan_vote(uuid, vote_enum, text) to authenticated;
grant execute on function disburse_loan(uuid, date, payment_method_enum) to authenticated;
grant execute on function record_repayment(uuid, bigint, bigint, bigint, date,
  payment_method_enum, text) to authenticated;
