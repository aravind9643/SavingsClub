-- 0025_member_payouts.sql
--
-- Money could go into this fund and never come out.
--
-- remove_member() checked the member owed nothing, marked them 'left', and
-- stopped. Their savings were never returned. fn_fund_total_paise() is
-- contributions + interest - expenses, with no term for a payout, because no
-- payout existed -- so a member who paid Rs.50,000 over three years and walked
-- away had that money silently absorbed, and every remaining member's
-- share_pct grew to swallow it.
--
-- That is not a missing feature. It is a wrong number, produced today, by the
-- most common transaction a savings group performs after collecting money.
--
-- WHY A NEW TABLE RATHER THAN AN EXPENSE
--
-- A payout was previously only expressible as an expense, which is wrong three
-- times over: it counts against the annual expense cap (returning savings is
-- not spending), it appears in expense reports as if the group consumed the
-- money, and it loses the link to the member it belongs to. Payouts are their
-- own kind of event and get their own table.
--
-- WHAT A PAYOUT IS NOT
--
-- It does not reverse contributions. The contribution rows stay exactly as
-- recorded -- they are history, and history is what the group signed off on
-- each month. A payout is a new, later event that moves money the other way.
-- The fund total nets the two.

create type payout_kind_enum as enum ('exit', 'dividend', 'interim');

create table member_payouts (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references groups (id),
  member_id     uuid not null references members (id),
  kind          payout_kind_enum not null,
  amount_paise  bigint not null check (amount_paise > 0),
  paid_on       date not null,
  method        payment_method_enum not null default 'bank',
  note          text,
  -- Set when this payout was part of a group-wide share-out, so the whole
  -- distribution can be shown, audited and reported as one event.
  distribution_id uuid,
  recorded_by   uuid not null references members (id),
  created_at    timestamptz not null default now()
);

create index member_payouts_group_idx  on member_payouts (group_id, paid_on desc);
create index member_payouts_member_idx on member_payouts (member_id);
create index member_payouts_dist_idx   on member_payouts (distribution_id)
  where distribution_id is not null;

-- ---------------------------------------------------------------------------
-- The fund math learns the word "out".
--
-- Every figure downstream of fn_fund_total_paise() -- the loan cap, the
-- lendable ceiling, the expected bank balance -- corrects itself the moment
-- this term exists, because they all call the one function. That was the
-- point of building it that way.
-- ---------------------------------------------------------------------------
create or replace function fn_payouts_paid_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from member_payouts where group_id = p_group_id
$$;

create or replace function fn_fund_total_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select fn_contributions_received_paise(p_group_id)
       + fn_interest_received_paise(p_group_id)
       - fn_expenses_paid_paise(p_group_id)
       - fn_payouts_paid_paise(p_group_id)
$$;

-- What a member has actually got back. Needed to show a truthful net position
-- rather than a lifetime-contributions figure that overstates what they hold.
create or replace function member_paid_out_paise(p_member_id uuid)
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from member_payouts
  where member_id = p_member_id and group_id = current_group_id()
$$;

-- ---------------------------------------------------------------------------
-- A member's share of the fund.
--
-- Pro-rata by net contribution, which is the rule nearly every group of this
-- kind writes down: you get back what you put in, plus your share of what the
-- group earned on it. Interest earned is distributed in the same proportion,
-- because it was earned by everyone's money sitting in the pot together.
--
-- Deliberately computed from CONTRIBUTIONS, not from time-weighted balances.
-- A time-weighted rule is arguably fairer to early joiners, but it cannot be
-- checked by hand at a meeting, and a figure the group cannot verify is a
-- figure the group will not trust.
-- ---------------------------------------------------------------------------
create or replace function member_share_paise(
  p_member_id uuid,
  p_group_id uuid default current_group_id()
) returns bigint
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_mine  bigint;
  v_all   bigint;
  v_fund  bigint;
  v_out   bigint;
begin
  select coalesce(sum(amount_paise + late_fee_paise), 0) into v_mine
  from contributions where member_id = p_member_id and group_id = p_group_id;

  select coalesce(sum(amount_paise + late_fee_paise), 0) into v_all
  from contributions where group_id = p_group_id;

  if v_all = 0 then
    return 0;
  end if;

  v_fund := fn_fund_total_paise(p_group_id);
  if v_fund <= 0 then
    return 0;
  end if;

  -- Their slice of what the fund is worth now, less whatever they have
  -- already been paid. Truncating division favours the fund by at most a
  -- paise per member, which is the right direction to round: the group can
  -- never be made short by a rounding rule.
  v_out := v_fund * v_mine / v_all;

  return greatest(0, v_out - member_paid_out_paise(p_member_id));
end $$;

