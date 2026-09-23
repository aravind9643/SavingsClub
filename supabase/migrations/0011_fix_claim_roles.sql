-- 0011_fix_claim_roles.sql
--
-- Fixes a bug in claim_group(): it granted the founder cashier, accountant AND
-- president, which fn_check_cashier_ne_accountant() rejects. Signing up as the
-- first member failed with
--   "Cashier and Accountant must be different people (overlapping assignment)".
--
-- The mistaken assumption was that DEFERRABLE let one person hold both offices
-- transiently. It does not: deferring moves the check to commit time, it never
-- permits the end state.
--
-- The founder now becomes PRESIDENT only. That office carries everything setup
-- needs -- add members, assign roles, edit the rules -- while money operations
-- still require cashier or accountant. That is the separation the whole group
-- agreement rests on, so the fix is also the more correct design.
--
-- 0010 is rewritten to match, so a fresh database gets this behaviour directly;
-- this migration exists for databases where 0010 already ran.

create or replace function claim_group(
  p_group_name text,
  p_full_name text,
  p_phone text default null
) returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := (select auth.uid());
  v_email text;
  v_cfg   app_config;
  v_row   members;
begin
  if v_uid is null then
    raise exception 'You must be signed in to set up the group'
      using errcode = 'insufficient_privilege';
  end if;

  -- Lock first, check second: this is what makes two simultaneous claims safe.
  select * into v_cfg from app_config where id for update;

  if v_cfg.claimed_at is not null then
    raise exception 'This group has already been set up'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from members) then
    raise exception 'This group already has members'
      using errcode = 'insufficient_privilege';
  end if;

  select email into v_email from auth.users where id = v_uid;

  insert into members (auth_user_id, full_name, phone, email, joined_on)
  values (v_uid, p_full_name, p_phone, lower(v_email), current_date)
  returning * into v_row;

  -- President only -- see the note at the top of this file.
  insert into role_assignments (member_id, role, start_date)
  values (v_row.id, 'president', current_date);

  update app_config
  set group_name = coalesce(nullif(btrim(p_group_name), ''), group_name),
      claimed_at = now()
  where id;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- A failed claim leaves auth.users with an account but members empty, and
-- app_config.claimed_at still null -- so the next attempt works. Nothing to
-- clean up. But if a half-finished claim DID leave a member row without
-- claimed_at being set, the group would be stuck: members exist, so claim is
-- refused, yet nobody is linked. Repair that case here.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from members)
     and (select claimed_at from app_config where id) is null then
    update app_config set claimed_at = now() where id;
    raise notice 'Repaired: group had members but was not marked claimed';
  end if;
end $$;
