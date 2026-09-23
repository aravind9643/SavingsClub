-- 0012_multi_group.sql
-- Single-tenant -> multi-tenant.
--
-- Until now the whole database WAS one savings group: app_config held exactly
-- one row, claim_group() could fire exactly once, and every RLS policy said
-- "are you a member?" with no need to ask "of what?". This migration makes the
-- database hold many independent groups, with one auth user able to belong to
-- several of them, holding a different office in each.
--
-- THE SECURITY PROPERTY THIS FILE MUST GUARANTEE:
-- a member of group A can never read or write a single row of group B --
-- through a table, a view, an RPC, or a money aggregate. Money aggregates are
-- the sharp edge: fn_fund_total_paise() currently sums the entire table. Left
-- unscoped it would add every group's money together, and because the loan cap
-- check calls the same function, the UI and the enforcement would agree on the
-- same wrong number. That is a money-loss bug wearing a display bug's clothes,
-- so every aggregate below takes an explicit group.
--
-- TWO-STEP AUTHORIZATION. The active group is carried in a JWT claim, which is
-- fast but can outlive the membership it asserts: remove someone and their
-- token still names the group until it expires. So the claim only chooses
-- WHICH group; a live lookup in `members` decides WHETHER you may see it.
-- Every policy does both. Never shortcut this to the claim alone.

-- ---------------------------------------------------------------------------
-- 1. groups -- the tenant, and the per-group config that app_config used to be
-- ---------------------------------------------------------------------------
create table groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  -- auth user, not member: at insert time no member row exists yet.
  created_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now(),
  setup_complete boolean not null default false,
  archived_at timestamptz,

  -- everything that used to live in app_config
  monthly_contribution_paise bigint not null default 50000,
  due_day                    int  not null default 5,
  grace_day                  int  not null default 10,
  late_fee_paise             bigint not null default 5000,
  loan_rate_bp               int  not null default 200,
  overdue_rate_bp            int  not null default 300,
  max_loan_months            int  not null default 6,
  max_loan_pct_bp            int  not null default 3000,
  reserve_pct_bp             int  not null default 2500,
  -- 0 means "compute a majority from the active member count" -- see
  -- required_loan_approvals(). A fixed 4 would lock a 3-person group out of
  -- lending entirely on its first day.
  loan_required_approvals    int  not null default 0,
  expense_required_approvals int  not null default 0,
  expense_annual_pct_bp      int  not null default 2000,
  cash_float_limit_paise     bigint not null default 500000,
  cash_report_hours          int  not null default 24,
  timezone                   text not null default 'Asia/Kolkata',

  constraint sane_days check (grace_day >= due_day),
  constraint sane_pcts check (
    max_loan_pct_bp between 0 and 10000 and reserve_pct_bp between 0 and 10000
  )
);

create index groups_created_by_idx on groups (created_by);

-- ---------------------------------------------------------------------------
-- 2. profiles -- what a signed-in user is before any group is chosen
-- ---------------------------------------------------------------------------
create table profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text,
  -- Which group to open on next sign-in. NOT authoritative for access: it is
  -- validated against members every time it is used.
  last_group_id uuid references groups (id) on delete set null,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. members gains a group, and its global unique keys become per-group
-- ---------------------------------------------------------------------------
alter table members
  add column group_id uuid references groups (id),
  add column status text not null default 'active'
    check (status in ('pending', 'active', 'left'));

-- ---------------------------------------------------------------------------
-- 4. group_id on every table.
--
-- Nullable first, backfilled in step 9, then made NOT NULL -- so this migration
-- is safe to run against the live single-group database.
-- ---------------------------------------------------------------------------
alter table role_assignments   add column group_id uuid references groups (id);
alter table contribution_periods add column group_id uuid references groups (id);
alter table contributions      add column group_id uuid references groups (id);
alter table cash_ledger        add column group_id uuid references groups (id);
alter table loans              add column group_id uuid references groups (id);
alter table loan_votes         add column group_id uuid references groups (id);
alter table loan_repayments    add column group_id uuid references groups (id);
alter table expenses           add column group_id uuid references groups (id);
alter table expense_votes      add column group_id uuid references groups (id);
alter table bank_statements    add column group_id uuid references groups (id);
alter table audit_log          add column group_id uuid references groups (id);

-- ---------------------------------------------------------------------------
-- 5. Invite codes.
--
-- A table rather than a column on groups: rotation becomes "issue a new row,
-- revoke the old", which keeps a trail of who issued which code, and allows
-- two codes to be valid during a handover.
--
-- A code is a bearer credential that will end up forwarded in a WhatsApp
-- group, so it expires, can be use-capped, and -- critically -- only gets the
-- joiner as far as `pending`. An officer still has to approve them.
-- ---------------------------------------------------------------------------
create table group_invites (
  code       text primary key,
  group_id   uuid not null references groups (id) on delete cascade,
  created_by uuid not null references members (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  max_uses   int,
  use_count  int not null default 0,
  revoked_at timestamptz
);

create index group_invites_group_idx on group_invites (group_id);

-- Crockford base32 minus I, L, O, U: no character a person can misread.
create or replace function fn_new_invite_code() returns text
language plpgsql set search_path = public, pg_temp as $$
declare
  v_alphabet text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_code text;
  v_try  int;
begin
  for v_try in 1..5 loop
    v_code := '';
    for i in 1..12 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * 32)::int, 1);
    end loop;
    v_code := substr(v_code,1,4) || '-' || substr(v_code,5,4) || '-' || substr(v_code,9,4);
    if not exists (select 1 from group_invites where code = v_code) then
      return v_code;
    end if;
  end loop;
  raise exception 'Could not generate a unique invite code';
end $$;

-- Input arrives however the person typed it. Compare on a canonical form.
create or replace function fn_normalize_code(p_code text) returns text
language sql immutable as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- ---------------------------------------------------------------------------
-- 6. Identity helpers.
--
-- All SECURITY DEFINER with a pinned search_path, as before. Two new rules:
--
--   * is_member_of() pins auth.uid() INSIDE the function and takes no user
--     parameter. A SECURITY DEFINER function that accepted "is user X in group
--     Y" would be a membership oracle for anyone who could call it.
--   * current_group_id() reads the JWT claim, falling back to profiles while
--     old tokens (issued before the auth hook existed) are still in the wild.
--     The fallback is deleted once tokens have rotated.
-- ---------------------------------------------------------------------------
create or replace function current_group_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    nullif(((select auth.jwt()) -> 'app_metadata' ->> 'group_id'), '')::uuid,
    (select p.last_group_id from profiles p where p.id = (select auth.uid()))
  )
$$;

-- The live check. The claim says which group; this says whether you may see it.
create or replace function is_member_of(p_group_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from members m
    where m.group_id = p_group_id
      and m.auth_user_id = (select auth.uid())
      and m.left_on is null
      and m.status = 'active'
  )
$$;

create or replace function in_current_group() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select is_member_of(current_group_id())
$$;

create or replace function current_member_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.id from members m
  where m.group_id = current_group_id()
    and m.auth_user_id = (select auth.uid())
    and m.left_on is null
    and m.status = 'active'
  limit 1
$$;

-- Every group this user may open, for the switcher.
create or replace function my_group_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.group_id from members m
  where m.auth_user_id = (select auth.uid())
    and m.left_on is null
    and m.status = 'active'
$$;

create or replace function is_group_member() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select in_current_group()
$$;

-- member_id already implies the group, so this signature is unchanged.
create or replace function role_of(p_member_id uuid) returns role_enum
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select ra.role from role_assignments ra
     where ra.member_id = p_member_id
       and ra.role <> 'member'
       and ra.start_date <= current_date
       and (ra.end_date is null or ra.end_date > current_date)
     order by ra.start_date desc limit 1),
    'member'::role_enum)
$$;

create or replace function current_role_of() returns role_enum
language sql stable security definer set search_path = public, pg_temp as $$
  select role_of(current_member_id())
$$;

-- ---------------------------------------------------------------------------
-- Drop the views first, before anything they depend on is touched.
--
-- Two separate reasons, both of which abort the migration if ignored:
--
--   1. Every view below gains group_id as its FIRST column. CREATE OR REPLACE
--      VIEW can only APPEND columns -- it cannot rename or reorder existing
--      ones -- and reports the refusal as "cannot change name of view column
--      <x> to group_id", which reads like a typo and is really a structural
--      rule.
--   2. The money functions these views call are themselves dropped just below,
--      and a function cannot be dropped while a view still depends on it.
--
-- Order matters within the block: v_member_positions reads v_fund_summary, so
-- the dependent goes first. CASCADE would paper over that ordering -- and would
-- silently drop anything else that had come to depend on these, which is
-- exactly the kind of collateral damage a migration should not do quietly.
-- ---------------------------------------------------------------------------
drop view if exists v_member_positions;
drop view if exists v_unpaid_contributions;
drop view if exists v_cash_alerts;
drop view if exists v_loan_status;
drop view if exists v_expense_status;
drop view if exists v_fund_summary;

