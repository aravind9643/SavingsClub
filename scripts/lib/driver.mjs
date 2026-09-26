/**
 * Two ways to be a signed-in user, behind one interface.
 *
 * Every write in this app goes through an RPC -- all 21 tables refuse
 * INSERT, UPDATE and DELETE to `authenticated`. So a test script cannot
 * seed data by writing rows; it has to act as real members calling the
 * same functions the screens call. That is the point: a scenario that
 * passes here passes in the app, because it went through every role check
 * and RLS policy on the way.
 *
 *   remote  a real Supabase project. Real GoTrue users, real JWTs, real
 *           PostgREST. This is the deployment.
 *   local   plain Postgres with the test shim. There is no auth server
 *           without Docker, so a "session" is `set role authenticated`
 *           plus the JWT claims in a GUC -- exactly what PostgREST does
 *           per request, which is why the shim's auth.uid() reads `sub`
 *           from request.jwt.claims rather than somewhere convenient.
 *
 * Scenario code never knows which it is talking to.
 */

const isLocal = (target) => target === 'local';

/* ------------------------------------------------------------------ local */

async function localDriver({ db = 'sanchay_test', password = process.env.PGPASSWORD } = {}) {
  const { default: pg } = await import('pg');

  // One connection is HELD OPEN per member, because `set role` and the
  // claims GUC are session state -- a pooled client that hopped between
  // users would silently act as the wrong person. So the pool must be big
  // enough for every member in a scenario plus the raw/admin calls, or
  // pool.connect() simply blocks forever waiting for a free client. That
  // looks exactly like a deadlock and is not one.
  const pool = new pg.Pool({
    host: '127.0.0.1',
    user: 'postgres',
    password,
    database: db,
    max: 24,
    // Fail loudly instead of hanging if a scenario ever does exhaust it.
    connectionTimeoutMillis: 5000,
  });

  // One client per user, held open: `set role` and the claims GUC are
  // session state, so a pooled connection that hops between users would
  // silently act as the wrong person.
  const sessions = new Map();

  async function sessionFor(user) {
    const key = user?.id ?? '__anon__';
    if (sessions.has(key)) return sessions.get(key);
    const client = await pool.connect();
    sessions.set(key, client);
    return client;
  }

  async function applyClaims(client, user, groupId) {
    await client.query('reset role');
    const claims = {
      sub: user?.id ?? null,
      role: 'authenticated',
      app_metadata: groupId ? { group_id: groupId } : {},
    };
    await client.query('select set_config($1, $2, false)', [
      'request.jwt.claims',
      JSON.stringify(claims),
    ]);
    // Without this the policies are never consulted -- superuser bypasses
    // RLS, and every check would pass while proving nothing.
    await client.query('set role authenticated');
  }

  // pg_proc.proretset, cached -- one lookup per function per run.
  const setCache = new Map();
  async function returnsSet(client, fn) {
    if (setCache.has(fn)) return setCache.get(fn);
    const { rows } = await client.query(
      `select bool_or(p.proretset) as s from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = $1`,
      [fn],
    );
    const v = rows[0]?.s ?? false;
    setCache.set(fn, v);
    return v;
  }

  return {
    target: 'local',

    async createUser(email) {
      const id = crypto.randomUUID();
      const c = await pool.connect();
      try {
        await c.query(
          `insert into auth.users (id, email, aud, role, created_at, updated_at)
           values ($1, $2, 'authenticated', 'authenticated', now(), now())
           on conflict (id) do nothing`,
          [id, email],
        );
      } finally {
        c.release();
      }
      return { id, email };
    },

    async rpc(user, groupId, fn, args = {}) {
      const client = await sessionFor(user);
      await applyClaims(client, user, groupId);
      const names = Object.keys(args);
      const params = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
      // `select f(...)` on a function returning a composite gives ONE column
      // holding the whole row as a string. `select * from f(...)` expands it
      // into real columns, which is what a PostgREST caller sees.
      const { rows } = await client.query(
        `select * from ${fn}(${params})`,
        names.map((n) => args[n]),
      );
      // Whether this returns a SET is a property of the function, not of how
      // many rows came back this time: guessing from rows.length turns a
      // one-result pending_members() into an object and breaks .find().
      const setReturning = await returnsSet(client, fn);
      if (setReturning) return rows;
      if (!rows.length) return null;
      const cols = Object.keys(rows[0]);
      // A scalar function yields a single column named after itself.
      return cols.length === 1 && cols[0] === fn ? rows[0][fn] : rows[0];
    },

    async select(user, groupId, from, { eq = {}, columns = '*' } = {}) {
      const client = await sessionFor(user);
      await applyClaims(client, user, groupId);
      const keys = Object.keys(eq);
      const where = keys.length
        ? ' where ' + keys.map((k, i) => `${k} = $${i + 1}`).join(' and ')
        : '';
      const { rows } = await client.query(
        `select ${columns} from ${from}${where}`,
        keys.map((k) => eq[k]),
      );
      return rows;
    },

    /** Escape hatch: things no RPC exposes, like ageing a loan. */
    async raw(sql, params = []) {
      const c = await pool.connect();
      try {
        await c.query('reset role');
        const { rows } = await c.query(sql, params);
        return rows;
      } finally {
        c.release();
      }
    },

    async close() {
      for (const c of sessions.values()) c.release();
      sessions.clear();
      await pool.end();
    },
  };
}

