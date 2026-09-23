-- 0001_identity.sql
-- Members, time-boxed role assignments, group config, and the RLS helper
-- functions every later policy depends on.
--
-- Money convention: every money column is `*_paise` bigint. Rates are basis
-- points (200 bp = 2.00%). No floats anywhere in this schema.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- enums
-- ---------------------------------------------------------------------------
create type role_enum as enum ('member', 'cashier', 'accountant', 'president');
create type payment_method_enum as enum ('cash', 'bank');
create type vote_enum as enum ('approve', 'reject', 'abstain');
create type cash_direction_enum as enum ('in', 'out');

-- ---------------------------------------------------------------------------
-- members
-- ---------------------------------------------------------------------------
create table members (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique references auth.users (id) on delete set null,
  full_name     text not null check (length(btrim(full_name)) > 0),
  phone         text,
  joined_on     date not null default current_date,
  left_on       date,
  nominee_name  text,
  nominee_phone text,
  created_at    timestamptz not null default now(),
  constraint left_after_joined check (left_on is null or left_on >= joined_on)
);

-- `is_active` as a generated column keeps "active" in one place.
alter table members
  add column is_active boolean generated always as (left_on is null) stored;

create index members_active_idx on members (is_active) where is_active;

-- ---------------------------------------------------------------------------
-- role_assignments: roles rotate yearly, so they are time-boxed rows.
-- ---------------------------------------------------------------------------
create table role_assignments (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid not null references members (id) on delete cascade,
  role       role_enum not null,
  start_date date not null default current_date,
  end_date   date,
  created_at timestamptz not null default now(),
  constraint end_after_start check (end_date is null or end_date > start_date)
);

-- At most one holder of each office at any instant. 'member' is exempt --
-- everyone is a member.
alter table role_assignments
  add constraint one_office_holder_at_a_time
  exclude using gist (
    role with =,
    daterange(start_date, coalesce(end_date, 'infinity'::date), '[)') with &&
  )
  where (role <> 'member');

create index role_assignments_member_idx on role_assignments (member_id);
create index role_assignments_current_idx on role_assignments (role)
  where end_date is null;

-- Cashier and Accountant must be different people. This spans rows, so it is a
-- DEFERRABLE constraint trigger: a swap performed in one transaction is legal,
-- only the end state is checked.
create or replace function fn_check_cashier_ne_accountant() returns trigger
language plpgsql as $$
declare
  v_clash int;
begin
  select count(*) into v_clash
  from role_assignments a
  join role_assignments b
    on a.member_id = b.member_id
   and a.role = 'cashier'
   and b.role = 'accountant'
   and daterange(a.start_date, coalesce(a.end_date, 'infinity'::date), '[)')
    && daterange(b.start_date, coalesce(b.end_date, 'infinity'::date), '[)');

  if v_clash > 0 then
    raise exception
      'Cashier and Accountant must be different people (overlapping assignment)'
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger trg_cashier_ne_accountant
  after insert or update on role_assignments
  deferrable initially deferred
  for each row execute function fn_check_cashier_ne_accountant();

-- ---------------------------------------------------------------------------
-- app_config: a single row. Also serves as the serialization lock for all
-- fund-mutating approvals (see 0005/0006) -- locking it FOR UPDATE makes
-- concurrent loan approvals strictly serial, which removes the entire class of
-- "two loans jointly breach the reserve" races.
-- ---------------------------------------------------------------------------
create table app_config (
  id                        boolean primary key default true,
  group_name                text not null default 'Sangam',
  monthly_contribution_paise bigint not null default 50000,   -- Rs.500
  due_day                   int  not null default 5,
  grace_day                 int  not null default 10,
  late_fee_paise            bigint not null default 5000,     -- Rs.50
  loan_rate_bp              int  not null default 200,        -- 2.00% / month
  overdue_rate_bp           int  not null default 300,        -- 3.00% / month
  max_loan_months           int  not null default 6,
  max_loan_pct_bp           int  not null default 3000,       -- 30% of fund
  reserve_pct_bp            int  not null default 2500,       -- 25% of fund
  loan_required_approvals   int  not null default 4,
  expense_required_approvals int not null default 5,
  expense_annual_pct_bp     int  not null default 2000,       -- 20% of fund/year
  cash_float_limit_paise    bigint not null default 500000,   -- Rs.5,000
  cash_report_hours         int  not null default 24,
  timezone                  text not null default 'Asia/Kolkata',
  constraint singleton check (id),
  constraint sane_days check (grace_day >= due_day),
  constraint sane_pcts check (
    max_loan_pct_bp between 0 and 10000
    and reserve_pct_bp between 0 and 10000
  )
);

