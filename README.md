# SavingsClub — savings group app

A web app for friends' savings groups (*sangam*, *chit*, *committee*): monthly
payments, loans with group voting, spending, the cashier's cash in hand, bank
checks, and a record nobody can edit.

Built to match the rules in a group's signed agreement. The point of the app is
that those rules are enforced by the database, not by trust and not by the
screen — a member calling the API directly cannot bypass them.

**One deployment serves any number of groups.** Anyone can start a group and
becomes its admin; everyone else joins with an invite code and is then approved
by an officer. Each group's money, members and rules are its own, and
`supabase/tests/isolation.sql` proves two groups cannot see each other.

## Stack

React 19 · TypeScript · Vite · react-router-dom · Supabase (Postgres, Auth, RLS)

No state-management or data-fetching library: `src/hooks/useQuery.ts` is about
200 lines and covers what this app needs. If it grows much past that, adopt
TanStack Query rather than extending it.

> **Working on the code?** [`AGENTS.md`](AGENTS.md) is the engineering context:
> the multi-tenancy model and why every policy has two halves, why the money
> aggregates are the most dangerous functions here, how the group-namespaced
> query cache works, and the migration rules learned the hard way. Read it
> before changing anything.

---

## Setup

### 1. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) and create a project (the
   free tier is ample for a small group).
2. Choose a region close to you — Mumbai (`ap-south-1`) for India.
3. Save the database password somewhere safe.

### 2. Point the app at it

```bash
cp .env.example .env.local
```

Fill in both values from **Project Settings → API**:

```
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

The anon key is safe in the browser — every table is protected by row-level
security. Never put the **service_role** key in this file.

### 3. Apply the database schema

With the Supabase CLI:

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

Or paste each file in `supabase/migrations/` into the SQL editor, **in
numerical order**. There are 40 of them.

Then run the assertions. Open **SQL Editor → New query**, paste the whole of
`supabase/tests/assertions.sql`, and run it. The last row should read
`ALL ASSERTIONS PASSED`; the individual PASS lines appear under **Messages**.

If it does not pass, stop and fix that before going further — it is checking
the protections that make the whole app trustworthy.

The file is plain SQL with no `psql` meta-commands, so it runs unchanged in the
SQL Editor or through `psql`. It creates a few `~test …` members and a test
loan and removes them again at the end; the audit rows they generate stay, by
design, because the record cannot be deleted from.

Then run `supabase/tests/isolation.sql` the same way. It builds two complete
groups with different amounts of money in each, becomes an ordinary member of
the first, and reads everything the app reads — every table, every view, every
money function — asserting that not one row or rupee of the second is visible.
It also checks that writes cannot cross, that a *pending* member sees nothing
at all, and that every money function refuses an explicit request for the other
group's id. It ends in `ROLLBACK`, so it leaves nothing behind. The last line
under **Messages** should read `ISOLATION: all 50 checks passed`.

This is the test worth running after any change to a policy or a money
function, because a tenancy bug does not raise an error — it silently shows one
group another group's money.

### 4. Turn on email + password login

In **Authentication → Providers → Email**:

- **Enable Email** — on
- **Confirm email** — **off**

Turning confirmation off matters. Supabase's built-in email sender allows only
a handful of messages an hour, and it is meant for testing, not for real use.
With confirmation on, every signup sends an email and the seventh person to
join hits `over_email_send_rate_limit`. With it off, people sign in with a
password and no email is sent at all.

Under **Authentication → URL Configuration → Redirect URLs**, add
`http://localhost:5173` and your deployed URL.

> Letting anyone create an account is safe here. An account by itself grants
> nothing: every table requires an **active** member row in the group being
> read. A stranger who signs up can start a group of their own — which is
> empty, and theirs — but sees nothing of yours. Reaching your group needs a
> live invite code *and* an officer's approval.

If you would rather keep magic links — the app still offers them — connect your
own SMTP under **Authentication → Emails → SMTP Settings**. Resend and Brevo
both have free tiers well above what a small group needs.

### 5. Run it

```bash
npm install
npm run dev
```

### 6. Set the group up in the app

There is nothing more to do in SQL. `supabase/seed.sql` is intentionally empty.

1. Sign in with your own email (**First time here** creates the account).
2. Choose **Start a new group**. Name it and enter your own name.
3. You are now its admin, which is what lets you invite people and set the
   rules.
