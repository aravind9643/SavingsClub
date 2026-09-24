-- 0034_explicit_read_grants.sql
--
-- Every read policy in this app was unreachable on a clean database.
--
-- Found by replaying all 32 migrations into a plain PostgreSQL 18 instance:
-- `select * from v_fund_summary` failed with "permission denied for table
-- groups". Not a policy denial -- a GRANT denial, which is checked first.
--
-- All 21 RLS tables had a SELECT policy for `authenticated`, and not one of
-- them had a SELECT grant. The whole authorization model was sitting behind a
-- door that was never unlocked.
--
-- WHY THE LIVE APP WORKS ANYWAY
--
-- Supabase's own bootstrap runs
--     alter default privileges in schema public
--       grant all on tables to anon, authenticated;
-- before any of these migrations. Every table created here silently inherited
-- SELECT from that, so the policies were reachable and nobody noticed.
--
-- The tell was already in the code: this project revokes INSERT, UPDATE and
-- DELETE on 28 occasions and never revokes SELECT. You cannot revoke a
-- privilege that was never granted -- so the migrations were written against
-- a database that had already granted everything, without ever saying so.
--
-- WHY THAT IS WORTH FIXING EVEN THOUGH PRODUCTION IS FINE
--
-- The security model is stated in the policies. If the grant that makes those
-- policies reachable lives only in a platform default, then the model is not
-- actually written down anywhere in this repository -- and the database cannot
-- be rebuilt, tested locally, or moved off Supabase without silently losing
-- either all access or, far worse, the revokes that depend on the same
-- assumption.
--
-- This migration says out loud what was being assumed. It grants SELECT and
-- nothing else, so RLS remains the only thing deciding which ROWS are visible;
-- writes stay RPC-only, exactly as before.

do $$
declare
  r record;
begin
  -- Every RLS table in public gets an explicit read grant. Driven from the
  -- catalog rather than a hand-written list, because a list is how the next
  -- table added quietly misses out -- the same lesson 0012 learned about
  -- triggers and 0026 about constraints.
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relrowsecurity
  loop
    execute format('grant select on public.%I to authenticated', r.relname);
    -- anon gets nothing. Signing in is what makes you a member of anything.
    execute format('revoke all on public.%I from anon', r.relname);
  end loop;

  -- Views are security_invoker, so they read the caller's own privileges on
  -- the tables underneath. Granting the view without the tables would still
  -- fail, which is exactly the shape of the bug above.
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v' and c.relname like 'v\_%'
  loop
    execute format('grant select on public.%I to authenticated', r.relname);
    execute format('revoke all on public.%I from anon', r.relname);
  end loop;
end $$;

-- The write revokes are restated here so they cannot be outlived by the grant
-- loop above. Writing goes through the RPCs, and only through them.
do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      -- members is the one exception: a member may edit their own row through
      -- a column-level grant, which 0012 set up deliberately.
      and c.relname <> 'members'
  loop
    execute format('revoke insert, update, delete on public.%I from authenticated, anon',
                   r.relname);
  end loop;
end $$;