/* ----------------------------------------------------------------- remote */

async function remoteDriver({ url, anonKey, serviceKey }) {
  const { createClient } = await import('@supabase/supabase-js');

  if (!url || !anonKey) {
    throw new Error(
      'Remote needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (.env.local).',
    );
  }

  // Creating users needs the service key. Without it the script can still
  // sign in as users that already exist.
  const admin = serviceKey
    ? createClient(url, serviceKey, { auth: { persistSession: false } })
    : null;

  const clients = new Map();

  async function clientFor(user) {
    if (!user) {
      return createClient(url, anonKey, { auth: { persistSession: false } });
    }
    if (clients.has(user.id)) return clients.get(user.id);
    const c = createClient(url, anonKey, { auth: { persistSession: false } });
    const { error } = await c.auth.signInWithPassword({
      email: user.email,
      password: user.password,
    });
    if (error) throw new Error(`sign in ${user.email}: ${error.message}`);
    clients.set(user.id, c);
    return c;
  }

  // The group is carried in a JWT claim, so switching group means getting a
  // new token -- the claim is written by set_active_group() and only appears
  // after a refresh.
  async function ensureGroup(c, groupId) {
    if (!groupId) return;
    const { error } = await c.rpc('set_active_group', { p_group_id: groupId });
    if (error && !/does not exist/i.test(error.message)) throw error;
    await c.auth.refreshSession();
  }

  return {
    target: 'remote',

    async createUser(email, password = 'test-password-123!') {
      if (!admin) {
        throw new Error(
          'Creating users needs SUPABASE_SERVICE_ROLE_KEY. ' +
          'Set it, or pass users that already exist.',
        );
      }
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error) throw new Error(`create ${email}: ${error.message}`);
      return { id: data.user.id, email, password };
    },

    async rpc(user, groupId, fn, args = {}) {
      const c = await clientFor(user);
      await ensureGroup(c, groupId);
      const { data, error } = await c.rpc(fn, args);
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return data;
    },

    async select(user, groupId, from, { eq = {}, columns = '*' } = {}) {
      const c = await clientFor(user);
      await ensureGroup(c, groupId);
      let q = c.from(from).select(columns);
      for (const [k, v] of Object.entries(eq)) q = q.eq(k, v);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return data ?? [];
    },

    async raw() {
      throw new Error(
        'raw SQL is local-only. On remote, do it in the SQL editor -- a ' +
        'script should not be quietly rewriting a live ledger.',
      );
    },

    async close() {
      for (const c of clients.values()) await c.auth.signOut();
      clients.clear();
    },
  };
}

export async function makeDriver(target, opts = {}) {
  return isLocal(target) ? localDriver(opts) : remoteDriver(opts);
}
