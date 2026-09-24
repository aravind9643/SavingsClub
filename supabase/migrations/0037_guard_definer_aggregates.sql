-- 0037_guard_definer_aggregates.sql
--
-- Any signed-in user could read any group's money by passing its id.
--
-- Demonstrated against a live database. Bob, a member of Group B only, set his
-- claim to Group A and was correctly stonewalled everywhere -- zero rows from
-- every table, RPCs refused, export refused. Then:
--
--     select fn_fund_total_paise('<group A id>');
--     -> 505000
--
-- Group A's actual balance. The one path that answered was the one that
-- bypasses RLS by design.
--
-- WHY THIS EXISTS
--
-- 0012 gave every money aggregate an explicit p_group_id so the figures would
-- be CORRECT under multi-tenancy -- before that they summed across all groups.
-- That fixed the arithmetic. It did not add an authorization check, because
-- the functions are SECURITY DEFINER and RLS is exactly what SECURITY DEFINER
-- turns off. The parameter made them accurate and left them open.
--
-- AGENTS.md already names these "the sharpest edge in the codebase". The edge
-- was real.
--
-- HOW BAD
--
-- All 14 are granted to `authenticated`, so every one is reachable over
-- PostgREST with nothing but a valid login:
--     POST /rest/v1/rpc/fn_fund_total_paise {"p_group_id": "..."}
-- No membership, no invite, no claim -- just the group's uuid. Fund total,
-- contributions, outstanding loans, cash in hand, every member's share.
--
-- THE FIX
--
-- One guard, applied to every one of them: if you are asking about a group,
-- you must be a member of that group. Stated once as a function so the rule
-- has a single home, then wired into each aggregate.
--
-- A member reading their OWN group is unaffected -- which is every real call
-- the app makes, since the UI only ever passes current_group_id().

-- ---------------------------------------------------------------------------
-- The rule.
--
-- Deliberately NOT the claim. The claim says which group you are looking at;
-- membership says whether you may. Checking the claim here would be circular,
-- because the attack is a forged claim.
-- ---------------------------------------------------------------------------
create or replace function fn_assert_member_of(p_group_id uuid)
returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_group_id is null then
    raise exception 'No group chosen' using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from members m
    where m.group_id = p_group_id
      and m.auth_user_id = auth.uid()
      and m.status = 'active'
      and m.left_on is null
  ) then
    raise exception 'You are not a member of this group'
      using errcode = 'insufficient_privilege';
  end if;

  return p_group_id;
end $$;

grant execute on function fn_assert_member_of(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Every aggregate now checks before it counts.
--
-- Each keeps its exact signature and return type, so no overload is created
-- and no caller changes. The only difference is the guard.
-- ---------------------------------------------------------------------------

create or replace function fn_contributions_received_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise + late_fee_paise), 0)::bigint
  from contributions where group_id = fn_assert_member_of(p_group_id)
$$;

create or replace function fn_interest_received_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(interest_paise + penalty_paise), 0)::bigint
  from loan_repayments where group_id = fn_assert_member_of(p_group_id)
$$;

create or replace function fn_expenses_paid_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from expenses
  where group_id = fn_assert_member_of(p_group_id) and status = 'paid'
$$;

create or replace function fn_payouts_paid_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from member_payouts where group_id = fn_assert_member_of(p_group_id)
$$;

create or replace function fn_opening_balance_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(opening_balance_paise), 0)::bigint
  from members where group_id = fn_assert_member_of(p_group_id)
$$;

-- fn_fund_total_paise composes the five above. Each already guards, so the
-- assertion here is belt-and-braces -- and cheap, since it is the same
-- index probe the others make.
create or replace function fn_fund_total_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select fn_opening_balance_paise(fn_assert_member_of(p_group_id))
       + fn_contributions_received_paise(p_group_id)
       + fn_interest_received_paise(p_group_id)
       - fn_expenses_paid_paise(p_group_id)
       - fn_payouts_paid_paise(p_group_id)
$$;

create or replace function total_outstanding_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(loan_outstanding_principal_paise(l.id)), 0)::bigint
  from loans l
  where l.group_id = fn_assert_member_of(p_group_id)
    and l.status in ('approved', 'disbursed')
$$;

create or replace function cash_float_balance_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(case when direction = 'in' then amount_paise
                           else -amount_paise end), 0)::bigint
  from cash_ledger where group_id = fn_assert_member_of(p_group_id)
$$;

create or replace function active_member_count(
  p_group_id uuid default current_group_id()
) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from members
  where group_id = fn_assert_member_of(p_group_id)
    and left_on is null and status = 'active'
$$;

create or replace function fn_expenses_ytd_paise(
  p_year int,
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from expenses
  where group_id = fn_assert_member_of(p_group_id)
    and status in ('approved', 'paid')
    and not is_loan_write_off
    and not is_writeoff_recovery
    and extract(year from incurred_on)::int = p_year
$$;

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
    and group_id  = fn_assert_member_of(p_group_id)
$$;

create or replace function loan_arrears_paise(
  p_loan_id uuid,
  p_as_of date default current_date,
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(0,
    coalesce((select sum(i.principal_paise) from loan_instalments i
              where i.loan_id = p_loan_id
                and i.group_id = fn_assert_member_of(p_group_id)
                and i.due_on <= p_as_of), 0)
    - coalesce((select sum(r.principal_paise) from loan_repayments r
                where r.loan_id = p_loan_id
                  and r.group_id = fn_assert_member_of(p_group_id)
                  and r.paid_on <= p_as_of), 0)
  )::bigint
$$;

create or replace function loan_next_due(
  p_loan_id uuid,
  p_as_of date default current_date,
  p_group_id uuid default current_group_id()
) returns date
language sql stable security definer set search_path = public, pg_temp as $$
  select min(due_on) from loan_instalments
  where loan_id = p_loan_id
    and group_id = fn_assert_member_of(p_group_id)
    and due_on > p_as_of
$$;

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
  perform fn_assert_member_of(p_group_id);

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

create or replace function fn_distributable_paise(
  p_kind distribution_kind_enum,
  p_group_id uuid default current_group_id()
) returns bigint
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cash bigint;
  v_amt  bigint;
begin
  perform fn_assert_member_of(p_group_id);

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

-- member_paid_out_paise takes no group at all -- it reads current_group_id()
-- directly, so a forged claim reaches no rows the member cannot already see.
-- Restated here with the membership check made explicit rather than implied.
create or replace function member_paid_out_paise(p_member_id uuid)
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from member_payouts
  where member_id = p_member_id
    and group_id = fn_assert_member_of(current_group_id())
$$;