-- ---------------------------------------------------------------------------
-- Retire the single-tenant signatures BEFORE the group-scoped ones are created.
--
-- CREATE OR REPLACE FUNCTION matches on (name, argument types). Every function
-- below gains a p_group_id parameter, so the new definition does not replace
-- the old one -- it creates a SECOND function alongside it. That is not a
-- cosmetic leftover:
--
--   fn_fund_total_paise()      <- old, sums EVERY group's money, no filter
--   fn_fund_total_paise(uuid)  <- new, correctly scoped
--
-- and because the new parameter carries `default current_group_id()`, a plain
-- `fn_fund_total_paise()` call matches both. Postgres either rejects it as
-- ambiguous or resolves to the unscoped one -- and the unscoped one is exactly
-- the cross-tenant money leak this whole migration exists to prevent. The old
-- signature must not survive the migration.
--
-- update_config is the same rule from the other direction: its arguments are
-- unchanged but its return type moves from app_config to groups, and a return
-- type cannot be changed by REPLACE at all. It aborts the migration outright,
-- which is the friendlier of the two failures.
-- ---------------------------------------------------------------------------
drop function if exists active_member_count();
drop function if exists fn_contributions_received_paise();
drop function if exists fn_interest_received_paise();
drop function if exists fn_expenses_paid_paise();
drop function if exists fn_fund_total_paise();
drop function if exists fn_expenses_ytd_paise(int);
drop function if exists cash_float_balance_paise();
drop function if exists total_outstanding_paise();
drop function if exists update_config(
  text, bigint, int, int, bigint, int, int, int, int, int, int, int, int,
  bigint, int, boolean);

create or replace function active_member_count(p_group_id uuid default current_group_id())
returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from members
  where group_id = p_group_id and left_on is null and status = 'active'
$$;

create or replace function fn_assert_active_member() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_id uuid := current_member_id();
begin
  if v_id is null then
    raise exception 'You are not an active member of this group'
      using errcode = 'insufficient_privilege';
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Approval thresholds scale with the group.
--
-- A fixed 4 was right for one seven-member group and wrong for everyone else:
-- a three-person group could never approve a loan, because request_loan()
-- refuses when there are fewer eligible voters than required approvals.
-- 0 in the config means "a majority of the active members".
-- ---------------------------------------------------------------------------
create or replace function required_loan_approvals(p_group_id uuid default current_group_id())
returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(2, coalesce(
    nullif((select g.loan_required_approvals from groups g where g.id = p_group_id), 0),
    (active_member_count(p_group_id) / 2) + 1
  ))
$$;

create or replace function required_expense_approvals(p_group_id uuid default current_group_id())
returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(2, coalesce(
    nullif((select g.expense_required_approvals from groups g where g.id = p_group_id), 0),
    (active_member_count(p_group_id) * 2 / 3) + 1
  ))
$$;

-- ---------------------------------------------------------------------------
-- 8. Backfill the existing live group.
--
-- Triggers on the affected tables are quiesced around this and restored after;
-- see the comment on the catalog query below for why that is necessary and why
-- it is done from the catalog rather than from a hand-written list.
-- ---------------------------------------------------------------------------
do $$
declare
  v_group uuid;
  v_owner uuid;
  v_cfg   record;
  t       text;
  -- 'schema.table triggername' pairs, so one array carries both halves.
  v_trigs    text[];
  v_left_off text[];
  v_tables text[] := array[
    'members','role_assignments','contribution_periods','contributions',
    'cash_ledger','loans','loan_votes','loan_repayments','expenses',
    'expense_votes','bank_statements','audit_log'];
begin
  -- Nothing to migrate on a fresh database.
  if not exists (select 1 from app_config where id) then
    return;
  end if;
  if not exists (select 1 from members) then
    return;
  end if;

  -- ------------------------------------------------------------------------
  -- Quiesce the triggers on the tables about to be backfilled.
  --
  -- The backfill sets one new column on every row of twelve tables. It changes
  -- no amount, no status and no date -- but the triggers guarding those tables
  -- do not know that, and several of them reject the write anyway:
  --
  --   trg_audit_immutable (audit_log)   -- refuses UPDATE outright
  --   trg_contributions_period_open     -- refuses any write to a CLOSED period,
  --                                        and closed periods are exactly what
  --                                        an established group is full of
  --   trg_audit (all twelve)            -- would write a full old/new jsonb copy
  --                                        of the whole database into the log,
  --                                        burying the real history
  --
  -- Naming them individually is what failed twice here already: a hand-kept
  -- list drifts from the schema, and each drift aborts the migration at a
  -- different statement. So ask the catalog which triggers actually exist on
  -- these tables, disable those, and re-enable exactly the same set. The list
  -- cannot be wrong because it is not a list -- it is a query.
  --
  -- This is safe only because it is confined to one transaction that no other
  -- session can write inside: the ALTERs take ACCESS EXCLUSIVE on each table.
  -- ------------------------------------------------------------------------
  select coalesce(array_agg(format('%I.%I', n.nspname, c.relname)
                            || ' ' || quote_ident(tg.tgname)), '{}')
  into v_trigs
  from pg_trigger tg
  join pg_class c on c.oid = tg.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and not tg.tgisinternal          -- FK enforcement triggers: never touch
    and tg.tgenabled <> 'D'          -- already disabled: leave it that way
    and c.relname = any (v_tables);

  foreach t in array v_trigs loop
    execute format('alter table %s disable trigger %s',
                   split_part(t, ' ', 1), split_part(t, ' ', 2));
  end loop;

  select * into v_cfg from app_config where id;

  -- The founder: whoever holds the office of president, else any linked member.
  select m.auth_user_id into v_owner
  from members m
  join role_assignments ra on ra.member_id = m.id
  where ra.role = 'president' and ra.end_date is null and m.auth_user_id is not null
  limit 1;

  if v_owner is null then
    select auth_user_id into v_owner
    from members where auth_user_id is not null limit 1;
  end if;

  if v_owner is null then
    raise exception 'Cannot migrate: no member is linked to a login yet';
  end if;

  insert into groups (
    name, created_by, setup_complete,
    monthly_contribution_paise, due_day, grace_day, late_fee_paise,
    loan_rate_bp, overdue_rate_bp, max_loan_months, max_loan_pct_bp,
    reserve_pct_bp, loan_required_approvals, expense_required_approvals,
    expense_annual_pct_bp, cash_float_limit_paise, cash_report_hours, timezone
  )
  values (
    coalesce(nullif(btrim(v_cfg.group_name), ''), 'My group'),
    v_owner, v_cfg.setup_complete,
    v_cfg.monthly_contribution_paise, v_cfg.due_day, v_cfg.grace_day,
    v_cfg.late_fee_paise, v_cfg.loan_rate_bp, v_cfg.overdue_rate_bp,
    v_cfg.max_loan_months, v_cfg.max_loan_pct_bp, v_cfg.reserve_pct_bp,
    -- Keep this group's existing fixed thresholds rather than silently
    -- switching a running group to majority rules mid-flight.
    v_cfg.loan_required_approvals, v_cfg.expense_required_approvals,
    v_cfg.expense_annual_pct_bp, v_cfg.cash_float_limit_paise,
    v_cfg.cash_report_hours, v_cfg.timezone
  )
  returning id into v_group;

  -- The backfill itself: one new column, nothing else touched. No amount, no
  -- status, no date and no actor changes -- so disabling the guards above
  -- rewrites no history. It records which group each existing row belonged to,
  -- which was never in doubt, because until this migration there was only one.
  foreach t in array v_tables loop
    execute format('update public.%I set group_id = %L where group_id is null', t, v_group);
  end loop;

  insert into profiles (id, last_group_id)
  select distinct auth_user_id, v_group from members where auth_user_id is not null
  on conflict (id) do update set last_group_id = excluded.last_group_id;

  -- Re-arm exactly what was disabled, in reverse.
  foreach t in array v_trigs loop
    execute format('alter table %s enable trigger %s',
                   split_part(t, ' ', 1), split_part(t, ' ', 2));
  end loop;

  -- ...and prove it. A migration that finished with the audit log writable, or
  -- the closed-period guard off, would be a far worse outcome than one that
  -- failed outright -- and unlike a failure it would not announce itself.
  select coalesce(array_agg(c.relname || '.' || tg.tgname), '{}') into v_left_off
  from pg_trigger tg
  join pg_class c on c.oid = tg.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and not tg.tgisinternal
    and tg.tgenabled = 'D'
    and c.relname = any (v_tables);

  if array_length(v_left_off, 1) > 0 then
    raise exception 'Refusing to finish: these triggers are still disabled: %',
      array_to_string(v_left_off, ', ');
  end if;

  raise notice 'Migrated the existing group into groups.id = %', v_group;
end $$;

-- audit_log rows written before groups existed keep a null group_id, so it
-- stays nullable. Everything else is now mandatory.
alter table members              alter column group_id set not null;
alter table role_assignments     alter column group_id set not null;
alter table contribution_periods alter column group_id set not null;
alter table contributions        alter column group_id set not null;
alter table cash_ledger          alter column group_id set not null;
alter table loans                alter column group_id set not null;
alter table loan_votes           alter column group_id set not null;
alter table loan_repayments      alter column group_id set not null;
alter table expenses             alter column group_id set not null;
alter table expense_votes        alter column group_id set not null;
alter table bank_statements      alter column group_id set not null;

-- ---------------------------------------------------------------------------
-- 9. Integrity: make the denormalised group_id provably consistent.
--
-- group_id is copied onto child tables so policies can be a plain equality
-- rather than a correlated subquery into the parent. Composite foreign keys
-- are what stop that copy from ever disagreeing with the parent -- without
-- them, a bug in one RPC could file a vote under group A against a loan in
-- group B, and cast_loan_vote() counts votes by loan_id alone, so that vote
-- would cross the approval threshold of group B.
-- ---------------------------------------------------------------------------
alter table loans    add constraint loans_group_id_key    unique (group_id, id);
alter table expenses add constraint expenses_group_id_key unique (group_id, id);
alter table members  add constraint members_group_id_key  unique (group_id, id);
alter table contribution_periods
  add constraint periods_group_id_key unique (group_id, id);

alter table loan_votes
  add constraint loan_votes_loan_group_fk
  foreign key (group_id, loan_id) references loans (group_id, id) on delete cascade;

alter table loan_repayments
  add constraint loan_repayments_loan_group_fk
  foreign key (group_id, loan_id) references loans (group_id, id);

