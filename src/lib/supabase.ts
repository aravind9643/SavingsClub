import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  throw new Error(
    'Missing Supabase configuration. Copy .env.example to .env.local and fill in ' +
      'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from your project settings.',
  );
}

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/**
 * Postgres raises our business-rule violations with human-readable messages.
 * Surface those directly -- they are written to be read by members -- and fall
 * back to something generic for anything else.
 */
export function friendlyError(err: unknown): string {
  if (!err) return 'Something went wrong.';
  const e = err as {
    message?: string; details?: string; hint?: string;
    code?: string; status?: number;
  };
  const msg = e.message ?? '';
  const code = e.code ?? '';

  // Supabase's built-in email sender is heavily throttled (a few messages an
  // hour) and is meant only for testing. Say so plainly instead of showing the
  // raw code -- otherwise it reads like a fault in the app.
  if (code === 'over_email_send_rate_limit' || /email rate limit/i.test(msg)) {
    return (
      'Too many sign-in emails have been sent from this project in the last hour. ' +
      'Wait about an hour, or set up your own SMTP in Supabase ' +
      '(Authentication → Emails → SMTP Settings) to remove the limit.'
    );
  }
  if (code === 'over_request_rate_limit' || e.status === 429) {
    return 'Too many attempts just now. Wait a minute and try again.';
  }
  if (code === 'otp_expired' || /expired/i.test(msg)) {
    return 'That sign-in link has expired. Request a new one.';
  }
  if (code === 'validation_failed' && /email/i.test(msg)) {
    return 'That email address does not look right.';
  }

  if (e.code === '42501' || /insufficient_privilege/i.test(msg)) {
    return msg.replace(/^.*?:\s*/, '') || 'You do not have permission to do that.';
  }
  if (e.code === '23505') return 'That entry already exists.';
  if (e.code === '23503') return 'That refers to something which does not exist.';
  if (msg) return msg;
  return 'Something went wrong.';
}