4. Go to **Settings → Invite people → Create an invite code**. You get a code
   like `ABCD-EFGH-JKLM`, good for 7 days.
5. Send that code to the others. Each of them signs up, chooses **Join with a
   code**, and enters it.
6. Their requests appear on your **Members** page under *Requests to join*.
   Approve each one — check the name first.
7. Go to **Settings** and adjust the rules if they differ from your agreement.
8. On **Members → Offices**, hand the cashier and accountant jobs to the right
   people. They must be two different people — the app warns you in red until
   they are.

Until both money jobs are filled, no payment, loan or cash movement can be
recorded at all. The dashboard says so rather than letting anyone discover it
as a failed save.

**Why a code is not enough on its own.** Joining with a code puts someone in
`pending`, where they see *nothing* — not the balance, not the members, not a
single row. An officer has to approve them first, and the dashboard tells the
officer someone is waiting. Codes get forwarded into WhatsApp groups, and one
forward should not expose a ledger.

Only one code is live at a time. Creating a new one retires the old, so **New
code** is also how you stop a code that has spread too far.

**An existing group can bring its history.** If the group already ran on paper,
**Settings → What the group already had** records what each member had saved
before the app. It is locked once agreed, and refused outright once any money
has moved — changing it later would silently restate every share and payout
computed from it.

**Several groups, one login.** Anyone can belong to any number of groups — join
a second with another code, or start one from the group switcher (the group name
in the app bar). Each group keeps entirely separate money, members and rules.

---

## Deploying

Any static host works. With Vercel or Netlify: connect the repo, build command
`npm run build`, output directory `dist`, and set the two `VITE_` variables in
the host's environment settings.

Add the deployed URL to Supabase's redirect URLs, or magic links will bounce.

---

## How the rules are enforced

Everything a member could gain money by bypassing is enforced in the database.
Client-side checks in this app exist to give a helpful message *before* the
server refuses, never instead of it.

| Rule | Enforced by |
|---|---|
| Nobody votes on their own loan | `cast_loan_vote`; `loan_votes` has no INSERT policy |
| Nor on a loan they vouched for | `cast_loan_vote` — the guarantor has an obvious interest |
| Enough people must say yes | `required_loan_approvals()` — a majority by default, with the loan row locked |
| One member can borrow only so much | Checked in `request_loan` against **aggregate** outstanding |
| Some of the fund never gets lent | Re-checked at request, at approval, and again at payout |
| Cashier ≠ accountant | Deferrable constraint trigger on `role_assignments` |
| One cashier at a time | `EXCLUDE` constraint over the date range |
| A limit on cash in hand | Statement-level trigger on `cash_ledger` |
| Late fee after the grace date | Applied server-side in `record_contribution`, **once per member per month** however many part payments follow |
| Never more than is due | `record_contribution` refuses an overpayment |
| Yearly spending cap | Checked in `cast_expense_vote` at approval — and write-offs and recoveries are excluded, so a bad loan cannot consume or inflate the budget |
| Loan status order | `fn_loan_status_transition` rejects illegal jumps |
| Records are never deleted | No table has a DELETE policy |
| Every change is logged | `fn_audit` trigger on every table |
| A member leaving keeps their history | `remove_member` sets `left_on`; it never deletes |
| …and takes their money with them | `remove_member` refuses while they still owe, **or are still owed** |
| Money functions answer only members | `fn_assert_member_of()` inside all 16 of them |

Writes are **RPC-only**. No table has an INSERT, UPDATE or DELETE policy at
all, with one deliberate exception: a member may edit their own `full_name`,
`phone`, `nominee_name` and `nominee_phone` through a column grant. That
absence is the security property — it is why a member cannot insert their own
approving vote or flip a loan straight to paid-out.

Two properties worth knowing about:

**Concurrency.** Every money RPC locks the group row first
(`select … from groups … for no key update`) and then the loan or expense,
always in that order — 32 call sites, all the same way round. Without it, two
members voting at the same moment could each see enough approvals and each add
the last one, and two loans approved simultaneously could jointly break the
reserve. The order is fixed so two sessions cannot deadlock.

**Snapshots.** `required_approvals`, `eligible_voter_count` and the borrower's
role are copied onto the loan when it is requested. Eligibility is judged from
that snapshot, so a role rotation or a member leaving mid-vote cannot move the
goalposts on a decision already in progress.