alter table expense_votes
  add constraint expense_votes_expense_group_fk
  foreign key (group_id, expense_id) references expenses (group_id, id) on delete cascade;

alter table contributions
  add constraint contributions_period_group_fk
  foreign key (group_id, period_id) references contribution_periods (group_id, id);

alter table contributions
  add constraint contributions_member_group_fk
  foreign key (group_id, member_id) references members (group_id, id);

alter table loans
  add constraint loans_borrower_group_fk
  foreign key (group_id, borrower_id) references members (group_id, id);

alter table loans
  add constraint loans_guarantor_group_fk
  foreign key (group_id, guarantor_id) references members (group_id, id);

alter table loan_votes
  add constraint loan_votes_voter_group_fk
  foreign key (group_id, voter_id) references members (group_id, id);

alter table expense_votes
  add constraint expense_votes_voter_group_fk
  foreign key (group_id, voter_id) references members (group_id, id);

-- ---------------------------------------------------------------------------
-- 10. Per-group uniqueness, replacing the global versions.
-- ---------------------------------------------------------------------------
drop index if exists members_email_key;
alter table members drop constraint if exists members_auth_user_id_key;

create unique index members_group_auth_key on members (group_id, auth_user_id)
  where auth_user_id is not null;
create unique index members_group_email_key on members (group_id, lower(email))
  where email is not null;

alter table contribution_periods drop constraint if exists contribution_periods_period_month_key;
alter table contribution_periods
  add constraint periods_group_month_key unique (group_id, period_month);

alter table bank_statements drop constraint if exists bank_statements_as_of_key;
alter table bank_statements
  add constraint bank_statements_group_asof_key unique (group_id, as_of);

-- One cashier per GROUP, not one in the whole database. Without the group_id
-- in this constraint the second group could never appoint a president.
alter table role_assignments drop constraint if exists one_office_holder_at_a_time;
alter table role_assignments
  add constraint one_office_holder_per_group
  exclude using gist (
    group_id with =,
    role with =,
    daterange(start_date, coalesce(end_date, 'infinity'::date), '[)') with &&
  )
  where (role <> 'member');

create or replace function fn_check_cashier_ne_accountant() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_clash int;
begin
  select count(*) into v_clash
  from role_assignments a
  join role_assignments b
    on a.member_id = b.member_id
   and a.group_id = b.group_id
   and a.role = 'cashier'
   and b.role = 'accountant'
   and daterange(a.start_date, coalesce(a.end_date, 'infinity'::date), '[)')
    && daterange(b.start_date, coalesce(b.end_date, 'infinity'::date), '[)')
  where a.group_id = new.group_id;

  if v_clash > 0 then
    raise exception
      'Cashier and Accountant must be different people (overlapping assignment)'
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- 11. Group-leading indexes.
--
-- Every policy filters on group_id first, so it must be the leading column or
-- every query degrades to a sequential scan filtered by tenant -- which gets
-- slower for everybody as groups are added.
-- ---------------------------------------------------------------------------
create index members_group_idx            on members (group_id) where left_on is null;
create index role_assignments_group_idx   on role_assignments (group_id);
create index periods_group_idx            on contribution_periods (group_id, period_month desc);
create index contributions_group_idx      on contributions (group_id, period_id);
create index cash_ledger_group_idx        on cash_ledger (group_id, occurred_at desc);
create index loans_group_status_idx       on loans (group_id, status);
create index loan_votes_group_idx         on loan_votes (group_id, loan_id);
create index loan_repayments_group_idx    on loan_repayments (group_id, loan_id);
create index expenses_group_idx           on expenses (group_id, status);
create index expense_votes_group_idx      on expense_votes (group_id, expense_id);
create index bank_statements_group_idx    on bank_statements (group_id, as_of desc);
create index audit_log_group_idx          on audit_log (group_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- 12. Money aggregates, now group-scoped.
--
-- THE most dangerous part of this migration. Each of these previously summed
-- its whole table. Unscoped in a multi-group database they would add every
-- group's money together -- and since the reserve check in cast_loan_vote()
-- calls the same functions the dashboard does, the screen and the enforcement
-- would agree on the same wrong number and authorise loans that break the
-- reserve. Nothing would throw.
--
-- Each takes p_group_id explicitly, defaulting to the active group. The
-- explicit parameter matters: an RPC that has locked group A must pass A, not
-- re-read the claim, which could name B.
-- ---------------------------------------------------------------------------
create or replace function fn_contributions_received_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise + late_fee_paise), 0)::bigint
  from contributions where group_id = p_group_id
$$;

create or replace function fn_interest_received_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(interest_paise + penalty_paise), 0)::bigint
  from loan_repayments where group_id = p_group_id
$$;

create or replace function fn_expenses_paid_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from expenses where group_id = p_group_id and status = 'paid'
$$;

create or replace function fn_fund_total_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select fn_contributions_received_paise(p_group_id)
       + fn_interest_received_paise(p_group_id)
       - fn_expenses_paid_paise(p_group_id)
$$;

create or replace function fn_expenses_ytd_paise(
  p_year int, p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from expenses
  where group_id = p_group_id
    and status in ('approved', 'paid')
    and extract(year from incurred_on) = p_year
$$;

create or replace function cash_float_balance_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(
    case when direction = 'in' then amount_paise else -amount_paise end
  ), 0)::bigint
  from cash_ledger where group_id = p_group_id
$$;

create or replace function total_outstanding_paise(
  p_group_id uuid default current_group_id()
) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(loan_outstanding_principal_paise(l.id)), 0)::bigint
  from loans l
  where l.group_id = p_group_id
    and l.status in ('approved', 'disbursed')
$$;

-- These two are keyed on a row that already implies its group -- but they are
-- SECURITY DEFINER, so handed a uuid from another group they would happily
-- compute it. A uuid being unguessable is not access control.
create or replace function loan_outstanding_principal_paise(p_loan_id uuid)
returns bigint
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_group uuid;
  v_out   bigint;
begin
  select group_id into v_group from loans where id = p_loan_id;
  if v_group is null then
    return 0;
  end if;
  if not is_member_of(v_group) then
    raise exception 'That loan belongs to another group'
      using errcode = 'insufficient_privilege';
  end if;

  select greatest(0,
    (select l.principal_paise from loans l where l.id = p_loan_id)
    - coalesce((select sum(r.principal_paise) from loan_repayments r
                where r.loan_id = p_loan_id), 0))::bigint
  into v_out;
  return v_out;
end $$;

create or replace function member_outstanding_paise(p_member_id uuid)
returns bigint
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_group uuid;
begin
  select group_id into v_group from members where id = p_member_id;
  if v_group is null then
    return 0;
  end if;
  if not is_member_of(v_group) then
    raise exception 'That member belongs to another group'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select sum(loan_outstanding_principal_paise(l.id))
    from loans l
    where l.borrower_id = p_member_id
      and l.status in ('approved', 'disbursed')
  ), 0)::bigint;
end $$;

-- ---------------------------------------------------------------------------
-- 13. Views, group-scoped.
--
-- security_invoker keeps RLS applying to the tables a view reads -- but it
-- says nothing about the SECURITY DEFINER functions called inside, which is
-- most of the money math. Both had to be fixed; neither alone is enough.
--
-- These are DROPPED first, not replaced. CREATE OR REPLACE VIEW can only
-- APPEND columns: it refuses to rename or reorder existing ones, and every
-- view below gains group_id at the FRONT, which shifts everything after it.
-- Postgres reports that as "cannot change name of view column X to group_id",
-- which reads like a typo and is really a structural rule.
--
-- The DROPs themselves happen much earlier in this file, because the money
-- functions these views call are dropped too, and a function cannot be dropped
-- while a view still depends on it.
-- ---------------------------------------------------------------------------
create or replace view v_fund_summary
with (security_invoker = true) as
select
  g.id                                             as group_id,
  fn_contributions_received_paise(g.id)            as contributions_paise,
  fn_interest_received_paise(g.id)                 as interest_received_paise,
  fn_expenses_paid_paise(g.id)                     as expenses_paise,
  fn_fund_total_paise(g.id)                        as total_fund_paise,
  (fn_fund_total_paise(g.id) * g.reserve_pct_bp / 10000)      as reserve_paise,
  (fn_fund_total_paise(g.id) * (10000 - g.reserve_pct_bp) / 10000) as lendable_paise,
  total_outstanding_paise(g.id)                    as outstanding_paise,
  greatest(0, (fn_fund_total_paise(g.id) * (10000 - g.reserve_pct_bp) / 10000)
              - total_outstanding_paise(g.id))     as still_lendable_paise,
  (fn_fund_total_paise(g.id) * g.max_loan_pct_bp / 10000) as per_member_cap_paise,
  cash_float_balance_paise(g.id)                   as cash_float_paise,
  g.cash_float_limit_paise,
  (fn_fund_total_paise(g.id)
     - total_outstanding_paise(g.id)
     - cash_float_balance_paise(g.id))             as expected_bank_balance_paise,
  (select coalesce(sum(a.interest_paise + a.penalty_paise), 0)::bigint
   from loans l
   cross join lateral loan_accrued_interest_paise(l.id) a
   where l.status = 'disbursed' and l.group_id = g.id) as accrued_receivable_paise
from groups g
where g.id = current_group_id() and in_current_group();

