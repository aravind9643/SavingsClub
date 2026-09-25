import { useState } from 'react';
import { supabase, friendlyError } from '../lib/supabase';
import { ErrorNote, Field, Busy } from '../components/ui';

type Mode = 'password' | 'signup' | 'magic';

export default function Login() {
  const [mode, setMode] = useState<Mode>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setError(null); setInfo(null);
    try {
      if (mode === 'magic') {
        const { error: e } = await supabase.auth.signInWithOtp({
          email, options: { emailRedirectTo: window.location.origin },
        });
        if (e) throw e;
        setSent(true);
        return;
      }
      if (mode === 'signup') {
        const { data, error: e } = await supabase.auth.signUp({
          email, password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (e) throw e;
        if (!data.session) {
          setInfo('Account created. Confirm your email, then sign in.');
          setMode('password');
        }
        return;
      }
      const { error: e } = await supabase.auth.signInWithPassword({ email, password });
      if (e) throw e;
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="auth">
        <div className="auth-card">
          <div className="auth-logo">✓</div>
          <h1>Check your email</h1>
          <p className="muted" style={{ marginTop: 10 }}>
            A sign-in link is on its way to <strong>{email}</strong>.
          </p>
          <p className="dim">
            Nothing after a minute? The free email sender is rate limited — a password
            works straight away.
          </p>
          <div className="btn-row stack">
            <button className="primary lg" onClick={() => { setSent(false); setMode('password'); }}>
              Use a password instead
            </button>
          </div>
        </div>
      </div>
    );
  }

  const ok = mode === 'magic' ? Boolean(email) : Boolean(email) && password.length >= 6;

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-logo">✦</div>
        <h1>SavingsClub</h1>
        <p className="muted" style={{ marginTop: 8, marginBottom: 20 }}>
          {mode === 'signup'
            ? 'Create your sign-in. You can start a group or join one next.'
            : 'Sign in to your savings group.'}
        </p>

        <ErrorNote error={error} />
        {info && (
          <div className="error" style={{ background: 'var(--mint-ghost)', color: 'var(--mint)' }}>
            {info}
          </div>
        )}

        <Field label="Email">
          <input
            type="email" value={email} autoComplete="email" inputMode="email"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && ok) void submit(); }}
            placeholder="you@example.com"
          />
        </Field>

        {mode !== 'magic' && (
          <Field label="Password" hint={mode === 'signup' ? 'At least 6 characters' : undefined}>
            <input
              type="password" value={password}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ok) void submit(); }}
              placeholder="••••••••"
            />
          </Field>
        )}

        <div className="btn-row stack">
          <Busy className="primary lg" pending={busy} disabled={!ok} onClick={() => void submit()}>
            {mode === 'signup' ? 'Create account' : mode === 'magic' ? 'Send link' : 'Sign in'}
          </Busy>
        </div>

        <div
          style={{
            display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap',
            marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--hairline)',
          }}
        >
          {mode !== 'password' && (
            <button className="ghost" style={{ padding: 4, border: 0 }}
              onClick={() => { setMode('password'); setError(null); }}>
              Use a password
            </button>
          )}
          {mode !== 'signup' && (
            <button className="ghost" style={{ padding: 4, border: 0 }}
              onClick={() => { setMode('signup'); setError(null); }}>
              First time here
            </button>
          )}
          {mode !== 'magic' && (
            <button className="ghost" style={{ padding: 4, border: 0 }}
              onClick={() => { setMode('magic'); setError(null); }}>
              Email me a link
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
