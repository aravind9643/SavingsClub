# Sanchay — context for agents

A multi-tenant web app for friends' savings groups (*sangam*, *chit fund*,
*committee*): monthly contributions, member loans with group voting, expenses,
the cashier's cash float, bank reconciliation, and an append-only audit log.

Read this before changing anything. Most of what looks like over-engineering
here is load-bearing, and the reasons are not obvious from the code alone.

---

## The one idea this codebase is built around

**The database enforces the rules, not the UI.**

Every protection is a policy, a constraint, or a `SECURITY DEFINER` function
that re-checks its own preconditions. A member who opens devtools and calls
PostgREST directly, with their own valid token, can do nothing the UI would not
let them do. If you find yourself writing a check in React that has no
counterpart in SQL, you have almost certainly put it in the wrong place.

The corollary matters just as much: **a bug here does not look like an error.**
It looks like a number that is slightly too large. Treat "the screen shows a
plausible figure" as no evidence at all.

---

## Getting it running

```bash
npm install
cp .env.example .env.local    # then fill in VITE_SUPABASE_URL and
                              # VITE_SUPABASE_ANON_KEY from the Supabase
                              # dashboard (Project Settings → API)
npm run dev                   # http://localhost:5173
```

In the app: **First time here** → create an account → **Start a new group**.
You become the admin. Invite others from **Settings → Invite people**, approve
them on **Members**. Nothing needs to be seeded by hand.

Migrations are applied with `npx supabase db push` (or
`npx supabase db reset --linked` to rebuild from scratch — this **destroys all
remote data**, so confirm with the user first).

## Stack

React 19 · TypeScript · Vite 8 · react-router-dom 7 · Supabase (Postgres, Auth,
RLS) · oxlint

No data-fetching library. `src/hooks/useQuery.ts` is ~200 lines and does what
this app needs. If it grows much past that, adopt TanStack Query rather than
extending it further.

```
src/
  App.tsx              routes, the gate (which screen for which state), Screen frame
  context/
    SessionContext.tsx session, groups[], currentGroupId, switchGroup, role, config
    FundContext.tsx    fund summary + the dashboard alert list
  hooks/useQuery.ts    the whole cache layer, group-namespaced (see below)
  components/
    ui.tsx             Hero Chip Tag List Row Notice Panel Stat Sheet Field Busy …
    icons.tsx          Font Awesome wrappers
    GroupSwitcher.tsx  bottom sheet listing your groups
  lib/
    money.ts           paise helpers; money is NEVER a float
    types.ts           row shapes returned by views and RPCs
    supabase.ts        client + friendlyError
  pages/               14 screens
supabase/
  migrations/          0001-0024, applied in numerical order
  tests/
    assertions.sql     protections still in force (RLS on, RPC-only writes, …)
    isolation.sql      two real groups, proves neither can see the other
```

---

## Money

**Integer paise everywhere** — in Postgres (`bigint`), over the wire, and in
JS. Never a float, never a partial rupee. Rates are **basis points** (`200` =
2.00% per month).

₹50 lakh is 5e8 paise, eight orders of magnitude below `MAX_SAFE_INTEGER`, so
integer arithmetic in JS is exact at this scale. `assertSafe()` makes that
assumption fail loudly if it ever stops holding. Use `toPaise`,
`rupeesToPaise`, `formatPaise`, `formatPaiseShort` from `lib/money.ts` — do not
hand-roll `/100`.

Supabase returns `bigint` as a number *or* a string depending on magnitude,
which is why `toPaise()` accepts both.

### Two fund numbers that are not the same

| | |
|---|---|
| `total_fund_paise` | contributions + interest **received** − expenses. Money out on loan is still an asset, so it is **not** subtracted. |
| `expected_bank_balance_paise` | fund − outstanding principal − cash float. What should actually be sitting in the bank. |

Accrued-but-unpaid interest is a **separate memo line**
(`accrued_receivable_paise`), never folded into the fund. That is what lets
reconciliation reach exactly zero instead of "close enough".