-- ---------------------------------------------------------------------------
-- pay_out_member: return a leaving member's money.
--
-- Separate from remove_member() on purpose. Paying someone out and marking
-- them gone are two events that can be days apart -- the group agrees the
-- figure at the meeting, the cashier makes the transfer when the bank opens.
-- Forcing them into one call would mean either lying about the date or
-- refusing to record reality.
-- ---------------------------------------------------------------------------
create or replace function pay_out_member(
  p_member_id uuid,
  p_amount_paise bigint default null,
  p_kind payout_kind_enum default 'exit',
  p_paid_on date default current_date,
  p_method payment_method_enum default 'bank',
  p_note text default null
) returns member_payouts
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group  uuid := current_group_id();
  v_actor  uuid := fn_assert_active_member();
  v_amount bigint;
  v_owed   bigint;
  v_avail  bigint;
  v_name   text;
  v_row    member_payouts;
begin
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may pay a member out'
      using errcode = 'insufficient_privilege';
  end if;

  -- Lock order is groups -> everything else, as in every other money RPC.
  -- Two payouts racing could each see enough money for one of them.
  perform 1 from groups where id = v_group for no key update;

  if not exists (select 1 from members
                 where id = p_member_id and group_id = v_group) then
    raise exception 'That person is not in this group' using errcode = 'check_violation';
  end if;

  if p_paid_on > current_date then
    raise exception 'A payment cannot be dated in the future'
      using errcode = 'check_violation';
  end if;

  v_amount := coalesce(p_amount_paise, member_share_paise(p_member_id, v_group));

  if v_amount <= 0 then
    raise exception 'There is nothing to pay this member'
      using errcode = 'check_violation';
  end if;

  -- A member with a running loan is holding group money already. Paying them
  -- their savings while they owe would hand over the same rupees twice.
  v_owed := member_outstanding_paise(p_member_id);
  if v_owed > 0 then
    raise exception 'This member still owes Rs.% - the loan must be settled first',
      (v_owed::numeric / 100)::text using errcode = 'check_violation';
  end if;

  -- The fund cannot pay out money that is lent out. Cash on loan is an asset,
  -- not something the cashier can transfer.
  v_avail := fn_fund_total_paise(v_group) - total_outstanding_paise(v_group);
  if v_amount > v_avail then
    raise exception 'Only Rs.% is available to pay out right now - the rest is out on loan',
      (greatest(0, v_avail)::numeric / 100)::text using errcode = 'check_violation';
  end if;

  select full_name into v_name from members where id = p_member_id;

  insert into member_payouts (
    group_id, member_id, kind, amount_paise, paid_on, method, note, recorded_by
  )
  values (v_group, p_member_id, p_kind, v_amount, p_paid_on, p_method,
          p_note, v_actor)
  returning * into v_row;

  -- Cash leaving the tin is a cash event, exactly as a cash contribution
  -- arriving is. Skipping this would break the "every rupee is in exactly one
  -- bucket" invariant reconciliation depends on.
  if p_method = 'cash' then
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at,
                             purpose, counterparty, recorded_by,
                             reported_at, reported_by)
    values (v_group, 'out', v_amount, p_paid_on::timestamptz,
            case p_kind
              when 'exit' then 'Savings returned to member'
              when 'dividend' then 'Profit share paid'
              else 'Part payment to member'
            end,
            v_name, v_actor, now(), v_actor);
  end if;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- remove_member now refuses to lose someone's money by accident.
--
-- Everything else about it is unchanged: same role check, same admin
-- protection, same guarantor check, same order. The only addition is that a
-- member still holding a share cannot be quietly marked 'left'.
-- ---------------------------------------------------------------------------
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
      (v_owed::numeric / 100)::text using errcode = 'check_violation';
  end if;

  if exists (select 1 from loans
             where guarantor_id = p_member_id and group_id = v_group
               and status in ('approved', 'disbursed')) then
    raise exception 'This member vouched for a running loan - someone else must take that on first'
      using errcode = 'check_violation';
  end if;

  -- The new rule. Rs.1 of slack absorbs the truncating division in
  -- member_share_paise(), so a fully paid member is never blocked by a
  -- rounding remainder.
  v_share := member_share_paise(p_member_id, v_group);
  if v_share > 100 then
    raise exception 'This member is still owed about Rs.% - pay them out first',
      (v_share::numeric / 100)::text using errcode = 'check_violation';
  end if;

  update role_assignments set end_date = p_left_on
  where member_id = p_member_id and group_id = v_group and end_date is null;

  update members set left_on = p_left_on, status = 'left'
  where id = p_member_id and group_id = v_group and left_on is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Member not found or already left' using errcode = 'no_data_found';
  end if;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- RLS. Reads for the group, writes through the RPC only -- as everywhere else.
-- ---------------------------------------------------------------------------
alter table member_payouts enable row level security;

