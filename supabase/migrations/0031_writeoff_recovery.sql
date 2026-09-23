-- 0031_writeoff_recovery.sql
--
-- A written-off loan was a dead end. Borrowers sometimes pay anyway.
--
-- The status machine allowed disbursed -> written_off and nothing after it, so
-- when a member who had been written off turned up eighteen months later with
-- the money, there was no way to record it. The options were to leave the
-- group's books permanently understating what it held, or to invent a fake
-- contribution -- which would then distort that member's share and every
-- payout computed from it.
--
-- This happens often enough in real groups that it has a name: recovery. It
-- is usually partial, usually late, and always worth recording, because it is
-- the evidence that the write-off was a timing problem rather than a loss.
--
-- HOW IT BOOKS
--
-- The write-off booked an expense (0020) for the principal lost. A recovery
-- reverses that expense to the extent recovered -- as a NEGATIVE expense
-- amount rather than a contribution, so it lands in exactly the account the
-- loss came out of and the two net correctly in every report.
--
-- Any interest or penalty recovered goes through loan_repayments as normal
-- interest income, because that is what it is.

alter table expenses
  add column if not exists is_writeoff_recovery boolean not null default false;

comment on column expenses.is_writeoff_recovery is
  'A negative expense reversing a loan write-off, to the extent the money came '
  'back. Excluded from the annual expense cap, like the write-off it reverses.';

-- ---------------------------------------------------------------------------
-- The status machine gains one transition.
--
-- written_off -> closed, and only once nothing is outstanding. A partial
-- recovery leaves the loan written off, which is truthful: some of it is
-- still lost.
--
-- Every other transition is unchanged.
-- ---------------------------------------------------------------------------
create or replace function fn_loan_status_transition() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if old.status = new.status then
    return new;
  end if;

  if not (
    (old.status = 'requested' and new.status in ('approved', 'rejected'))
    or (old.status = 'approved'  and new.status in ('disbursed', 'rejected'))
    or (old.status = 'disbursed' and new.status in ('closed', 'written_off'))
    or (old.status = 'written_off' and new.status = 'closed')
  ) then
    raise exception 'Illegal loan status transition % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- record_recovery: money back on a loan the group had given up on.
-- ---------------------------------------------------------------------------
create or replace function record_recovery(
  p_loan_id uuid,
  p_principal_paise bigint default 0,
  p_interest_paise bigint default 0,
  p_paid_on date default current_date,
  p_method payment_method_enum default 'bank',
  p_note text default null
) returns loan_repayments
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_loan  loans;
  v_lost  bigint;
  v_back  bigint;
  v_name  text;
  v_row   loan_repayments;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may record money coming back'
      using errcode = 'insufficient_privilege';
  end if;

  perform 1 from groups where id = v_group for no key update;

  select * into v_loan from loans
  where id = p_loan_id and group_id = v_group for update;

  if v_loan.id is null then
    raise exception 'Loan not found' using errcode = 'no_data_found';
  end if;
  if v_loan.status <> 'written_off' then
    raise exception 'This loan was not written off - record a normal repayment instead'
      using errcode = 'check_violation';
  end if;
  if p_principal_paise < 0 or p_interest_paise < 0 then
    raise exception 'An amount cannot be less than zero' using errcode = 'check_violation';
  end if;
  if p_principal_paise + p_interest_paise <= 0 then
    raise exception 'Enter an amount' using errcode = 'check_violation';
  end if;
  if p_paid_on > current_date then
    raise exception 'A payment cannot be dated in the future'
      using errcode = 'check_violation';
  end if;

  -- The group cannot recover more principal than it wrote off.
  v_lost := loan_outstanding_principal_paise(p_loan_id);
  if p_principal_paise > v_lost then
    raise exception 'Only Rs.% of this loan was written off',
      (v_lost::numeric / 100)::text using errcode = 'check_violation';
  end if;

  select full_name into v_name from members where id = v_loan.borrower_id;

  -- The trigger that auto-closes a settled loan only fires for 'disbursed',
  -- so a written-off loan is not closed behind our back here. The close is
  -- decided explicitly below.
  insert into loan_repayments (
    group_id, loan_id, paid_on, principal_paise, interest_paise, penalty_paise,
    method, note, recorded_by
  )
  values (v_group, p_loan_id, p_paid_on, p_principal_paise, p_interest_paise, 0,
          p_method, coalesce(p_note, 'Recovered after write-off'), v_actor)
  returning * into v_row;

  -- Reverse the loss, to the extent it came back.
  if p_principal_paise > 0 then
    insert into expenses (
      group_id, category, description, amount_paise, incurred_on, method,
      requires_vote, fund_total_at_request_paise, required_approvals,
      eligible_voter_count, created_by, status, decided_at, paid_on,
      is_loan_write_off, is_writeoff_recovery
    )
    values (
      v_group, 'other',
      'Recovered from ' || coalesce(v_name, 'a member')
        || ' on a loan written off earlier',
      -p_principal_paise, p_paid_on, p_method,
      false, fn_fund_total_paise(v_group), 0,
      active_member_count(v_group), v_actor, 'paid', now(), p_paid_on,
      false, true
    );
  end if;

  if p_method = 'cash' then
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at,
                             purpose, counterparty, recorded_by,
                             reported_at, reported_by)
    values (v_group, 'in', p_principal_paise + p_interest_paise,
            p_paid_on::timestamptz, 'Recovered on a written-off loan',
            v_name, v_actor, now(), v_actor);
  end if;

  -- Fully recovered: the loan is closed rather than written off, and the
  -- record shows it came good in the end.
  v_back := loan_outstanding_principal_paise(p_loan_id);
  if v_back = 0 then
    update loans set status = 'closed', closed_on = p_paid_on
    where id = p_loan_id;
  end if;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- The expense check constraint has to allow a negative amount now.
--
-- Dropped by catalog lookup rather than by a guessed name, for the same
-- reason 0012 learned to do that with triggers.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    where c.relname = 'expenses'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%amount_paise%'
      and pg_get_constraintdef(con.oid) ilike '%> 0%'
  loop
    execute format('alter table expenses drop constraint %I', r.conname);
  end loop;
end $$;

alter table expenses
  drop constraint if exists expenses_amount_nonzero;
alter table expenses
  add constraint expenses_amount_nonzero check (amount_paise <> 0);

-- ---------------------------------------------------------------------------
-- Keep the recovery out of the yearly spending cap.
--
-- fn_expenses_ytd_paise() sums approved and paid expenses to enforce the
-- annual limit, excluding write-offs because the cap governs CHOSEN spending.
-- A recovery is a negative expense, so left in it would SUBTRACT from the
-- year's total and quietly raise the ceiling -- a group that recovered
-- Rs.20,000 could then spend Rs.20,000 more than its own rule allows.
--
-- Same reasoning as the write-off exclusion, opposite sign.
-- ---------------------------------------------------------------------------
create or replace function fn_expenses_ytd_paise(
  p_year int,
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from expenses
  where group_id = p_group_id
    and status in ('approved', 'paid')
    and not is_loan_write_off
    and not is_writeoff_recovery
    and extract(year from incurred_on)::int = p_year
$$;

revoke execute on function record_recovery(uuid, bigint, bigint, date,
                                           payment_method_enum, text)
  from public, anon;
grant execute on function record_recovery(uuid, bigint, bigint, date,
                                          payment_method_enum, text)
  to authenticated;
