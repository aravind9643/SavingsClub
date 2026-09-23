-- 0003_cash.sql
-- The cashier's emergency cash float (Rs.5,000 cap) and the 24-hour
-- reporting rule.
--
-- The running balance is NOT stored. A stored balance column desyncs the
-- moment anything is inserted out of order; it is derived from the ledger.

create table cash_ledger (
  id           uuid primary key default gen_random_uuid(),
  direction    cash_direction_enum not null,
  amount_paise bigint not null check (amount_paise > 0),
  occurred_at  timestamptz not null default now(),
  purpose      text not null check (length(btrim(purpose)) > 0),
  counterparty text,
  expense_id   uuid,                       -- FK added in 0006 once expenses exists
  reported_at  timestamptz,                -- null => not yet told to the group
  reported_by  uuid references members (id),
  recorded_by  uuid not null references members (id),
  created_at   timestamptz not null default now(),
  constraint reported_fields_together check (
    (reported_at is null and reported_by is null)
    or (reported_at is not null and reported_by is not null)
  )
);

create index cash_ledger_time_idx on cash_ledger (occurred_at desc);
create index cash_ledger_unreported_idx on cash_ledger (occurred_at)
  where reported_at is null;

create or replace function cash_float_balance_paise() returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(
    case when direction = 'in' then amount_paise else -amount_paise end
  ), 0)::bigint
  from cash_ledger
$$;

-- ---------------------------------------------------------------------------
-- The float cap is a hard control, so it is enforced in the database rather
-- than the UI. The cashier's legitimate escape hatch when the float is full is
-- a 'Deposited to bank' out-entry, not an override.
-- ---------------------------------------------------------------------------
create or replace function fn_enforce_cash_float_limit() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_limit   bigint;
  v_balance bigint;
begin
  select cash_float_limit_paise into v_limit from app_config where id;
  v_balance := cash_float_balance_paise();

  if v_balance > v_limit then
    raise exception
      'Cash float would reach % but the limit is % -- deposit into the bank first',
      (v_balance::numeric / 100)::text, (v_limit::numeric / 100)::text
      using errcode = 'check_violation';
  end if;

  if v_balance < 0 then
    raise exception 'Cash float cannot go negative (would be %)',
      (v_balance::numeric / 100)::text
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

-- AFTER + STATEMENT-level so the balance is evaluated once on the final state.
create trigger trg_cash_float_limit
  after insert or update or delete on cash_ledger
  for each statement execute function fn_enforce_cash_float_limit();

-- ---------------------------------------------------------------------------
-- record_cash_movement: cashier-only write path.
-- ---------------------------------------------------------------------------
create or replace function record_cash_movement(
  p_direction cash_direction_enum,
  p_amount_paise bigint,
  p_purpose text,
  p_occurred_at timestamptz default now(),
  p_counterparty text default null,
  p_report_now boolean default false
) returns cash_ledger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := current_member_id();
  v_row   cash_ledger;
begin
  if v_actor is null then
    raise exception 'Not an active member' using errcode = 'insufficient_privilege';
  end if;
  if current_role_of() <> 'cashier' then
    raise exception 'Only the cashier holds the float'
      using errcode = 'insufficient_privilege';
  end if;

  insert into cash_ledger (direction, amount_paise, occurred_at, purpose,
                           counterparty, recorded_by, reported_at, reported_by)
  values (p_direction, p_amount_paise, p_occurred_at, p_purpose,
          p_counterparty, v_actor,
          case when p_report_now then now() end,
          case when p_report_now then v_actor end)
  returning * into v_row;

  return v_row;
end $$;

-- Reporting a spend to the group is a separate act from recording it, because
-- the 24-hour rule measures the gap between the two.
create or replace function report_cash_movement(p_id uuid)
returns cash_ledger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := current_member_id();
  v_row   cash_ledger;
begin
  if v_actor is null then
    raise exception 'Not an active member' using errcode = 'insufficient_privilege';
  end if;

  update cash_ledger
  set reported_at = now(), reported_by = v_actor
  where id = p_id and reported_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Cash entry not found or already reported'
      using errcode = 'check_violation';
  end if;
  return v_row;
end $$;

revoke execute on function record_cash_movement(cash_direction_enum, bigint, text,
  timestamptz, text, boolean) from public, anon;
revoke execute on function report_cash_movement(uuid) from public, anon;
revoke execute on function cash_float_balance_paise() from public, anon;

grant execute on function record_cash_movement(cash_direction_enum, bigint, text,
  timestamptz, text, boolean) to authenticated;
grant execute on function report_cash_movement(uuid) to authenticated;
grant execute on function cash_float_balance_paise() to authenticated;

alter table cash_ledger enable row level security;

create policy cash_read on cash_ledger
  for select to authenticated using (is_group_member());

revoke insert, update, delete on cash_ledger from authenticated, anon;
