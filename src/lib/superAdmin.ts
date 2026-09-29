import { createClient } from '@supabase/supabase-js';

/**
 * The developer console's only door into the database: the `superadmin` Edge
 * Function (supabase/functions/superadmin).
 *
 * This file used to build a service_role client in the browser, from a key in
 * a VITE_ env var or localStorage, behind a PIN checked right here in client
 * code. A VITE_ variable is inlined into the public bundle, so any deployed
 * build carried full database access for anyone who opened devtools. Now the
 * key lives in the function's environment, and the function admits a request
 * only from a signed-in account listed in `super_admins` (0043).
 *
 * The developer signs in with email + password on /admin itself, through a
 * client of its OWN -- separate storage key, sessionStorage rather than
 * localStorage. Sharing the app's client would have made the developer's
 * login the app's login too: open "/" afterwards and a person who belongs to
 * no group lands in onboarding, and signing out of one signs out of both.
 */
const adminAuth = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  {
    auth: {
      storageKey: 'savingsclub-superadmin-auth',
      // Gone when the tab closes, so a borrowed laptop does not stay unlocked.
      storage: typeof window !== 'undefined' ? window.sessionStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  },
);

/**
 * `status` tells the caller WHY a call failed, which the message alone does
 * not: 401/403 is a verdict on the account; 0 is "no answer at all" and the fix
 * is deploying the function. Treating the second as the first sent people to
 * fix an account that was never checked.
 */
export class SuperAdminError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const NOT_DEPLOYED =
  'Could not reach the superadmin Edge Function — it is probably not deployed yet. '
  + 'Run: npx supabase functions deploy superadmin';

export async function hasSuperAdminSession(): Promise<boolean> {
  const { data } = await adminAuth.auth.getSession();
  return Boolean(data.session);
}

export async function superAdminSignIn(email: string, password: string): Promise<void> {
  const { error } = await adminAuth.auth.signInWithPassword({ email: email.trim(), password });
  if (error) {
    // One message for both, on purpose: saying which half was wrong tells a
    // stranger which emails have accounts.
    throw new SuperAdminError(
      error.status === 429 ? 'Too many attempts just now. Wait a minute and try again.'
        : 'Email or password is incorrect.',
      error.status ?? 400,
    );
  }
}

export async function superAdminSignOut(): Promise<void> {
  await adminAuth.auth.signOut();
}

export async function superAdmin<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  // invoke() sends this client's access token as the Authorization header.
  const { data, error } = await adminAuth.functions.invoke('superadmin', {
    body: { action, ...payload },
  });
  if (error) {
    const ctx = (error as { context?: unknown }).context;
    // FunctionsHttpError carries the Response; the function puts a readable
    // sentence in `error`, which is worth more than "non-2xx status code".
    if (ctx instanceof Response) {
      if (ctx.status === 404) throw new SuperAdminError(NOT_DEPLOYED, 404);
      let message = error.message;
      try {
        const body = await ctx.clone().json();
        if (body && typeof body.error === 'string') message = body.error;
      } catch {
        /* not JSON -- keep the transport message */
      }
      throw new SuperAdminError(message, ctx.status);
    }
    // FunctionsFetchError / FunctionsRelayError: no response reached us. For
    // a function that has never been deployed this is what the browser sees,
    // because the gateway's 404 carries no CORS headers.
    throw new SuperAdminError(NOT_DEPLOYED, 0);
  }
  return data as T;
}
