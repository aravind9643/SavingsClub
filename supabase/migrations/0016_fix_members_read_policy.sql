-- 0016_fix_members_read_policy.sql
-- Restore strict group isolation on members_read policy.
-- A signed-in user must only read members belonging to the active group,
-- preventing cross-group leakage and duplicate member entries in dropdowns.

drop policy if exists members_read on members;
create policy members_read on members for select to authenticated
  using (group_id = current_group_id() and in_current_group());
