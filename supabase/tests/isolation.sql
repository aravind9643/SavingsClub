-- isolation.sql
-- Run after 0012_multi_group.sql, the same way as assertions.sql:
--   * Supabase dashboard -> SQL Editor -> paste this whole file -> Run
--   * psql -v ON_ERROR_STOP=1 -f supabase/tests/isolation.sql
--
-- Plain SQL only -- no psql meta-commands, because the SQL Editor rejects them.
--
-- WHAT THIS EXISTS TO CATCH
--
-- The migration made every table multi-tenant. The failure that matters is not
-- an error -- it is silence: one policy missing its group filter, or one money
-- aggregate still summing the whole table, and group A quietly sees group B's
-- money. Nothing throws. The screen just shows a number that is too big.
--
-- So this does not inspect the catalog and trust it. It creates two real
-- groups with real money in them, becomes an ordinary member of the first, and
-- reads everything the app reads. Every count must come back as group A's
-- alone.
--
-- HOW THE IMPERSONATION WORKS
--
-- set_config('request.jwt.claims') is what PostgREST does per request, and
-- `set local role authenticated` drops the superuser bypass. Without that role
-- change the policies are not consulted at all and every check below would
-- pass while proving nothing -- which is why check 0 verifies the harness
-- itself before any real assertion runs.
--
-- Everything happens inside one transaction that ends in ROLLBACK, so this
-- leaves no groups, members or money behind.

begin;

do $$
declare
  v_a         uuid;   -- group A: the one we will be a member of
  v_b         uuid;   -- group B: the one we must never see
  v_uid_a     uuid := '00000000-0000-0000-0000-0000000000aa';
  v_uid_b     uuid := '00000000-0000-0000-0000-0000000000bb';
  v_mem_a     uuid;
  v_mem_b     uuid;
  v_period_a  uuid;
  v_period_b  uuid;
  v_loan_a    uuid;
  v_loan_b    uuid;
  v_n         bigint;
  v_money     bigint;
  v_txt       text;
  v_tbl       text;
  v_leaked    text[] := '{}';
  v_checks    int := 0;
  v_tables    text[] := array[
    'members','role_assignments','contribution_periods','contributions',
    'cash_ledger','loans','loan_votes','loan_repayments','expenses',
    'expense_votes','bank_statements','audit_log'];
