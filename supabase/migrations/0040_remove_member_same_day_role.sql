-- 0040_remove_member_same_day_role.sql
--
-- A member given a job today could not be removed today.
--
-- remove_member() ends every open role with
--
--     update role_assignments set end_date = p_left_on ...
--
-- and role_assignments carries `check (end_date is null or end_date >
-- start_date)`. So when the role STARTED today and the member is removed
-- today, end_date = start_date and the check fails. The whole call rolls
-- back, and what the officer sees is
--
--     new row for relation "role_assignments" violates check constraint
--     "end_after_start"
--
-- -- a raw constraint name, in an app that took the trouble to write every
-- other error in plain words (0023).
--
-- WHEN THIS HAPPENS
--
-- On setup day, which is exactly when a group is most likely to be
-- fiddling with who does what: add someone, make them accountant, realise
-- they should not be in the group, try to remove them. Refused, with a
-- message nobody can act on.
--
-- THE FIX ALREADY EXISTS IN THIS CODEBASE
--
-- release_role() has handled this correctly since 0010: end the assignments
-- that genuinely ran for a while, and DELETE the ones that never started,
-- because a role that began and ended on the same day is not a period of
-- office -- it is a mistake being corrected, and the audit log already
-- records that it happened.
--
-- remove_member() simply never got the same treatment. This gives it that,
-- and changes nothing else: same role checks, same guards, same order.

create or replace function remove_member(
  p_member_id uuid,
  p_left_on date default current_date
) returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_owed  bigint;
  v_share bigint;
  v_row   members;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may remove a member'
      using errcode = 'insufficient_privilege';
  end if;

  if role_of(p_member_id) = 'admin' then
    raise exception 'Make someone else the admin before removing this person'
      using errcode = 'check_violation';
  end if;

  v_owed := member_outstanding_paise(p_member_id);
  if v_owed > 0 then
    raise exception 'This member still owes Rs.% - the loan must be settled first',
      fmt_rupees(v_owed) using errcode = 'check_violation';
  end if;

  if exists (select 1 from loans
             where guarantor_id = p_member_id and group_id = v_group
               and status in ('approved', 'disbursed')) then
    raise exception 'This member vouched for a running loan - someone else must take that on first'
      using errcode = 'check_violation';
  end if;

  v_share := member_share_paise(p_member_id, v_group);
  if v_share > 100 then
    raise exception 'This member is still owed about Rs.% - pay them out first',
      fmt_rupees(v_share) using errcode = 'check_violation';
  end if;

  -- Close the jobs that actually ran.
  update role_assignments set end_date = p_left_on
  where member_id = p_member_id and group_id = v_group
    and end_date is null and start_date < p_left_on;

  -- And remove the ones that never got a day. end_date = start_date breaks
  -- `end_after_start`, and a role held for zero days is not history worth
  -- keeping -- the audit log already has both the grant and this removal.
  delete from role_assignments
  where member_id = p_member_id and group_id = v_group
    and end_date is null and start_date >= p_left_on;

  update members set left_on = p_left_on, status = 'left'
  where id = p_member_id and group_id = v_group and left_on is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Member not found or already left' using errcode = 'no_data_found';
  end if;

  return v_row;
end $$;
