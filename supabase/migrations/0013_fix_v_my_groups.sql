-- 0013_fix_v_my_groups.sql
-- Fix: v_my_groups must show all groups the signed-in user belongs to.
--
-- In 0012, v_my_groups was defined with (security_invoker = true).
-- But `members` has an RLS policy:
--   using (group_id = current_group_id() and in_current_group())
-- Under security_invoker = true, that RLS policy was applied to the `members`
-- table within v_my_groups, which filtered out all member rows for any group
-- other than current_group_id(). As a result, v_my_groups only ever returned
-- the currently active group, completely breaking the group switcher for
-- users belonging to multiple groups.
--
-- v_my_groups already explicitly enforces auth isolation in its WHERE clause:
--   where m.auth_user_id = (select auth.uid())
-- Setting security_invoker = false allows the view to find all memberships
-- for the caller without being suppressed by the single-tenant policy on members.

alter view v_my_groups set (security_invoker = false);
