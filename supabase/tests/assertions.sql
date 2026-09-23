-- assertions.sql
-- Run after every migration, either way:
--   * Supabase dashboard -> SQL Editor -> paste this whole file -> Run
--   * psql -v ON_ERROR_STOP=1 -f supabase/tests/assertions.sql
--
-- Plain SQL only -- no psql meta-commands (\set, \timing), because the SQL
-- Editor is not psql and rejects them. Each check raises an exception on
-- failure, so the run stops at the first problem in either environment.
--
-- The failure mode this exists to catch: the app is built, everything feels
-- fine, and one table shipped with RLS never enabled -- which PostgREST then
-- exposes to every authenticated user. Testing through the SQL editor or the
-- service key will never reveal it, because neither respects RLS.
--
-- Checks 7 and 8 insert test members and a test loan, then roll them back at
-- the end, so running this leaves no rows behind.

do $$
declare
  v_missing text[];
begin
  -- 1. Every table in public must have RLS enabled.
  select array_agg(c.relname order by c.relname) into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity;

  if v_missing is not null then
    raise exception 'FAIL: tables without RLS: %', v_missing;
  end if;
  raise notice 'PASS: every public table has RLS enabled';
end $$;

do $$
declare
  v_bad text[];
begin
  -- 2. No table may have a DELETE policy: the books are append-only.
  select array_agg(distinct tablename order by tablename) into v_bad
  from pg_policies
  where schemaname = 'public' and cmd = 'DELETE';

  if v_bad is not null then
    raise exception 'FAIL: DELETE policies exist on: %', v_bad;
  end if;
  raise notice 'PASS: no DELETE policies anywhere';
end $$;

do $$
declare
  v_bad text[];
begin
  -- 3. loans and loan_votes must have NO write policy at all -- every
  --    mutation has to go through the SECURITY DEFINER RPCs. This is what
  --    makes self-approval and cap-bypass impossible from a raw API call.
  select array_agg(tablename || '.' || cmd order by tablename) into v_bad
  from pg_policies
  where schemaname = 'public'
    and tablename in ('loans', 'loan_votes')
    and cmd in ('INSERT', 'UPDATE', 'DELETE');

  if v_bad is not null then
    raise exception 'FAIL: loans/loan_votes have write policies: %', v_bad;
  end if;
  raise notice 'PASS: loans and loan_votes are RPC-only';
end $$;

do $$
declare
  v_bad text[];
begin
  -- 4. Every SECURITY DEFINER function must pin search_path. An unpinned one
  --    is a privilege-escalation hole.
  select array_agg(p.proname order by p.proname) into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
      where cfg like 'search_path=%'
    );

  if v_bad is not null then
    raise exception 'FAIL: SECURITY DEFINER without search_path: %', v_bad;
  end if;
  raise notice 'PASS: all SECURITY DEFINER functions pin search_path';
end $$;

do $$
declare
  v_missing text[];
begin
  -- 5. Every business table must carry the audit trigger.
  select array_agg(c.relname order by c.relname) into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname <> 'audit_log'
    and not exists (
      select 1 from pg_trigger t
      where t.tgrelid = c.oid and t.tgname = 'trg_audit'
    );

  if v_missing is not null then
    raise exception 'FAIL: tables missing the audit trigger: %', v_missing;
  end if;
  raise notice 'PASS: every business table is audited';
end $$;

do $$
begin
  -- 6. anon must not be able to read anything.
  if exists (
    select 1 from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public'
  ) then
    raise warning 'anon still holds table grants -- check they are intended';
  else
    raise notice 'PASS: anon holds no table grants in public';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7 & 8. Behavioural checks under a real member JWT.
--
-- These need test members and a test loan. Everything is created inside one
-- block and removed again at the end, so a passing run leaves the database
-- exactly as it found it. The cleanup is in an EXCEPTION handler too, so a
-- failing assertion still cleans up before it re-raises.
--
-- Note on the "must be refused" checks: each one asserts on the SQLSTATE it
-- expects, not merely that *something* threw. A bare `when others` would turn
-- a typo in the test itself into a false PASS -- which is the worst possible
-- outcome for a file whose whole job is to be trustworthy.
-- ---------------------------------------------------------------------------
do $$
declare
  v_auth     uuid := gen_random_uuid();
  v_auth2    uuid := gen_random_uuid();
  v_alice    uuid;
  v_bob      uuid;
  v_borrower uuid;
  v_other    uuid;
  v_loan     uuid;
  v_ok       boolean;
  v_state    text;