create or replace view v_member_positions
with (security_invoker = true) as
select
  m.id                                   as member_id,
  m.group_id,
  m.full_name,
  m.is_active,
  role_of(m.id)                          as role,
  coalesce(ct.paid_paise, 0)             as contributed_paise,
  coalesce(ct.late_fees_paise, 0)        as late_fees_paise,
  coalesce(ct.periods_paid, 0)           as periods_paid,
  member_outstanding_paise(m.id)         as outstanding_paise,
  f.per_member_cap_paise                 as cap_paise,
  (member_outstanding_paise(m.id) > f.per_member_cap_paise) as cap_breached,
  case when f.total_fund_paise = 0 then 0::numeric
       else round(coalesce(ct.paid_paise, 0)::numeric / f.total_fund_paise * 100, 2)
  end                                    as share_pct
from members m
cross join lateral (select * from v_fund_summary) f
left join (
  select member_id,
         sum(amount_paise)   as paid_paise,
         sum(late_fee_paise) as late_fees_paise,
         count(*)            as periods_paid
  from contributions group by member_id
) ct on ct.member_id = m.id
where m.group_id = current_group_id()
  and m.status <> 'pending'
  and in_current_group();

create or replace view v_unpaid_contributions
with (security_invoker = true) as
select
  p.id           as period_id,
  p.group_id,
  p.period_month,
  p.due_date,
  p.grace_date,
  m.id           as member_id,
  m.full_name,
  p.amount_paise as expected_paise,
  (current_date > p.grace_date) as is_overdue
from contribution_periods p
join members m on m.group_id = p.group_id
left join contributions c on c.period_id = p.id and c.member_id = m.id
where c.id is null
  and m.left_on is null
  and m.status = 'active'
  and p.group_id = current_group_id()
  and in_current_group()
  and m.joined_on <= (p.period_month + interval '1 month' - interval '1 day')::date;

create or replace view v_loan_status
with (security_invoker = true) as
select
  l.id,
  l.group_id,
  l.borrower_id,
  b.full_name                     as borrower_name,
  l.guarantor_id,
  g.full_name                     as guarantor_name,
  l.principal_paise,
  l.purpose,
  l.rate_bp,
  l.overdue_rate_bp,
  l.term_months,
  l.status,
  l.requested_at,
  l.disbursed_on,
  l.due_on,
  l.closed_on,
  l.required_approvals,
  l.eligible_voter_count,
  loan_outstanding_principal_paise(l.id) as outstanding_principal_paise,
  acc.interest_paise              as accrued_interest_paise,
  acc.penalty_paise               as accrued_penalty_paise,
  coalesce(rp.principal_paid, 0)  as principal_paid_paise,
  coalesce(rp.interest_paid, 0)   as interest_paid_paise,
  (loan_outstanding_principal_paise(l.id)
    + acc.interest_paise + acc.penalty_paise
    - coalesce(rp.interest_paid, 0))     as total_due_paise,
  case when l.status = 'disbursed' and l.due_on is not null and current_date > l.due_on
       then current_date - l.due_on else 0 end as days_overdue,
  (l.status = 'disbursed' and l.due_on is not null and current_date > l.due_on)
                                  as is_overdue,
  coalesce(v.approvals, 0)        as approvals,
  coalesce(v.rejections, 0)       as rejections,
  (l.status = 'requested'
    and current_member_id() is not null
    and current_member_id() <> l.borrower_id
    and not exists (
      select 1 from loan_votes lv
      where lv.loan_id = l.id and lv.voter_id = current_member_id()
    ))                            as can_i_vote,
  (select lv.vote from loan_votes lv
   where lv.loan_id = l.id and lv.voter_id = current_member_id()) as my_vote
from loans l
join members b on b.id = l.borrower_id
join members g on g.id = l.guarantor_id
cross join lateral loan_accrued_interest_paise(l.id) acc
left join (
  select loan_id,
         sum(principal_paise) as principal_paid,
         sum(interest_paise + penalty_paise) as interest_paid
  from loan_repayments group by loan_id
) rp on rp.loan_id = l.id
left join (
  select loan_id,
         count(*) filter (where vote = 'approve') as approvals,
         count(*) filter (where vote = 'reject')  as rejections
  from loan_votes group by loan_id
) v on v.loan_id = l.id
where l.group_id = current_group_id() and in_current_group();

create or replace view v_cash_alerts
with (security_invoker = true) as
select
  cl.id,
  cl.group_id,
  cl.direction,
  cl.amount_paise,
  cl.occurred_at,
  cl.purpose,
  cl.counterparty,
  cl.reported_at,
  m.full_name as recorded_by_name,
  case
    when cl.reported_at is null
      then now() > cl.occurred_at + make_interval(hours => g.cash_report_hours)
    else cl.reported_at > cl.occurred_at + make_interval(hours => g.cash_report_hours)
  end as reporting_breached,
  (cl.reported_at is null) as unreported
from cash_ledger cl
join members m on m.id = cl.recorded_by
join groups g on g.id = cl.group_id
where cl.direction = 'out'
  and cl.group_id = current_group_id()
  and in_current_group();

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
) v on v.expense_id = e.id
where e.group_id = current_group_id() and in_current_group();

-- The switcher needs this before any group is active, so it must NOT use
-- current_group_id().
create or replace view v_my_groups
with (security_invoker = true) as
select
  g.id,
  g.name,
  g.setup_complete,
  m.id           as member_id,
  role_of(m.id)  as role,
  m.status,
  (g.id = current_group_id()) as is_current
from groups g
join members m on m.group_id = g.id
where m.auth_user_id = (select auth.uid())
  and m.left_on is null
  and g.archived_at is null;

grant select on v_fund_summary, v_member_positions, v_unpaid_contributions,
                v_loan_status, v_cash_alerts, v_expense_status, v_my_groups
  to authenticated;
revoke all on v_fund_summary, v_member_positions, v_unpaid_contributions,
              v_loan_status, v_cash_alerts, v_expense_status, v_my_groups
  from anon;

-- ---------------------------------------------------------------------------
-- 14. RLS, rewritten for tenancy.
--
-- Every policy is the same shape:
--     group_id = current_group_id() and in_current_group()
--
-- Both halves are load-bearing. The first picks the tenant and, because
-- current_group_id() is STABLE and claim-derived, folds to a constant the
-- planner can use against the group-leading indexes. The second re-checks
-- membership live, which is what stops a JWT that outlived its membership
-- from still reading the group it names.
-- ---------------------------------------------------------------------------
drop policy if exists members_read          on members;
drop policy if exists members_update_self   on members;
drop policy if exists roles_read            on role_assignments;
drop policy if exists config_read           on app_config;
drop policy if exists audit_read            on audit_log;
drop policy if exists cash_read             on cash_ledger;
drop policy if exists periods_read          on contribution_periods;
drop policy if exists contributions_read    on contributions;
drop policy if exists loans_read            on loans;
drop policy if exists loan_votes_read       on loan_votes;
drop policy if exists loan_repayments_read  on loan_repayments;
drop policy if exists loan_repayments_insert on loan_repayments;
drop policy if exists expenses_read         on expenses;
drop policy if exists expense_votes_read    on expense_votes;
drop policy if exists bank_statements_read  on bank_statements;

create policy members_read on members for select to authenticated
  using (group_id = current_group_id() and in_current_group());

-- A member may edit only their own contact details, and only in the group
-- they currently have open. Which COLUMNS they may touch is still enforced by
-- the column grant from 0001, not by this policy.
create policy members_update_self on members for update to authenticated
  using (group_id = current_group_id()
         and auth_user_id = (select auth.uid())
         and in_current_group())
  with check (group_id = current_group_id()
              and auth_user_id = (select auth.uid()));

create policy roles_read on role_assignments for select to authenticated
  using (group_id = current_group_id() and in_current_group());

create policy cash_read on cash_ledger for select to authenticated
  using (group_id = current_group_id() and in_current_group());

create policy periods_read on contribution_periods for select to authenticated
  using (group_id = current_group_id() and in_current_group());

create policy contributions_read on contributions for select to authenticated
  using (group_id = current_group_id() and in_current_group());

create policy loans_read on loans for select to authenticated
  using (group_id = current_group_id() and in_current_group());

create policy loan_votes_read on loan_votes for select to authenticated
  using (group_id = current_group_id() and in_current_group());

create policy loan_repayments_read on loan_repayments for select to authenticated
  using (group_id = current_group_id() and in_current_group());

create policy expenses_read on expenses for select to authenticated
  using (group_id = current_group_id() and in_current_group());

create policy expense_votes_read on expense_votes for select to authenticated
  using (group_id = current_group_id() and in_current_group());

create policy bank_statements_read on bank_statements for select to authenticated
  using (group_id = current_group_id() and in_current_group());

create policy audit_read on audit_log for select to authenticated
  using (group_id = current_group_id() and in_current_group());

-- groups: the switcher needs every group you belong to, not just the open one.
alter table groups        enable row level security;
alter table profiles      enable row level security;
alter table group_invites enable row level security;

create policy groups_read on groups for select to authenticated
  using (id in (select my_group_ids()));

create policy profiles_self on profiles for select to authenticated
  using (id = (select auth.uid()));

-- Only officers see invite codes. A code is a bearer credential; a plain
-- member does not need to be able to hand one out.
create policy invites_read on group_invites for select to authenticated
  using (group_id = current_group_id()
         and in_current_group()
         and current_role_of() in ('cashier', 'accountant', 'president'));

revoke insert, update, delete on groups        from authenticated, anon;
revoke insert, update, delete on profiles      from authenticated, anon;
revoke insert, update, delete on group_invites from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 15. Creating and joining groups.
--
-- claim_group() is gone: it existed to let exactly one group ever be created.
-- ---------------------------------------------------------------------------
drop function if exists claim_group(text, text, text);
drop function if exists is_group_claimed();

