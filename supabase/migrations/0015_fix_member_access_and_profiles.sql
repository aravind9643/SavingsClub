-- 0015_fix_member_access_and_profiles.sql
-- Fix: Prevent infinite loading on join/login by ensuring active group resolution
-- and self-member read permissions.
--
-- 1. A signed-in user must always be able to read their own member row
--    (auth_user_id = auth.uid()), even before current_group_id() has synced.
-- 2. current_group_id() must fall back to the user's active membership if
--    profiles.last_group_id is not yet set.
-- 3. join_group_with_code() must record the joined group in profiles so
--    subsequent queries know the active tenant.

-- 1. Update members_read policy so a user can always inspect their own profile.
drop policy if exists members_read on members;
create policy members_read on members for select to authenticated
  using (
    auth_user_id = (select auth.uid())
    or (group_id = current_group_id() and in_current_group())
  );

-- 2. Update current_group_id() to fall back to the user's active membership.
create or replace function current_group_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    nullif(((select auth.jwt()) -> 'app_metadata' ->> 'group_id'), '')::uuid,
    (select p.last_group_id from profiles p where p.id = (select auth.uid())),
    (select m.group_id from members m
     where m.auth_user_id = (select auth.uid())
       and m.left_on is null
       and m.status = 'active'
     order by m.joined_on desc
     limit 1)
  )
$$;

-- 3. In join_group_with_code(), record the joined group in profiles.
create or replace function join_group_with_code(
  p_code text,
  p_full_name text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := (select auth.uid());
  v_email text;
  v_inv   group_invites;
  v_member uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in' using errcode = 'insufficient_privilege';
  end if;

  select * into v_inv from group_invites
  where fn_normalize_code(code) = fn_normalize_code(p_code)
  for update;

  if v_inv.code is null then
    raise exception 'That code is not recognised' using errcode = 'no_data_found';
  end if;
  if v_inv.revoked_at is not null or v_inv.expires_at < now() then
    raise exception 'That code is no longer valid' using errcode = 'check_violation';
  end if;
  if v_inv.max_uses is not null and v_inv.use_count >= v_inv.max_uses then
    raise exception 'That code has been used up' using errcode = 'check_violation';
  end if;

  if exists (select 1 from members
             where group_id = v_inv.group_id and auth_user_id = v_uid) then
    raise exception 'You are already in that group' using errcode = 'unique_violation';
  end if;

  select email into v_email from auth.users where id = v_uid;

  -- An officer may have added this person by email already; adopt that row
  -- rather than creating a second one for the same person.
  select id into v_member from members
  where group_id = v_inv.group_id
    and email is not null and lower(email) = lower(v_email)
    and auth_user_id is null
    and left_on is null;

  if v_member is not null then
    update members
    set auth_user_id = v_uid,
        full_name = coalesce(nullif(btrim(p_full_name), ''), full_name),
        status = 'pending'
    where id = v_member;
  else
    insert into members (group_id, auth_user_id, full_name, email, joined_on, status)
    values (v_inv.group_id, v_uid, btrim(p_full_name), lower(v_email),
            current_date, 'pending')
    returning id into v_member;
  end if;

  update group_invites set use_count = use_count + 1 where code = v_inv.code;

  -- Record this group in profiles so current_group_id() immediately resolves to it
  insert into profiles (id, last_group_id)
  values (v_uid, v_inv.group_id)
  on conflict (id) do update set last_group_id = excluded.last_group_id;

  return v_inv.group_id;
end $$;