drop policy if exists member_payouts_read on member_payouts;
create policy member_payouts_read on member_payouts
  for select to authenticated
  using (group_id = current_group_id() and in_current_group());

revoke insert, update, delete on member_payouts from authenticated, anon;

revoke execute on function pay_out_member(uuid, bigint, payout_kind_enum, date,
                                          payment_method_enum, text)
  from public, anon;
grant execute on function pay_out_member(uuid, bigint, payout_kind_enum, date,
                                         payment_method_enum, text)
  to authenticated;
grant execute on function member_share_paise(uuid, uuid) to authenticated;
grant execute on function member_paid_out_paise(uuid) to authenticated;
grant execute on function fn_payouts_paid_paise(uuid) to authenticated;

-- Money movements are audited like every other money table.
drop trigger if exists trg_audit_member_payouts on member_payouts;
create trigger trg_audit_member_payouts
  after insert or update or delete on member_payouts
  for each row execute function fn_audit();

-- ---------------------------------------------------------------------------
-- The member view gains the truth about what someone actually holds.
--
-- contributed_paise alone overstates it the moment anyone is paid anything,
-- and share_pct was computed against contributions while the fund it divided
-- had no payout term at all. Both are corrected here.
--
-- CREATE OR REPLACE VIEW can only APPEND columns, and these land in the middle
-- of the select list, so the view is dropped and rebuilt. Nothing depends on
-- it, so it drops alone.
-- ---------------------------------------------------------------------------
-- v_fund_summary needs the payout line too. Appending a column is the one
-- change CREATE OR REPLACE VIEW permits, so this needs no drop -- but the
-- column must go LAST, after accrued_receivable_paise, or it is a rename.
create or replace view v_fund_summary
with (security_invoker = true) as
select
  g.id                                             as group_id,
  fn_contributions_received_paise(g.id)            as contributions_paise,
  fn_interest_received_paise(g.id)                 as interest_received_paise,
  fn_expenses_paid_paise(g.id)                     as expenses_paise,
  fn_fund_total_paise(g.id)                        as total_fund_paise,
  (fn_fund_total_paise(g.id) * g.reserve_pct_bp / 10000)      as reserve_paise,
  (fn_fund_total_paise(g.id) * (10000 - g.reserve_pct_bp) / 10000) as lendable_paise,
  total_outstanding_paise(g.id)                    as outstanding_paise,
  greatest(0, (fn_fund_total_paise(g.id) * (10000 - g.reserve_pct_bp) / 10000)
              - total_outstanding_paise(g.id))     as still_lendable_paise,
  (fn_fund_total_paise(g.id) * g.max_loan_pct_bp / 10000) as per_member_cap_paise,
  cash_float_balance_paise(g.id)                   as cash_float_paise,
  g.cash_float_limit_paise,
  (fn_fund_total_paise(g.id)
     - total_outstanding_paise(g.id)
     - cash_float_balance_paise(g.id))             as expected_bank_balance_paise,
  (select coalesce(sum(a.interest_paise + a.penalty_paise), 0)::bigint
   from loans l
   cross join lateral loan_accrued_interest_paise(l.id) a
   where l.status = 'disbursed' and l.group_id = g.id) as accrued_receivable_paise,
  fn_payouts_paid_paise(g.id)                      as payouts_paise
from groups g
where g.id = current_group_id() and in_current_group();

drop view if exists v_member_positions;
create view v_member_positions
with (security_invoker = true) as
select
  m.id                                   as member_id,
  m.group_id,
  m.full_name,
  m.is_active,
  role_of(m.id)                          as role,
  coalesce(ct.paid_paise, 0)             as contributed_paise,
  coalesce(ct.late_fees_paise, 0)        as late_fees_paise,
  coalesce(ct.periods_paid, 0)           as periods_paid,
  member_paid_out_paise(m.id)            as paid_out_paise,
  member_share_paise(m.id, m.group_id)   as share_paise,
  member_outstanding_paise(m.id)         as outstanding_paise,
  f.per_member_cap_paise                 as cap_paise,
  (member_outstanding_paise(m.id) > f.per_member_cap_paise) as cap_breached,
  case when f.total_fund_paise = 0 then 0::numeric
       else round(coalesce(ct.paid_paise, 0)::numeric / f.total_fund_paise * 100, 2)
  end                                    as share_pct
from members m
cross join lateral (select * from v_fund_summary) f
left join (
  select member_id,
         sum(amount_paise)   as paid_paise,
         sum(late_fee_paise) as late_fees_paise,
         count(*)            as periods_paid
  from contributions group by member_id
) ct on ct.member_id = m.id
where m.group_id = current_group_id()
  and m.status <> 'pending'
  and in_current_group();

grant select on v_member_positions to authenticated;
revoke all on v_member_positions from anon;