create or replace function create_group(
  p_group_name text,
  p_full_name text,
  p_phone text default null
) returns groups
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := (select auth.uid());
  v_email text;
  v_group groups;
  v_member uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to create a group'
      using errcode = 'insufficient_privilege';
  end if;
  if length(btrim(coalesce(p_group_name, ''))) = 0 then
    raise exception 'The group needs a name' using errcode = 'check_violation';
  end if;

  select email into v_email from auth.users where id = v_uid;

  insert into groups (name, created_by) values (btrim(p_group_name), v_uid)
  returning * into v_group;

  insert into members (group_id, auth_user_id, full_name, phone, email, joined_on, status)
  values (v_group.id, v_uid, btrim(p_full_name), p_phone, lower(v_email),
          current_date, 'active')
  returning id into v_member;

  -- President only. One person cannot hold cashier and accountant at once --
  -- the constraint trigger refuses it, and DEFERRABLE does not change that.
  -- President carries everything setup needs anyway.
  insert into role_assignments (group_id, member_id, role, start_date)
  values (v_group.id, v_member, 'president', current_date);

  insert into profiles (id, last_group_id) values (v_uid, v_group.id)
  on conflict (id) do update set last_group_id = excluded.last_group_id;

  return v_group;
end $$;

-- Switching groups. Validates membership before recording the choice; the
-- client then refreshes its token to pick up the new claim.
create or replace function set_active_group(p_group_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_member_of(p_group_id) then
    raise exception 'You are not a member of that group'
      using errcode = 'insufficient_privilege';
  end if;

  insert into profiles (id, last_group_id)
  values ((select auth.uid()), p_group_id)
  on conflict (id) do update set last_group_id = excluded.last_group_id;
end $$;

create or replace function create_invite(
  p_max_uses int default null,
  p_days_valid int default 7
) returns group_invites
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := fn_assert_active_member();
  v_group uuid := current_group_id();
  v_row   group_invites;
begin
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may invite people'
      using errcode = 'insufficient_privilege';
  end if;

  -- One live code at a time: issuing a new one retires the old, so a code
  -- that has been forwarded around stops working.
  update group_invites set revoked_at = now()
  where group_id = v_group and revoked_at is null;

  insert into group_invites (code, group_id, created_by, expires_at, max_uses)
  values (fn_new_invite_code(), v_group, v_actor,
          now() + make_interval(days => greatest(1, p_days_valid)), p_max_uses)
  returning * into v_row;

  return v_row;
end $$;

create or replace function revoke_invite(p_code text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may revoke an invite'
      using errcode = 'insufficient_privilege';
  end if;

  update group_invites set revoked_at = now()
  where group_id = current_group_id()
    and fn_normalize_code(code) = fn_normalize_code(p_code)
    and revoked_at is null;
end $$;

-- Shown before joining. Returns the group's NAME only -- an invite code must
-- not become a read handle on the group row.
create or replace function preview_invite(p_code text)
returns table (group_name text, member_count int, valid boolean, reason text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_inv group_invites;
  v_g   groups;
begin
  select * into v_inv from group_invites
  where fn_normalize_code(code) = fn_normalize_code(p_code);

  if v_inv.code is null then
    return query select null::text, 0, false, 'That code is not recognised';
    return;
  end if;
  if v_inv.revoked_at is not null then
    return query select null::text, 0, false, 'That code has been cancelled';
    return;
  end if;
  if v_inv.expires_at < now() then
    return query select null::text, 0, false, 'That code has expired';
    return;
  end if;
  if v_inv.max_uses is not null and v_inv.use_count >= v_inv.max_uses then
    return query select null::text, 0, false, 'That code has been used up';
    return;
  end if;

  select * into v_g from groups where id = v_inv.group_id;
  return query select v_g.name, active_member_count(v_g.id), true, null::text;
end $$;

-- Joining lands you in `pending`: you can see nothing until an officer
-- approves you. A code WILL end up forwarded in a WhatsApp group, and one
-- forward should not expose a ledger.
create or replace function join_group_with_code(
  p_code text,
  p_full_name text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := (select auth.uid());
  v_email text;
  v_inv   group_invites;
  v_member uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in' using errcode = 'insufficient_privilege';
  end if;

  select * into v_inv from group_invites
  where fn_normalize_code(code) = fn_normalize_code(p_code)
  for update;

  if v_inv.code is null then
    raise exception 'That code is not recognised' using errcode = 'no_data_found';
  end if;
  if v_inv.revoked_at is not null or v_inv.expires_at < now() then
    raise exception 'That code is no longer valid' using errcode = 'check_violation';
  end if;
  if v_inv.max_uses is not null and v_inv.use_count >= v_inv.max_uses then
    raise exception 'That code has been used up' using errcode = 'check_violation';
  end if;

  if exists (select 1 from members
             where group_id = v_inv.group_id and auth_user_id = v_uid) then
    raise exception 'You are already in that group' using errcode = 'unique_violation';
  end if;

  select email into v_email from auth.users where id = v_uid;

  -- An officer may have added this person by email already; adopt that row
  -- rather than creating a second one for the same person.
  select id into v_member from members
  where group_id = v_inv.group_id
    and email is not null and lower(email) = lower(v_email)
    and auth_user_id is null
    and left_on is null;

  if v_member is not null then
    update members
    set auth_user_id = v_uid,
        full_name = coalesce(nullif(btrim(p_full_name), ''), full_name),
        status = 'pending'
    where id = v_member;
  else
    insert into members (group_id, auth_user_id, full_name, email, joined_on, status)
    values (v_inv.group_id, v_uid, btrim(p_full_name), lower(v_email),
            current_date, 'pending')
    returning id into v_member;
  end if;

  update group_invites set use_count = use_count + 1 where code = v_inv.code;

  return v_inv.group_id;
end $$;

create or replace function approve_pending_member(p_member_id uuid)
returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row members;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may approve a new member'
      using errcode = 'insufficient_privilege';
  end if;

  update members set status = 'active'
  where id = p_member_id
    and group_id = current_group_id()
    and status = 'pending'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'No pending member with that id in this group'
      using errcode = 'no_data_found';
  end if;
  return v_row;
end $$;

create or replace function reject_pending_member(p_member_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may reject a request'
      using errcode = 'insufficient_privilege';
  end if;

  delete from members
  where id = p_member_id and group_id = current_group_id() and status = 'pending';
end $$;

-- Pending members are invisible to the ordinary members list, so officers need
-- their own way to see who is waiting.
create or replace function pending_members()
returns table (id uuid, full_name text, email text, joined_on date)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.id, m.full_name, m.email, m.joined_on
  from members m
  where m.group_id = current_group_id()
    and m.status = 'pending'
    and in_current_group()
    and current_role_of() in ('cashier', 'accountant', 'president')
  order by m.joined_on
$$;

-- ---------------------------------------------------------------------------
-- 16. Every money RPC, group-scoped.
--
-- Two changes run through all of them:
--
--   * The serialization lock moves from `app_config` (one global mutex) to
--     `groups` (one row per tenant). Same guarantee -- two concurrent approvals
--     in one group cannot jointly breach its reserve -- without unrelated
--     groups blocking each other. FOR NO KEY UPDATE rather than FOR UPDATE:
--     thirteen tables now carry group_id -> groups(id), and a full FOR UPDATE
--     would block every child insert referencing that row.
--
--   * The group is DERIVED from current_group_id(), never taken as an
--     argument. An RPC that accepted a group id would let a caller lock an
--     arbitrary group's row, which is a cheap denial of service against a
--     group they are not even in.
--
-- The lock order stays groups -> loan/expense, for the same deadlock reason as
-- before.
-- ---------------------------------------------------------------------------

create or replace function open_period(p_month date)
returns contribution_periods
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_cfg   groups;
  v_start date := date_trunc('month', p_month)::date;
  v_row   contribution_periods;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may open a period'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_cfg from groups where id = v_group;

  insert into contribution_periods (group_id, period_month, due_date, grace_date, amount_paise)
  values (v_group, v_start, v_start + (v_cfg.due_day - 1),
          v_start + (v_cfg.grace_day - 1), v_cfg.monthly_contribution_paise)
  on conflict (group_id, period_month) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from contribution_periods
    where group_id = v_group and period_month = v_start;
  end if;
  return v_row;
end $$;

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
  v_group  uuid := current_group_id();
  v_actor  uuid := fn_assert_active_member();
  v_cfg    groups;
  v_period contribution_periods;
  v_fee    bigint := 0;
  v_row    contributions;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may record contributions'
      using errcode = 'insufficient_privilege';
  end if;
  if p_amount_paise <= 0 then
    raise exception 'Amount must be positive' using errcode = 'check_violation';
  end if;

  select * into v_cfg from groups where id = v_group;
  select * into v_period from contribution_periods
  where id = p_period_id and group_id = v_group;
  if v_period.id is null then
    raise exception 'Unknown contribution period' using errcode = 'foreign_key_violation';
  end if;
  if not exists (select 1 from members
                 where id = p_member_id and group_id = v_group) then
    raise exception 'That member is not in this group' using errcode = 'check_violation';
  end if;

  if p_paid_on > v_period.grace_date then
    v_fee := v_cfg.late_fee_paise;
  end if;

  insert into contributions (
    group_id, period_id, member_id, amount_paise, late_fee_paise,
    paid_on, method, note, recorded_by
  )
  values (v_group, p_period_id, p_member_id, p_amount_paise, v_fee,
          p_paid_on, p_method, p_note, v_actor)
  returning * into v_row;

  if p_method = 'cash' then
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose,
                             counterparty, recorded_by, reported_at, reported_by)
    values (v_group, 'in', p_amount_paise + v_fee, p_paid_on::timestamptz,
            'Contribution received in cash',
            (select full_name from members where id = p_member_id),
            v_actor, now(), v_actor);
  end if;

  return v_row;
end $$;

create or replace function close_period(p_period_id uuid)
returns contribution_periods
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row contribution_periods;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may close a period'
      using errcode = 'insufficient_privilege';
  end if;

  update contribution_periods set closed_at = now()
  where id = p_period_id and group_id = current_group_id() and closed_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Period not found or already closed' using errcode = 'check_violation';
  end if;
  return v_row;
end $$;

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
  v_actor uuid := fn_assert_active_member();
  v_row   cash_ledger;
begin
  if current_role_of() <> 'cashier' then
    raise exception 'Only the cashier holds the float'
      using errcode = 'insufficient_privilege';
  end if;

  insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose,
                           counterparty, recorded_by, reported_at, reported_by)
  values (current_group_id(), p_direction, p_amount_paise, p_occurred_at, p_purpose,
          p_counterparty, v_actor,
          case when p_report_now then now() end,
          case when p_report_now then v_actor end)
  returning * into v_row;

  return v_row;
end $$;

create or replace function report_cash_movement(p_id uuid)
returns cash_ledger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := fn_assert_active_member();
  v_row   cash_ledger;
begin
  update cash_ledger set reported_at = now(), reported_by = v_actor
  where id = p_id and group_id = current_group_id() and reported_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Cash entry not found or already reported'
      using errcode = 'check_violation';
  end if;
  return v_row;
end $$;

-- The float limit is per group, so the trigger has to check per group.
create or replace function fn_enforce_cash_float_limit() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  r record;
begin
  for r in
    select cl.group_id,
           sum(case when cl.direction = 'in' then cl.amount_paise
                    else -cl.amount_paise end) as bal,
           g.cash_float_limit_paise as lim
    from cash_ledger cl join groups g on g.id = cl.group_id
    group by cl.group_id, g.cash_float_limit_paise
  loop
    if r.bal > r.lim then
      raise exception
        'Cash float would reach % but the limit is % -- deposit into the bank first',
        (r.bal::numeric / 100)::text, (r.lim::numeric / 100)::text
        using errcode = 'check_violation';
    end if;
    if r.bal < 0 then
      raise exception 'Cash float cannot go negative (would be %)',
        (r.bal::numeric / 100)::text using errcode = 'check_violation';
    end if;
  end loop;
  return null;
end $$;

create or replace function request_loan(
  p_guarantor_id uuid,
  p_principal_paise bigint,
  p_term_months int,
  p_purpose text default null
) returns loans
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group    uuid := current_group_id();
  v_actor    uuid := fn_assert_active_member();
  v_cfg      groups;
  v_fund     bigint;
  v_cap      bigint;
  v_lendable bigint;
  v_out      bigint;
  v_mine     bigint;
  v_eligible int;
  v_needed   int;
  v_row      loans;
begin
  -- Lock this group's row before reading any fund figure.
  select * into v_cfg from groups where id = v_group for no key update;

  if p_principal_paise <= 0 then
    raise exception 'Loan amount must be positive' using errcode = 'check_violation';
  end if;
  if p_term_months < 1 or p_term_months > v_cfg.max_loan_months then
    raise exception 'Repayment term must be between 1 and % months', v_cfg.max_loan_months
      using errcode = 'check_violation';
  end if;
  if p_guarantor_id = v_actor then
    raise exception 'You cannot stand guarantor for your own loan'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from members
                 where id = p_guarantor_id and group_id = v_group
                   and left_on is null and status = 'active') then
    raise exception 'Guarantor must be an active member of this group'
      using errcode = 'check_violation';
  end if;

  v_fund     := fn_fund_total_paise(v_group);
  v_cap      := v_fund * v_cfg.max_loan_pct_bp / 10000;
  v_lendable := v_fund * (10000 - v_cfg.reserve_pct_bp) / 10000;
  v_out      := total_outstanding_paise(v_group);
  v_mine     := member_outstanding_paise(v_actor);
  v_needed   := required_loan_approvals(v_group);

  if v_mine + p_principal_paise > v_cap then
    raise exception
      'This would take your total borrowing to Rs.% but your limit is Rs.%',
      ((v_mine + p_principal_paise)::numeric / 100)::text, (v_cap::numeric / 100)::text
      using errcode = 'check_violation';
  end if;

  if v_out + p_principal_paise > v_lendable then
    raise exception
      'Only Rs.% is available to lend (the reserve must stay in the bank)',
      (greatest(0, v_lendable - v_out)::numeric / 100)::text
      using errcode = 'check_violation';
  end if;

  select count(*)::int into v_eligible
  from members
  where group_id = v_group and left_on is null and status = 'active' and id <> v_actor;

  if v_eligible < v_needed then
    raise exception
      'Not enough members to approve a loan yet (% can vote, % approvals needed)',
      v_eligible, v_needed
      using errcode = 'check_violation';
  end if;

  insert into loans (
    group_id, borrower_id, guarantor_id, principal_paise, purpose,
    rate_bp, overdue_rate_bp, term_months, status,
    fund_total_at_request_paise, eligible_voter_count,
    required_approvals, borrower_role_at_request
  )
  values (
    v_group, v_actor, p_guarantor_id, p_principal_paise, p_purpose,
    v_cfg.loan_rate_bp, v_cfg.overdue_rate_bp, p_term_months, 'requested',
    v_fund, v_eligible, v_needed, role_of(v_actor)
  )
  returning * into v_row;

  return v_row;
end $$;

create or replace function cast_loan_vote(
  p_loan_id uuid,
  p_vote vote_enum,
  p_note text default null
) returns loans
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group     uuid := current_group_id();
  v_actor     uuid := fn_assert_active_member();
  v_cfg       groups;
  v_loan      loans;
  v_approvals int;
  v_rejections int;
  v_lendable  bigint;
  v_out       bigint;
begin
  select * into v_cfg from groups where id = v_group for no key update;
  select * into v_loan from loans
  where id = p_loan_id and group_id = v_group for update;

  if v_loan.id is null then
    raise exception 'Loan not found' using errcode = 'no_data_found';
  end if;
  if v_loan.status <> 'requested' then
    raise exception 'This loan is already %', v_loan.status
      using errcode = 'check_violation';
  end if;
  if v_actor = v_loan.borrower_id then
    raise exception 'You cannot vote on your own loan request'
      using errcode = 'insufficient_privilege';
  end if;

  insert into loan_votes (group_id, loan_id, voter_id, vote, note)
  values (v_group, p_loan_id, v_actor, p_vote, p_note)
  on conflict (loan_id, voter_id)
  do update set vote = excluded.vote, note = excluded.note, voted_at = now();

  select
    count(*) filter (where vote = 'approve'),
    count(*) filter (where vote = 'reject')
  into v_approvals, v_rejections
  from loan_votes where loan_id = p_loan_id and group_id = v_group;

  if v_approvals >= v_loan.required_approvals then
    v_lendable := fn_fund_total_paise(v_group) * (10000 - v_cfg.reserve_pct_bp) / 10000;
    v_out      := total_outstanding_paise(v_group);

    if v_out + v_loan.principal_paise > v_lendable then
      raise exception
        'The fund can no longer cover this loan: only Rs.% is lendable now',
        (greatest(0, v_lendable - v_out)::numeric / 100)::text
        using errcode = 'check_violation';
    end if;

    update loans set status = 'approved', decided_at = now()
    where id = p_loan_id returning * into v_loan;

  elsif v_rejections > v_loan.eligible_voter_count - v_loan.required_approvals then
    update loans set status = 'rejected', decided_at = now()
    where id = p_loan_id returning * into v_loan;
  end if;

  return v_loan;
end $$;

create or replace function disburse_loan(
  p_loan_id uuid,
  p_disbursed_on date default current_date,
  p_method payment_method_enum default 'bank'
) returns loans
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group    uuid := current_group_id();
  v_actor    uuid := fn_assert_active_member();
  v_cfg      groups;
  v_loan     loans;
  v_lendable bigint;
  v_out      bigint;
begin
  select * into v_cfg from groups where id = v_group for no key update;
  select * into v_loan from loans
  where id = p_loan_id and group_id = v_group for update;

  if v_loan.id is null then
    raise exception 'Loan not found' using errcode = 'no_data_found';
  end if;
  if v_loan.status <> 'approved' then
    raise exception 'Only an approved loan can be disbursed (this one is %)', v_loan.status
      using errcode = 'check_violation';
  end if;
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may disburse a loan'
      using errcode = 'insufficient_privilege';
  end if;
  if v_actor = v_loan.borrower_id then
    raise exception 'You cannot disburse your own loan -- ask the other office holder'
      using errcode = 'insufficient_privilege';
  end if;

  v_lendable := fn_fund_total_paise(v_group) * (10000 - v_cfg.reserve_pct_bp) / 10000;
  v_out      := total_outstanding_paise(v_group);
  if v_out + v_loan.principal_paise > v_lendable then
    raise exception 'Disbursing now would break the reserve'
      using errcode = 'check_violation';
  end if;

  update loans
  set status = 'disbursed',
      disbursed_on = p_disbursed_on,
      due_on = (p_disbursed_on + make_interval(months => v_loan.term_months))::date
  where id = p_loan_id
  returning * into v_loan;

  if p_method = 'cash' then
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose,
                             counterparty, recorded_by, reported_at, reported_by)
    values (v_group, 'out', v_loan.principal_paise, p_disbursed_on::timestamptz,
            'Loan disbursed',
            (select full_name from members where id = v_loan.borrower_id),
            v_actor, now(), v_actor);
  end if;

  return v_loan;
end $$;

create or replace function record_repayment(
  p_loan_id uuid,
  p_principal_paise bigint,
  p_interest_paise bigint default 0,
  p_penalty_paise bigint default 0,
  p_paid_on date default current_date,
  p_method payment_method_enum default 'bank',
  p_note text default null
) returns loan_repayments
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_loan  loans;
  v_out   bigint;
  v_row   loan_repayments;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may record a repayment'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_loan from loans
  where id = p_loan_id and group_id = v_group for update;
  if v_loan.id is null then
    raise exception 'Loan not found' using errcode = 'no_data_found';
  end if;
  if v_loan.status <> 'disbursed' then
    raise exception 'Only a disbursed loan can be repaid (this one is %)', v_loan.status
      using errcode = 'check_violation';
  end if;

  v_out := loan_outstanding_principal_paise(p_loan_id);
  if p_principal_paise > v_out then
    raise exception 'Principal repayment Rs.% exceeds the outstanding Rs.%',
      (p_principal_paise::numeric / 100)::text, (v_out::numeric / 100)::text
      using errcode = 'check_violation';
  end if;

  insert into loan_repayments (group_id, loan_id, paid_on, principal_paise,
                               interest_paise, penalty_paise, method, note, recorded_by)
  values (v_group, p_loan_id, p_paid_on, p_principal_paise, p_interest_paise,
          p_penalty_paise, p_method, p_note, v_actor)
  returning * into v_row;

  if p_method = 'cash' then
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose,
                             counterparty, recorded_by, reported_at, reported_by)
    values (v_group, 'in', p_principal_paise + p_interest_paise + p_penalty_paise,
            p_paid_on::timestamptz, 'Loan repayment received in cash',
            (select full_name from members where id = v_loan.borrower_id),
            v_actor, now(), v_actor);
  end if;

  return v_row;