**A write-off must reduce the fund.** `write_off_loan()` books an expense row
for the unrecovered principal, flagged `is_loan_write_off`. Without it the lost
money stayed counted as an asset: `outstanding` fell, `fund` did not, and
reconciliation carried a permanent gap exactly equal to the loss — while the
group kept lending against a cap computed from the inflated total. The flag
keeps that loss out of `fn_expenses_ytd_paise()`, so one default cannot consume
the group's discretionary spending budget for the year.

### Interest

Simple interest on the **reducing balance**, computed per-day over a 30-day
month. The overdue rate applies **only to days after the due date** — never
retroactively to the whole term. `loan_accrued_interest_paise(loan_id, as_of)`
walks the repayment history segment by segment; it is the only correct source
for what a loan owes. Do not re-derive it in TypeScript.

---

## Multi-tenancy — read this before touching any query

### Two-step authorization

> The active group is carried in a JWT claim, which is fast but **can outlive
> the membership it asserts**: remove someone and their token still names the
> group until it expires. So the claim only chooses WHICH group; a live lookup
> in `members` decides WHETHER you may see it. Every policy does both. Never
> shortcut this to the claim alone.

Every RLS policy is the same shape, and both halves are load-bearing:

```sql
group_id = current_group_id() and in_current_group()
```

`current_group_id()` reads the `group_id` claim, falling back to
`profiles.last_group_id`. `in_current_group()` is the live `members` check.

### Money functions are SECURITY DEFINER — RLS does NOT protect them

This is the sharpest edge in the codebase. Ten aggregates
(`fn_fund_total_paise`, `total_outstanding_paise`, `cash_float_balance_paise`,
…) run as definer and therefore **bypass RLS entirely**. Each takes
`p_group_id uuid default current_group_id()` and filters on it explicitly.

If one loses that filter it sums *every tenant's money together*. And because
the loan cap check in `cast_loan_vote()` calls the same function the dashboard
does, **the screen and the enforcement would agree on the same wrong number**
and authorise loans that breach the reserve. Nothing throws.

When an RPC has already locked a group, it passes that group id explicitly
rather than re-reading the claim — the claim could name a different group.

### Writes are RPC-only

Every table has **no write policy at all** except `members`, which permits
self-edit of `phone`, `nominee_name`, `nominee_phone` via a column grant. That
absence is the security property: it is why a member cannot insert their own
approving vote or flip a loan straight to `disbursed`.

To change what a write does, change the RPC. Adding a write policy to work
around one is almost always wrong.

### Denormalised `group_id` + composite FKs

Child tables carry `group_id` so policies are a plain equality rather than a
correlated subquery. Composite foreign keys (`(group_id, loan_id)` →
`loans(group_id, id)`) are what stop that copy from ever disagreeing with the
parent. Without them a bug could file a vote under group A against a loan in
group B — and `cast_loan_vote()` counts by `loan_id` alone, so that vote would
cross **group B's** approval threshold.

### Concurrency

Lock order is **`groups` → `loans`** (or `expenses`), always. RPCs do
`select * into v_cfg from groups where id = v_group for no key update` first.
That serialises concurrent mutations — votes, loan disbursements, expense approvals,
and period openings (`open_period`) — so concurrent operations cannot jointly
breach reserves or diverge config state. Keep the order; reversing it deadlocks.

### Snapshots beat live lookups for votes

`required_approvals`, `eligible_voter_count` and `borrower_role_at_request` are
copied onto the loan at request time, so a role rotation mid-vote cannot move
the goalposts.

---

## The frontend cache is group-namespaced — do not bypass it

Query keys at call sites are bare nouns: `'fund'`, `'members'`, `'loans'`.
`useQuery` prefixes every key with the active group id **centrally**, in
`setQueryGroup()`.

This is deliberate. The alternative — adding `currentGroupId` to ~30 cache key
strings — fails silently the first time someone forgets one: switch group and the
new group's name renders above the previous group's balance. Keep the namespacing
in the hook. Do not add the group id to cache keys, and do not read the cache
directly.

`invalidate('fund')` scopes to the active group too, so it can never disturb
another tenant's rows.

### Defense-in-depth: query filters vs cache keys

Distinguish between **cache keys** and the **underlying Supabase query**:
- **Cache key**: Always a bare noun (`useQuery('members', ...)`).
- **Query body**: Explicitly filter `.eq('group_id', currentGroupId)` when `currentGroupId`
  is available.
