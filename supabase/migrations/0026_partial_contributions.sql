-- 0026_partial_contributions.sql
--
-- `unique (period_id, member_id)` made a routine event impossible.
--
-- Someone paying Rs.500 of Rs.1,000 now and the rest next week could not be
-- recorded: the second payment violated the constraint. And because
-- v_unpaid_contributions finds unpaid members with `where c.id is null`, the
-- FIRST payment marked the month fully settled. The shortfall did not show up
-- anywhere. The group's own chase-list quietly told them everyone had paid.
--
-- So this is not "part payments are unsupported". It is "part payments are
-- recorded as payment in full", which is the worse of the two failures.
--
-- THE FIX
--
-- Drop the unique constraint, let a member have many rows in a period, and
-- make "unpaid" mean SUM(paid) < expected rather than "no row exists".
--
-- WHY NOT A BALANCE COLUMN
--
-- Because then the truth would live in two places and drift. The original
-- design note in 0004 was right -- unpaid is derived, never stored. The bug
-- was not the principle, it was that the derivation compared existence when
-- it should have compared amounts. Keep the principle, fix the comparison.

-- ---------------------------------------------------------------------------
-- 1. Many payments per member per period.
--
-- The constraint has been created under two different names across this
-- project's history (inline in 0004, possibly re-added since), so drop by
-- catalog lookup rather than by a guessed name -- the same lesson 0012 learned
-- about triggers.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    where c.relname = 'contributions'
      and con.contype = 'u'
      and (
        select array_agg(att.attname order by att.attname)
        from unnest(con.conkey) k
        join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k
      ) = array['member_id', 'period_id']
  loop
    execute format('alter table contributions drop constraint %I', r.conname);
  end loop;
end $$;

-- Reads are now "all the payments in this period for this member", so the
-- index that matters is the composite one.
create index if not exists contributions_period_member_idx
  on contributions (period_id, member_id);