end $$;

create or replace function propose_expense(
  p_category expense_category_enum,
  p_description text,
  p_amount_paise bigint,
  p_incurred_on date default current_date,
  p_method payment_method_enum default 'bank'
) returns expenses
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group    uuid := current_group_id();
  v_actor    uuid := fn_assert_active_member();
  v_cfg      groups;
  v_fund     bigint;
  v_eligible int;
  v_needs    boolean;
  v_row      expenses;
begin
  select * into v_cfg from groups where id = v_group for no key update;

  if p_amount_paise <= 0 then
    raise exception 'Amount must be positive' using errcode = 'check_violation';
  end if;

  v_fund  := fn_fund_total_paise(v_group);
  v_needs := p_category not in ('bank_charge', 'admin');
  v_eligible := active_member_count(v_group);

  insert into expenses (
    group_id, category, description, amount_paise, incurred_on, method,
    requires_vote, fund_total_at_request_paise, required_approvals,
    eligible_voter_count, created_by, status, decided_at
  )
  values (
    v_group, p_category, p_description, p_amount_paise, p_incurred_on, p_method,
    v_needs, v_fund,
    case when v_needs then required_expense_approvals(v_group) else 0 end,
    v_eligible, v_actor,
    case when v_needs then 'proposed'::expense_status_enum
         else 'approved'::expense_status_enum end,
    case when v_needs then null else now() end
  )
  returning * into v_row;

  return v_row;
