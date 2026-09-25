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
    ProfileSheet.tsx   self-edit: phone + family contact (the only member self-write)
  lib/
    money.ts           paise helpers; money is NEVER a float
    types.ts           row shapes returned by views and RPCs
    supabase.ts        client + friendlyError
  pages/               12 screens. The money screens were consolidated:
                       Contributions -> Deposits, and Cash + Bank + Expenses
                       -> MoneyHub (Treasury). More -> Community.
supabase/
  migrations/          0001-0037, applied in numerical order
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

This is the sharpest edge in the codebase. Sixteen aggregates
(`fn_fund_total_paise`, `total_outstanding_paise`, `cash_float_balance_paise`,
…) run as definer and therefore **bypass RLS entirely**. Each takes
`p_group_id uuid default current_group_id()`, filters on it explicitly, **and
calls `fn_assert_member_of(p_group_id)` before counting anything**.

Both halves are load-bearing, and they answer different questions:

| | |
|---|---|
| the `group_id` filter | makes the figure **correct** — without it the function sums every tenant's money together |
| `fn_assert_member_of()` | makes the figure **yours** — without it anyone with a login can pass any group's uuid and read its balance |

0012 added the first and not the second, and that gap was live for 25
migrations: `fn_fund_total_paise('<someone else's group>')` returned their
actual balance over PostgREST, while every policy, table read and RPC in the
app correctly refused. See 0037 — the fix asserts **membership, not the claim**,
because the attack is a forged claim.

If one loses the `group_id` filter it sums every tenant's money together. And
because the loan cap check in `cast_loan_vote()` calls the same function the
dashboard does, **the screen and the enforcement would agree on the same wrong
number** and authorise loans that breach the reserve. Nothing throws.

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
- `supabase/tests/isolation.sql` → `ISOLATION: all 50 checks passed`

`isolation.sql` is the one to run after touching any policy or money function.
It builds two real groups with **different** amounts of money, becomes an
ordinary member of the first, and asserts that not one row or rupee of the
second is visible across every table, view and aggregate — plus that writes
cannot cross and a pending member sees nothing. It ends in `ROLLBACK`.

**It also calls every money aggregate with the OTHER group's id, explicitly.**
That is check 3b, and it exists because the rest of the file only ever called
them with no argument — which proves the *default* is scoped and nothing more.
A real leak lived in that gap for 25 migrations (see 0037).

### Running migrations locally

Postgres 18 is installed. The migrations can be replayed from scratch, which
is what `supabase db reset --linked` does and what finds the class of bug that
reading SQL does not:

```bash
export PATH="/c/Program Files/PostgreSQL/18/bin:$PATH"; export PGPASSWORD=...
psql -h 127.0.0.1 -U postgres -c "drop database if exists sanchay_test"                                -c "create database sanchay_test"
psql -h 127.0.0.1 -U postgres -d sanchay_test -f <shim>.sql   # see below
for f in supabase/migrations/*.sql; do
  psql -h 127.0.0.1 -U postgres -d sanchay_test -v ON_ERROR_STOP=1 -f "$f" || break
done
```

The shim supplies what Supabase provides and vanilla Postgres does not: the
`anon` / `authenticated` / `service_role` roles, `auth.users`, and
`auth.uid()` / `auth.jwt()` / `auth.role()`. **`auth.uid()` must read `sub`
out of `request.jwt.claims`**, exactly as the real one does — a shim that
reads some other GUC will make `isolation.sql` fail at its own harness check.

Impersonation in a test is therefore:

```sql
select set_config('request.jwt.claims', json_build_object(
  'sub', '<auth user uuid>',
  'app_metadata', json_build_object('group_id', '<group uuid>')
)::text, false);
set role authenticated;   -- without this, RLS is bypassed and proves nothing
```

Keep the migrations themselves free of anything that only works on Supabase;
if a migration has to be edited to replay locally, the local run has stopped
testing what ships.

