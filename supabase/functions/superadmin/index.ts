// superadmin -- the developer console's only way into the database.
//
// The console used to hold the service_role key in the browser, gated by a PIN
// checked in client JavaScript. Now the key lives here, in the function's own
// environment, and every request is authorised on the server:
//
//   1. the caller's Supabase access token must be valid -- the developer signs
//      in with email + password on /admin (a login that belongs to no group),
//   2. and that user must be listed in `super_admins` (0043), a table only the
//      service role can read, so nobody can add themselves.
//
// Passwords, hashing and sign-in rate limits are Supabase Auth's job, not this
// function's: it never sees a password.
//
// Only named actions against allowlisted tables are accepted. This is not a
// generic SQL proxy: a stolen super-admin session can do what the console can
// do, and nothing else.
//
// Deploy:  npx supabase functions deploy superadmin

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// PostgREST caps a response at 1000 rows by default. The console used to issue
// a single select per table, so past that point the lists silently ended and
// "Total deposited" was computed from a truncated set -- a figure too small
// with no error. Page until a short page comes back.
const PAGE = 1000;

async function fetchAll(
  db: SupabaseClient,
  table: string,
  orderBy: string,
  build?: (q: any) => any,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = db.from(table).select('*').order(orderBy, { ascending: true }).range(from, from + PAGE - 1);
    if (build) q = build(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

// What the console lists, and the stable column each is paged by.
const LOAD: Record<string, string> = {
  groups: 'created_at',
  members: 'id',
  loans: 'id',
  loan_repayments: 'id',
  contributions: 'id',
  bank_statements: 'id',
  expenses: 'id',
};

// Every table the console may touch, and how. This registry IS the
// allowlist: a table that is not here cannot be read, edited or deleted, and
// the Tables browser, the backup and the delete action all read from it.
//
//   pk        the primary key a row is addressed by
//   edit      whether update_row is allowed. audit_log is append-only
//             (trg_audit_immutable) and super_admins is managed in SQL only.
interface TableRule { pk: string; edit: boolean }
const TABLES: Record<string, TableRule> = {
  groups:               { pk: 'id', edit: true },
  profiles:             { pk: 'id', edit: true },
  members:              { pk: 'id', edit: true },
  role_assignments:     { pk: 'id', edit: true },
  group_invites:        { pk: 'code', edit: true },
  contribution_periods: { pk: 'id', edit: true },
  contributions:        { pk: 'id', edit: true },
  loans:                { pk: 'id', edit: true },
  loan_votes:           { pk: 'id', edit: true },
  loan_instalments:     { pk: 'id', edit: true },
  loan_repayments:      { pk: 'id', edit: true },
  expenses:             { pk: 'id', edit: true },
  expense_votes:        { pk: 'id', edit: true },
  cash_ledger:          { pk: 'id', edit: true },
  bank_statements:      { pk: 'id', edit: true },
  member_payouts:       { pk: 'id', edit: true },
  distributions:        { pk: 'id', edit: true },
  distribution_lines:   { pk: 'id', edit: true },
  meetings:             { pk: 'id', edit: true },
  meeting_attendance:   { pk: 'id', edit: true },
  audit_log:            { pk: 'id', edit: false },
};

// Columns no edit may change, whatever the table:
//   group_id    tenancy. Composite FKs tie every child row to its parent's
//               group; moving one row would either fail or split a loan from
//               its votes across two tenants.
//   created_at  history, not data.
// plus the table's own primary key.
const NEVER_EDIT = new Set(['group_id', 'created_at']);

// Money and rates are integers everywhere in this schema (paise, basis
// points). A float here is exactly the "number slightly too large" bug.
const INTEGER_SUFFIXES = ['_paise', '_bp', '_count', '_months', '_hours', '_day'];

const ROLES = new Set(['member', 'cashier', 'accountant', 'admin']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // ---- who is asking
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const { data: auth, error: authErr } = token
    ? await db.auth.getUser(token)
    : { data: null, error: new Error('no token') };
  if (authErr || !auth?.user) return json({ error: 'Sign in to the console first' }, 401);

  const { data: allowed, error: allowErr } = await db
    .from('super_admins').select('auth_user_id').eq('auth_user_id', auth.user.id).maybeSingle();
  if (allowErr) return json({ error: `Could not check access: ${allowErr.message}` }, 500);
  if (!allowed) {
    return json({ error: `${auth.user.email ?? 'This account'} is not a super admin` }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Request body must be JSON' }, 400);
  }

  try {
    switch (body.action) {
      case 'whoami':
        return json({ email: auth.user.email ?? null });

      case 'load': {
        const entries = await Promise.all(
          Object.entries(LOAD).map(async ([t, o]) => [t, await fetchAll(db, t, o)] as const),
        );
        const data: Record<string, unknown> = Object.fromEntries(entries);
        data.role_assignments = await fetchAll(db, 'role_assignments', 'id', (q) => q.is('end_date', null));
        // The audit log is unbounded; the console shows the latest slice only.
        const { data: audit, error } = await db
          .from('audit_log').select('*').order('occurred_at', { ascending: false }).limit(300);
        if (error) throw new Error(`audit_log: ${error.message}`);
        data.audit_log = audit ?? [];
        return json(data);
      }

      case 'backup': {
        const entries = await Promise.all(
          Object.entries(TABLES).map(async ([t, r]) => [t, await fetchAll(db, t, r.pk)] as const),
        );
        return json({ exported_at: new Date().toISOString(), tables: Object.fromEntries(entries) });
      }

      case 'tables':
        return json({ tables: Object.entries(TABLES).map(([name, r]) => ({ name, pk: r.pk, edit: r.edit })) });

      case 'list_table': {
        const table = String(body.table ?? '');
        const rule = TABLES[table];
        if (!rule) return json({ error: `${table} is not available in the console` }, 400);
        // The audit log is unbounded: newest slice only. Everything else in
        // full, paged past the 1000-row cap.
        if (table === 'audit_log') {
          const { data, error } = await db
            .from('audit_log').select('*').order('id', { ascending: false }).limit(1000);
          if (error) throw new Error(error.message);
          return json({ rows: data ?? [], truncated: (data?.length ?? 0) === 1000 });
        }
        return json({ rows: await fetchAll(db, table, rule.pk), truncated: false });
      }

      case 'update_row': {
        const table = String(body.table ?? '');
        const rule = TABLES[table];
        if (!rule) return json({ error: `${table} is not available in the console` }, 400);
        if (!rule.edit) return json({ error: `${table} is read-only` }, 400);
        const key = String(body.pk ?? '');
        const values = body.values;
        if (!key) return json({ error: 'Which row?' }, 400);
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
          return json({ error: 'values must be an object of column: value' }, 400);
        }

        // Validate against the row as it is now: only columns that exist, never
        // the key or the tenancy column, and no type changes. PostgREST would
        // reject some of this; checking here gives a sentence instead of a code.
        const { data: current, error: readErr } = await db
          .from(table).select('*').eq(rule.pk, key).maybeSingle();
        if (readErr) throw new Error(readErr.message);
        if (!current) return json({ error: 'That row no longer exists — refresh and try again' }, 404);

        const patch: Record<string, unknown> = {};
        for (const [col, v] of Object.entries(values as Record<string, unknown>)) {
          if (!(col in current)) return json({ error: `${table} has no column ${col}` }, 400);
          if (col === rule.pk || NEVER_EDIT.has(col)) {
            return json({ error: `${col} cannot be changed` }, 400);
          }
          const was = (current as Record<string, unknown>)[col];
          if (v !== null && typeof v === 'object') {
            return json({ error: `${col}: structured values cannot be edited here` }, 400);
          }
          const mustBeInteger = typeof was === 'number'
            || INTEGER_SUFFIXES.some((s) => col.endsWith(s));
          if (mustBeInteger && v !== null && !(typeof v === 'number' && Number.isSafeInteger(v))) {
            return json({ error: `${col} must be a whole number` }, 400);
          }
          if (typeof was === 'boolean' && v !== null && typeof v !== 'boolean') {
            return json({ error: `${col} must be true or false` }, 400);
          }
          patch[col] = v;
        }
        if (Object.keys(patch).length === 0) return json({ row: current, changed: 0 });

        // Constraints, triggers and the audit log all still apply: this is an
        // UPDATE like any other, just not routed through an RPC's own checks.
        const { data: row, error } = await db
          .from(table).update(patch).eq(rule.pk, key).select('*').single();
        if (error) throw new Error(error.message);
        return json({ row, changed: Object.keys(patch).length });
      }

      case 'delete': {
        const table = String(body.table ?? '');
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        const rule = TABLES[table];
        if (!rule) return json({ error: `Deleting from ${table} is not allowed` }, 400);
        if (ids.length === 0) return json({ deleted: 0 });

        if (table === 'audit_log') {
          const { data, error } = await db.rpc('admin_delete_audit_logs', { p_ids: ids.map(Number) });
          if (error) throw new Error(error.message);
          return json({ deleted: data ?? 0 });
        }
        // `count` so the console can say what actually happened rather than
        // what was asked for -- a filter matching nothing is not an error.
        const { error, count } = await db.from(table).delete({ count: 'exact' }).in(rule.pk, ids);
        if (error) throw new Error(error.message);
        return json({ deleted: count ?? 0 });
      }

      case 'save_group': {
        const name = text(body.name, 120);
        const monthly = Number(body.monthly_contribution_paise);
        if (!name) return json({ error: 'Give the group a name' }, 400);
        if (!Number.isSafeInteger(monthly) || monthly < 0) {
          return json({ error: 'Monthly contribution must be a whole amount' }, 400);
        }
        const payload = { name, monthly_contribution_paise: monthly };
        const q = body.id
          ? db.from('groups').update(payload).eq('id', String(body.id))
          : db.from('groups').insert(payload);
        const { error } = await q;
        if (error) throw new Error(error.message);
        return json({ ok: true });
      }

      case 'save_member': {
        const group_id = text(body.group_id, 64);
        const full_name = text(body.full_name, 120);
        if (!group_id) return json({ error: 'Pick a group' }, 400);
        if (!full_name) return json({ error: 'Enter the member’s name' }, 400);
        const payload = {
          group_id,
          full_name,
          phone: text(body.phone, 32),
          nominee_name: text(body.nominee_name, 120),
          nominee_phone: text(body.nominee_phone, 32),
        };
        const q = body.id
          ? db.from('members').update(payload).eq('id', String(body.id))
          : db.from('members').insert(payload);
        const { error } = await q;
        if (error) throw new Error(error.message);
        return json({ ok: true });
      }

      case 'assign_role': {
        const role = String(body.role ?? '');
        const on = String(body.on ?? '');
        if (!ROLES.has(role)) return json({ error: 'Unknown role' }, 400);
        if (!ISO_DATE.test(on)) return json({ error: 'Date must be YYYY-MM-DD' }, 400);
        const { error } = await db.rpc('admin_assign_role', {
          p_group_id: String(body.group_id ?? ''),
          p_member_id: String(body.member_id ?? ''),
          p_role: role,
          p_on: on,
        });
        if (error) throw new Error(error.message);
        return json({ ok: true });
      }

      default:
        return json({ error: `Unknown action: ${String(body.action)}` }, 400);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