-- ---------------------------------------------------------------------------
-- 2. What a member has actually paid toward a period.
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER bypasses RLS, so the group has to be named explicitly. A
-- period id from another tenant would otherwise return that tenant's figures.
create or replace function member_period_paid_paise(
  p_period_id uuid,
  p_member_id uuid,
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from contributions
  where period_id = p_period_id
    and member_id = p_member_id
    and group_id  = p_group_id
$$;

-- ---------------------------------------------------------------------------
-- 3. record_contribution: accept part payments, charge the late fee once.
--
-- Everything from 0021 is preserved -- future-date guard, closed-period guard,
-- payment-before-period guard, member-in-group check, the 10x sanity ceiling,
-- the cash ledger entry. Three things change:
--
--   a. The 10x ceiling now measures the period TOTAL after this payment, not
--      this payment alone. Ten part payments of the full amount should still
--      trip it.
--   b. The late fee is charged at most once per member per period. Without
--      this, paying late in four instalments would be fined four times.
--   c. Overpayment is refused. Previously the unique constraint made it
--      impossible by accident; now it has to be an explicit rule, or a typo
--      silently credits the fund and distorts every share calculation.
-- ---------------------------------------------------------------------------
create or replace function record_contribution(
  p_period_id uuid,
  p_member_id uuid,
  p_amount_paise bigint,
  p_paid_on date default current_date,
  p_method payment_method_enum default 'bank',
  p_note text default null
) returns contributions
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group    uuid := current_group_id();
  v_actor    uuid := fn_assert_active_member();
  v_cfg      groups;
  v_period   contribution_periods;
  v_fee      bigint := 0;
  v_already  bigint;
  v_fees_yet bigint;
  v_row      contributions;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may record a payment'
      using errcode = 'insufficient_privilege';
  end if;
  if p_amount_paise <= 0 then
    raise exception 'Amount must be more than zero' using errcode = 'check_violation';
  end if;
  if p_paid_on > current_date then
    raise exception 'A payment cannot be dated in the future'
      using errcode = 'check_violation';
  end if;

  select * into v_cfg from groups where id = v_group;
  select * into v_period from contribution_periods
  where id = p_period_id and group_id = v_group;
  if v_period.id is null then
    raise exception 'Unknown month' using errcode = 'foreign_key_violation';
  end if;

  if v_period.closed_at is not null then
    raise exception 'That month is closed - record this in the current month instead'
      using errcode = 'check_violation';
  end if;

  if p_paid_on < v_period.period_month then
    raise exception 'Payment date % is before the month it is being recorded against (%)',
      p_paid_on, to_char(v_period.period_month, 'Mon YYYY')
      using errcode = 'check_violation';
  end if;

  if not exists (select 1 from members
                 where id = p_member_id and group_id = v_group) then
    raise exception 'That person is not in this group' using errcode = 'check_violation';
  end if;

  -- Lock the member's existing rows for this period so two cashiers recording
  -- the same payment cannot both see the same "already paid" figure and let
  -- the total sail past the expected amount.
  perform 1 from contributions
  where period_id = p_period_id and member_id = p_member_id
  for update;

  v_already := member_period_paid_paise(p_period_id, p_member_id, v_group);

  if v_already + p_amount_paise > v_period.amount_paise then
    raise exception 'That is more than is due. Rs.% is still owed for %',
      ((v_period.amount_paise - v_already)::numeric / 100)::text,
      to_char(v_period.period_month, 'Mon YYYY')
      using errcode = 'check_violation';
  end if;

  -- The 10x sanity ceiling from 0021 is deliberately NOT repeated here. The
  -- overpayment check above is strictly tighter -- it refuses anything over
  -- 1x the expected amount, so nothing could ever reach 10x. Keeping both
  -- would leave a branch that can never run, which reads like a guard and
  -- protects nothing.

  -- Late once is late once, however many instalments follow.
  if p_paid_on > v_period.grace_date then
    select coalesce(sum(late_fee_paise), 0) into v_fees_yet
    from contributions
    where period_id = p_period_id and member_id = p_member_id;

    if v_fees_yet = 0 then
      v_fee := v_cfg.late_fee_paise;
    end if;
  end if;

  insert into contributions (
    group_id, period_id, member_id, amount_paise, late_fee_paise,
    paid_on, method, note, recorded_by
  )
  values (v_group, p_period_id, p_member_id, p_amount_paise, v_fee,
          p_paid_on, p_method, p_note, v_actor)
  returning * into v_row;

  if p_method = 'cash' then
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose,
                             counterparty, recorded_by, reported_at, reported_by)
    values (v_group, 'in', p_amount_paise + v_fee, p_paid_on::timestamptz,
            'Payment received in cash',
            (select full_name from members where id = p_member_id),
            v_actor, now(), v_actor);
  end if;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 4. "Unpaid" now means short, not absent.
--
-- The view gains paid_paise and shortfall_paise, and the rows it returns are
-- members who have paid LESS than the month expects -- including those who
-- have paid something. That is the whole point of this migration: a member who
-- paid half must appear on the chase-list.
--
-- Columns land in the middle of the select list, so this is a drop and rebuild
-- rather than a replace.
-- ---------------------------------------------------------------------------
drop view if exists v_unpaid_contributions;
create view v_unpaid_contributions
with (security_invoker = true) as
select
  p.id           as period_id,
  p.group_id,
  p.period_month,
  p.due_date,
  p.grace_date,
  m.id           as member_id,
  m.full_name,
  p.amount_paise as expected_paise,
  coalesce(c.paid_paise, 0)                      as paid_paise,
  (p.amount_paise - coalesce(c.paid_paise, 0))   as shortfall_paise,
  (coalesce(c.paid_paise, 0) > 0)                as part_paid,
  (current_date > p.grace_date) as is_overdue
from contribution_periods p
join members m on m.group_id = p.group_id
left join (
  select period_id, member_id, sum(amount_paise) as paid_paise
  from contributions
  group by period_id, member_id
) c on c.period_id = p.id and c.member_id = m.id
where coalesce(c.paid_paise, 0) < p.amount_paise
  and m.left_on is null
  and m.status = 'active'
  and p.group_id = current_group_id()
  and in_current_group()
  and m.joined_on <= (p.period_month + interval '1 month' - interval '1 day')::date;

grant select on v_unpaid_contributions to authenticated;
revoke all on v_unpaid_contributions from anon;

grant execute on function member_period_paid_paise(uuid, uuid, uuid) to authenticated;
