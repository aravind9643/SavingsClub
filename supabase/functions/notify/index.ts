// notify -- the daily digest. Called once a day by pg_cron (see README in
// this folder); never by the app.
//
//   1. check the caller knows NOTIFY_CRON_SECRET (there is no user here)
//   2. ask notifications_due() (0047) what each member needs telling -- it
//      reads the same views the screens do, as that member
//   3. word it in each device's language, one notification per person per
//      group, and send it with Web Push (../_shared/webpush.ts)
//   4. delete subscriptions the browser has dropped (404 / 410)
//
// POST {"dry_run": true} returns the digests without sending anything.
//
// Secrets:
//   NOTIFY_CRON_SECRET   24+ characters, also written into the cron job
//   VAPID_PRIVATE_JWK    from scripts/vapid-keys.mjs
//   VAPID_SUBJECT        mailto:you@example.com
//   SUPERADMIN_DB_KEY    a secret key (sb_secret_...), shared with superadmin
//
// Deploy:  npx supabase functions deploy notify --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendPush, type Vapid } from '../_shared/webpush.ts';

type Lang = 'en' | 'te';
interface Due { auth_user_id: string; group_name: string; kind: string; amount_paise: number | null; due_on: string | null; n: number }
interface Sub { id: string; auth_user_id: string; endpoint: string; p256dh: string; auth_secret: string; lang: Lang }

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

