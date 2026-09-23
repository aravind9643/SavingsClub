-- 0029_distributions.sql
--
-- Interest flowed into the fund and stayed there forever. The app could not
-- model the end of a cycle.
--
-- share_pct was computed and shown on the members screen, which implies a
-- distribution -- but nothing ever acted on it. A group that runs a twelve
-- month cycle and shares out the profit at Diwali, or winds up entirely and
-- splits the pot, had no way to say so. The fund could only grow.
--
-- TWO KINDS OF SHARE-OUT, ONE MECHANISM
--
--   profit  -- distribute the interest earned, keep the savings invested.
--             The common annual event. Members stay, the group continues.
--   final   -- distribute everything and close the group. Each member gets
--             their full share; the fund ends at zero.
--
-- Both produce member_payouts rows (from 0025) tied by distribution_id, so a
-- share-out is auditable as one event and every downstream figure -- fund
-- total, shares, expected bank balance -- corrects itself without any special
-- casing, because they all read the payouts table.
--
-- WHY IT IS PROPOSED THEN CONFIRMED
--
-- A share-out is the largest movement of money a group ever makes, and it is
-- irreversible. Computing the figures and committing them in one call would
-- mean the group finds out what everyone is getting only after it has already
-- happened. Propose first, read the numbers at the meeting, then confirm.

create type distribution_kind_enum as enum ('profit', 'final');