While RLS already guarantees multi-tenant isolation, explicit query scoping is
load-bearing defense-in-depth: if an RLS policy ever regresses, cross-tenant data
cannot leak, and Postgres can use tenant indices directly without broad scans.

### Double-submit mutation guard

`useMutation` maintains an internal `inflightRef` re-entry lock. If a second tap
arrives before React batches the state update that disables the submit button,
the extra call is dropped rather than firing duplicate RPCs.

---

## Onboarding model

Anyone may create a group and becomes its **admin**. Others join with an
invite code (`ABCD-EFGH-JKLM`, 7-day expiry, one live code per group — issuing a
new one retires the old).

**A code alone gets you nothing.** `join_group_with_code()` lands the joiner in
`status = 'pending'`, where they can read **nothing** until an officer calls
`approve_pending_member()`. The reason is written into the migration: *a code
WILL end up forwarded in a WhatsApp group, and one forward should not expose a
ledger.*

Member `status` is `'pending' | 'active' | 'left'`. Only `'active'` counts for
`in_current_group()`, for `active_member_count()`, and for vote eligibility.

Approval thresholds are majority-based when config is `0`:
`greatest(2, active/2 + 1)`. A fixed `4` would lock a 3-person group out of
lending on its first day.

`release_role('admin')` and `remove_member()` on an admin both **raise** —
the office must be handed over, never left empty. `remove_member()` also refuses
anyone with an outstanding loan: settle the debt first, or the money leaves with
them and the books never balance again.

---

## Roles

`member | cashier | accountant | admin`. Cashier and accountant **must be
different people** — a constraint trigger enforces it, and `DEFERRABLE` does not
change that (deferring moves the check to commit; it never permits the end
state). One holder per office per group, enforced by a GiST exclusion
constraint over `daterange`.

Role responsibilities and RPC permissions:
- **Admin**: Group administrator. Configures rules (`update_config`), invites
  and approves members (`approve_pending_member`), and can open the monthly
  period (`open_period`) once money offices are assigned.
- **Cashier**: Holds the cash float, records cash movements (`record_cash_movement`),
  records cash/bank contributions and repayments, opens/closes periods, and disburses loans.
- **Accountant**: Performs bank reconciliation (`record_bank_statement`), records
  contributions and repayments, opens/closes periods, and disburses loans.
- **Officers** (`admin | cashier | accountant`): Can propose auto-approved
  `admin` and `bank_charge` expenses without voting, write off uncollectable
  disbursed loans (`write_off_loan`), and cancel pending loan or expense requests.
- **Members**: Democratic participation. Can propose loans (`request_loan`), cancel
  their own pending requests (`cancel_loan_request`), vote on others' loans,
  propose regular expenses (`propose_expense`), cancel their own pending expenses
  (`cancel_expense`), and vote on others' expenses. Neither borrowers nor expense
  proposers may vote on their own requests.

Until both money offices (cashier and accountant) are filled, contributions,
repayments, and loans cannot be recorded — the RPCs strictly require one of those
roles. The dashboard and Chanda screen alert users to assign roles rather than
failing at record-time.

---

## Audit log

Trigger-based, not application-level — that is what catches writes made from
the SQL editor or a cron job, which app-level logging would miss. Attached
catalog-driven by `fn_attach_audit_triggers()` to every table except
`audit_log` itself and `profiles`.

Append-only: `trg_audit_immutable` raises on UPDATE **and** DELETE, for
everyone including the table owner. If a migration genuinely must touch it (the
0012 backfill had to stamp `group_id`), disable the trigger, do the work, and
re-enable — then *verify* it came back on. A migration that finishes with the
audit log writable is worse than one that fails, because it does not announce
itself.

---

## Testing and verification

```bash
npx tsc --noEmit          # types
npx oxlint src            # lint
npm run build             # production build
```

SQL tests run in the Supabase SQL Editor or via psql — plain SQL, **no psql
meta-commands** (`\set` etc.), because the SQL Editor rejects them:

- `supabase/tests/assertions.sql` → `ALL ASSERTIONS PASSED`
- `supabase/tests/isolation.sql` → `ISOLATION: all 43 checks passed`

