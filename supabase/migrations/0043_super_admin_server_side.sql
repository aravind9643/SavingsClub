-- 0043_super_admin_server_side.sql
--
-- The developer console used to run in the browser with the service_role key.
-- That key was read from a VITE_ env var -- which Vite inlines into the public
-- bundle -- or pasted into localStorage, and the only gate in front of it was
-- a PIN compared in client-side JavaScript (default '1996'). Anyone who opened
-- devtools on a deployed build could read or rewrite every group's ledger.
--
-- The console now calls the `superadmin` Edge Function, which holds the key
-- server-side and decides who may use it. This migration supplies the two
-- things that function needs from the database.

-- ---------------------------------------------------------------------------
-- 1. Who is a super admin
-- ---------------------------------------------------------------------------
-- An allowlist of auth users. RLS on and NO policies, and no grant to anon or
-- authenticated: only the service role (inside the Edge Function) can read it,
-- so a signed-in user can neither list the super admins nor add themselves.
create table if not exists super_admins (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  note         text,
  added_at     timestamptz not null default now()
);

alter table super_admins enable row level security;
revoke all on super_admins from public, anon, authenticated;
grant select, insert, delete on super_admins to service_role;

-- To grant access (SQL Editor, once per person):
--   insert into super_admins (auth_user_id, note)
--   select id, 'developer' from auth.users where email = '<your login email>';

-- ---------------------------------------------------------------------------
-- 2. Changing a member's office in one transaction
-- ---------------------------------------------------------------------------
-- The console did this as three separate REST calls -- end the office's
-- current holder, end the member's own roles, insert the new one -- and
-- checked the error of only the last. A failure part-way left the group with
-- the office empty; assigning "member" to the admin left it with no admin at
-- all, which release_role() and remove_member() both refuse for good reason.
--
-- It also set end_date = today on roles that started today, which breaks
-- `end_after_start` (see 0040): a role held for zero days is deleted, not
-- ended.
--
-- p_on is passed by the caller because the console builds it from the
-- operator's LOCAL calendar date; the server's current_date is UTC and is a
-- day behind in India between 00:00 and 05:29.
drop function if exists admin_assign_role(uuid, uuid, role_enum, date);

create function admin_assign_role(
  p_group_id  uuid,
  p_member_id uuid,
  p_role      role_enum,
  p_on        date
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cfg     groups;
  v_current role_enum;
begin
  -- Lock order is groups first, always (see AGENTS.md "Concurrency").
  select * into v_cfg from groups where id = p_group_id for no key update;
  if not found then
    raise exception 'Group not found' using errcode = 'no_data_found';
  end if;

  if p_on is null or p_on > current_date + 1 then
    raise exception 'A role cannot start in the future' using errcode = 'check_violation';
  end if;

  if not exists (select 1 from members
                 where id = p_member_id and group_id = p_group_id and status = 'active') then
    raise exception 'That person is not an active member of this group'
      using errcode = 'check_violation';
  end if;

  -- One admin per group (exclusion constraint), so if this member holds it
  -- and is being moved off it, nobody else does.
  if p_role <> 'admin' and exists (
    select 1 from role_assignments
    where group_id = p_group_id and member_id = p_member_id
      and role = 'admin' and end_date is null
  ) then
    raise exception 'Make someone else the admin first - a group cannot be left without one'
      using errcode = 'check_violation';
  end if;

  select role into v_current from role_assignments
  where group_id = p_group_id and member_id = p_member_id and end_date is null
  order by start_date desc, id desc limit 1;

  -- Already so: nothing to change, and no churn in the audit log.
  if (p_role = 'member' and v_current is null)
     or (v_current = p_role and (select count(*) from role_assignments
                                 where group_id = p_group_id and member_id = p_member_id
                                   and end_date is null) = 1) then
    return;
  end if;

  -- Free the office from whoever holds it now...
  if p_role <> 'member' then
    update role_assignments set end_date = p_on
    where group_id = p_group_id and role = p_role
      and end_date is null and start_date < p_on;
    delete from role_assignments
    where group_id = p_group_id and role = p_role
      and end_date is null and start_date >= p_on;
  end if;

  -- ...and this member from whatever they held.
  update role_assignments set end_date = p_on
  where group_id = p_group_id and member_id = p_member_id
    and end_date is null and start_date < p_on;
  delete from role_assignments
  where group_id = p_group_id and member_id = p_member_id
    and end_date is null and start_date >= p_on;

  if p_role <> 'member' then
    insert into role_assignments (group_id, member_id, role, start_date)
    values (p_group_id, p_member_id, p_role, p_on);
  end if;
end $$;

revoke all on function admin_assign_role(uuid, uuid, role_enum, date) from public, anon, authenticated;
grant execute on function admin_assign_role(uuid, uuid, role_enum, date) to service_role;
