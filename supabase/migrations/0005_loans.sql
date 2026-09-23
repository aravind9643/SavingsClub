-- 0005_loans.sql
-- Loans, repayments, interest accrual and the fund caps.
--
-- Interest policy (decided with the group, recorded here because it is the
-- single most argued-about number in a savings group):
--   * SIMPLE interest on the REDUCING principal balance, accrued per day at
--     rate_bp/month over a 30-day month.
--   * The overdue rate applies ONLY to days after the due date, never
--     retroactively to the whole term.
--   * Interest is rounded to whole paise, half-up, at the point of accrual.
--
-- "Interest income" in the fund math means interest ACTUALLY RECEIVED
-- (loan_repayments.interest_paise). Accrued-but-unpaid interest is a
-- receivable shown separately -- mixing the two is what makes a
-- reconciliation that can never reach zero.

create type loan_status_enum as enum (
  'requested', 'approved', 'rejected', 'disbursed', 'closed', 'written_off'
);

create table loans (
  id                  uuid primary key default gen_random_uuid(),
  borrower_id         uuid not null references members (id),
  guarantor_id        uuid not null references members (id),
  principal_paise     bigint not null check (principal_paise > 0),
  purpose             text,
  rate_bp             int not null check (rate_bp >= 0),
  overdue_rate_bp     int not null check (overdue_rate_bp >= 0),
  term_months         int not null check (term_months between 1 and 12),
  status              loan_status_enum not null default 'requested',
  requested_at        timestamptz not null default now(),
  decided_at          timestamptz,
  disbursed_on        date,
  due_on              date,
  closed_on           date,
  -- Snapshots taken at request time. Eligibility is computed from these, not
  -- from live state, so a role rotation or a member leaving mid-vote cannot
  -- silently move the goalposts.
  fund_total_at_request_paise bigint not null,
  eligible_voter_count        int not null check (eligible_voter_count >= 0),
  required_approvals          int not null check (required_approvals > 0),
  borrower_role_at_request    role_enum not null,
  created_at          timestamptz not null default now(),
  constraint borrower_is_not_guarantor check (borrower_id <> guarantor_id),
  constraint disbursed_needs_date check (
    status <> 'disbursed' or (disbursed_on is not null and due_on is not null)
  )
);

create index loans_borrower_open_idx on loans (borrower_id)
  where status in ('approved', 'disbursed');
create index loans_status_idx on loans (status);

create table loan_votes (
  id       uuid primary key default gen_random_uuid(),
  loan_id  uuid not null references loans (id) on delete cascade,
  voter_id uuid not null references members (id),
  vote     vote_enum not null,
  note     text,
  voted_at timestamptz not null default now(),
  unique (loan_id, voter_id)
);

create index loan_votes_loan_idx on loan_votes (loan_id);

create table loan_repayments (
  id              uuid primary key default gen_random_uuid(),
  loan_id         uuid not null references loans (id),
  paid_on         date not null,
  principal_paise bigint not null default 0 check (principal_paise >= 0),
  interest_paise  bigint not null default 0 check (interest_paise >= 0),
  penalty_paise   bigint not null default 0 check (penalty_paise >= 0),
  method          payment_method_enum not null default 'bank',
  note            text,
  recorded_by     uuid not null references members (id),
  created_at      timestamptz not null default now(),
  constraint repayment_is_not_empty check (
    principal_paise + interest_paise + penalty_paise > 0
  )
);

create index loan_repayments_loan_idx on loan_repayments (loan_id, paid_on);

-- ---------------------------------------------------------------------------
-- Status transitions. Without this a client could flip a 'requested' loan
-- straight to 'disbursed' and skip the vote entirely.
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
  ) then
    raise exception 'Illegal loan status transition % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger trg_loan_status_transition
  before update on loans
  for each row execute function fn_loan_status_transition();

-- ---------------------------------------------------------------------------
-- Outstanding principal for a loan / a member.
-- ---------------------------------------------------------------------------
create or replace function loan_outstanding_principal_paise(p_loan_id uuid)
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(
    0,
    (select l.principal_paise from loans l where l.id = p_loan_id)
    - coalesce((select sum(r.principal_paise) from loan_repayments r
                where r.loan_id = p_loan_id), 0)
  )::bigint
$$;

create or replace function member_outstanding_paise(p_member_id uuid)
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(loan_outstanding_principal_paise(l.id)), 0)::bigint
  from loans l
  where l.borrower_id = p_member_id
    and l.status in ('approved', 'disbursed')
$$;

create or replace function total_outstanding_paise() returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(loan_outstanding_principal_paise(l.id)), 0)::bigint
  from loans l
  where l.status in ('approved', 'disbursed')
$$;