`isolation.sql` is the one to run after touching any policy or money function.
It builds two real groups with **different** amounts of money, becomes an
ordinary member of the first, and asserts that not one row or rupee of the
second is visible across every table, view and aggregate — plus that writes
cannot cross and a pending member sees nothing. It ends in `ROLLBACK`.

There is no local Postgres or Docker in this environment, so migrations cannot
be dry-run; they are verified statically and then applied.

### Verifying claims about this codebase

Do not assert that something is safe because it looks safe. The checks that
found real bugs here all worked by *constructing the failure*: parsing SQL with
`pglast`, running the cache logic against two group ids and asserting the
second cannot read the first's rows, enumerating every gate state to prove none
is blank or traps the user. When you write a check, make it fail first.

---

## Writing migrations

Numbered `NNNN_name.sql`, applied in order, each wrapped in a transaction by
the Supabase CLI — so a mid-file failure rolls the whole file back and leaves
the database untouched.

Six rules, every one of which was learned by breaking a real push:

1. **`CREATE OR REPLACE VIEW` can only APPEND columns.** Adding a column at the
   front fails with `cannot change name of view column X to Y`, which reads
   like a typo and is a structural rule. Drop the view first — dependents
   before dependencies, and prefer explicit order over `CASCADE`, which hides
   what it destroys.

2. **`CREATE OR REPLACE FUNCTION` matches on (name, arg types).** Add a
   parameter and you create a *second* function beside the old one. Here that
   left the unscoped single-tenant aggregate callable — a cross-tenant money
   leak with no error. Changing a return type fails outright. Either way:
   `DROP FUNCTION` first, and drop dependent views before the functions they
   call.

3. **Never toggle triggers from a hand-written table list.** Query `pg_trigger`
   for what actually exists, and re-enable exactly that set. `audit_log`
   deliberately has no `trg_audit`, and a literal list that assumed otherwise
   aborted the migration twice.

4. **`drop … if exists`** on every drop. It costs nothing and removes a whole
   class of failure.

6. **Renaming an enum label is two jobs, not one.** `ALTER TYPE ... RENAME
   VALUE` moves the label in place — stored rows, indexes and constraints all
   stay valid, and unlike `ADD VALUE` it has no same-transaction restriction.
   But it does NOT touch string literals inside function bodies, which are
   plpgsql source compared against the enum at run time. Every function and
   policy naming the old label must be redefined in the SAME migration, or the
   app raises `invalid input value for enum` the moment the rename lands.
   Generate those redefinitions from the installed sources rather than
   retyping them (see `0024`).

5. **Order matters more than syntax.** `pglast` parsing proves a file is valid
   SQL; it proves nothing about whether each statement is legal against the
   schema *as it exists at that moment*. That gap caused every failed push in
   this project's history.

The backfill block in `0012` returns early when `members` is empty, so it is a
no-op on a fresh database.

### Applied & Prepared Migrations (0001–0019)

| Migration | Name | Description |
|---|---|---|
| `0001` | `identity.sql` | Users, groups, base member tables & auth triggers |
| `0002` | `audit.sql` | Immutable append-only audit trigger mechanism |
| `0003` | `cash.sql` | Cash float ledger & reporting tracking |
| `0004` | `contributions.sql` | Periods & contribution recording |
| `0005` | `loans.sql` | Loan definitions, status views & repayments |
| `0006` | `expenses_tables.sql` | Group expense tables & categories |
| `0007` | `fund_math.sql` | Integer paise aggregations & fund total mathematics |
| `0008` | `expense_rpcs_bank.sql` | Expense proposals, approvals & bank reconciliation |
| `0009` | `loan_voting.sql` | Democratic loan approval quorum & vote transitions |
| `0010` | `onboarding.sql` | Group invite codes, pending members & onboarding RPCs |
| `0011` | `fix_claim_roles.sql` | JWT claim synchronization fixes |
| `0012` | `multi_group.sql` | Full multi-tenant schema refactor, group_id backfills & composite FKs |
| `0013` | `fix_v_my_groups.sql` | Resolves multi-group listing across active memberships |
| `0014` | `fix_audit_row_id.sql` | Corrects casting of audit log row UUIDs |
| `0015` | `fix_member_access_and_profiles.sql` | Self-member read policy & profile fallback |
| `0016` | `fix_members_read_policy.sql` | Restores strict multi-tenant RLS on `members` |
| `0017` | `allow_officers_open_period.sql` | Allows the admin (alongside Cashier & Accountant) to open periods |
| `0018` | `critical_fixes.sql` | Lock in `open_period`, 10x cap, auto-closing repaid loans, negative amount guards |
| `0019` | `logic_fixes.sql` | Grace date guard in `close_period`, `cancel_loan_request`, `write_off_loan`, `cancel_expense`, `update_config` validation |
| `0020` | `fund_integrity.sql` | Write-offs book an expense so reconciliation holds; yearly cap enforced on auto-approved expenses; loans no longer auto-close with interest owed |
| `0021` | `date_guards.sql` | Future-date and ordering guards on every date-taking RPC; closed periods refuse new entries |
| `0022` | `governance_fixes.sql` | Guarantor cannot vote; withdrawal distinguished from rejection; vote deadlock broken when members leave |
| `0023` | `plain_error_messages.sql` | Database error text rewritten in plain words — these strings are UI |
| `0024` | `rename_president_to_admin.sql` | `role_enum` label renamed in place; all 17 functions and 1 policy redefined in the same transaction |