### Verifying claims about this codebase

Do not assert that something is safe because it looks safe. The checks that
found real bugs here all worked by *constructing the failure*: parsing SQL with
`pglast`, running the cache logic against two group ids and asserting the
second cannot read the first's rows, enumerating every gate state to prove none
is blank or traps the user. When you write a check, make it fail first.

**Static analysis has a ceiling, and it is lower than it looks.** Migrations
0025–0032 passed a replay checker, a tenancy checker, and arithmetic proofs of
every money rule. Running them then found, in the same code:

| Bug | Why no amount of reading would have caught it |
|---|---|
| `name[] = text[]` has no operator | A type mismatch two catalog joins deep |
| `case … end` into an enum column | `confirm_distribution` could never have run |
| `fmt_rupees(numeric)` did not exist | `sum()` returns numeric, not bigint |
| `role_of()` was nondeterministic | The SQL is *correct*; the bug is what it leaves unsaid |
| No table had a `SELECT` grant | The code is right and the platform was filling a gap |
| 16 aggregates answered any caller | Every policy was right; these bypass policies |

Three of those six are invisible in the source text by construction. Replay
first, then assert — and write the assertion so it fails when the guard is
removed, or it is not an assertion.

**A test that prints the truth and checks nothing goes green when the truth
changes.** Two negative controls proved exactly that here: the fixtures showed
the correct part-payment and arrears figures on screen while asserting neither,
so reverting both fixes left the suite passing.

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

### Applied & Prepared Migrations (0001–0037)

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
| `0025` | `member_payouts.sql` | Member exit payouts, share calculations, and payout ledger |
| `0026` | `partial_contributions.sql` | Multiple part-payments per period, single late-fee calculation |
| `0027` | `loan_schedule.sql` | Equal principal loan instalments, schedule tracking, arrears reporting |
| `0028` | `opening_balance.sql` | Pre-existing group onboarding with per-member opening balances |
| `0029` | `distributions.sql` | Profit & final distribution proposals, line splits & confirmation |
| `0030` | `meetings.sql` | Meeting attendance recording, excused status, and absent fines |
| `0031` | `writeoff_recovery.sql` | Recovery of previously written-off loan debt |
| `0032` | `reminders_and_export.sql` | Server-derived reminders view & full JSON ledger export |
| `0033` | `deterministic_role.sql` | Tie-breaking role resolution by authority order |
| `0034` | `explicit_read_grants.sql` | Explicit PostgREST SELECT grants on tables and views for `authenticated` |
| `0035` | `readable_money_in_errors.sql` | User-friendly `fmt_rupees` formatting with numeric overload |
| `0036` | `settable_meeting_fine.sql` | Meeting absent fee configuration in `update_config` |
| `0037` | `guard_definer_aggregates.sql` | Strict group-membership assertions in SECURITY DEFINER money aggregates |

---

## The group lifecycle (0025–0032)

Until 0025 the app was an excellent ledger and an incomplete group: it recorded
money moving in and out with real rigour, but had almost nothing for the events
that END things. Those are exactly the moments savings groups argue about.

### Money can now leave (`member_payouts`, 0025)

**This was a wrong number, not a missing feature.** `remove_member` marked a
member `left` and never returned their savings; `fn_fund_total_paise()` had no
payout term, so their money was absorbed and every remaining member's share
quietly grew to swallow it. In a three-member worked example, a departing
member's ₹54,545 inflated one remaining member's share by ₹27,272.

- A payout is **not** an expense (it would hit the annual cap and lose the
  member link) and **not** a reversed contribution (history stays as recorded).
  It is its own event; the fund nets the two.
- `member_share_paise()` is pro-rata by net contribution — a rule the group can
  check by hand at a meeting. A time-weighted rule is arguably fairer to early
  joiners but cannot be verified, and an unverifiable figure will not be
  trusted.
