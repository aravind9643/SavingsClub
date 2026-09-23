-- 0004_contributions.sql
-- Monthly contribution periods and the payments against them.
--
-- "Unpaid" is modelled as the ABSENCE of a contribution row rather than a
-- status column, so there is no second place for the truth to live. The
-- dashboard derives unpaid counts from periods x active members LEFT JOIN
-- contributions.

create table contribution_periods (
  id           uuid primary key default gen_random_uuid(),
  period_month date not null unique,       -- always the 1st of the month
  due_date     date not null,
  grace_date   date not null,
  amount_paise bigint not null check (amount_paise > 0),
  opened_at    timestamptz not null default now(),
  closed_at    timestamptz,
  constraint period_is_month_start check (date_trunc('month', period_month) = period_month),
  constraint grace_after_due check (grace_date >= due_date)
);

create index contribution_periods_month_idx on contribution_periods (period_month desc);

create table contributions (
  id             uuid primary key default gen_random_uuid(),
  period_id      uuid not null references contribution_periods (id),
  member_id      uuid not null references members (id),
  amount_paise   bigint not null check (amount_paise > 0),
  late_fee_paise bigint not null default 0 check (late_fee_paise >= 0),
  paid_on        date not null,
  method         payment_method_enum not null default 'bank',
  note           text,
  recorded_by    uuid not null references members (id),
  created_at     timestamptz not null default now(),
  unique (period_id, member_id)
);

create index contributions_period_idx on contributions (period_id);
create index contributions_member_idx on contributions (member_id);

-- ---------------------------------------------------------------------------
-- A closed period is frozen. Without this, a "correction" to last year's
-- figures could silently move the reconciliation baseline.
-- ---------------------------------------------------------------------------
create or replace function fn_block_closed_period() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_closed timestamptz;
begin
  select closed_at into v_closed
  from contribution_periods
  where id = coalesce(new.period_id, old.period_id);

  if v_closed is not null then
    raise exception 'Contribution period is closed; record a correction in a later period'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;

create trigger trg_contributions_period_open
  before insert or update on contributions
  for each row execute function fn_block_closed_period();

-- ---------------------------------------------------------------------------
-- open_period(month): create the month's period from current config.
-- ---------------------------------------------------------------------------
create or replace function open_period(p_month date)
returns contribution_periods
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cfg    app_config;
  v_start  date := date_trunc('month', p_month)::date;
  v_row    contribution_periods;
begin
  if current_member_id() is null then
    raise exception 'Not an active member' using errcode = 'insufficient_privilege';
  end if;
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may open a period'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_cfg from app_config where id;

  insert into contribution_periods (period_month, due_date, grace_date, amount_paise)
  values (
    v_start,
    v_start + (v_cfg.due_day - 1),
    v_start + (v_cfg.grace_day - 1),
    v_cfg.monthly_contribution_paise
  )
  on conflict (period_month) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from contribution_periods where period_month = v_start;
  end if;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- record_contribution: the only supported write path. Applies the late fee
-- server-side so it cannot be waived from the client.
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
  v_cfg    app_config;
  v_period contribution_periods;
  v_fee    bigint := 0;
  v_row    contributions;
  v_actor  uuid := current_member_id();
begin
  if v_actor is null then
    raise exception 'Not an active member' using errcode = 'insufficient_privilege';
  end if;
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may record contributions'
      using errcode = 'insufficient_privilege';
  end if;
  if p_amount_paise <= 0 then
    raise exception 'Amount must be positive' using errcode = 'check_violation';
  end if;

  select * into v_cfg from app_config where id;
  select * into v_period from contribution_periods where id = p_period_id;
  if v_period.id is null then
    raise exception 'Unknown contribution period' using errcode = 'foreign_key_violation';
  end if;

  if p_paid_on > v_period.grace_date then
    v_fee := v_cfg.late_fee_paise;
  end if;

  insert into contributions (
    period_id, member_id, amount_paise, late_fee_paise,
    paid_on, method, note, recorded_by
  )
  values (
    p_period_id, p_member_id, p_amount_paise, v_fee,
    p_paid_on, p_method, p_note, v_actor
  )
  returning * into v_row;

  -- A cash contribution physically enters the cashier's float. Recording it
  -- here keeps the "every rupee is in exactly one bucket" invariant that
  -- reconciliation depends on (see 0008).
  if p_method = 'cash' then
    insert into cash_ledger (direction, amount_paise, occurred_at, purpose,
                             counterparty, recorded_by, reported_at, reported_by)
    values ('in', p_amount_paise + v_fee, p_paid_on::timestamptz,
            'Contribution received in cash',
            (select full_name from members where id = p_member_id),
            v_actor, now(), v_actor);
  end if;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- close_period: freeze a month.
-- ---------------------------------------------------------------------------
create or replace function close_period(p_period_id uuid)
returns contribution_periods
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row contribution_periods;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may close a period'
      using errcode = 'insufficient_privilege';
  end if;

  update contribution_periods
  set closed_at = now()
  where id = p_period_id and closed_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Period not found or already closed' using errcode = 'check_violation';
  end if;
  return v_row;
end $$;

revoke execute on function open_period(date) from public, anon;
revoke execute on function close_period(uuid) from public, anon;
revoke execute on function record_contribution(uuid, uuid, bigint, date, payment_method_enum, text)
  from public, anon;

grant execute on function open_period(date) to authenticated;
grant execute on function close_period(uuid) to authenticated;
grant execute on function record_contribution(uuid, uuid, bigint, date, payment_method_enum, text)
  to authenticated;

alter table contribution_periods enable row level security;
alter table contributions        enable row level security;

create policy periods_read on contribution_periods
  for select to authenticated using (is_group_member());

create policy contributions_read on contributions
  for select to authenticated using (is_group_member());

-- Writes go through record_contribution() only.
revoke insert, update, delete on contribution_periods from authenticated, anon;
revoke insert, update, delete on contributions from authenticated, anon;
