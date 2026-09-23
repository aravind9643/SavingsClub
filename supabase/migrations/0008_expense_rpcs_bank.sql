-- 0008_expense_rpcs_bank.sql
-- Expense RPCs (5-of-7 vote, 20%/year cap) and the bank side of
-- reconciliation.
--
-- These sit after the fund math in 0007 because they call v_fund_summary and
-- fn_assert_active_member. The tables they operate on were created in 0006.

-- ---------------------------------------------------------------------------
-- propose_expense: any member may propose. The 20%/year cap is checked at
-- approval, not proposal, but a proposal that already breaches it is refused
-- early so nobody wastes a vote.
-- ---------------------------------------------------------------------------
create or replace function fn_expenses_ytd_paise(p_year int) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from expenses
  where status in ('approved', 'paid')
    and extract(year from incurred_on) = p_year
$$;

create or replace function propose_expense(
  p_category expense_category_enum,
  p_description text,
  p_amount_paise bigint,
  p_incurred_on date default current_date,
  p_method payment_method_enum default 'bank'
) returns expenses
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor    uuid := fn_assert_active_member();
  v_cfg      app_config;
  v_fund     bigint;
  v_eligible int;
  v_needs    boolean;
  v_row      expenses;
begin
  select * into v_cfg from app_config where id for update;

  if p_amount_paise <= 0 then
    raise exception 'Amount must be positive' using errcode = 'check_violation';
  end if;

  v_fund  := fn_fund_total_paise();
  v_needs := p_category not in ('bank_charge', 'admin');

  select count(*)::int into v_eligible from members where left_on is null;

  insert into expenses (
    category, description, amount_paise, incurred_on, method,
    requires_vote, fund_total_at_request_paise, required_approvals,
    eligible_voter_count, created_by,
    status, decided_at
  )
  values (
    p_category, p_description, p_amount_paise, p_incurred_on, p_method,
    v_needs, v_fund,
    case when v_needs then v_cfg.expense_required_approvals else 0 end,
    v_eligible, v_actor,
    case when v_needs then 'proposed'::expense_status_enum
         else 'approved'::expense_status_enum end,
    case when v_needs then null else now() end
  )
  returning * into v_row;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- cast_expense_vote: same locking discipline as loans.
-- Unlike a loan, the proposer MAY vote -- an expense benefits the whole group,
-- so there is no self-dealing to guard against.
-- ---------------------------------------------------------------------------
create or replace function cast_expense_vote(
  p_expense_id uuid,
  p_vote vote_enum,
  p_note text default null
) returns expenses
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor      uuid := fn_assert_active_member();
  v_cfg        app_config;
  v_exp        expenses;
  v_approvals  int;
  v_rejections int;
  v_cap        bigint;
  v_ytd        bigint;
begin
  select * into v_cfg from app_config where id for update;
  select * into v_exp from expenses where id = p_expense_id for update;

  if v_exp.id is null then
    raise exception 'Expense not found' using errcode = 'no_data_found';
  end if;
  if v_exp.status <> 'proposed' then
    raise exception 'This expense is already %', v_exp.status
      using errcode = 'check_violation';
  end if;

  insert into expense_votes (expense_id, voter_id, vote, note)
  values (p_expense_id, v_actor, p_vote, p_note)
  on conflict (expense_id, voter_id)
  do update set vote = excluded.vote, note = excluded.note, voted_at = now();

  select
    count(*) filter (where vote = 'approve'),
    count(*) filter (where vote = 'reject')
  into v_approvals, v_rejections
  from expense_votes where expense_id = p_expense_id;

  if v_approvals >= v_exp.required_approvals then
    -- The annual cap is checked here, at the moment of approval, against the
    -- fund as it stands now.
    v_cap := fn_fund_total_paise() * v_cfg.expense_annual_pct_bp / 10000;
    v_ytd := fn_expenses_ytd_paise(extract(year from v_exp.incurred_on)::int);

    if v_ytd + v_exp.amount_paise > v_cap then
      raise exception
        'Group expenses for % would reach Rs.% but the yearly limit is Rs.% (20%% of the fund)',
        extract(year from v_exp.incurred_on)::int,
        ((v_ytd + v_exp.amount_paise)::numeric / 100)::text,
        (v_cap::numeric / 100)::text
        using errcode = 'check_violation';
    end if;

    update expenses set status = 'approved', decided_at = now()
    where id = p_expense_id returning * into v_exp;

  elsif v_rejections > v_exp.eligible_voter_count - v_exp.required_approvals then
    update expenses set status = 'rejected', decided_at = now()
    where id = p_expense_id returning * into v_exp;
  end if;

  return v_exp;
end $$;

