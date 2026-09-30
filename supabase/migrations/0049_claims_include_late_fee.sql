-- 0049_claims_include_late_fee.sql
--
-- A late UPI payment put Rs.50 into the fund that nobody paid.
--
-- The pay sheet asked for the month's Rs.500. The member sent Rs.500 and
-- claimed Rs.500. confirm_payment_claim() handed that Rs.500 to
-- record_contribution(), which -- correctly, for a cashier taking cash --
-- added the Rs.50 late fee ON TOP. The receipt said Rs.550, the fund said
-- Rs.550, the bank had Rs.500.
--
-- For a cash payment "amount + fee" is right: the cashier collects both. For
-- a claim it is wrong: the claim is what ARRIVED, and the ledger must record
-- exactly that. So:
--
--   * payment_quote() is the one place that says what a member has to send
--     now: what is still owed, plus the late fee if this payment is late and
--     none has been charged yet, less what is already claimed. The pay sheet
--     shows it and the UPI link asks for it.
--   * claim_payment() refuses more than that quote.
--   * confirm_payment_claim() splits the claim: the fee record_contribution()
--     will charge comes out of it first, the rest is the deposit. Afterwards
--     amount + fee must equal the claim, or nothing is recorded.

-- ---------------------------------------------------------------------------
-- The fee a payment dated p_paid_on would be charged. Mirrors the rule in
-- record_contribution() ("late once is late once") so the split below matches
-- what that function then does; the equality check in confirm makes any
-- future drift refuse loudly instead of inflating the fund.
-- ---------------------------------------------------------------------------
create or replace function fn_late_fee_due_paise(
  p_period_id uuid, p_member_id uuid, p_paid_on date
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_paid_on > p.grace_date
     and not exists (select 1 from contributions c
                     where c.period_id = p.id and c.member_id = p_member_id
                       and c.late_fee_paise > 0)
    then g.late_fee_paise
    else 0
  end::bigint
  from contribution_periods p
  join groups g on g.id = p.group_id
  where p.id = p_period_id
    and p.group_id = fn_assert_member_of(current_group_id())
$$;

revoke all on function fn_late_fee_due_paise(uuid, uuid, date) from public, anon;
grant execute on function fn_late_fee_due_paise(uuid, uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- What the signed-in member has to send for a month, paying on p_paid_on.
-- ---------------------------------------------------------------------------
create or replace function payment_quote(
  p_period_id uuid, p_paid_on date default current_date
) returns table (
  due_paise bigint, late_fee_paise bigint, pending_paise bigint, to_pay_paise bigint
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_group   uuid := current_group_id();
  v_me      uuid := fn_assert_active_member();
  v_period  contribution_periods;
  v_due     bigint;
  v_fee     bigint;
  v_pending bigint;
begin
  select * into v_period from contribution_periods
  where id = p_period_id and group_id = v_group;
  if v_period.id is null then
    raise exception 'Unknown month' using errcode = 'foreign_key_violation';
  end if;

  v_due := greatest(0, v_period.amount_paise
                       - member_period_paid_paise(p_period_id, v_me, v_group));
  v_fee := fn_late_fee_due_paise(p_period_id, v_me, p_paid_on);
  select coalesce(sum(amount_paise), 0) into v_pending
  from payment_claims
  where period_id = p_period_id and member_id = v_me and status = 'pending';

  -- A pending claim may already carry the fee (a late claim of Rs.550), so
  -- it is subtracted from deposit + fee together. Once the deposit is fully
  -- claimed there is nothing more to send -- the fee included, because a
  -- claim dated on time owes none.
  return query select
    v_due,
    v_fee,
    v_pending,
    case when v_due > v_pending then v_due + v_fee - v_pending else 0 end::bigint;
end $$;

revoke all on function payment_quote(uuid, date) from public, anon;
grant execute on function payment_quote(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- claim_payment: same checks as 0046, with the cap taken from the quote.
-- ---------------------------------------------------------------------------
create or replace function claim_payment(
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
  v_q       record;
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

  select * into v_q from payment_quote(p_period_id, p_paid_on);
  if p_amount_paise > v_q.to_pay_paise then
    raise exception 'That is more than you owe for %. Rs.% is still due%',
      to_char(v_period.period_month, 'Mon YYYY'),
      fmt_rupees(v_q.to_pay_paise),
      case when v_q.late_fee_paise > 0 and v_q.to_pay_paise > 0
           then ', including the Rs.' || fmt_rupees(v_q.late_fee_paise) || ' late fee' else '' end
      || case when v_q.pending_paise > 0 then ' after the payment already waiting to be confirmed' else '' end
      using errcode = 'check_violation';
  end if;
  -- A late payment must at least cover the fee, or confirming it would record
  -- a deposit of nothing.
  if p_amount_paise <= v_q.late_fee_paise and v_q.pending_paise = 0 then
    raise exception 'A late payment must be more than the Rs.% late fee',
      fmt_rupees(v_q.late_fee_paise) using errcode = 'check_violation';
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

-- ---------------------------------------------------------------------------
-- confirm_payment_claim: the claim is the total that arrived.
-- ---------------------------------------------------------------------------
create or replace function confirm_payment_claim(p_claim_id uuid)
returns payment_claims
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_claim payment_claims;
  v_fee   bigint;
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

  -- Same rows record_contribution() is about to lock and read.
  perform 1 from contributions
  where period_id = v_claim.period_id and member_id = v_claim.member_id
  for update;

  v_fee := fn_late_fee_due_paise(v_claim.period_id, v_claim.member_id, v_claim.paid_on);
  if v_claim.amount_paise <= v_fee then
    raise exception 'This payment of Rs.% does not cover the Rs.% late fee - turn it down and ask for the full amount',
      fmt_rupees(v_claim.amount_paise), fmt_rupees(v_fee)
      using errcode = 'check_violation';
  end if;

  -- Every contribution rule, applied by the function that owns them.
  v_contr := record_contribution(
    v_claim.period_id, v_claim.member_id, v_claim.amount_paise - v_fee, v_claim.paid_on,
    v_claim.method,
    concat_ws(' · ', upper(v_claim.method::text) || ' claim', v_claim.reference));

  -- The invariant this migration exists for: the fund grows by exactly what
  -- arrived. Refuse (and roll back) rather than record a rupee that did not.
  if v_contr.amount_paise + v_contr.late_fee_paise <> v_claim.amount_paise then
    raise exception 'Recorded Rs.% for a payment of Rs.% - nothing was saved',
      fmt_rupees(v_contr.amount_paise + v_contr.late_fee_paise), fmt_rupees(v_claim.amount_paise)
      using errcode = 'check_violation';
  end if;

  update payment_claims
  set status = 'confirmed', decided_by = v_actor, decided_at = now(),
      contribution_id = v_contr.id
  where id = v_claim.id
  returning * into v_claim;
  return v_claim;
end $$;