insert into app_config (id) values (true);

-- ---------------------------------------------------------------------------
-- RLS helper functions.
--
-- These MUST be SECURITY DEFINER: a policy on `members` that subqueries
-- `members` re-enters its own policy and Postgres raises
-- "infinite recursion detected in policy". A SECURITY DEFINER function reads
-- the table with RLS bypassed, breaking the cycle. search_path is pinned --
-- an unpinned search_path on a SECURITY DEFINER function is a privilege
-- escalation hole.
--
-- STABLE (not VOLATILE) lets the planner evaluate these once per statement.
-- ---------------------------------------------------------------------------
create or replace function current_member_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from members
  where auth_user_id = (select auth.uid())
    and left_on is null
  limit 1
$$;

create or replace function is_group_member() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select current_member_id() is not null
$$;

-- The office (cashier/accountant/president) held by a member today, or
-- 'member' if they hold none.
create or replace function role_of(p_member_id uuid) returns role_enum
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select ra.role
     from role_assignments ra
     where ra.member_id = p_member_id
       and ra.role <> 'member'
       and ra.start_date <= current_date
       and (ra.end_date is null or ra.end_date > current_date)
     order by ra.start_date desc
     limit 1),
    'member'::role_enum)
$$;

create or replace function current_role_of() returns role_enum
language sql stable security definer set search_path = public, pg_temp as $$
  select role_of(current_member_id())
$$;

create or replace function active_member_count() returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from members where left_on is null
$$;

-- Every RPC that writes money starts by calling this, so the "are you actually
-- in this group" check is written once rather than in each one.
create or replace function fn_assert_active_member() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_id uuid := current_member_id();
begin
  if v_id is null then
    raise exception 'Not an active member of this group'
      using errcode = 'insufficient_privilege';
  end if;
  return v_id;
end $$;

revoke execute on function current_member_id()       from public, anon;
revoke execute on function is_group_member()         from public, anon;
revoke execute on function role_of(uuid)             from public, anon;
revoke execute on function current_role_of()         from public, anon;
revoke execute on function active_member_count()     from public, anon;
revoke execute on function fn_assert_active_member() from public, anon;

grant execute on function current_member_id()       to authenticated;
grant execute on function is_group_member()         to authenticated;
grant execute on function role_of(uuid)             to authenticated;
grant execute on function current_role_of()         to authenticated;
grant execute on function active_member_count()     to authenticated;
grant execute on function fn_assert_active_member() to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
--
-- Baseline posture for the whole app:
--   * anon gets nothing
--   * every member reads everything (transparency is the product)
--   * writes are narrow and role-gated, and the money-moving ones go through
--     SECURITY DEFINER RPCs rather than table grants
--   * NO table anywhere gets a DELETE policy -- financial records are
--     append-only and corrections are reversing entries
-- ---------------------------------------------------------------------------
alter table members          enable row level security;
alter table role_assignments enable row level security;
alter table app_config       enable row level security;

-- (select auth.uid()) rather than bare auth.uid(): the subselect form is
-- hoisted to an InitPlan and evaluated once per statement instead of per row.

create policy members_read on members
  for select to authenticated
  using (is_group_member());

-- A member may edit only their own contact details. Which *columns* they may
-- touch is enforced by the column grant below, not by this policy.
create policy members_update_self on members
  for update to authenticated
  using (auth_user_id = (select auth.uid()))
  with check (auth_user_id = (select auth.uid()));

revoke update on members from authenticated;
grant update (phone, nominee_name, nominee_phone) on members to authenticated;

create policy roles_read on role_assignments
  for select to authenticated
  using (is_group_member());

create policy config_read on app_config
  for select to authenticated
  using (is_group_member());

-- No insert/update/delete policies for role_assignments or app_config:
-- rotation and config changes happen through migrations or an admin RPC.
