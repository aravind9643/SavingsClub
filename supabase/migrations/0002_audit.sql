-- 0002_audit.sql
-- Append-only audit log, populated by triggers.
--
-- Why triggers rather than application code: the app is not the only writer.
-- RPCs, the Supabase SQL editor, a future cron job and a panicked manual fix
-- all mutate data. A trigger catches every one of them; app-level logging
-- catches only the paths someone remembered to instrument -- and the paths you
-- did not expect are exactly the ones an audit log exists to reveal.

create table audit_log (
  id              bigserial primary key,
  occurred_at     timestamptz not null default now(),
  actor_auth_id   uuid,
  actor_member_id uuid references members (id),
  table_name      text not null,
  row_id          text not null,          -- text: works for uuid and bigserial pks alike
  action          text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_data        jsonb,
  new_data        jsonb,
  changed_keys    text[],
  txid            bigint not null default txid_current()
);

create index audit_log_row_idx      on audit_log (table_name, row_id);
create index audit_log_time_idx     on audit_log (occurred_at desc);
create index audit_log_actor_idx    on audit_log (actor_member_id);

-- ---------------------------------------------------------------------------
-- The trigger function.
--
-- SECURITY DEFINER so it can write to a table that has no INSERT policy for
-- anyone. actor_auth_id is null when the write came from the SQL editor or a
-- service-role job -- that is honest and is precisely the event most worth
-- surfacing in the UI.
-- ---------------------------------------------------------------------------
create or replace function fn_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old  jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new  jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_id   text  := coalesce(v_new ->> 'id', v_old ->> 'id');
  v_keys text[];
begin
  if tg_op = 'UPDATE' then
    select array_agg(key order by key) into v_keys
    from jsonb_object_keys(v_new) as key
    where v_new -> key is distinct from v_old -> key;

    -- A no-op UPDATE should not create audit noise.
    if v_keys is null then
      return new;
    end if;
  end if;

  insert into audit_log (
    actor_auth_id, actor_member_id, table_name, row_id,
    action, old_data, new_data, changed_keys
  )
  values (
    (select auth.uid()), current_member_id(), tg_table_name, v_id,
    tg_op, v_old, v_new, v_keys
  );

  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------------------
-- Attach the trigger to every business table.
--
-- Driven by a catalog query rather than a hand-written list so that a table
-- added later cannot silently escape auditing -- rerunning this block picks it
-- up. `audit_log` itself is excluded (auditing the audit would recurse).
-- ---------------------------------------------------------------------------
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
      and c.relname not in ('audit_log')
  loop
    execute format('drop trigger if exists trg_audit on public.%I', r.relname);
    execute format(
      'create trigger trg_audit after insert or update or delete on public.%I
         for each row execute function fn_audit()', r.relname);
  end loop;
end $$;

select fn_attach_audit_triggers();

-- ---------------------------------------------------------------------------
-- Make the log genuinely append-only.
-- ---------------------------------------------------------------------------
create or replace function fn_audit_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end $$;

create trigger trg_audit_immutable
  before update or delete on audit_log
  for each row execute function fn_audit_immutable();

alter table audit_log enable row level security;

-- Everyone in the group can read the log. That visibility is the control.
create policy audit_read on audit_log
  for select to authenticated
  using (is_group_member());

-- Deliberately no INSERT/UPDATE/DELETE policy: only fn_audit writes here.
revoke insert, update, delete on audit_log from authenticated, anon;
revoke all on sequence audit_log_id_seq from authenticated, anon;
