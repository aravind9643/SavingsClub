-- 0028_opening_balance.sql
--
-- Every group started at zero, which blocked the most likely user: a group
-- that already exists.
--
-- A five-year-old group with Rs.4,00,000 in the bank and eight running loans
-- could only onboard by inventing fake historical contributions -- which would
-- then be wrong in every per-member figure, every share calculation, and every
-- payout for the rest of the group's life. The alternative was to abandon five
-- years of history. Neither is acceptable, so neither should be necessary.
--
-- THE SHAPE OF THE FIX
--
-- An opening balance is not a contribution and must never be modelled as one.
-- A contribution says "this member paid this much in this month". An opening
-- balance says "on the day we started using this app, the group held this
-- much, and these members had this much of it to their name". The second
-- statement carries no month, no late fee, and no claim about when the money
-- arrived.
--
-- So: a per-member opening figure, and a group-level opening date. The fund
-- math adds the opening total; the share calculation adds each member's
-- opening figure to their contributions. Both were single functions, which is
-- why this is a small change rather than a rewrite.

alter table groups
  add column if not exists opened_on date,
  add column if not exists opening_locked boolean not null default false;

comment on column groups.opening_locked is
  'Set once the opening position is agreed. After this the figures cannot be '
  'edited, because every share and payout since has been computed from them.';

alter table members
  add column if not exists opening_balance_paise bigint not null default 0
    check (opening_balance_paise >= 0);

comment on column members.opening_balance_paise is
  'What this member had already saved with the group before it started using '
  'this app. Counts toward their share exactly as a contribution does, but '
  'belongs to no month and attracts no late fee.';

-- ---------------------------------------------------------------------------
-- The fund math learns where the group started.
-- ---------------------------------------------------------------------------
create or replace function fn_opening_balance_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(opening_balance_paise), 0)::bigint
  from members where group_id = p_group_id
$$;

create or replace function fn_fund_total_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select fn_opening_balance_paise(p_group_id)
       + fn_contributions_received_paise(p_group_id)
       + fn_interest_received_paise(p_group_id)
       - fn_expenses_paid_paise(p_group_id)
       - fn_payouts_paid_paise(p_group_id)
$$;

-- ---------------------------------------------------------------------------
-- A member's share now counts what they brought in with them.
--
-- Same pro-rata rule as 0025, with opening balances on both sides of the
-- ratio. A member who brought Rs.50,000 into a group whose opening total was
-- Rs.4,00,000 owns that proportion from day one -- which is the entire reason
-- the opening figures have to be recorded per member rather than as one lump.
-- ---------------------------------------------------------------------------
create or replace function member_share_paise(
  p_member_id uuid,
  p_group_id uuid default current_group_id()
) returns bigint
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_mine bigint;
  v_all  bigint;
  v_fund bigint;
  v_out  bigint;
begin
  select coalesce(sum(c.amount_paise + c.late_fee_paise), 0)
       + coalesce((select m.opening_balance_paise from members m
                   where m.id = p_member_id), 0)
  into v_mine
  from contributions c
  where c.member_id = p_member_id and c.group_id = p_group_id;

  select coalesce(sum(c.amount_paise + c.late_fee_paise), 0)
       + fn_opening_balance_paise(p_group_id)
  into v_all
  from contributions c
  where c.group_id = p_group_id;

  if v_all = 0 then
    return 0;
  end if;

  v_fund := fn_fund_total_paise(p_group_id);
  if v_fund <= 0 then
    return 0;
  end if;

  v_out := v_fund * v_mine / v_all;
  return greatest(0, v_out - member_paid_out_paise(p_member_id));
end $$;

-- ---------------------------------------------------------------------------
-- set_opening_position: record where the group stood on day one.
--
-- Takes every member's figure in one call, because a half-entered opening
-- position is worse than none -- the shares would be wrong in a way that looks
-- plausible. All of it, or none of it.
-- ---------------------------------------------------------------------------
create or replace function set_opening_position(
  p_opened_on date,
  p_balances jsonb
) returns groups
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_cfg   groups;
  v_row   groups;
  r       record;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may set the opening figures'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_cfg from groups where id = v_group for no key update;

  if v_cfg.opening_locked then
    raise exception 'The opening figures are already agreed and cannot be changed'
      using errcode = 'check_violation';
  end if;

  if p_opened_on > current_date then
    raise exception 'The start date cannot be in the future'
      using errcode = 'check_violation';
  end if;

  -- Changing the opening position after money has moved would silently
  -- restate every share and every payout already made from them.
  if exists (select 1 from contributions where group_id = v_group)
     or exists (select 1 from loans where group_id = v_group
                and status in ('disbursed', 'closed', 'written_off'))
     or exists (select 1 from member_payouts where group_id = v_group) then
    raise exception 'Money has already been recorded - the opening figures can no longer be set'
      using errcode = 'check_violation';
  end if;

  for r in
    select (e.key)::uuid as member_id, (e.value)::text::bigint as amount
    from jsonb_each(p_balances) e
  loop
    if r.amount < 0 then
      raise exception 'An opening amount cannot be less than zero'
        using errcode = 'check_violation';
    end if;
    if not exists (select 1 from members
                   where id = r.member_id and group_id = v_group) then
      raise exception 'That person is not in this group' using errcode = 'check_violation';
    end if;

    update members set opening_balance_paise = r.amount
    where id = r.member_id and group_id = v_group;
  end loop;

  update groups set opened_on = p_opened_on where id = v_group
  returning * into v_row;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- lock_opening_position: the group signs off, and the figures become history.
-- ---------------------------------------------------------------------------
create or replace function lock_opening_position() returns groups
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_row   groups;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'admin') then
    raise exception 'Only the cashier, accountant or admin may agree the opening figures'
      using errcode = 'insufficient_privilege';
  end if;

  update groups set opening_locked = true
  where id = v_group and opened_on is not null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Set the start date and the opening amounts first'
      using errcode = 'check_violation';
  end if;
  return v_row;
end $$;

-- v_fund_summary shows the opening line, so the total can be read as a sum
-- rather than taken on trust. Appending a column is legal.
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
  fn_payouts_paid_paise(g.id)                      as payouts_paise,
  fn_opening_balance_paise(g.id)                   as opening_paise
from groups g
where g.id = current_group_id() and in_current_group();

revoke execute on function set_opening_position(date, jsonb) from public, anon;
revoke execute on function lock_opening_position() from public, anon;
grant execute on function set_opening_position(date, jsonb) to authenticated;
grant execute on function lock_opening_position() to authenticated;
grant execute on function fn_opening_balance_paise(uuid) to authenticated;
