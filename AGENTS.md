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
You become president. Invite others from **Settings → Invite people**, approve
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
  migrations/          0001-0012, applied in numerical order
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

Lock order is **`groups` → `loans`**, always. RPCs do
`select * into v_cfg from groups where id = v_group for no key update` first.
That serialises concurrent votes so two approvals cannot jointly breach the
reserve. Keep the order; reversing it deadlocks.

### Snapshots beat live lookups for votes

`required_approvals`, `eligible_voter_count` and `borrower_role_at_request` are
copied onto the loan at request time, so a role rotation mid-vote cannot move
the goalposts.

---

## The frontend cache is group-namespaced — do not bypass it

Query keys at call sites are bare nouns: `'fund'`, `'members'`, `'loans'`.
`useQuery` prefixes every key with the active group id **centrally**, in
`setQueryGroup()`.

This is deliberate. The alternative — adding `currentGroupId` to ~30 call sites
— fails silently the first time someone forgets one: switch group and the new
group's name renders above the previous group's balance. Keep the namespacing
in the hook. Do not add the group id at call sites, and do not read the cache
directly.

`invalidate('fund')` scopes to the active group too, so it can never disturb
another tenant's rows.

---

## Onboarding model

Anyone may create a group and becomes its **president**. Others join with an
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

`release_role('president')` and `remove_member()` on a president both **raise** —
the office must be handed over, never left empty. `remove_member()` also refuses
anyone with an outstanding loan: settle the debt first, or the money leaves with
them and the books never balance again.

---

## Roles

`member | cashier | accountant | president`. Cashier and accountant **must be
different people** — a constraint trigger enforces it, and `DEFERRABLE` does not
change that (deferring moves the check to commit; it never permits the end
state). One holder per office per group, enforced by a GiST exclusion
constraint over `daterange`.

Until both money offices are filled, contributions/loans/cash cannot be
recorded at all — the RPCs require one of those roles. The dashboard says so
rather than letting people discover it as a failed save.

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

Five rules, every one of which was learned by breaking a real push:

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

5. **Order matters more than syntax.** `pglast` parsing proves a file is valid
   SQL; it proves nothing about whether each statement is legal against the
   schema *as it exists at that moment*. That gap caused every failed push in
   this project's history.

The backfill block in `0012` returns early when `members` is empty, so it is a
no-op on a fresh database.

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