create table distributions (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references groups (id),
  kind          distribution_kind_enum not null,
  status        text not null default 'proposed'
    check (status in ('proposed', 'confirmed', 'cancelled')),
  -- What the fund was worth when the figures were computed. If the fund has
  -- moved by the time the group confirms, the proposal is stale and refused.
  fund_at_proposal_paise bigint not null,
  total_paise   bigint not null check (total_paise >= 0),
  as_of         date not null,
  note          text,
  proposed_by   uuid not null references members (id),
  proposed_at   timestamptz not null default now(),
  confirmed_by  uuid references members (id),
  confirmed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index distributions_group_idx on distributions (group_id, proposed_at desc);

create table distribution_lines (
  id              uuid primary key default gen_random_uuid(),
  distribution_id uuid not null references distributions (id) on delete cascade,
  group_id        uuid not null references groups (id),
  member_id       uuid not null references members (id),
  amount_paise    bigint not null check (amount_paise >= 0),
  unique (distribution_id, member_id)
);

create index distribution_lines_dist_idx on distribution_lines (distribution_id);

alter table member_payouts
  add constraint member_payouts_distribution_fk
  foreign key (distribution_id) references distributions (id);

-- ---------------------------------------------------------------------------
-- What is available to share out.
--
-- Profit = interest received, less expenses, less anything already shared as
-- profit before. Savings are NOT profit and are never included: distributing
-- them would quietly liquidate the group while telling everyone it was a
-- good year.
--
-- Money out on loan cannot be distributed whatever the kind -- it is not
-- there to hand over.
-- ---------------------------------------------------------------------------
create or replace function fn_distributable_paise(
  p_kind distribution_kind_enum,
  p_group_id uuid default current_group_id()
) returns bigint
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cash bigint;
  v_amt  bigint;
begin
  -- Never more than the group can actually pay today.
  v_cash := fn_fund_total_paise(p_group_id) - total_outstanding_paise(p_group_id);

  if p_kind = 'final' then
    v_amt := fn_fund_total_paise(p_group_id);
  else
    v_amt := fn_interest_received_paise(p_group_id)
           - fn_expenses_paid_paise(p_group_id)
           - coalesce((select sum(total_paise) from distributions
                       where group_id = p_group_id and kind = 'profit'
                         and status = 'confirmed'), 0);
  end if;

  return greatest(0, least(v_amt, v_cash));
end $$;

-- ---------------------------------------------------------------------------
-- propose_distribution: work out who gets what, and show it before doing it.
-- ---------------------------------------------------------------------------
create or replace function propose_distribution(
  p_kind distribution_kind_enum default 'profit',
  p_amount_paise bigint default null,
  p_as_of date default current_date,
  p_note text default null
) returns distributions
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_avail bigint;
  v_total bigint;
  v_base  bigint;
  v_given bigint := 0;
  v_row   distributions;
  r       record;
  v_last  uuid;
begin
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may propose a share-out'
      using errcode = 'insufficient_privilege';
  end if;

  perform 1 from groups where id = v_group for no key update;

  if p_as_of > current_date then
    raise exception 'A share-out cannot be dated in the future'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from distributions
             where group_id = v_group and status = 'proposed') then
    raise exception 'There is already a share-out waiting to be agreed'
      using errcode = 'check_violation';
  end if;

  -- Money still out on loan has to come back before the group can split up.
  if p_kind = 'final' and total_outstanding_paise(v_group) > 0 then
    raise exception 'Every loan must be settled before the group can close'
      using errcode = 'check_violation';
  end if;

  v_avail := fn_distributable_paise(p_kind, v_group);
  v_total := coalesce(p_amount_paise, v_avail);

  if v_total <= 0 then
    raise exception 'There is nothing to share out'
      using errcode = 'check_violation';
  end if;
  if v_total > v_avail then
    raise exception 'Only Rs.% can be shared out right now',
      (v_avail::numeric / 100)::text using errcode = 'check_violation';
  end if;

  -- The total of what everyone holds. Each member's slice is their part of it.
  select coalesce(sum(c.amount_paise + c.late_fee_paise), 0)
       + fn_opening_balance_paise(v_group)
  into v_base
  from contributions c where c.group_id = v_group;

  if v_base = 0 then
    raise exception 'Nobody has paid anything in yet'
      using errcode = 'check_violation';
  end if;

  insert into distributions (
    group_id, kind, fund_at_proposal_paise, total_paise, as_of, note, proposed_by
  )
  values (v_group, p_kind, fn_fund_total_paise(v_group), v_total, p_as_of,
          p_note, v_actor)
  returning * into v_row;

  -- Truncating division leaves a remainder of up to (members - 1) paise. It
  -- goes to the last member rather than being dropped, so the lines sum to
  -- the total exactly and the group's books close at zero.
  for r in
    select m.id,
           (coalesce((select sum(c.amount_paise + c.late_fee_paise)
                      from contributions c
                      where c.member_id = m.id and c.group_id = v_group), 0)
            + m.opening_balance_paise) as held
    from members m
    where m.group_id = v_group and m.status = 'active' and m.left_on is null
    order by m.full_name, m.id
  loop
    insert into distribution_lines (distribution_id, group_id, member_id, amount_paise)
    values (v_row.id, v_group, r.id, v_total * r.held / v_base);
    v_given := v_given + (v_total * r.held / v_base);
    v_last  := r.id;
  end loop;

  if v_last is null then
    raise exception 'There are no active members to share out to'
      using errcode = 'check_violation';
  end if;

  if v_total > v_given then
    update distribution_lines
    set amount_paise = amount_paise + (v_total - v_given)
    where distribution_id = v_row.id and member_id = v_last;
  end if;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- confirm_distribution: the group has seen the figures and agreed.
--
-- Deliberately a different person from the proposer, the same separation the
-- app applies to disbursing a loan. The one who computes the figures is not
-- the one who releases the money.
-- ---------------------------------------------------------------------------
create or replace function confirm_distribution(p_distribution_id uuid)
returns distributions
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_row   distributions;
  r       record;
