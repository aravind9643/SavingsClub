-- 0046_upi_claims_bank_deposit.sql
--
-- Three pieces of one loop -- a member pays by UPI, says so, the cashier
-- confirms, and the cash that did come in by hand reaches the bank:
--
--   1. deposit_cash_to_bank()   cash in hand -> the bank, as its own act
--   2. groups.upi_id            where members pay, set by the admin
--   3. payment_claims           "I've paid" from the member, confirmed or
--                               rejected by the cashier / accountant
--
-- Nothing here writes a contribution by any route but record_contribution().
-- A confirmed claim goes through it, so every rule it enforces -- closed
-- months, overpayment, the late fee charged once -- applies unchanged.

-- ---------------------------------------------------------------------------
-- 1. Cash into the bank
-- ---------------------------------------------------------------------------
-- The commonest cash movement a cashier makes had no name. It had to be
-- entered as a generic "cash out" with a typed purpose, and when it was not
-- entered at all the books expected the money in hand while the bank already
-- held it: Rs.2,000 in the bank, Rs.0 expected, a mismatch alert, and no
-- money actually missing.
--
-- It moves nothing in the fund -- money in the bank and money in hand are both
-- the group's -- so it is only a cash_ledger row. The existing float trigger
-- refuses a deposit larger than the cash held.
drop function if exists deposit_cash_to_bank(bigint, date, text);

create function deposit_cash_to_bank(
  p_amount_paise bigint,
  p_deposited_on date default current_date,
  p_reference    text default null
) returns cash_ledger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_cfg   groups;
  v_held  bigint;
  v_row   cash_ledger;
begin
  if current_role_of() <> 'cashier' then
    raise exception 'Only the cashier holds the cash' using errcode = 'insufficient_privilege';
  end if;
  if p_amount_paise is null or p_amount_paise <= 0 then
    raise exception 'Amount must be more than zero' using errcode = 'check_violation';
  end if;
  if p_deposited_on is null or p_deposited_on > current_date then
    raise exception 'A deposit cannot be dated in the future' using errcode = 'check_violation';
  end if;

  -- groups first: the same lock every money RPC takes, so two deposits of the
  -- same cash cannot both see it available.
  select * into v_cfg from groups where id = v_group for no key update;

  v_held := cash_float_balance_paise(v_group);
  if p_amount_paise > v_held then
    raise exception 'Only Rs.% is in hand - you cannot deposit Rs.%',
      fmt_rupees(v_held), fmt_rupees(p_amount_paise) using errcode = 'check_violation';
  end if;

  insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose,
                           counterparty, recorded_by, reported_at, reported_by)
  values (v_group, 'out', p_amount_paise,
          -- Today's deposit is stamped now; a back-dated one at the start of
          -- its day. Never in the future, which record_cash_movement refuses.
          case when p_deposited_on = current_date then now() else p_deposited_on::timestamptz end,
          'Deposited into the bank',
          nullif(btrim(coalesce(p_reference, '')), ''),
          v_actor, now(), v_actor)
  returning * into v_row;

  return v_row;
end $$;