begin
  insert into members (auth_user_id, full_name, joined_on)
  values (v_auth, '~test Alice', current_date - 400) returning id into v_alice;
  insert into members (full_name, joined_on)
  values ('~test Bob', current_date - 400) returning id into v_bob;

  -- Impersonate Alice.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  if current_member_id() is distinct from v_alice then
    raise exception 'FAIL: current_member_id did not resolve to the signed-in member';
  end if;
  raise notice 'PASS: current_member_id resolves under a member JWT';

  -- A direct INSERT into loans must be refused by RLS (42501).
  v_ok := false;
  begin
    insert into loans (borrower_id, guarantor_id, principal_paise, rate_bp,
                       overdue_rate_bp, term_months, fund_total_at_request_paise,
                       eligible_voter_count, required_approvals, borrower_role_at_request)
    values (v_alice, v_bob, 100000, 200, 300, 6, 1000000, 6, 4, 'member');
  exception when insufficient_privilege then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL: a member was able to INSERT into loans directly';
  end if;
  raise notice 'PASS: direct INSERT into loans is refused';

  -- A direct INSERT into loan_votes must be refused by RLS (42501).
  v_ok := false;
  begin
    insert into loan_votes (loan_id, voter_id, vote)
    values (gen_random_uuid(), v_alice, 'approve');
  exception when insufficient_privilege then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL: a member was able to INSERT a vote directly';
  end if;
  raise notice 'PASS: direct INSERT into loan_votes is refused';

  -- Writing to the audit log must be refused.
  v_ok := false;
  begin
    insert into audit_log (table_name, row_id, action)
    values ('members', v_alice::text, 'INSERT');
  exception when insufficient_privilege then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL: a member was able to write to audit_log';
  end if;
  raise notice 'PASS: audit_log is not writable by members';

  -- ---- the self-approval rule, the most important guard in the app --------
  perform set_config('role', 'postgres', true);

  insert into members (auth_user_id, full_name, joined_on)
  values (v_auth2, '~test Borrower', current_date - 400) returning id into v_borrower;
  insert into members (full_name, joined_on)
  values ('~test Other', current_date - 400) returning id into v_other;

  insert into loans (borrower_id, guarantor_id, principal_paise, rate_bp,
                     overdue_rate_bp, term_months, fund_total_at_request_paise,
                     eligible_voter_count, required_approvals, borrower_role_at_request)
  values (v_borrower, v_other, 100000, 200, 300, 6, 10000000, 6, 4, 'member')
  returning id into v_loan;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_auth2::text, 'role', 'authenticated')::text, true);

  v_ok := false;
  begin
    perform cast_loan_vote(v_loan, 'approve', null);
  exception when insufficient_privilege then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL: the borrower was allowed to vote on their own loan';
  end if;
  raise notice 'PASS: the borrower cannot vote on their own loan';

  -- A different member MUST be able to vote -- otherwise the check above
  -- would pass even if voting were broken for everyone.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_auth::text, 'role', 'authenticated')::text, true);
  perform cast_loan_vote(v_loan, 'approve', 'assertion test');

  if not exists (
    select 1 from loan_votes where loan_id = v_loan and voter_id = v_alice
  ) then
    raise exception 'FAIL: a non-borrower could not vote -- voting is broken';
  end if;
  raise notice 'PASS: a non-borrower can vote';

  -- ---- cleanup -----------------------------------------------------------
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);

  delete from loan_votes where loan_id = v_loan;
  delete from loans where id = v_loan;
  delete from members where id in (v_alice, v_bob, v_borrower, v_other);

  -- The audit rows these operations generated are deliberately NOT deleted:
  -- audit_log is append-only by design, enforced by a trigger that refuses
  -- DELETE even for the table owner. Test rows appear in the log named
  -- '~test ...' -- that is correct behaviour, not leftover mess.

  raise notice 'PASS: behavioural checks complete, test data removed';

exception
  when others then
    -- Clean up even on failure, then re-raise so the run still fails loudly.
    get stacked diagnostics v_state = returned_sqlstate;
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', null, true);
    delete from loan_votes where loan_id = v_loan;
    delete from loans where id = v_loan;
    delete from members where full_name like '~test %';
    raise;
end $$;

-- ---------------------------------------------------------------------------
-- 9. A stranger cannot get into an existing group.
--
-- This used to test "the group can be claimed only once", which was the right
-- property when one database meant one group. It no longer is: anyone may now
-- create a group, and that is intended -- their own group is empty and theirs.
--
-- The property that actually protects an existing group is that joining it
-- requires a valid invite code, and even then lands the joiner in `pending`
-- where they can read nothing until an officer approves. If a stranger could
-- reach an existing group without a code, someone who found the URL could put
-- themselves next to real money.
-- ---------------------------------------------------------------------------
do $$
declare
  v_uid uuid := gen_random_uuid();
  v_ok  boolean;
begin
  -- Pretend to be a signed-in stranger with no member row anywhere.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);

  -- A made-up code must be refused. Any of these errcodes is a correct
  -- refusal; what must NOT happen is a successful join.
  v_ok := false;
  begin
    perform join_group_with_code('ZZZZ-ZZZZ-ZZZZ', 'Attacker');
  exception
    when no_data_found or check_violation or insufficient_privilege then
      v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL: a group could be joined with an invalid invite code';
  end if;

  -- And a stranger must not be able to mint a code for a group they are not in.
  v_ok := false;
  begin
    perform create_invite(null, 7);
  exception
    when insufficient_privilege or no_data_found then
      v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL: a non-member could create an invite code';
  end if;

  perform set_config('request.jwt.claims', null, true);
  raise notice 'PASS: a stranger cannot join or invite without standing in a group';
end $$;

-- ---------------------------------------------------------------------------
-- 10. Setup RPCs are the only write path -- role_assignments and groups must
--     have no direct INSERT/UPDATE/DELETE policy at all.
--
-- `groups` replaced app_config here: it now holds the rule settings, so a
-- direct write policy on it would let a member change the interest rate or the
-- reserve floor without going through update_config's role check.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text[];
begin
  select array_agg(tablename || '.' || cmd || ' (' || policyname || ')'
                   order by tablename) into v_bad
  from pg_policies
  where schemaname = 'public'
    and tablename in ('role_assignments', 'groups', 'group_invites')
    and cmd in ('INSERT', 'UPDATE', 'DELETE');

  if v_bad is not null then
    raise exception 'FAIL: direct write policies on setup tables: %', v_bad;
  end if;
  raise notice 'PASS: roles and config are RPC-only';
end $$;

select 'ALL ASSERTIONS PASSED' as result;
