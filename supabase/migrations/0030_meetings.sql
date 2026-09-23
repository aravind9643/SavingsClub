-- 0030_meetings.sql
--
-- The group met every month and the app had no idea.
--
-- "fine" appeared 44 times in this codebase and every one of them was a late
-- fee on a payment. Real groups also fine members for MISSING THE MEETING --
-- and the meeting is where decisions get made. Loan voting here is
-- asynchronous with no notion of quorum, only required_approvals, so a group
-- whose written rules say "decided in the monthly meeting" had no way to
-- record that it met, who came, or that the decision was taken there.
--
-- WHAT THIS IS NOT
--
-- It is not a second approval mechanism. Loan voting stays exactly as it is --
-- adding a quorum gate to an existing, working, well-tested vote path would
-- risk the one flow that most needs to stay predictable. A meeting can be
-- linked to the decisions taken at it, but it never blocks them.
--
-- The value here is the record: who attended, who was fined for not, and what
-- was resolved. That is what the register in the group's cupboard holds, and
-- it is the reason many groups still keep the cupboard.

create table meetings (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references groups (id),
  held_on      date not null,
  note         text,
  -- Charged to each member marked absent without leave, at the time
  -- attendance is recorded. Snapshotted per meeting so a later change to the
  -- group's rules never restates an old meeting's fines.
  absent_fee_paise bigint not null default 0 check (absent_fee_paise >= 0),
  recorded_by  uuid not null references members (id),
  created_at   timestamptz not null default now(),
  unique (group_id, held_on)
);

create index meetings_group_idx on meetings (group_id, held_on desc);

create type attendance_enum as enum ('present', 'absent', 'excused');

create table meeting_attendance (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references meetings (id) on delete cascade,
  group_id    uuid not null references groups (id),
  member_id   uuid not null references members (id),
  status      attendance_enum not null,
  fee_paise   bigint not null default 0 check (fee_paise >= 0),
  unique (meeting_id, member_id)
);

create index meeting_attendance_meeting_idx on meeting_attendance (meeting_id);
create index meeting_attendance_member_idx  on meeting_attendance (member_id);

alter table groups
  add column if not exists meeting_absent_fee_paise bigint not null default 0
    check (meeting_absent_fee_paise >= 0);

comment on column groups.meeting_absent_fee_paise is
  'What a member is fined for missing a meeting without excuse. Zero means '
  'the group does not fine for absence, which is the default.';

-- Fines owed for absence. A receivable, like accrued interest -- recorded so
-- it can be chased, deliberately NOT added to the fund until it is actually
-- collected, for the same reason interest is counted on receipt.
create or replace function member_meeting_fines_paise(p_member_id uuid)
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(fee_paise), 0)::bigint
  from meeting_attendance
  where member_id = p_member_id and group_id = current_group_id()
$$;

-- ---------------------------------------------------------------------------
-- record_meeting: the meeting happened, and this is who was there.
--
-- Attendance comes in with the meeting rather than as a second step, because
-- a meeting row with nobody marked is a record of nothing.
-- ---------------------------------------------------------------------------
create or replace function record_meeting(
  p_held_on date,
  p_attendance jsonb,
  p_note text default null
) returns meetings
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_cfg   groups;
  v_row   meetings;
  r       record;
  v_st    attendance_enum;
  v_fee   bigint;
begin
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may record a meeting'
      using errcode = 'insufficient_privilege';
  end if;

  if p_held_on > current_date then
    raise exception 'A meeting cannot be dated in the future'
      using errcode = 'check_violation';
  end if;

  select * into v_cfg from groups where id = v_group;

  insert into meetings (group_id, held_on, note, absent_fee_paise, recorded_by)
  values (v_group, p_held_on, p_note, v_cfg.meeting_absent_fee_paise, v_actor)
  on conflict (group_id, held_on) do update
    set note = coalesce(excluded.note, meetings.note)
  returning * into v_row;

  for r in
    select (e.key)::uuid as member_id, (e.value)::text as status
    from jsonb_each_text(p_attendance) e
  loop
    if not exists (select 1 from members
                   where id = r.member_id and group_id = v_group) then
      raise exception 'That person is not in this group' using errcode = 'check_violation';
    end if;

    v_st := r.status::attendance_enum;
    -- Only an unexcused absence is fined. "Excused" exists precisely so the
    -- group can record that it chose not to fine someone, rather than that
    -- choice living only in somebody's memory.
    v_fee := case when v_st = 'absent' then v_row.absent_fee_paise else 0 end;

    insert into meeting_attendance (meeting_id, group_id, member_id, status, fee_paise)
    values (v_row.id, v_group, r.member_id, v_st, v_fee)
    on conflict (meeting_id, member_id) do update
      set status = excluded.status, fee_paise = excluded.fee_paise;
  end loop;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- Who came, and how often.
-- ---------------------------------------------------------------------------
create or replace view v_meeting_attendance
with (security_invoker = true) as
select
  ma.id,
  ma.meeting_id,
  ma.group_id,
  ma.member_id,
  m.full_name,
  ma.status,
  ma.fee_paise,
  mt.held_on,
  mt.note
from meeting_attendance ma
join meetings mt on mt.id = ma.meeting_id
join members  m  on m.id  = ma.member_id
where ma.group_id = current_group_id() and in_current_group();

create or replace view v_member_attendance_summary
with (security_invoker = true) as
select
  m.id                                                as member_id,
  m.group_id,
  m.full_name,
  count(ma.id) filter (where ma.status = 'present')   as present_count,
  count(ma.id) filter (where ma.status = 'absent')    as absent_count,
  count(ma.id) filter (where ma.status = 'excused')   as excused_count,
  coalesce(sum(ma.fee_paise), 0)::bigint              as fines_paise
from members m
left join meeting_attendance ma on ma.member_id = m.id
where m.group_id = current_group_id()
  and m.status <> 'pending'
  and in_current_group()
group by m.id, m.group_id, m.full_name;

grant select on v_meeting_attendance, v_member_attendance_summary to authenticated;
revoke all on v_meeting_attendance, v_member_attendance_summary from anon;

alter table meetings           enable row level security;
alter table meeting_attendance enable row level security;

drop policy if exists meetings_read on meetings;
create policy meetings_read on meetings
  for select to authenticated
  using (group_id = current_group_id() and in_current_group());

drop policy if exists meeting_attendance_read on meeting_attendance;
create policy meeting_attendance_read on meeting_attendance
  for select to authenticated
  using (group_id = current_group_id() and in_current_group());

revoke insert, update, delete on meetings           from authenticated, anon;
revoke insert, update, delete on meeting_attendance from authenticated, anon;

revoke execute on function record_meeting(date, jsonb, text) from public, anon;
grant execute on function record_meeting(date, jsonb, text) to authenticated;
grant execute on function member_meeting_fines_paise(uuid) to authenticated;
