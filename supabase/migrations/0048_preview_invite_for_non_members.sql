-- 0048_preview_invite_for_non_members.sql
--
-- Nobody could join a group: "Check the code" answered "You are not a member
-- of this group" for every valid invite.
--
-- preview_invite() is, by definition, called by someone who is not a member
-- yet. It showed the member count via active_member_count(), and 0037 made
-- that aggregate refuse non-members -- correctly, for the aggregate. The
-- preview was collateral.
--
-- The fix counts inline, here, behind the invite checks. The aggregate keeps
-- its guard; the only thing an invite code reveals stays what 0012 intended:
-- the group's name and how many people are in it.

create or replace function preview_invite(p_code text)
returns table (group_name text, member_count int, valid boolean, reason text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_inv group_invites;
  v_g   groups;
begin
  select * into v_inv from group_invites
  where fn_normalize_code(code) = fn_normalize_code(p_code);

  if v_inv.code is null then
    return query select null::text, 0, false, 'That code is not recognised';
    return;
  end if;
  if v_inv.revoked_at is not null then
    return query select null::text, 0, false, 'That code has been cancelled';
    return;
  end if;
  if v_inv.expires_at < now() then
    return query select null::text, 0, false, 'That code has expired';
    return;
  end if;
  if v_inv.max_uses is not null and v_inv.use_count >= v_inv.max_uses then
    return query select null::text, 0, false, 'That code has been used up';
    return;
  end if;

  select * into v_g from groups where id = v_inv.group_id;
  return query
    select v_g.name,
           (select count(*)::int from members m
            where m.group_id = v_g.id
              and m.left_on is null and m.status = 'active'),
           true, null::text;
end $$;