- `remove_member` now refuses while a share of more than ₹1 remains. The ₹1 of
  slack absorbs the truncating division, which always rounds toward the fund —
  the group can never be made short by a rounding rule.

### Part payments are recordable (0026)

`unique (period_id, member_id)` made a routine event impossible. Worse: because
`v_unpaid_contributions` used `where c.id is null`, the FIRST payment marked the
month fully settled, so **a half-paid member vanished off the group's own
chase-list**.

- Unpaid now means `sum(paid) < expected`, not "no row exists". The 0004 design
  note was right — unpaid is derived, never stored. The bug was comparing
  existence where it should have compared amounts.
- Late fee is charged **once per member per period**, not per instalment.
- Overpayment is refused explicitly. The unique constraint used to prevent it
  by accident.
- The 10x sanity ceiling from 0021 is deliberately NOT carried forward: the new
  overpayment check is strictly tighter, so it would be a branch that can never
  run — a guard that reads like protection and provides none.

### Loans have a schedule (`loan_instalments`, 0027)

A loan was one balloon payment at term end. **A borrower nine months delinquent
on a twelve-month loan showed as perfectly healthy**, because nothing was
overdue until the entire term expired.

- **Equal principal**, not equal EMI — interest rides on the reducing balance.
  Checkable on paper at the meeting.
- The rounding remainder goes on the **first** instalment. If a borrower stops
  paying partway the group has collected more, not less. Rounding never favours
  the debtor.
- `is_overdue` now means "behind on the plan **or** past the final date".
  `days_overdue` stays 0 mid-term, so the UI shows `arrears_paise` instead —
  "₹X behind" rather than "0 days overdue".
- Interest accrual is **unchanged**. The schedule is EXPECTATION; accrual is
  what the outstanding money earned. Different questions, kept apart. Repayments
  are recorded against the loan, not against a schedule row — making a cashier
  allocate a part payment across instalments is how a simple app becomes an
  accounting package nobody in the group can operate.

### Existing groups can onboard (0028)

Every group started at zero, which blocked the most likely user: a group that
already exists. The only alternatives were inventing fake historical
contributions (wrong in every per-member figure forever) or abandoning years of
history.

An opening balance is per-member and belongs to no month — it carries no late
fee and makes no claim about when the money arrived. It is locked once agreed,
and refused outright once any money has moved, because changing it would
silently restate every share and payout already computed from it.

### The cycle can end (`distributions`, 0029)

Interest flowed in and stayed forever; the fund could only grow. `share_pct` was
displayed, implying a distribution, but nothing acted on it.

- `profit` distributes earnings and the group continues; `final` distributes
  everything and archives the group.
- **Savings are never distributed as profit** — that would liquidate the group
  while reporting a good year.
- **Proposed, then confirmed by a different person.** A share-out is the largest
  and most irreversible movement a group makes; computing and committing in one
  call would mean the group learns the figures only after the fact. A proposal
  is refused at confirmation if the fund has moved since.
- The rounding remainder goes to the last member so the lines sum to the total
  exactly and the books close at zero.

### Meetings are recorded (0030)

"fine" appeared 44 times and every one was a late fee. Groups also fine for
missing the meeting — and the meeting is where decisions happen.

This is **not** a second approval mechanism. Loan voting is untouched; adding a
quorum gate to the one flow that most needs to stay predictable would be a poor
trade. The value is the record. `excused` exists so the group can record that it
chose not to fine someone, rather than that choice living in memory.

### Write-offs are reversible (0031)

Borrowers sometimes pay after a write-off, and there was no way to record it.
A recovery books a **negative expense**, landing in the same account the loss
came from so the two net correctly. Partial recovery leaves the loan
`written_off` — truthfully, some of it is still lost.

**The trap:** a negative expense would SUBTRACT from the year's spending total
and raise the cap. A group recovering ₹20,000 could then spend ₹20,000 beyond
its own rule (headroom would have gone from ₹22,000 to ₹42,000).
`fn_expenses_ytd_paise()` excludes recoveries for the same reason it already
excluded write-offs.