---

## Deliberate decisions that look like omissions

- **`supabase/seed.sql` is empty.** Groups are created from inside the app.
  Seeding would pre-empt the onboarding flow.
- **No soft-delete anywhere.** Members are `left_on`-dated, loans go to
  `closed`/`written_off`. Nothing is removed, so the audit log stays coherent.
- **`localStorage` holds only the last-opened group id.** It is a convenience;
  the server re-derives and re-validates it on every request, so tampering
  buys nothing.
- **`link_signed_in_member()` and `group_status()` still exist** as
  compatibility shims for a client mid-deploy. The current app uses
  `v_my_groups`.
- **`app_config` is gone.** Its settings are columns on `groups`. Audit rows
  now name `groups`.
- **Loans auto-close upon full principal repayment.** `record_repayment` checks
  `loan_outstanding_principal_paise(p_loan_id) = 0` and sets `status = 'closed'`
  automatically. Without this, zero-balance loans stay `disbursed` forever,
  polluting overdue queries and blocking member removal.
- **`write_off_loan` marks uncollectable debt.** Disbursed loans that will never be
  repaid transition to `written_off` via an officer RPC with an audit reason,
  reducing active debt to zero while preserving ledger truth.
- **Pending requests can be withdrawn.** Borrowers can withdraw un-voted loans with
  `cancel_loan_request()`, and proposers can withdraw un-voted expenses with
  `cancel_expense()`.
- **Local calendar dates over UTC strings.** Never build a calendar date with
  `new Date().toISOString().slice(0, 10)`. It converts to UTC first, so in IST
  (UTC+5:30) everything between 00:00 and 05:29 reports YESTERDAY — about a
  quarter of every day. A contribution recorded at 02:00 on the 11th lands on
  the 10th, and if the grace date was the 10th the late fee is silently
  skipped. Use `today()`, `toDateString()`, `monthStart()` and `parseDate()`
  from `src/lib/dates.ts`; they read local fields. The same trap applies when
  READING: `new Date('2026-09-24')` is UTC midnight, which renders as the 23rd
  west of Greenwich — `fmtDate()` handles that.
- **Every date-taking RPC refuses the future** and, where a natural floor
  exists, refuses to predate it (a repayment cannot precede its disbursal, a
  payment cannot precede the expense). A ledger may record the past — an entry
  written up late is normal bookkeeping — but never the future.

---

## Conventions

- Comments explain **why**, not what. If a line's purpose is obvious, it needs
  no comment; if it encodes a decision, the reason belongs next to it.
- Errors are written for the person reading them, not the developer:
  *"Cash float is over the limit — deposit the excess into the bank"*, not
  *"constraint violation"*.
- UI is dark-first and mobile-first: bottom sheets, a tab bar, a FAB, list rows
  instead of tables. Respects `prefers-reduced-motion`.
- Telugu-in-Roman-script is the maintainer's working language; code, comments
  and UI copy are English.