// Same rule as lib/money formatPaise: whole rupees unless there are paise.
function rs(p: number | null): string {
  const v = Number(p ?? 0);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: v % 100 === 0 ? 0 : 2,
  }).format(v / 100);
}
function day(iso: string | null, lang: Lang): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(lang === 'te' ? 'te-IN' : 'en-IN', {
    day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

// One line per item. Kept beside the English in src/lib/i18n.ts in meaning;
// these are shorter because a notification shows two lines at most.
const LINES: Record<Lang, Record<string, (d: Due, l: Lang) => string>> = {
  en: {
    contribution_overdue: (d) => `${rs(d.amount_paise)} contribution overdue`,
    contribution_due: (d, l) => `${rs(d.amount_paise)} due by ${day(d.due_on, l)}`,
    loan_overdue: (d) => `loan ${rs(d.amount_paise)} behind`,
    loan_due: (d, l) => `loan instalment ${rs(d.amount_paise)} due ${day(d.due_on, l)}`,
    loan_vote: (d) => d.n === 1 ? '1 loan needs your vote' : `${d.n} loans need your vote`,
    expense_vote: (d) => d.n === 1 ? '1 spending request needs your vote' : `${d.n} spending requests need your vote`,
    claims_to_confirm: (d) => d.n === 1 ? `confirm 1 payment (${rs(d.amount_paise)})` : `confirm ${d.n} payments (${rs(d.amount_paise)})`,
    guarantee_behind: (d) => `a loan you vouched for is ${rs(d.amount_paise)} behind`,
  },
  te: {
    contribution_overdue: (d) => `${rs(d.amount_paise)} జమ గడువు దాటింది`,
    contribution_due: (d, l) => `${day(d.due_on, l)} లోపు ${rs(d.amount_paise)} కట్టాలి`,
    loan_overdue: (d) => `అప్పు ${rs(d.amount_paise)} వెనుకబడింది`,
    loan_due: (d, l) => `అప్పు వాయిదా ${rs(d.amount_paise)} ${day(d.due_on, l)} న`,
    loan_vote: (d) => d.n === 1 ? '1 అప్పు అభ్యర్థనకు మీ ఓటు కావాలి' : `${d.n} అప్పు అభ్యర్థనలకు మీ ఓటు కావాలి`,
    expense_vote: (d) => d.n === 1 ? '1 ఖర్చు అభ్యర్థనకు మీ ఓటు కావాలి' : `${d.n} ఖర్చు అభ్యర్థనలకు మీ ఓటు కావాలి`,
    claims_to_confirm: (d) => `${d.n} చెల్లింపులు (${rs(d.amount_paise)}) నిర్ధారించాలి`,
    guarantee_behind: (d) => `మీరు హామీ ఇచ్చిన అప్పు ${rs(d.amount_paise)} వెనుకబడింది`,
  },
};

// Worst first, so the line a phone truncates is the least urgent.
const ORDER = ['contribution_overdue', 'loan_overdue', 'guarantee_behind', 'claims_to_confirm',
  'contribution_due', 'loan_due', 'loan_vote', 'expense_vote'];

async function sameSecret(a: string, b: string): Promise<boolean> {
  const e = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', e.encode(a)), crypto.subtle.digest('SHA-256', e.encode(b))]);
  const u = new Uint8Array(x); const v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  const secret = Deno.env.get('NOTIFY_CRON_SECRET') ?? '';
  if (secret.length < 24) return json({ error: 'NOTIFY_CRON_SECRET is not set (24+ characters)' }, 503);
  if (!(await sameSecret(req.headers.get('x-cron-secret') ?? '', secret))) return json({ error: 'Forbidden' }, 403);

  const dbKey = Deno.env.get('NOTIFY_DB_KEY') ?? Deno.env.get('SUPERADMIN_DB_KEY');
  const jwk = Deno.env.get('VAPID_PRIVATE_JWK');
  if (!dbKey || !jwk) return json({ error: 'Set SUPERADMIN_DB_KEY and VAPID_PRIVATE_JWK' }, 503);
  const vapid: Vapid = { privateJwk: JSON.parse(jwk), subject: Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com' };

  const body = await req.json().catch(() => ({}));
  const dryRun = Boolean((body as { dry_run?: boolean }).dry_run);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, dbKey, { auth: { persistSession: false } });

  const { data: due, error } = await db.rpc('notifications_due');
  if (error) return json({ error: `notifications_due: ${error.message}` }, 500);
  const rows = (due ?? []) as Due[];
  if (rows.length === 0) return json({ people: 0, sent: 0 });

  const users = [...new Set(rows.map((r) => r.auth_user_id))];
  const { data: subs, error: subErr } = await db.from('push_subscriptions').select('*').in('auth_user_id', users);
  if (subErr) return json({ error: `push_subscriptions: ${subErr.message}` }, 500);

  // One notification per person per group.
  const digests = new Map<string, { user: string; group: string; items: Due[] }>();
  for (const r of rows) {
    const k = `${r.auth_user_id}|${r.group_name}`;
    if (!digests.has(k)) digests.set(k, { user: r.auth_user_id, group: r.group_name, items: [] });
    digests.get(k)!.items.push(r);
  }

  let sent = 0; let failed = 0; let removed = 0;
  const preview: unknown[] = [];
  for (const { user, group, items } of digests.values()) {
    items.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    for (const s of (subs ?? []) as Sub[]) {
      if (s.auth_user_id !== user) continue;
      const lang: Lang = s.lang === 'te' ? 'te' : 'en';
      const text = items.map((d) => LINES[lang][d.kind]?.(d, lang)).filter(Boolean).join(' · ');
      const payload = {
        title: group,
        body: text.charAt(0).toUpperCase() + text.slice(1),
        url: '/',
        // Same tag each day: today's digest replaces yesterday's on the phone.
        tag: `digest:${group}`,
      };
      if (dryRun) { preview.push({ user, lang, ...payload }); continue; }
      try {
        const r = await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth_secret }, payload, vapid);
        if (r.gone) {
          await db.from('push_subscriptions').delete().eq('id', s.id);
          removed++;
        } else if (r.status >= 200 && r.status < 300) {
          await db.from('push_subscriptions').update({ last_sent_at: new Date().toISOString() }).eq('id', s.id);
          sent++;
        } else {
          failed++;
          console.error('push failed', r.status, r.body);
        }
      } catch (e) {
        failed++;
        console.error('push error', e);
      }
    }
  }
  return json(dryRun ? { dry_run: true, digests: preview } : { people: digests.size, sent, failed, removed });
});