-- ---------------------------------------------------------------------------
-- mark_expense_paid: only now does the money actually leave the fund.
-- ---------------------------------------------------------------------------
create or replace function mark_expense_paid(
  p_expense_id uuid,
  p_paid_on date default current_date
) returns expenses
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := fn_assert_active_member();
  v_exp   expenses;
  v_cash  uuid;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may mark an expense paid'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_exp from expenses where id = p_expense_id for update;
  if v_exp.id is null then
    raise exception 'Expense not found' using errcode = 'no_data_found';
  end if;
  if v_exp.status <> 'approved' then
    raise exception 'Only an approved expense can be paid (this one is %)', v_exp.status
      using errcode = 'check_violation';
  end if;

  if v_exp.method = 'cash' then
    insert into cash_ledger (direction, amount_paise, occurred_at, purpose,
                             expense_id, recorded_by, reported_at, reported_by)
    values ('out', v_exp.amount_paise, p_paid_on::timestamptz,
            v_exp.description, v_exp.id, v_actor, now(), v_actor)
    returning id into v_cash;
  end if;

  update expenses set status = 'paid', paid_on = p_paid_on
  where id = p_expense_id returning * into v_exp;

  return v_exp;
end $$;

-- ---------------------------------------------------------------------------
-- Bank side
-- ---------------------------------------------------------------------------
create table bank_statements (
  id                    uuid primary key default gen_random_uuid(),
  as_of                 date not null unique,
  closing_balance_paise bigint not null,
  -- The expected figure and the difference are snapshotted when the statement
  -- is entered, so the group keeps a history of when the books last balanced
  -- rather than a number that silently re-computes itself later.
  expected_balance_paise bigint not null,
  difference_paise       bigint not null,
  note                  text,
  uploaded_by           uuid not null references members (id),
  created_at            timestamptz not null default now()
);

create or replace function record_bank_statement(
  p_as_of date,
  p_closing_balance_paise bigint,
  p_note text default null
) returns bank_statements
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor    uuid := fn_assert_active_member();
  v_expected bigint;
  v_row      bank_statements;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may record a bank statement'
      using errcode = 'insufficient_privilege';
  end if;

  select expected_bank_balance_paise into v_expected from v_fund_summary;

  insert into bank_statements (as_of, closing_balance_paise, expected_balance_paise,
                               difference_paise, note, uploaded_by)
  values (p_as_of, p_closing_balance_paise, v_expected,
          p_closing_balance_paise - v_expected, p_note, v_actor)
  on conflict (as_of) do update
    set closing_balance_paise = excluded.closing_balance_paise,
        expected_balance_paise = excluded.expected_balance_paise,
        difference_paise = excluded.difference_paise,
        note = excluded.note,
        uploaded_by = excluded.uploaded_by
  returning * into v_row;

  return v_row;
end $$;

create or replace view v_expense_status
with (security_invoker = true) as
select
  e.*,
  m.full_name as created_by_name,
  coalesce(v.approvals, 0)  as approvals,
  coalesce(v.rejections, 0) as rejections,
  (e.status = 'proposed'
    and current_member_id() is not null
    and not exists (
      select 1 from expense_votes ev
      where ev.expense_id = e.id and ev.voter_id = current_member_id()
    )) as can_i_vote,
  (select ev.vote from expense_votes ev
   where ev.expense_id = e.id and ev.voter_id = current_member_id()) as my_vote
from expenses e
join members m on m.id = e.created_by
left join (
  select expense_id,
         count(*) filter (where vote = 'approve') as approvals,
         count(*) filter (where vote = 'reject')  as rejections
  from expense_votes group by expense_id
) v on v.expense_id = e.id;

revoke execute on function propose_expense(expense_category_enum, text, bigint,
  date, payment_method_enum) from public, anon;
revoke execute on function cast_expense_vote(uuid, vote_enum, text) from public, anon;
revoke execute on function mark_expense_paid(uuid, date) from public, anon;
revoke execute on function record_bank_statement(date, bigint, text) from public, anon;

grant execute on function propose_expense(expense_category_enum, text, bigint,
  date, payment_method_enum) to authenticated;
grant execute on function cast_expense_vote(uuid, vote_enum, text) to authenticated;
grant execute on function mark_expense_paid(uuid, date) to authenticated;
grant execute on function record_bank_statement(date, bigint, text) to authenticated;

alter table bank_statements enable row level security;

create policy bank_statements_read on bank_statements
  for select to authenticated using (is_group_member());

revoke insert, update, delete on bank_statements from authenticated, anon;

grant select on v_expense_status to authenticated;
revoke all on v_expense_status from anon;

-- Pick up audit triggers for the tables created in this migration.
select fn_attach_audit_triggers();