### Reminders and export (0032)

- **No message-sending service is included.** Choosing an SMS/WhatsApp provider
  costs money and is the group's decision. What lives in the database is the
  part that has to either way: `v_reminders` computes WHO needs telling WHAT,
  server-side, from the same figures the screens use. The app renders it as a
  message the cashier forwards by hand — which is what these groups already do.
- `export_group_data()` returns the whole ledger as JSON, runnable by **any
  active member**. "Can we see our own books" is not a privilege a group should
  have to be granted.

## What running the migrations found (0033–0037)

Postgres arrived after 0032 was written. Replaying all of it turned up six
bugs that had survived a replay checker, a tenancy checker and arithmetic
proofs — because none of them are visible in the source text.

### 0033 — `role_of()` returned different answers for the same data

    order by ra.start_date desc limit 1

When a member holds two jobs that started on the **same day**, `start_date`
does not break the tie, so the row returned is whichever the planner reaches
first. Demonstrated: the same member and the same two rows gave `admin` one
moment and `cashier` the next, purely because the rows were reordered.

Reachable, not theoretical. `assign_role` only forbids cashier + accountant on
one person — admin + cashier is deliberately allowed, and in a small group it
is the normal arrangement. A group set up in one sitting gives both jobs the
same `start_date`.

`current_role_of()` gates almost every RPC, so this is a cashier being refused
when recording a payment, or an admin being allowed to handle money — the same
person, different answer between two requests, no error that points here.

Now ordered by **authority**, then date, then id: total, and never dependent on
physical row order.

### 0034 — every read policy was unreachable

`select * from v_fund_summary` failed with *permission denied for table
groups*. Not a policy denial — a **grant** denial, checked first. All 21 RLS
tables had a SELECT policy for `authenticated` and **not one had a SELECT
grant**.

