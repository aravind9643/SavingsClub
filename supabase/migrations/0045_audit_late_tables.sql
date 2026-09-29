-- 0045_audit_late_tables.sql
--
-- Six tables were never audited.
--
-- fn_attach_audit_triggers() is catalog-driven, but it only runs when a
-- migration calls it -- and the last call was 0012. Every table created after
-- that shipped with no trg_audit:
--
--     member_payouts        0025   money leaving the group
--     distributions         0029   share-outs, the largest movement a group makes
--     distribution_lines    0029   who got what from them
--     loan_instalments      0027   the repayment schedule
--     meetings              0030
--     meeting_attendance    0030   absent fines
--
-- AGENTS.md says the audit log is trigger-based precisely so it catches
-- writes the app never made; for these six it caught nothing at all.
-- assertions.sql check 5 would have said so on its first run after 0025.
--
-- super_admins (0043) is left out deliberately, next to profiles: it is not
-- group business, and fn_audit() needs an `id` column for audit_log.row_id
-- (NOT NULL) that super_admins does not have -- attaching the trigger would
-- make every grant of console access fail.
--
-- The function is redefined with the new exclusion and re-run, rather than
-- six hand-written CREATE TRIGGERs, so the next table added gets the same
-- treatment the moment any migration calls it (AGENTS.md rule 3).

create or replace function fn_attach_audit_triggers() returns void
language plpgsql as $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      -- audit_log: it IS the log. profiles, super_admins: personal / platform,
      -- not group business. Keep in step with assertions.sql check 5.
      and c.relname not in ('audit_log', 'profiles', 'super_admins')
  loop
    execute format('drop trigger if exists trg_audit on public.%I', r.relname);
    execute format(
      'create trigger trg_audit after insert or update or delete on public.%I
         for each row execute function fn_audit()', r.relname);
  end loop;
end $$;

select fn_attach_audit_triggers();

-- Verify rather than assume (the lesson of the 0012 backfill): fail the whole
-- migration if any business table is still unaudited.
do $$
declare
  v_missing text[];
begin
  select array_agg(c.relname order by c.relname) into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname not in ('audit_log', 'profiles', 'super_admins')
    and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'trg_audit');
  if v_missing is not null then
    raise exception 'tables still missing trg_audit: %', v_missing;
  end if;
end $$;