begin
  -- ==========================================================================
  -- SETUP. Done as the migration owner, before dropping to `authenticated`.
  -- ==========================================================================

  -- Two auth users. ON CONFLICT so a re-run after a failed run is harmless.
  insert into auth.users (id, instance_id, aud, role, email,
                          encrypted_password, email_confirmed_at,
                          created_at, updated_at)
  values
    (v_uid_a, '00000000-0000-0000-0000-000000000000', 'authenticated',
     'authenticated', 'isolation-a@example.test', '', now(), now(), now()),
    (v_uid_b, '00000000-0000-0000-0000-000000000000', 'authenticated',
     'authenticated', 'isolation-b@example.test', '', now(), now(), now())
  on conflict (id) do nothing;

  insert into groups (name, created_by, monthly_contribution_paise)
  values ('Isolation A', v_uid_a, 50000) returning id into v_a;
  insert into groups (name, created_by, monthly_contribution_paise)
  values ('Isolation B', v_uid_b, 50000) returning id into v_b;

  insert into members (group_id, auth_user_id, full_name, email, joined_on, status)
  values (v_a, v_uid_a, 'Member A', 'isolation-a@example.test', current_date, 'active')
  returning id into v_mem_a;
  insert into members (group_id, auth_user_id, full_name, email, joined_on, status)
  values (v_b, v_uid_b, 'Member B', 'isolation-b@example.test', current_date, 'active')
  returning id into v_mem_b;

  insert into role_assignments (group_id, member_id, role, start_date)
  values (v_a, v_mem_a, 'cashier', current_date),
         (v_b, v_mem_b, 'cashier', current_date);

  -- Money in both groups, and deliberately MORE in B: if any aggregate is
  -- unscoped the totals come back inflated rather than merely different, and
  -- an off-by-a-tenant bug cannot hide behind equal numbers.
  insert into contribution_periods (group_id, period_month, due_date, grace_date, amount_paise)
  values (v_a, date_trunc('month', current_date)::date, current_date, current_date, 50000)
  returning id into v_period_a;
  insert into contribution_periods (group_id, period_month, due_date, grace_date, amount_paise)
  values (v_b, date_trunc('month', current_date)::date, current_date, current_date, 50000)
  returning id into v_period_b;

  insert into contributions (group_id, period_id, member_id, amount_paise, paid_on, method)
  values (v_a, v_period_a, v_mem_a, 100000, current_date, 'bank'),
         (v_b, v_period_b, v_mem_b, 900000, current_date, 'bank');

  insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose, recorded_by)
  values (v_a, 'in', 100000, now(), 'test A', v_mem_a),
         (v_b, 'in', 900000, now(), 'test B', v_mem_b);

  insert into loans (group_id, borrower_id, guarantor_id, principal_paise,
                     rate_bp, overdue_rate_bp, term_months, status,
                     required_approvals, eligible_voter_count, borrower_role_at_request)
  values (v_a, v_mem_a, v_mem_a, 10000, 200, 300, 6, 'requested', 2, 1, 'cashier')
  returning id into v_loan_a;
  insert into loans (group_id, borrower_id, guarantor_id, principal_paise,
                     rate_bp, overdue_rate_bp, term_months, status,
                     required_approvals, eligible_voter_count, borrower_role_at_request)
  values (v_b, v_mem_b, v_mem_b, 90000, 200, 300, 6, 'requested', 2, 1, 'cashier')
  returning id into v_loan_b;

  insert into expenses (group_id, category, description, amount_paise,
                        incurred_on, method, status, created_by,
                        required_approvals, eligible_voter_count)
  values (v_a, 'trip', 'test A', 10000, current_date, 'bank', 'proposed', v_mem_a, 2, 1),
         (v_b, 'trip', 'test B', 90000, current_date, 'bank', 'proposed', v_mem_b, 2, 1);

  insert into bank_statements (group_id, as_of, closing_balance_paise, uploaded_by)
  values (v_a, current_date, 100000, v_mem_a),
         (v_b, current_date, 900000, v_mem_b);

  insert into profiles (id, last_group_id) values (v_uid_a, v_a)
  on conflict (id) do update set last_group_id = excluded.last_group_id;

  -- ==========================================================================
  -- BECOME MEMBER A. Everything from here is read as an ordinary member.
  -- ==========================================================================
  perform set_config('request.jwt.claims',
    json_build_object(
      'sub', v_uid_a::text,
      'role', 'authenticated',
      'app_metadata', json_build_object('group_id', v_a::text)
    )::text, true);
  set local role authenticated;

  -- --- 0. The harness itself ------------------------------------------------
  -- If RLS is being bypassed, every later check passes for the wrong reason.
  if (select auth.uid()) is distinct from v_uid_a then
    raise exception 'HARNESS BROKEN: auth.uid() is %, expected %',
      (select auth.uid()), v_uid_a;
  end if;
  if current_group_id() is distinct from v_a then
    raise exception 'HARNESS BROKEN: current_group_id() is %, expected %',
      current_group_id(), v_a;
  end if;
  if not in_current_group() then
    raise exception 'HARNESS BROKEN: member A is not recognised as in group A';
  end if;
  if is_member_of(v_b) then
    raise exception 'HARNESS BROKEN: member A reports membership of group B';
  end if;
  -- The positive control: group B's rows must exist and simply be invisible.
  -- Without this, a migration that inserted nothing would pass every check.
  if exists (select 1 from members where group_id = v_b) then
    raise exception 'HARNESS BROKEN: group B rows are visible, so RLS is off';
  end if;
  v_checks := v_checks + 5;

  -- --- 1. No table leaks a single row of the other group --------------------
  foreach v_tbl in array v_tables loop
    execute format(
      'select count(*) from public.%I where group_id is not distinct from %L',
      v_tbl, v_b) into v_n;
    if v_n > 0 then
      v_leaked := v_leaked || format('%s (%s rows)', v_tbl, v_n);
    end if;
    v_checks := v_checks + 1;
  end loop;

  if array_length(v_leaked, 1) > 0 then
    raise exception 'TENANT LEAK -- group B rows visible to a member of group A in: %',
      array_to_string(v_leaked, ', ');
  end if;

  -- --- 2. ...and each table does show group A's own rows --------------------
  -- Proving invisibility alone would also pass if the member could see nothing
  -- at all, which is not isolation, it is a broken app.
  select count(*) into v_n from members;
  if v_n <> 1 then
    raise exception 'Member A should see exactly 1 member (their own group), saw %', v_n;
  end if;
  select count(*) into v_n from loans;
  if v_n <> 1 then
    raise exception 'Member A should see exactly 1 loan, saw %', v_n;
  end if;
  select count(*) into v_n from contributions;
  if v_n <> 1 then
    raise exception 'Member A should see exactly 1 contribution, saw %', v_n;
  end if;
  v_checks := v_checks + 3;

  -- --- 3. The money aggregates are the real prize ---------------------------
  -- These are SECURITY DEFINER, so RLS does NOT protect them. If one lost its
  -- group filter it would sum both groups and no policy would stop it. Group A
  -- put in 100000 and group B 900000, so an unscoped sum reads 1000000 and is
  -- unmistakable.
  select fn_contributions_received_paise() into v_money;
  if v_money <> 100000 then
    raise exception 'fn_contributions_received_paise() = %, expected 100000 (group A only). Both groups sum to 1000000.', v_money;
  end if;

  select cash_float_balance_paise() into v_money;
  if v_money <> 100000 then
    raise exception 'cash_float_balance_paise() = %, expected 100000 (group A only)', v_money;
  end if;

  select active_member_count() into v_n;
  if v_n <> 1 then
    raise exception 'active_member_count() = %, expected 1 (group A only)', v_n;
  end if;

  select total_outstanding_paise() into v_money;
  if v_money <> 0 then
    raise exception 'total_outstanding_paise() = %, expected 0 (group A has no disbursed loan)', v_money;
  end if;

  -- fn_fund_total_paise() is the number the dashboard shows and the number the
  -- loan cap is checked against. Both wrong together is the worst case: the
  -- screen and the enforcement agree, so nothing looks amiss.
  select fn_fund_total_paise() into v_money;
  if v_money <> 100000 then
    raise exception 'fn_fund_total_paise() = %, expected 100000 (group A only)', v_money;
  end if;
  v_checks := v_checks + 5;

  -- --- 4. Every view is scoped too ------------------------------------------
  select count(*) into v_n from v_fund_summary;
  if v_n <> 1 then
    raise exception 'v_fund_summary returned % rows, expected exactly 1', v_n;
  end if;
  select total_fund_paise into v_money from v_fund_summary;
  if v_money <> 100000 then
    raise exception 'v_fund_summary.total_fund_paise = %, expected 100000', v_money;
  end if;

  select count(*) into v_n from v_member_positions;
  if v_n <> 1 then
    raise exception 'v_member_positions returned % rows, expected 1', v_n;
  end if;

  select count(*) into v_n from v_loan_status;
  if v_n <> 1 then
    raise exception 'v_loan_status returned % rows, expected 1', v_n;
  end if;

  select count(*) into v_n from v_expense_status;
  if v_n <> 1 then
    raise exception 'v_expense_status returned % rows, expected 1', v_n;
  end if;

  select count(*) into v_n from v_cash_alerts;
  if v_n <> 1 then
    raise exception 'v_cash_alerts returned % rows, expected 1', v_n;
  end if;

  select count(*) into v_n from v_unpaid_contributions;
  if exists (select 1 from v_unpaid_contributions where full_name = 'Member B') then
    raise exception 'v_unpaid_contributions shows a member of group B';
  end if;

  -- v_my_groups is the switcher. It must show A and NOT B.
  select count(*) into v_n from v_my_groups;
  if v_n <> 1 then
    raise exception 'v_my_groups returned % rows, expected 1 (only group A)', v_n;
  end if;
  select name into v_txt from v_my_groups;
  if v_txt <> 'Isolation A' then
    raise exception 'v_my_groups shows %, expected Isolation A', v_txt;
  end if;
  v_checks := v_checks + 9;

  -- --- 5. Writes cannot cross the boundary ----------------------------------
  -- Reading is only half of it. A vote filed against another group's loan
  -- would count toward THAT group's approval threshold.
  begin
    perform cast_loan_vote(v_loan_b, 'approve', null);
    raise exception 'WRITE LEAK: voted on a loan belonging to group B';
  exception
    when insufficient_privilege or no_data_found or check_violation then
      null;  -- refused, as it must be
  end;

  begin
    perform approve_pending_member(v_mem_b);
    raise exception 'WRITE LEAK: approved a member of group B';
  exception
    when insufficient_privilege or no_data_found or check_violation then
      null;
  end;

  -- set_active_group() is the one function that takes a group id from the
  -- client, so it is the obvious way in. It must refuse a group you are not in.
  begin
    perform set_active_group(v_b);
    raise exception 'WRITE LEAK: switched into group B without being a member';
  exception
    when insufficient_privilege then
      null;
  end;

  -- Direct table writes: loans and loan_votes have no write policies at all,
  -- which is what makes self-approval impossible from a raw PostgREST call.
  begin
    insert into loans (group_id, borrower_id, guarantor_id, principal_paise,
                       rate_bp, overdue_rate_bp, term_months, status,
                       required_approvals, eligible_voter_count,
                       borrower_role_at_request)
    values (v_b, v_mem_b, v_mem_b, 1, 200, 300, 6, 'approved', 0, 0, 'member');
    raise exception 'WRITE LEAK: inserted a loan directly into group B';
  exception
    when insufficient_privilege then
      null;
  end;
  v_checks := v_checks + 4;

  -- --- 6. A pending member sees nothing -------------------------------------
  -- Approval is what grants sight. Until then a join must expose no money,
  -- which is the whole reason the code alone is not enough to get in.
  reset role;
  update members set status = 'pending' where id = v_mem_a;
  set local role authenticated;

  if in_current_group() then
    raise exception 'A pending member is treated as being in the group';
  end if;

  select count(*) into v_n from members;
  if v_n <> 0 then
    raise exception 'A pending member can see % member rows, expected 0', v_n;
  end if;

  select count(*) into v_n from contributions;
  if v_n <> 0 then
    raise exception 'A pending member can see % contributions, expected 0', v_n;
  end if;

  select count(*) into v_n from v_fund_summary;
  if v_n <> 0 then
    raise exception 'A pending member can see the fund summary';
  end if;

  -- ...but v_my_groups must still list it, or the "waiting for approval"
  -- screen has no group to name.
  select count(*) into v_n from v_my_groups;
  if v_n <> 1 then
    raise exception 'v_my_groups should still show the pending group, saw % rows', v_n;
  end if;
  v_checks := v_checks + 5;

  reset role;
  raise notice 'ISOLATION: all % checks passed -- no tenant leak found', v_checks;
end $$;

-- Nothing above is kept: this test creates two whole groups.
rollback;
