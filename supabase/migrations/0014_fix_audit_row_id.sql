-- 0014_fix_audit_row_id.sql
-- Fix: fn_audit must handle tables whose primary key is not named 'id' (such as group_invites.code).
--
-- When an invite code is created, revoked, or updated, the audit trigger attempts to read
-- `coalesce(v_new ->> 'id', v_old ->> 'id')`. Since `group_invites` uses `code` as its primary key,
-- `v_id` was NULL, violating `audit_log.row_id NOT NULL`.
--
-- Falling back to `v_new ->> 'code'` (and general fallback to group_id/table_name) ensures all tables
-- can be audited without failing constraints.

create or replace function fn_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old   jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new   jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_id    text  := coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'code', v_old ->> 'code');
  v_group uuid  := nullif(coalesce(v_new ->> 'group_id', v_old ->> 'group_id'), '')::uuid;
  v_keys  text[];
begin
  if tg_op = 'UPDATE' then
    select array_agg(key order by key) into v_keys
    from jsonb_object_keys(v_new) as key
    where v_new -> key is distinct from v_old -> key;
    if v_keys is null then
      return new;
    end if;
  end if;

  -- `groups` itself has no group_id column; it IS the group.
  if v_group is null and tg_table_name = 'groups' then
    v_group := coalesce(v_new ->> 'id', v_old ->> 'id')::uuid;
  end if;

  -- Fallback if a table has neither `id` nor `code` as primary key
  if v_id is null then
    v_id := coalesce(v_group::text, tg_table_name);
  end if;

  insert into audit_log (
    group_id, actor_auth_id, actor_member_id, table_name, row_id,
    action, old_data, new_data, changed_keys
  )
  values (
    v_group, (select auth.uid()), current_member_id(), tg_table_name, v_id,
    tg_op, v_old, v_new, v_keys
  );

  return coalesce(new, old);
end $$;
