-- 0047_push_notifications.sql
--
-- Phone notifications: a daily digest of what each member has to do.
--
-- The work is split so the database decides WHAT and the `notify` Edge
-- Function only delivers:
--
--   push_subscriptions    one row per device that said yes; written only
--                         through the two RPCs below, readable by its owner.
--   notifications_due()   service_role only. For every active member, the
--                         items the app would show them on Home.
--
-- notifications_due() does not re-derive anything. It impersonates each
-- member in turn -- the same claims PostgREST would set -- and reads the
-- views the screens read: v_unpaid_contributions, v_reminders, v_loan_status,
-- v_expense_status. So a notification can never disagree with the screen it
-- opens. (AGENTS.md: "a bug here surfaces as a number slightly too large";
-- a second copy of the arithmetic is how that happens.)

create table if not exists push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid not null references auth.users (id) on delete cascade,
  endpoint      text not null unique,
  p256dh        text not null,
  auth_secret   text not null,
  lang          text not null default 'en' check (lang in ('en', 'te')),
  created_at    timestamptz not null default now(),
  last_sent_at  timestamptz,
  -- The push service's own origin, never a user-supplied host: the Edge
  -- Function POSTs to `endpoint`, so an arbitrary URL here would turn it
  -- into a request-forger against anything on the internet.
  check (endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com)/')
);

create index if not exists push_subscriptions_user_idx on push_subscriptions (auth_user_id);

alter table push_subscriptions enable row level security;

drop policy if exists push_subscriptions_own on push_subscriptions;
create policy push_subscriptions_own on push_subscriptions
  for select to authenticated
  using (auth_user_id = (select auth.uid()));

revoke insert, update, delete on push_subscriptions from authenticated, anon;
grant select on push_subscriptions to authenticated;
grant select, update, delete on push_subscriptions to service_role;

-- --- this device, yes ------------------------------------------------------
drop function if exists save_push_subscription(text, text, text, text);

create function save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_lang text default 'en'
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Sign in first' using errcode = 'insufficient_privilege';
  end if;
  -- A device belongs to whoever is signed in on it now: re-subscribing after
  -- someone else used the phone moves the row, it does not duplicate it.
  insert into push_subscriptions (auth_user_id, endpoint, p256dh, auth_secret, lang)
  values (v_uid, p_endpoint, p_p256dh, p_auth, coalesce(nullif(p_lang, ''), 'en'))
  on conflict (endpoint) do update
    set auth_user_id = excluded.auth_user_id,
        p256dh = excluded.p256dh,
        auth_secret = excluded.auth_secret,
        lang = excluded.lang;
exception when check_violation then
  raise exception 'This browser''s notification service is not supported'
    using errcode = 'check_violation';
end $$;

-- --- this device, no -------------------------------------------------------
drop function if exists remove_push_subscription(text);

create function remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from push_subscriptions
  where endpoint = p_endpoint and auth_user_id = (select auth.uid())
$$;

revoke all on function save_push_subscription(text, text, text, text) from public, anon;
revoke all on function remove_push_subscription(text) from public, anon;
grant execute on function save_push_subscription(text, text, text, text) to authenticated;
grant execute on function remove_push_subscription(text) to authenticated;

-- ---------------------------------------------------------------------------
-- What each member needs telling today.
-- ---------------------------------------------------------------------------
-- Structured, not sentences: the Edge Function words them in the language
-- the device asked for.
--
--   contribution_due / _overdue   amount = shortfall less claims awaiting
--                                 confirmation; due_on = grace date
--   loan_due / loan_overdue       from v_reminders
--   loan_vote / expense_vote      n = how many are waiting on this member
--   claims_to_confirm             officers only; n = claims by others
--   guarantee_behind              a loan this member vouched for is behind
--
-- A contribution is only mentioned from three days before its grace date:
-- a daily "you owe Rs.500, due in 25 days" is how people learn to swipe
-- notifications away unread.
drop function if exists notifications_due();

create function notifications_due()
returns table (
  auth_user_id uuid, group_name text, kind text,
  amount_paise bigint, due_on date, n int
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m        record;
  v_role   role_enum;
  v_claims bigint;
begin
  for m in
    select mb.id as member_id, mb.auth_user_id as uid, mb.group_id, g.name as gname
    from members mb
    join groups g on g.id = mb.group_id and g.archived_at is null
    where mb.status = 'active' and mb.left_on is null and mb.auth_user_id is not null
      and exists (select 1 from push_subscriptions ps where ps.auth_user_id = mb.auth_user_id)
  loop
    -- Become this member in this group, exactly as a request would.
    perform set_config('request.jwt.claims', json_build_object(
      'sub', m.uid, 'role', 'authenticated',
      'app_metadata', json_build_object('group_id', m.group_id))::text, true);

    select coalesce(sum(pc.amount_paise), 0) into v_claims
    from payment_claims pc
    where pc.member_id = m.member_id and pc.group_id = m.group_id and pc.status = 'pending';

    return query
      select m.uid, m.gname,
             case when bool_or(u.is_overdue) then 'contribution_overdue' else 'contribution_due' end,
             (sum(u.shortfall_paise) - v_claims)::bigint, min(u.grace_date), 1
      from v_unpaid_contributions u
      where u.member_id = m.member_id
      having sum(u.shortfall_paise) - v_claims > 0
         and (bool_or(u.is_overdue) or min(u.grace_date) <= current_date + 3);

    return query
      select m.uid, m.gname,
             case when r.kind = 'loan_overdue' then 'loan_overdue' else 'loan_due' end,
             r.amount_paise::bigint, r.due_on, 1
      from v_reminders r
      where r.member_id = m.member_id and r.kind in ('loan_overdue', 'loan_instalment_due');

    return query
      select m.uid, m.gname, 'loan_vote', null::bigint, null::date, count(*)::int
      from v_loan_status l where l.can_i_vote having count(*) > 0;

    return query
      select m.uid, m.gname, 'expense_vote', null::bigint, null::date, count(*)::int
      from v_expense_status e where e.can_i_vote having count(*) > 0;

    return query
      select m.uid, m.gname, 'guarantee_behind', sum(l.arrears_paise)::bigint, null::date, count(*)::int
      from v_loan_status l
      where l.guarantor_id = m.member_id and l.status = 'disbursed' and l.is_overdue
        and l.borrower_id is distinct from m.member_id
      having count(*) > 0;

    v_role := current_role_of();
    if v_role in ('cashier', 'accountant') then
      return query
        select m.uid, m.gname, 'claims_to_confirm', sum(pc.amount_paise)::bigint, null::date, count(*)::int
        from payment_claims pc
        where pc.group_id = m.group_id and pc.status = 'pending' and pc.member_id <> m.member_id
        having count(*) > 0;
    end if;
  end loop;

  perform set_config('request.jwt.claims', '', true);
end $$;

revoke all on function notifications_due() from public, anon, authenticated;
grant execute on function notifications_due() to service_role;

-- ---------------------------------------------------------------------------
-- push_subscriptions is personal, like profiles: not group business, and it
-- has no group_id for the audit row to belong to. Kept in step with
-- assertions.sql check 5.
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
      and c.relname not in ('audit_log', 'profiles', 'super_admins', 'push_subscriptions')
  loop
    execute format('drop trigger if exists trg_audit on public.%I', r.relname);
    execute format(
      'create trigger trg_audit after insert or update or delete on public.%I
         for each row execute function fn_audit()', r.relname);
  end loop;
end $$;

select fn_attach_audit_triggers();
drop trigger if exists trg_audit on push_subscriptions;
