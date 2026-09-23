-- 0006_expenses_tables.sql
-- Expense tables only.
--
-- These live BEFORE the fund math because fn_expenses_paid_paise() reads the
-- expenses table. The expense RPCs go the other way round -- they need
-- v_fund_summary and fn_assert_active_member -- so they are in 0008, after
-- both. Splitting the tables from their RPCs is what breaks that cycle.

create type expense_status_enum as enum ('proposed', 'approved', 'rejected', 'paid');
create type expense_category_enum as enum
  ('trip', 'party', 'celebration', 'bank_charge', 'admin', 'other');

create table expenses (
  id             uuid primary key default gen_random_uuid(),
  category       expense_category_enum not null,
  description    text not null check (length(btrim(description)) > 0),
  amount_paise   bigint not null check (amount_paise > 0),
  incurred_on    date not null default current_date,
  method         payment_method_enum not null default 'bank',
  status         expense_status_enum not null default 'proposed',
  -- Small administrative costs (bank charges) are not put to a vote.
  requires_vote  boolean not null default true,
  fund_total_at_request_paise bigint not null,
  required_approvals int not null,
  eligible_voter_count int not null,
  created_by     uuid not null references members (id),
  decided_at     timestamptz,
  paid_on        date,
  created_at     timestamptz not null default now()
);

create index expenses_status_idx on expenses (status);
create index expenses_year_idx on expenses (incurred_on);

create table expense_votes (
  id         uuid primary key default gen_random_uuid(),
  expense_id uuid not null references expenses (id) on delete cascade,
  voter_id   uuid not null references members (id),
  vote       vote_enum not null,
  note       text,
  voted_at   timestamptz not null default now(),
  unique (expense_id, voter_id)
);

create index expense_votes_expense_idx on expense_votes (expense_id);

-- cash_ledger.expense_id could not be a FK until expenses existed.
alter table cash_ledger
  add constraint cash_ledger_expense_fk
  foreign key (expense_id) references expenses (id);


alter table expenses      enable row level security;
alter table expense_votes enable row level security;

create policy expenses_read on expenses
  for select to authenticated using (is_group_member());
create policy expense_votes_read on expense_votes
  for select to authenticated using (is_group_member());

revoke insert, update, delete on expenses from authenticated, anon;
revoke insert, update, delete on expense_votes from authenticated, anon;

-- Pick up audit triggers for the tables created here.
select fn_attach_audit_triggers();