end $$;

create or replace function cast_expense_vote(
  p_expense_id uuid,
  p_vote vote_enum,
  p_note text default null
) returns expenses
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group      uuid := current_group_id();
  v_actor      uuid := fn_assert_active_member();
  v_cfg        groups;
  v_exp        expenses;
  v_approvals  int;
  v_rejections int;
  v_cap        bigint;
  v_ytd        bigint;
begin
  select * into v_cfg from groups where id = v_group for no key update;
  select * into v_exp from expenses
  where id = p_expense_id and group_id = v_group for update;

  if v_exp.id is null then
    raise exception 'Expense not found' using errcode = 'no_data_found';
  end if;
  if v_exp.status <> 'proposed' then
    raise exception 'This expense is already %', v_exp.status
      using errcode = 'check_violation';
  end if;

  insert into expense_votes (group_id, expense_id, voter_id, vote, note)
  values (v_group, p_expense_id, v_actor, p_vote, p_note)
  on conflict (expense_id, voter_id)
  do update set vote = excluded.vote, note = excluded.note, voted_at = now();

  select
    count(*) filter (where vote = 'approve'),
    count(*) filter (where vote = 'reject')
  into v_approvals, v_rejections
  from expense_votes where expense_id = p_expense_id and group_id = v_group;

  if v_approvals >= v_exp.required_approvals then
    v_cap := fn_fund_total_paise(v_group) * v_cfg.expense_annual_pct_bp / 10000;
    v_ytd := fn_expenses_ytd_paise(extract(year from v_exp.incurred_on)::int, v_group);

    if v_ytd + v_exp.amount_paise > v_cap then
      raise exception
        'Group expenses for % would reach Rs.% but the yearly limit is Rs.%',
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

create or replace function mark_expense_paid(
  p_expense_id uuid,
  p_paid_on date default current_date
) returns expenses
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_actor uuid := fn_assert_active_member();
  v_exp   expenses;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may mark an expense paid'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_exp from expenses
  where id = p_expense_id and group_id = v_group for update;
  if v_exp.id is null then
    raise exception 'Expense not found' using errcode = 'no_data_found';
  end if;
  if v_exp.status <> 'approved' then
    raise exception 'Only an approved expense can be paid (this one is %)', v_exp.status
      using errcode = 'check_violation';
  end if;

  if v_exp.method = 'cash' then
    insert into cash_ledger (group_id, direction, amount_paise, occurred_at, purpose,
                             expense_id, recorded_by, reported_at, reported_by)
    values (v_group, 'out', v_exp.amount_paise, p_paid_on::timestamptz,
            v_exp.description, v_exp.id, v_actor, now(), v_actor);
  end if;

  update expenses set status = 'paid', paid_on = p_paid_on
  where id = p_expense_id returning * into v_exp;

  return v_exp;
end $$;

create or replace function record_bank_statement(
  p_as_of date,
  p_closing_balance_paise bigint,
  p_note text default null
) returns bank_statements
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group    uuid := current_group_id();
  v_actor    uuid := fn_assert_active_member();
  v_expected bigint;
  v_row      bank_statements;
begin
  if current_role_of() not in ('cashier', 'accountant') then
    raise exception 'Only the cashier or accountant may record a bank statement'
      using errcode = 'insufficient_privilege';
  end if;

  v_expected := fn_fund_total_paise(v_group)
              - total_outstanding_paise(v_group)
              - cash_float_balance_paise(v_group);

  insert into bank_statements (group_id, as_of, closing_balance_paise,
                               expected_balance_paise, difference_paise, note, uploaded_by)
  values (v_group, p_as_of, p_closing_balance_paise, v_expected,
          p_closing_balance_paise - v_expected, p_note, v_actor)
  on conflict (group_id, as_of) do update
    set closing_balance_paise = excluded.closing_balance_paise,
        expected_balance_paise = excluded.expected_balance_paise,
        difference_paise = excluded.difference_paise,
        note = excluded.note,
        uploaded_by = excluded.uploaded_by
  returning * into v_row;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 17. Member and role management, group-scoped.
-- ---------------------------------------------------------------------------
create or replace function add_member(
  p_full_name text,
  p_email text default null,
  p_phone text default null,
  p_nominee_name text default null,
  p_nominee_phone text default null
) returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_row   members;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may add members'
      using errcode = 'insufficient_privilege';
  end if;
  if length(btrim(coalesce(p_full_name, ''))) = 0 then
    raise exception 'Name is required' using errcode = 'check_violation';
  end if;

  insert into members (group_id, full_name, email, phone, nominee_name,
                       nominee_phone, joined_on, status)
  values (v_group, btrim(p_full_name), lower(nullif(btrim(p_email), '')), p_phone,
          p_nominee_name, p_nominee_phone, current_date, 'active')
  returning * into v_row;

  return v_row;
end $$;

create or replace function update_member(
  p_member_id uuid,
  p_full_name text default null,
  p_email text default null,
  p_phone text default null,
  p_nominee_name text default null,
  p_nominee_phone text default null
) returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := fn_assert_active_member();
  v_row   members;
begin
  if p_member_id <> v_actor
     and current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'You may only edit your own details'
      using errcode = 'insufficient_privilege';
  end if;

  update members set
    full_name     = coalesce(nullif(btrim(p_full_name), ''), full_name),
    email         = coalesce(lower(nullif(btrim(p_email), '')), email),
    phone         = coalesce(nullif(btrim(p_phone), ''), phone),
    nominee_name  = coalesce(nullif(btrim(p_nominee_name), ''), nominee_name),
    nominee_phone = coalesce(nullif(btrim(p_nominee_phone), ''), nominee_phone)
  where id = p_member_id and group_id = current_group_id()
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Member not found in this group' using errcode = 'no_data_found';
  end if;
  return v_row;
end $$;

create or replace function assign_role(p_member_id uuid, p_role role_enum)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_other role_enum;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may change roles'
      using errcode = 'insufficient_privilege';
  end if;
  if p_role = 'member' then
    raise exception 'Use release_role() to remove an office'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from members
                 where id = p_member_id and group_id = v_group
                   and left_on is null and status = 'active') then
    raise exception 'That member is not active in this group'
      using errcode = 'check_violation';
  end if;

  v_other := case when p_role = 'cashier' then 'accountant'
                  when p_role = 'accountant' then 'cashier' end;
  if v_other is not null and exists (
    select 1 from role_assignments
    where member_id = p_member_id and group_id = v_group
      and role = v_other and end_date is null
  ) then
    raise exception
      'The cashier and the accountant must be different people -- move the other office first'
      using errcode = 'check_violation';
  end if;

  update role_assignments set end_date = current_date
  where group_id = v_group and role = p_role
    and end_date is null and start_date < current_date;

  delete from role_assignments
  where group_id = v_group and role = p_role
    and end_date is null and start_date >= current_date;

  insert into role_assignments (group_id, member_id, role, start_date)
  values (v_group, p_member_id, p_role, current_date);
