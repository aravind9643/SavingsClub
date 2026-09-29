-- 0044_enable_realtime.sql
--
-- Live updates never worked.
--
-- FundContext subscribes to postgres_changes on ten tables so that when the
-- cashier records a payment, every other member's screen refreshes. Supabase
-- only emits changes for tables in the `supabase_realtime` publication, and no
-- migration ever added one: `pg_publication_tables` for it was empty. Every
-- subscription connected, received nothing, and raised no error -- so other
-- devices kept showing the pre-payment balance until someone reloaded.
--
-- Realtime applies RLS to postgres_changes, so a member receives events only
-- for rows their own read policy lets them see: this exposes nothing a SELECT
-- would not.
--
-- Guarded twice so it replays anywhere:
--   - vanilla Postgres (the local replay in AGENTS.md) has no such
--     publication; skip rather than fail, or the local run stops testing
--     what ships.
--   - a table already in the publication is skipped: `alter publication ...
--     add table` raises on a duplicate.

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not present - skipping (not a Supabase database)';
    return;
  end if;

  -- Exactly the tables FundContext listens to. Keep the two lists in step.
  -- loan_repayments and expense_votes were missing from both: a repayment
  -- moves the fund, and a vote changes who is still being asked to vote.
  foreach t in array array[
    'contributions', 'loans', 'loan_votes', 'loan_repayments', 'cash_ledger',
    'expenses', 'expense_votes', 'members', 'role_assignments',
    'bank_statements', 'contribution_periods', 'distributions'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