-- ---------------------------------------------------------------------------
-- Interest accrual: reducing balance, per day, 30-day month.
--
-- Walks the repayment history so that the balance used for each segment is the
-- balance that actually applied during that segment.
-- ---------------------------------------------------------------------------
create or replace function loan_accrued_interest_paise(
  p_loan_id uuid,
  p_as_of date default current_date
) returns table (interest_paise bigint, penalty_paise bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_loan      loans;
  v_balance   bigint;
  v_cursor    date;
  v_interest  numeric := 0;
  v_penalty   numeric := 0;
  r           record;
  v_seg_end   date;
  v_normal_d  int;
  v_over_d    int;
begin
  select * into v_loan from loans where id = p_loan_id;
  if v_loan.id is null or v_loan.disbursed_on is null then
    return query select 0::bigint, 0::bigint;
    return;
  end if;

  v_balance := v_loan.principal_paise;
  v_cursor  := v_loan.disbursed_on;

  for r in
    select paid_on, sum(principal_paise) as principal
    from loan_repayments
    where loan_id = p_loan_id and paid_on <= p_as_of
    group by paid_on
    order by paid_on
  loop
    v_seg_end := r.paid_on;

    -- Split the segment at the due date: days before it accrue at the normal
    -- rate, days after it at the overdue rate.
    v_normal_d := greatest(0, least(v_seg_end, coalesce(v_loan.due_on, v_seg_end)) - v_cursor);
    v_over_d   := greatest(0, v_seg_end - greatest(v_cursor, coalesce(v_loan.due_on, v_seg_end)));

    v_interest := v_interest + v_balance::numeric * v_loan.rate_bp / 10000 * v_normal_d / 30;
    v_penalty  := v_penalty  + v_balance::numeric * v_loan.overdue_rate_bp / 10000 * v_over_d / 30;

    v_balance := greatest(0, v_balance - r.principal);
    v_cursor  := v_seg_end;
  end loop;

  -- Final open segment, from the last repayment to the as-of date.
  if p_as_of > v_cursor and v_balance > 0 then
    v_normal_d := greatest(0, least(p_as_of, coalesce(v_loan.due_on, p_as_of)) - v_cursor);
    v_over_d   := greatest(0, p_as_of - greatest(v_cursor, coalesce(v_loan.due_on, p_as_of)));

    v_interest := v_interest + v_balance::numeric * v_loan.rate_bp / 10000 * v_normal_d / 30;
    v_penalty  := v_penalty  + v_balance::numeric * v_loan.overdue_rate_bp / 10000 * v_over_d / 30;
  end if;

  return query select
    round(v_interest)::bigint,
    round(v_penalty)::bigint;
end $$;

-- ---------------------------------------------------------------------------
-- Auto-close a loan once principal, interest and penalty are all settled.
-- ---------------------------------------------------------------------------
create or replace function fn_close_loan_if_settled() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_loan      loans;
  v_out       bigint;
  v_accrued   record;
  v_paid_int  bigint;
begin
  select * into v_loan from loans where id = new.loan_id;
  if v_loan.status <> 'disbursed' then
    return new;
  end if;

  v_out := loan_outstanding_principal_paise(new.loan_id);
  if v_out > 0 then
    return new;
  end if;

  select * into v_accrued from loan_accrued_interest_paise(new.loan_id, new.paid_on);
  select coalesce(sum(interest_paise + penalty_paise), 0) into v_paid_int
  from loan_repayments where loan_id = new.loan_id;

  if v_paid_int >= v_accrued.interest_paise + v_accrued.penalty_paise then
    update loans
    set status = 'closed', closed_on = new.paid_on
    where id = new.loan_id;
  end if;
  return new;
end $$;

create trigger trg_close_loan_if_settled
  after insert on loan_repayments
  for each row execute function fn_close_loan_if_settled();

alter table loans           enable row level security;
alter table loan_votes      enable row level security;
alter table loan_repayments enable row level security;

create policy loans_read on loans
  for select to authenticated using (is_group_member());

-- Votes are deliberately visible to the whole group: an approval everyone can
-- see is the point of the rule.
create policy loan_votes_read on loan_votes
  for select to authenticated using (is_group_member());

create policy loan_repayments_read on loan_repayments
  for select to authenticated using (is_group_member());

create policy loan_repayments_insert on loan_repayments
  for insert to authenticated
  with check (current_role_of() in ('cashier', 'accountant'));

-- loans and loan_votes have NO write policy at all. Every mutation goes
-- through the RPCs in 0006, which is what makes self-approval and cap-bypass
-- impossible even for someone calling PostgREST directly with their own JWT.
revoke insert, update, delete on loans from authenticated, anon;
revoke insert, update, delete on loan_votes from authenticated, anon;
revoke update, delete on loan_repayments from authenticated, anon;
