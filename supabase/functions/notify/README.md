# Phone notifications — one-time setup

A daily digest to each member's phone: payments due, loans behind, votes
waiting, payments for the cashier to confirm. The database decides what
(`notifications_due()`, migration 0047); this function delivers it with Web
Push. Push services are free and need no account.

Run these from the project folder, in order.

**1. Make the VAPID key pair**

```powershell
node scripts/vapid-keys.mjs
```

It prints a public key and a command. Put the public key in `.env.local` and
in Vercel (Settings → Environment Variables) as `VITE_VAPID_PUBLIC_KEY`, then
run the printed `npx supabase secrets set 'VAPID_PRIVATE_JWK=…'` command.
The private key must never go in a `VITE_` variable.

**2. The other secrets**

```powershell
npx supabase secrets set VAPID_SUBJECT=mailto:you@example.com
npx supabase secrets set NOTIFY_CRON_SECRET=<a random string of 24+ characters>
```

`SUPERADMIN_DB_KEY` is already set for the developer console and is reused.

**3. Deploy**

```powershell
npx supabase functions deploy notify --no-verify-jwt
```

`--no-verify-jwt` because the caller is a cron job, not a signed-in person;
the function checks `NOTIFY_CRON_SECRET` instead.

**4. Try it without sending anything**

```powershell
curl.exe -X POST "https://<project-ref>.supabase.co/functions/v1/notify" `
  -H "x-cron-secret: <NOTIFY_CRON_SECRET>" -H "Content-Type: application/json" `
  -d '{\"dry_run\": true}'
```

It returns the digests it would send. Empty until someone has switched
notifications on (Profile → Phone notifications) and has something due.

**5. Schedule it** — in the Supabase SQL Editor, once. Not in a migration,
because it contains the secret.

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'savingsclub-daily-digest',
  '30 3 * * *',   -- 03:30 UTC = 09:00 IST
  $$ select net.http_post(
       url     := 'https://<project-ref>.supabase.co/functions/v1/notify',
       headers := jsonb_build_object('Content-Type', 'application/json',
                                     'x-cron-secret', '<NOTIFY_CRON_SECRET>'),
       body    := '{}'::jsonb) $$
);
```

To stop it: `select cron.unschedule('savingsclub-daily-digest');`

## Good to know

- **iPhone:** notifications work only when the app has been added to the Home
  Screen (Share → Add to Home Screen) and opened from there. The Profile sheet
  says so.
- **New VAPID keys** invalidate every subscription; members would have to
  switch notifications on again.
- A phone that uninstalls or blocks the app answers 404/410; the function
  deletes that subscription the next day.
