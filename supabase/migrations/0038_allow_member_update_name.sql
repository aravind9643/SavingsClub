-- 0038_allow_member_update_name.sql
-- Allow members to update their own full_name on members table.
-- Protected by RLS policy `members_update_self` (own row in active group only)
-- and constraint `length(btrim(full_name)) > 0`.

grant update (full_name) on members to authenticated;