---

## Money and interest

Money is **integer paise** everywhere — in the database, over the wire, and in
the app. Never a float, never a partial paisa. `src/lib/money.ts` is the only
place that converts.

Interest is **simple interest on the reducing balance**, accrued per day over a
30-day month. The overdue rate applies only to days after the due date, never
retroactively to the whole term.

A loan is repaid in **equal principal instalments** over its term, and the
schedule is built when it is paid out. A borrower who has missed instalments
reads as behind *before* the final date arrives — the app shows how much they
are behind by, not a day count that would be zero until the term expired.

Two figures that are easy to confuse, and are deliberately named apart:

- **Total fund** = what the group started with + payments in + interest
  *received* − spending − money paid back out to members. Money out on loan is
  still an asset, so it is not subtracted.
- **Expected bank balance** = total fund − loans outstanding − cash in hand.
  This is the number that must equal the bank statement.

Interest **accrued but not yet received** is shown as a separate memo line and
is deliberately *not* part of the fund. Mixing the two is what produces a
reconciliation that can never reach zero.

**Money can leave.** A member who goes is paid their share — what they put in,
plus their part of what the group earned on it, pro-rata by what they saved.
The group can also share out profit while continuing, or share out everything
and close. A share-out is proposed by one officer and agreed by a different
one, because it is the largest and most irreversible movement a group makes.

---

## Monthly routine

| When | Who | What |
|---|---|---|
| 1st–5th | everyone | Pay in |
| 5th | cashier | Post the bank statement screenshot in the group |
| 6th–9th | accountant | Record payments, repayments and spending |
| 10th | accountant | Record the bank statement on the **Treasury** page and confirm the difference is **zero** |
| monthly | everyone | Meeting — record who came on the **Community** page |
| every 6 months | 2 random members | Check the **Audit** page against the bank statement |
| yearly | everyone | Rotate the cashier and accountant |

The reconciliation difference is the single check that catches almost every
problem early. If it is not zero, find out why before doing anything else.

---

## Project layout

```
supabase/migrations/   schema, RLS policies, business-rule RPCs (0001-0040)
supabase/tests/        assertions + tenant-isolation proof
supabase/seed.sql      deliberately empty; groups are created in the app
scripts/               scenario tests -- see scripts/README.md
src/lib/               supabase client, money helpers, dates, shared types
src/hooks/             useQuery / useMutation, group-namespaced cache
src/context/           session (which groups, which one is open, what role)
src/components/        shared UI, icons, group switcher, profile sheet
src/pages/             one file per route
src/pages/money/       the Treasury sheets, split out of MoneyHub
```

The four files carrying the real risk, in order:

1. `supabase/migrations/0012_multi_group.sql` — tenancy: every policy, every
   group-scoped money function. A mistake here shows one group another group's
   money, silently.
2. `supabase/migrations/0037_guard_definer_aggregates.sql` — the membership
   check inside every money function. Without it, any signed-in user could read
   any group's balance by passing its id.
3. `supabase/migrations/0007_fund_math.sql` — the single source of money truth
4. `supabase/migrations/0005_loans.sql` — caps, status transitions, interest

Migrations must run in numerical order; each one depends on the ones before it.
Expense **tables** are created in `0006`, before the fund math that reads them,
while the expense **RPCs** are in `0008`, after the fund views they call — that
split is what keeps the dependencies acyclic.

## Checks

```bash
npm run lint             # oxlint
npx tsc -b               # typecheck -- NOT tsc --noEmit, which is more lenient
npm run build            # production build
npm run test:scenarios   # drive the app as real members (see scripts/README.md)
```

And in the Supabase SQL Editor, after any migration:

```
supabase/tests/assertions.sql   -> ALL ASSERTIONS PASSED
supabase/tests/isolation.sql    -> ISOLATION: all 50 checks passed
```

Run `isolation.sql` after touching **any** policy or money function. It is the
only check that would catch one group being able to see another's money, and
that failure produces no error of its own.

`npm run test:scenarios` plays whole stories through the app's own RPCs as
signed-in members — a month of collections, a loan from request to repayment, a
group winding up, two groups side by side. Because every write here goes
through an RPC, a scenario that passes has satisfied every role check, cap and
policy on the way through. It runs against a local Postgres by default, so a
careless run cannot touch a live ledger.