end $$;

create or replace function release_role(p_role role_enum) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may change roles'
      using errcode = 'insufficient_privilege';
  end if;
  -- A group must never be left headless: the president hands over, never
  -- simply resigns.
  if p_role = 'president' then
    raise exception 'Give the president role to someone else rather than leaving it empty'
      using errcode = 'check_violation';
  end if;

  update role_assignments set end_date = current_date
  where group_id = v_group and role = p_role
    and end_date is null and start_date < current_date;

  delete from role_assignments
  where group_id = v_group and role = p_role
    and end_date is null and start_date >= current_date;
end $$;

create or replace function remove_member(
  p_member_id uuid,
  p_left_on date default current_date
) returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_group uuid := current_group_id();
  v_owed  bigint;
  v_row   members;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may remove a member'
      using errcode = 'insufficient_privilege';
  end if;

  if role_of(p_member_id) = 'president' then
    raise exception 'Hand the president role to someone else before removing them'
      using errcode = 'check_violation';
  end if;

  v_owed := member_outstanding_paise(p_member_id);
  if v_owed > 0 then
    raise exception 'This member still owes Rs.% -- settle the loan first',
      (v_owed::numeric / 100)::text using errcode = 'check_violation';
  end if;

  if exists (select 1 from loans
             where guarantor_id = p_member_id and group_id = v_group
               and status in ('approved', 'disbursed')) then
    raise exception 'This member is guarantor on a running loan -- replace them first'
      using errcode = 'check_violation';
  end if;

  update role_assignments set end_date = p_left_on
  where member_id = p_member_id and group_id = v_group and end_date is null;

  update members set left_on = p_left_on, status = 'left'
  where id = p_member_id and group_id = v_group and left_on is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Member not found or already left' using errcode = 'no_data_found';
  end if;
  return v_row;
end $$;

create or replace function update_config(
  p_group_name text default null,
  p_monthly_contribution_paise bigint default null,
  p_due_day int default null,
  p_grace_day int default null,
  p_late_fee_paise bigint default null,
  p_loan_rate_bp int default null,
  p_overdue_rate_bp int default null,
  p_max_loan_months int default null,
  p_max_loan_pct_bp int default null,
  p_reserve_pct_bp int default null,
  p_loan_required_approvals int default null,
  p_expense_required_approvals int default null,
  p_expense_annual_pct_bp int default null,
  p_cash_float_limit_paise bigint default null,
  p_cash_report_hours int default null,
  p_setup_complete boolean default null
) returns groups
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row groups;
begin
  perform fn_assert_active_member();
  if current_role_of() not in ('cashier', 'accountant', 'president') then
    raise exception 'Only an office holder may change the group rules'
      using errcode = 'insufficient_privilege';
  end if;

  update groups set
    name = coalesce(nullif(btrim(p_group_name), ''), name),
    monthly_contribution_paise =
      coalesce(p_monthly_contribution_paise, monthly_contribution_paise),
    due_day                   = coalesce(p_due_day, due_day),
    grace_day                 = coalesce(p_grace_day, grace_day),
    late_fee_paise            = coalesce(p_late_fee_paise, late_fee_paise),
    loan_rate_bp              = coalesce(p_loan_rate_bp, loan_rate_bp),
    overdue_rate_bp           = coalesce(p_overdue_rate_bp, overdue_rate_bp),
    max_loan_months           = coalesce(p_max_loan_months, max_loan_months),
    max_loan_pct_bp           = coalesce(p_max_loan_pct_bp, max_loan_pct_bp),
    reserve_pct_bp            = coalesce(p_reserve_pct_bp, reserve_pct_bp),
    loan_required_approvals   =
      coalesce(p_loan_required_approvals, loan_required_approvals),
    expense_required_approvals =
      coalesce(p_expense_required_approvals, expense_required_approvals),
    expense_annual_pct_bp     = coalesce(p_expense_annual_pct_bp, expense_annual_pct_bp),
    cash_float_limit_paise    = coalesce(p_cash_float_limit_paise, cash_float_limit_paise),
    cash_report_hours         = coalesce(p_cash_report_hours, cash_report_hours),
    setup_complete            = coalesce(p_setup_complete, setup_complete)
  where id = current_group_id()
  returning * into v_row;

  return v_row;
end $$;

-- link_signed_in_member() is obsolete: joining is now an explicit act, either
-- create_group() or join_group_with_code(). Kept as a no-op returning the
-- caller's member row so an old client mid-deploy does not crash.
create or replace function link_signed_in_member() returns members
language sql stable security definer set search_path = public, pg_temp as $$
  select * from members where id = current_member_id()
$$;

-- group_status() kept for the same reason; the new client uses v_my_groups.
create or replace function group_status()
returns table (group_name text, claimed boolean, setup_complete boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select g.name, true, g.setup_complete
  from groups g where g.id = current_group_id()
$$;

-- ---------------------------------------------------------------------------
-- 18. The audit trigger records which group a change belonged to.
-- ---------------------------------------------------------------------------
create or replace function fn_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old   jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new   jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_id    text  := coalesce(v_new ->> 'id', v_old ->> 'id');
  v_group uuid  := nullif(coalesce(v_new ->> 'group_id', v_old ->> 'group_id'), '')::uuid;
  v_keys  text[];
begin
  if tg_op = 'UPDATE' then
    select array_agg(key order by key) into v_keys
    from jsonb_object_keys(v_new) as key
    where v_new -> key is distinct from v_old -> key;
    if v_keys is null then
      return new;
    end if;
  end if;

  -- `groups` itself has no group_id column; it IS the group.
  if v_group is null and tg_table_name = 'groups' then
    v_group := coalesce(v_new ->> 'id', v_old ->> 'id')::uuid;
  end if;

  insert into audit_log (
    group_id, actor_auth_id, actor_member_id, table_name, row_id,
    action, old_data, new_data, changed_keys
  )
  values (
    v_group, (select auth.uid()), current_member_id(), tg_table_name, v_id,
    tg_op, v_old, v_new, v_keys
  );

  return coalesce(new, old);
end $$;

-- profiles is personal, not group business -- keep it out of the group ledger.
create or replace function fn_attach_audit_triggers() returns void
language plpgsql as $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname not in ('audit_log', 'profiles')
  loop
    execute format('drop trigger if exists trg_audit on public.%I', r.relname);
    execute format(
      'create trigger trg_audit after insert or update or delete on public.%I
         for each row execute function fn_audit()', r.relname);
  end loop;
end $$;

select fn_attach_audit_triggers();

-- ---------------------------------------------------------------------------
-- 19. app_config goes away.
--
-- Its settings are columns on `groups` now, and `groups` is what the app reads.
--
-- An earlier draft left a compatibility VIEW behind here so that a client still
-- running the old code mid-deploy would keep working. That view was a mistake
-- twice over. It could not actually be written -- `select true as id, g.* from
-- groups g` yields `id` twice, once as the fake boolean singleton key and once
-- as the group's real uuid -- and even correctly written it would have been a
-- view that silently shows ONE group's settings to a client that believes
-- there is only one group, which is precisely the assumption this migration
-- exists to remove. A stale client should fail loudly, not read plausible
-- numbers from an arbitrary tenant.
-- ---------------------------------------------------------------------------
drop table app_config;

-- ---------------------------------------------------------------------------
-- 20. Grants.
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
  fns text[] := array[
    'current_group_id()', 'is_member_of(uuid)', 'in_current_group()',
    'current_member_id()', 'my_group_ids()', 'is_group_member()',
    'role_of(uuid)', 'current_role_of()', 'active_member_count(uuid)',
    'fn_assert_active_member()', 'required_loan_approvals(uuid)',
    'required_expense_approvals(uuid)',
    'create_group(text,text,text)', 'set_active_group(uuid)',
    'create_invite(int,int)', 'revoke_invite(text)', 'preview_invite(text)',
    'join_group_with_code(text,text)', 'approve_pending_member(uuid)',
    'reject_pending_member(uuid)', 'pending_members()',
    'fn_contributions_received_paise(uuid)', 'fn_interest_received_paise(uuid)',
    'fn_expenses_paid_paise(uuid)', 'fn_fund_total_paise(uuid)',
    'fn_expenses_ytd_paise(int,uuid)', 'cash_float_balance_paise(uuid)',
    'total_outstanding_paise(uuid)', 'loan_outstanding_principal_paise(uuid)',
    'member_outstanding_paise(uuid)',
    'open_period(date)', 'close_period(uuid)',
    'record_contribution(uuid,uuid,bigint,date,payment_method_enum,text)',
    'record_cash_movement(cash_direction_enum,bigint,text,timestamptz,text,boolean)',
    'report_cash_movement(uuid)',
    'request_loan(uuid,bigint,int,text)', 'cast_loan_vote(uuid,vote_enum,text)',
    'disburse_loan(uuid,date,payment_method_enum)',
    'record_repayment(uuid,bigint,bigint,bigint,date,payment_method_enum,text)',
    'propose_expense(expense_category_enum,text,bigint,date,payment_method_enum)',
    'cast_expense_vote(uuid,vote_enum,text)', 'mark_expense_paid(uuid,date)',
    'record_bank_statement(date,bigint,text)',
    'add_member(text,text,text,text,text)',
    'update_member(uuid,text,text,text,text,text)',
    'assign_role(uuid,role_enum)', 'release_role(role_enum)',
    'remove_member(uuid,date)',
    'update_config(text,bigint,int,int,bigint,int,int,int,int,int,int,int,int,bigint,int,boolean)',
    'link_signed_in_member()', 'group_status()'
  ];
begin
  foreach fn in array fns loop
    execute format('revoke execute on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;