Production works because Supabase's bootstrap runs `alter default privileges
… grant all on tables to anon, authenticated` first. The tell was already in
the code: this project revokes INSERT/UPDATE/DELETE 28 times and never revokes
SELECT — you cannot revoke what was never granted.

The security model is stated in the policies; if the grant that makes them
reachable lives only in a platform default, the model is not written down here
at all.

### 0035 — money in error messages read `Rs.1050.0000000000000000`

`bigint::numeric / 100` has full default scale and `::text` prints every
trailing zero. Written 42 times — not a slip, a missing helper everyone then
open-coded. `fmt_rupees()` now exists, with a **numeric overload** because
`sum()` over bigint returns numeric: without it `fn_enforce_cash_float_limit`
raised *function fmt_rupees(numeric) does not exist* instead of its over-limit
message.

### 0036 — the meeting fine could never be set

0030 added `groups.meeting_absent_fee_paise`, writes to `groups` are RPC-only,
and `update_config()` had no parameter for it. The column could only ever hold
its default. Found because a fixture tried a direct UPDATE and was refused —
the RPC-only rule working exactly as designed is what made the gap visible.

### 0037 — any signed-in user could read any group's money

The sharpest edge, and it was real. Bob, a member of Group B only, pointed his
claim at Group A and was correctly stonewalled everywhere — zero rows, RPCs
refused, export refused. Then:

    select fn_fund_total_paise('<group A id>');   ->  505000

Group A's actual balance. **16 SECURITY DEFINER aggregates** (the first count
said 14 — the probe that found them matched only `%paise%`/`%count%` names and
missed `loan_next_due` and `member_paid_out_paise`), all granted to
`authenticated`, all reachable over PostgREST with nothing but a valid login
and a group's uuid.

0012 gave them an explicit group so the figures would be *correct* under
multi-tenancy. That fixed the arithmetic and left them open: they are SECURITY
DEFINER, and RLS is exactly what SECURITY DEFINER turns off.

`fn_assert_member_of()` is now the single home for the rule — and it checks
**membership, not the claim**, because the attack *is* a forged claim.

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

---

## Design System & Frontend Architecture

- **Brand & Display Name**: **SavingsClub** ("SavingsClub — Group Savings & Loans").
- **Typography**: Inter Variable (`Inter-VariableFont_opsz,wght.ttf`), Google Fonts `opsz` 14..32, weights 300..800. Enabled font features:
  `font-feature-settings: 'cv02' 1, 'cv03' 1, 'cv04' 1, 'cv11' 1, 'tnum' 1;`
  Monospace / tabular numbers (`tnum`) ensure financial figures align cleanly without jitter.
- **Iconography**: Semantic FontAwesome SVGs wrapped centrally in `src/components/icons.tsx`.
- **Mobile Stat Cards Layout**: In `.stats.three` on mobile screens (`< 440px`), the layout is strictly a 2+1 grid (`grid-column: 1 / -1` for the 3rd stat card). Do not collapse into a single column.
- **Core User Experience Enhancements**:
  1. **Dashboard 1-Tap Quick Actions Bar**: 4-action grid below the Account card: Deposit, Get Loan, Invite via WhatsApp with active code, and Statement Sheet.
  2. **Treasury Proportional Asset Allocation Bar**: Multi-segment bar showing % in Bank (`mint`), % Cash Float (`amber`), % Active Loans (`violet`), with clickable breakdown pills to respective sub-ledgers.
  3. **Fast Member Search & Filtering**: Real-time instant search by name, phone, role, or email with match counts and clear button on both Deposits and Members pages.
  4. **Loan Payoff Progress Bars**: Visual progress meter on running loans displaying `% repaid` (`(principal_paid_paise / principal_paise) * 100`) and remaining principal.
  5. **WhatsApp Monthly Collection Broadcast**: 1-tap summary of month, collected vs expected, paid vs pending members for sharing directly to the group chat.
  6. **Excel / CSV Export & Printable Annual Statement**: 1-tap CSV spreadsheets for deposits, loans, and cash float (`src/lib/export.ts`) + formal A4/PDF Printable Annual Financial Statement with sign-off blocks (`src/components/PrintableStatement.tsx`).
  7. **Fund Growth & Member Return SVG Chart**: Interactive area curve tracking capital growth and individual member dividend/yield entitlement (`src/components/FundGrowthChart.tsx`).
  8. **Digital Payment Receipts**: Formal transaction slips with 1-tap WhatsApp sharing for deposits and loan repayments (`src/components/PaymentReceiptSheet.tsx`).
  9. **Smart Loan Repayment Schedule Simulator**: Pre-request simulator showing Month 1 vs final month payments and full reducing-balance schedules (`src/pages/NewLoan.tsx`).
  10. **Upcoming Meeting Countdown Banner**: Dashboard card displaying next meeting date, countdown, agenda, and 1-tap WhatsApp attendance reminder.
  11. **PWA Mobile App Support**: Offline asset caching (`public/sw.js`) and in-app install flow with iOS Safari guide (`InstallAppPanel`).

---

## Verification Checklist for Agents

Before completing any task, agents MUST run and verify:
```bash
npx tsc --noEmit          # 0 errors
npx oxlint src            # 0 warnings, 0 errors
npm run build             # production bundle builds cleanly
```

When touching database schema or migrations:
- Check migration status: `npx supabase migration list`
- Dry run migrations: `npx supabase db push --dry-run`
- Push migrations: `npx supabase db push --yes` (never use `db reset` without explicit user permission).
- Remote status: Migrations 0001–0037 are fully applied on the remote database. Tables like `distributions`, `distribution_lines`, `meetings`, `meeting_attendance`, `member_payouts` and `loan_instalments` (created by `0027_loan_schedule.sql` — the file is named for the concept, the table is not) and their RPCs are live.