revoke all on function deposit_cash_to_bank(bigint, date, text) from public, anon;
grant execute on function deposit_cash_to_bank(bigint, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The group's UPI ID
-- ---------------------------------------------------------------------------
-- Columns on groups, like every other group setting. Its own RPC rather than
-- another update_config() parameter: adding one would create a second
-- update_config beside the first (AGENTS.md rule 2) for a setting that is
-- nothing to do with the money rules that function validates.
alter table groups add column if not exists upi_id text;
alter table groups add column if not exists upi_payee_name text;

-- A VPA is handle@bank: letters, digits, dot, dash, underscore, then one @.
-- Checked here so a typo is refused when saved, not discovered when every
-- member's payment app says "invalid UPI ID".
alter table groups drop constraint if exists groups_upi_id_format;
alter table groups add constraint groups_upi_id_format
  check (upi_id is null or (length(upi_id) <= 255 and upi_id ~ '^[A-Za-z0-9._-]{2,}@[A-Za-z][A-Za-z0-9.-]{1,63}$'));

drop function if exists set_group_upi(text, text);

create function set_group_upi(p_upi_id text, p_payee_name text default null)
returns groups
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_row   groups;
  v_id    text := nullif(lower(btrim(coalesce(p_upi_id, ''))), '');
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('admin', 'cashier', 'accountant') then
    raise exception 'Only an officer may set where members pay'
      using errcode = 'insufficient_privilege';
  end if;
  if v_id is not null and (length(v_id) > 255 or v_id !~ '^[a-z0-9._-]{2,}@[a-z][a-z0-9.-]{1,63}$') then
    raise exception 'That does not look like a UPI ID - it should be like name@bank'
      using errcode = 'check_violation';
  end if;

  update groups
  set upi_id = v_id,
      upi_payee_name = nullif(btrim(coalesce(p_payee_name, '')), '')
  where id = v_group
  returning * into v_row;
  return v_row;
end $$;

revoke all on function set_group_upi(text, text) from public, anon;
grant execute on function set_group_upi(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. "I've paid"
-- ---------------------------------------------------------------------------
-- A claim is not money. It is a member's statement that they sent it, which
-- stays out of every fund figure until an officer has seen it arrive and
-- confirmed -- at which point it becomes an ordinary contribution. Until
-- then the member is still on the chase-list; the app shows them as
-- "waiting for confirmation" rather than "owes".
create table if not exists payment_claims (
  id              uuid primary key default gen_random_uuid(),
  group_id        uuid not null references groups (id),
  period_id       uuid not null,
  member_id       uuid not null,
  amount_paise    bigint not null check (amount_paise > 0),
  paid_on         date not null,
  method          payment_method_enum not null check (method in ('upi', 'bank')),
  reference       text,
  status          text not null default 'pending'
                  check (status in ('pending', 'confirmed', 'rejected', 'withdrawn')),
  submitted_at    timestamptz not null default now(),
  decided_by      uuid references members (id),
  decided_at      timestamptz,
  decision_note   text,
  contribution_id uuid references contributions (id),
  -- The same composite shape as every child table: the copied group_id can
  -- never disagree with the month's or the member's.
  foreign key (group_id, period_id) references contribution_periods (group_id, id),
  foreign key (group_id, member_id) references members (group_id, id),
  check ((status = 'pending') = (decided_at is null)),
  check (status <> 'confirmed' or contribution_id is not null),
  check (status <> 'rejected' or nullif(btrim(decision_note), '') is not null)
);

create index if not exists payment_claims_group_status_idx on payment_claims (group_id, status);
create index if not exists payment_claims_member_idx on payment_claims (member_id, period_id);

-- A UPI transaction reference identifies one payment. Two claims quoting the
-- same one in a group are the same money claimed twice.
create unique index if not exists payment_claims_reference_key
  on payment_claims (group_id, lower(reference))
  where reference is not null and status in ('pending', 'confirmed');

alter table payment_claims enable row level security;

drop policy if exists payment_claims_read on payment_claims;
create policy payment_claims_read on payment_claims
  for select to authenticated
  using (group_id = current_group_id() and in_current_group());

revoke insert, update, delete on payment_claims from authenticated, anon;
grant select on payment_claims to authenticated;

-- --- the member says they paid ---------------------------------------------
drop function if exists claim_payment(uuid, bigint, date, payment_method_enum, text);

create function claim_payment(
  p_period_id    uuid,
  p_amount_paise bigint,
  p_paid_on      date default current_date,
  p_method       payment_method_enum default 'upi',
  p_reference    text default null
) returns payment_claims
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group   uuid := current_group_id();
  v_me      uuid := fn_assert_active_member();
  v_period  contribution_periods;
  v_paid    bigint;
  v_pending bigint;
  v_ref     text := nullif(btrim(coalesce(p_reference, '')), '');
  v_row     payment_claims;
begin
  if p_method not in ('upi', 'bank') then
    raise exception 'Cash is handed to the cashier, who records it - there is nothing to claim'
      using errcode = 'check_violation';
  end if;
  if p_amount_paise is null or p_amount_paise <= 0 then
    raise exception 'Amount must be more than zero' using errcode = 'check_violation';
  end if;
  if p_paid_on is null or p_paid_on > current_date then
    raise exception 'A payment cannot be dated in the future' using errcode = 'check_violation';
  end if;
  if p_method = 'upi' and v_ref is null then
    raise exception 'Add the UPI transaction ID so the cashier can find your payment'
      using errcode = 'check_violation';
  end if;

  select * into v_period from contribution_periods
  where id = p_period_id and group_id = v_group
  for update;
  if v_period.id is null then
    raise exception 'Unknown month' using errcode = 'foreign_key_violation';
  end if;
  if v_period.closed_at is not null then
    raise exception 'That month is closed - ask the cashier to record it in the current month'
      using errcode = 'check_violation';
  end if;
  if p_paid_on < v_period.period_month then
    raise exception 'Payment date is before the month it is for'
      using errcode = 'check_violation';
  end if;

  -- Claimed-but-unconfirmed counts against what is still owed, or two claims
  -- for the same Rs.500 would both look payable until the second was refused
  -- at confirmation -- after the member had been told it went through.
  v_paid := member_period_paid_paise(p_period_id, v_me, v_group);
  select coalesce(sum(amount_paise), 0) into v_pending
  from payment_claims
  where period_id = p_period_id and member_id = v_me and status = 'pending';

  if v_paid + v_pending + p_amount_paise > v_period.amount_paise then
    raise exception 'That is more than you owe for %. Rs.% is still due%',
      to_char(v_period.period_month, 'Mon YYYY'),
      fmt_rupees(greatest(0, v_period.amount_paise - v_paid - v_pending)),
      case when v_pending > 0 then ' after the payment already waiting to be confirmed' else '' end
      using errcode = 'check_violation';
  end if;

  begin
    insert into payment_claims (group_id, period_id, member_id, amount_paise, paid_on, method, reference)
    values (v_group, p_period_id, v_me, p_amount_paise, p_paid_on, p_method, v_ref)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'That transaction ID has already been claimed in this group'
      using errcode = 'unique_violation';
  end;
  return v_row;
end $$;

-- --- an officer confirms it arrived ----------------------------------------
drop function if exists confirm_payment_claim(uuid);

create function confirm_payment_claim(p_claim_id uuid)
returns payment_claims
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_claim payment_claims;
  v_contr contributions;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may confirm a payment'
      using errcode = 'insufficient_privilege';
  end if;

  perform 1 from groups where id = v_group for no key update;
  select * into v_claim from payment_claims
  where id = p_claim_id and group_id = v_group
  for update;
  if v_claim.id is null then
    raise exception 'Payment not found' using errcode = 'no_data_found';
  end if;
  if v_claim.status <> 'pending' then
    raise exception 'This payment has already been dealt with' using errcode = 'check_violation';
  end if;
  if v_claim.member_id = v_actor then
    raise exception 'Someone else must confirm a payment you made yourself'
      using errcode = 'insufficient_privilege';
  end if;

  -- Every contribution rule, applied by the function that owns them.
  v_contr := record_contribution(
    v_claim.period_id, v_claim.member_id, v_claim.amount_paise, v_claim.paid_on,
    v_claim.method,
    concat_ws(' · ', upper(v_claim.method::text) || ' claim', v_claim.reference));

  update payment_claims
  set status = 'confirmed', decided_by = v_actor, decided_at = now(),
      contribution_id = v_contr.id
  where id = v_claim.id
  returning * into v_claim;
  return v_claim;
end $$;

-- --- or says it did not ----------------------------------------------------
drop function if exists reject_payment_claim(uuid, text);

create function reject_payment_claim(p_claim_id uuid, p_reason text)
returns payment_claims
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_claim payment_claims;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may turn a payment down'
      using errcode = 'insufficient_privilege';
  end if;
  -- The member is owed a reason: "not received" is one, silence is not.
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why, so the member knows what to check' using errcode = 'check_violation';
  end if;

  update payment_claims
  set status = 'rejected', decided_by = v_actor, decided_at = now(),
      decision_note = btrim(p_reason)
  where id = p_claim_id and group_id = v_group and status = 'pending'
  returning * into v_claim;
  if v_claim.id is null then
    raise exception 'Payment not found, or already dealt with' using errcode = 'no_data_found';
  end if;
  return v_claim;
end $$;

-- --- the member takes it back (typed the wrong amount, say) ----------------
drop function if exists withdraw_payment_claim(uuid);

create function withdraw_payment_claim(p_claim_id uuid)
returns payment_claims
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_me    uuid := fn_assert_active_member();
  v_claim payment_claims;
begin
  update payment_claims
  set status = 'withdrawn', decided_by = v_me, decided_at = now()
  where id = p_claim_id and group_id = v_group and member_id = v_me and status = 'pending'
  returning * into v_claim;
  if v_claim.id is null then
    raise exception 'Payment not found, or already dealt with' using errcode = 'no_data_found';
  end if;
  return v_claim;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'claim_payment(uuid, bigint, date, payment_method_enum, text)',
    'confirm_payment_claim(uuid)',
    'reject_payment_claim(uuid, text)',
    'withdraw_payment_claim(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- Audited like every business table (0045), and live like the ones the app
-- listens to (0044).
select fn_attach_audit_triggers();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and tablename = 'payment_claims') then
    alter publication supabase_realtime add table public.payment_claims;
  end if;
end $$;
