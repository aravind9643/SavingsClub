# Scenario tests

Drive the app as real members, in whole scenarios — a month of collections, a
loan from request to repayment, a group winding up, two groups side by side.

```bash
node scripts/test-scenarios.mjs                 # everything, against local
node scripts/test-scenarios.mjs --list
node scripts/test-scenarios.mjs --only=loans
node scripts/test-scenarios.mjs --target=remote # the real project
node scripts/test-scenarios.mjs --trace         # stack traces on failure
```

## Why it works this way

**Every write goes through an RPC.** All 21 tables refuse `INSERT`, `UPDATE`
and `DELETE` to `authenticated` — that absence *is* the security model. So a
test script cannot seed data by writing rows; it has to act as real members
calling the same functions the screens call.

That is the point. A scenario that passes here has satisfied every role check,
every cap and every RLS policy on the way through, so it passes in the app too.
A script that bypassed all that with the service key would prove nothing about
whether the rules work.

## The two targets

| | |
|---|---|
| `local` *(default)* | Plain Postgres with the test shim. Wipe and reseed freely. |
| `remote` | Your actual Supabase project. Real auth, real PostgREST, real rows. |

Local is the default deliberately: a careless run should not be able to write
to a live ledger. `--target=remote` is an explicit choice.

**Local has no auth server** (that needs Docker), so a "session" is
`set role authenticated` plus the JWT claims in a GUC — exactly what PostgREST
does per request. That is why the shim's `auth.uid()` reads `sub` out of
`request.jwt.claims` rather than somewhere more convenient.

**Remote needs `SUPABASE_SERVICE_ROLE_KEY`** in `.env.local` to create test
users. Without it the script can still sign in as users that already exist.
It never uses that key for anything else.

## Writing a scenario

```js
export default {
  name: 'my-scenario',
  describe: 'one line, shown by --list',

  async run({ club, expect, note, rupees, target }) {
    const { admin, cashier, everyone } = await club.withMembers(
      ['Anita', 'Bhaskar', 'Chandra'],
      { monthly: rupees(1000) },
    );

    await club.openMonth(cashier);
    await cashier.takesPayment(everyone[2], rupees(1000));

    const fund = await cashier.fund();
    expect('the money arrived', Number(fund.total_fund_paise), rupees(1000));
  },
};
```

Add it to `scenarios/index.mjs`.

### Test what is refused, not just what works

A scenario that only walks the happy path proves half of what matters. Every
actor has `.cannot()`, which fails loudly if the thing it describes is
*allowed*:

```js
const why = await member.cannot('record a payment as a plain member', () =>
  member.takesPayment(other, rupees(100)),
);
note(`refused: ${why}`);
```

### Moving the clock

Some behaviour only appears with time — a loan cannot be behind on its
schedule the day it is paid out. `club.age(loanId, days)` back-dates a loan
and rebuilds its instalments. **Local only**: on remote it throws, because a
script should not quietly rewrite a live ledger.

Guard those checks with `if (target === 'local')`.

## Gotchas worth knowing

**One connection per member, held open.** `set role` and the claims GUC are
*session* state, so a pooled client that hopped between users would silently
act as the wrong person. The pool is sized for that — if a scenario ever
exhausts it, `connectionTimeoutMillis` makes it fail loudly rather than hang,
because a hang looks exactly like a deadlock and is not one.

**Assert rules, not snapshots.** An early version of `monthly-round` asserted
the fund was exactly Rs.3000 after three payments. It was Rs.3150, because the
grace day had passed and each payment carried a late fee — the app was right
and the test was wrong. Assert *payments + whatever fees applied*, or the test
passes only on some days of the month.

**Rebuild before running.** The scenarios create real rows. `replay.sh` drops
and recreates the database, and now evicts open sessions first — without that,
`DROP DATABASE` fails silently and the next run tests yesterday's schema while
reporting success.

## What these found

Writing them turned up a real bug: `remove_member` could not remove a member
who had been given a job *that same day*. It ends open roles with
`end_date = today`, and `role_assignments` requires `end_date > start_date`, so
the whole call rolled back with a raw constraint name in front of the officer.

Setup day is exactly when a group is most likely to be adjusting who does what.
Fixed in `0040`, which applies the same treatment `release_role` has used since
0010: end the roles that ran, delete the ones that never got a day.