begin
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may agree a share-out'
      using errcode = 'insufficient_privilege';
  end if;

  perform 1 from groups where id = v_group for no key update;

  select * into v_row from distributions
  where id = p_distribution_id and group_id = v_group for update;

  if v_row.id is null then
    raise exception 'Share-out not found' using errcode = 'no_data_found';
  end if;
  if v_row.status <> 'proposed' then
    raise exception 'This share-out has already been dealt with'
      using errcode = 'check_violation';
  end if;
  if v_row.proposed_by = v_actor then
    raise exception 'Someone else must agree a share-out you proposed'
      using errcode = 'insufficient_privilege';
  end if;

  -- If the fund has moved since the figures were worked out, they are no
  -- longer the figures the group agreed to.
  if fn_fund_total_paise(v_group) <> v_row.fund_at_proposal_paise then
    raise exception 'The fund has changed since these figures were worked out - propose it again'
      using errcode = 'check_violation';
  end if;

  for r in
    select member_id, amount_paise from distribution_lines
    where distribution_id = p_distribution_id and amount_paise > 0
  loop
    insert into member_payouts (
      group_id, member_id, kind, amount_paise, paid_on, method, note,
      distribution_id, recorded_by
    )
    values (
      v_group, r.member_id,
      case when v_row.kind = 'final' then 'exit' else 'dividend' end,
      r.amount_paise, v_row.as_of, 'bank',
      case when v_row.kind = 'final' then 'Final share-out'
           else 'Profit share' end,
      p_distribution_id, v_actor
    );
  end loop;

  update distributions
  set status = 'confirmed', confirmed_by = v_actor, confirmed_at = now()
  where id = p_distribution_id
  returning * into v_row;

  -- A final share-out ends the group. Archiving it keeps the history readable
  -- while making clear no more money moves.
  if v_row.kind = 'final' then
    update groups set archived_at = now() where id = v_group;
  end if;

  return v_row;
end $$;

create or replace function cancel_distribution(p_distribution_id uuid)
returns distributions
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_row   distributions;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may cancel a share-out'
      using errcode = 'insufficient_privilege';
  end if;

  update distributions set status = 'cancelled'
  where id = p_distribution_id and group_id = v_group and status = 'proposed'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Share-out not found, or already dealt with'
      using errcode = 'check_violation';
  end if;
  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- What a proposed share-out would pay each member.
-- ---------------------------------------------------------------------------
create or replace view v_distribution_lines
with (security_invoker = true) as
select
  dl.id,
  dl.distribution_id,
  dl.group_id,
  dl.member_id,
  m.full_name,
  dl.amount_paise,
  d.kind,
  d.status,
  d.as_of
from distribution_lines dl
join distributions d on d.id = dl.distribution_id
join members m on m.id = dl.member_id
where dl.group_id = current_group_id() and in_current_group();

grant select on v_distribution_lines to authenticated;
revoke all on v_distribution_lines from anon;

alter table distributions      enable row level security;
alter table distribution_lines enable row level security;

drop policy if exists distributions_read on distributions;
create policy distributions_read on distributions
  for select to authenticated
  using (group_id = current_group_id() and in_current_group());

drop policy if exists distribution_lines_read on distribution_lines;
create policy distribution_lines_read on distribution_lines
  for select to authenticated
  using (group_id = current_group_id() and in_current_group());

revoke insert, update, delete on distributions      from authenticated, anon;
revoke insert, update, delete on distribution_lines from authenticated, anon;

revoke execute on function propose_distribution(distribution_kind_enum, bigint, date, text)
  from public, anon;
revoke execute on function confirm_distribution(uuid) from public, anon;
revoke execute on function cancel_distribution(uuid) from public, anon;

grant execute on function propose_distribution(distribution_kind_enum, bigint, date, text)
  to authenticated;
grant execute on function confirm_distribution(uuid) to authenticated;
grant execute on function cancel_distribution(uuid) to authenticated;
grant execute on function fn_distributable_paise(distribution_kind_enum, uuid)
  to authenticated;

drop trigger if exists trg_audit_distributions on distributions;
create trigger trg_audit_distributions
  after insert or update or delete on distributions
  for each row execute function fn_audit();
