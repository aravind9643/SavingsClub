import { useState } from 'react';
import { supabase, friendlyError } from '../lib/supabase';
import { ErrorNote, Field, Busy } from '../components/ui';
import { IconEye, IconEyeSlash, IconEmail, IconVault } from '../components/icons';
import { haptic } from '../lib/haptics';

type Mode = 'signin' | 'signup' | 'magic';

export default function Login() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [sent, setSent] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === 'magic') {
        const { error: e } = await supabase.auth.signInWithOtp({
          email: email.trim(),
          options: { emailRedirectTo: window.location.origin },
        });
        if (e) throw e;
        setSent(true);
        return;
      }
      if (mode === 'signup') {
        const { data, error: e } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (e) throw e;
        if (!data.session) {
          setInfo('Account created! Please check your email to confirm, then sign in.');
          setMode('signin');
        }
        return;
      }
      const { error: e } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
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
          <div className="auth-logo">
            <IconEmail width={24} height={24} />
          </div>
          <h1 style={{ fontFamily: 'var(--display)', fontSize: '1.45rem', fontWeight: 700 }}>
            Check your email
          </h1>
          <p className="muted" style={{ marginTop: 10, lineHeight: 1.5 }}>
            A secure sign-in link is on its way to <strong style={{ color: 'var(--text)' }}>{email}</strong>.
          </p>
          <div
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--hairline-soft)',
              borderRadius: 'var(--r-sm)',
              padding: '12px 14px',
              fontSize: '0.82rem',
              color: 'var(--text-3)',
              margin: '16px 0',
              lineHeight: 1.4,
            }}
          >
            Nothing after a minute? Check spam, or sign in instantly with a password.
          </div>
          <div className="btn-row stack">
            <button
              type="button"
              className="primary lg"
              onClick={() => {
                setSent(false);
                setMode('signin');
              }}
            >
              Sign in with password
            </button>
          </div>
        </div>
      </div>
    );
  }

  const ok = mode === 'magic'
    ? Boolean(email.trim())
    : Boolean(email.trim()) && password.length >= 6;

  return (
    <div className="auth">
      <div className="auth-card">
        {/* Logo badge & Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
          <div className="auth-logo" style={{ marginBottom: 0 }}>
            <IconVault width={24} height={24} />
          </div>
          <div>
            <h1 style={{ fontFamily: 'var(--display)', fontSize: '1.45rem', fontWeight: 750, letterSpacing: '-0.02em', margin: 0 }}>
              SavingsClub
            </h1>
            <span className="dim" style={{ fontSize: '0.78rem', letterSpacing: '0.01em' }}>
              Community Savings & Chit Fund
            </span>
          </div>
        </div>

        {/* Tab switch between Sign In and Sign Up */}
        {mode !== 'magic' ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              background: 'var(--surface-2)',
              padding: 3,
              borderRadius: 'var(--r-full)',
              border: '1px solid var(--hairline-soft)',
              marginBottom: 18,
            }}
          >
            <button
              type="button"
              className={`seg${mode === 'signin' ? ' on' : ''}`}
              style={{ padding: '7px 0', textAlign: 'center', width: '100%', borderRadius: 'var(--r-full)' }}
              onClick={() => {
                setMode('signin');
                setError(null);
                setInfo(null);
              }}
            >
              Sign in
            </button>
            <button
              type="button"
              className={`seg${mode === 'signup' ? ' on' : ''}`}
              style={{ padding: '7px 0', textAlign: 'center', width: '100%', borderRadius: 'var(--r-full)' }}
              onClick={() => {
                setMode('signup');
                setError(null);
                setInfo(null);
              }}
            >
              Create account
            </button>
          </div>
        ) : (
          <div style={{ marginBottom: 18 }}>
            <span style={{ fontFamily: 'var(--display)', fontSize: '1.1rem', fontWeight: 650, display: 'block' }}>
              Sign in with link
            </span>
            <span className="dim" style={{ fontSize: '0.8rem' }}>
              We will email you a passwordless login link.
            </span>
          </div>
        )}

        <ErrorNote error={error} />
        {info && (
          <div
            className="error"
            style={{
              background: 'var(--mint-ghost)',
              color: 'var(--mint)',
              borderColor: 'color-mix(in srgb, var(--mint) 30%, transparent)',
            }}
          >
            {info}
          </div>
        )}

        {/* Email Field */}
        <Field label="Email address">
          <div className="input-with-action">
            <input
              type="email"
              value={email}
              autoComplete="email"
              inputMode="email"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ok) void submit(); }}
              placeholder="you@example.com"
              autoFocus
            />
          </div>
        </Field>

        {/* Password Field */}
        {mode !== 'magic' && (
          <Field
            label="Password"
            hint={
              mode === 'signup' ? (
                <span style={{ color: password.length >= 6 ? 'var(--mint)' : 'var(--text-3)' }}>
                  {password.length >= 6 ? '✓ Strong enough' : 'At least 6 characters'}
                </span>
              ) : undefined
            }
          >
            <div className="input-with-action">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && ok) void submit(); }}
                placeholder="••••••••"
              />
              <button
                type="button"
                tabIndex={-1}
                className="input-action-btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  haptic(10);
                  setShowPassword((prev) => !prev);
                }}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <IconEyeSlash width={16} height={16} /> : <IconEye width={16} height={16} />}
              </button>
            </div>
          </Field>
        )}

        {/* Submit Button */}
        <div className="btn-row stack" style={{ marginTop: 18 }}>
          <Busy
            className="primary lg"
            pending={busy}
            disabled={!ok}
            onClick={() => void submit()}
          >
            {mode === 'signup'
              ? 'Create account'
              : mode === 'magic'
              ? 'Send magic link'
              : 'Sign in'}
          </Busy>
        </div>

        {/* Secondary options */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 12,
            marginTop: 18,
            paddingTop: 16,
            borderTop: '1px solid var(--hairline)',
          }}
        >
          {mode === 'magic' ? (
            <button
              type="button"
              className="sec-link"
              style={{ fontSize: '0.84rem' }}
              onClick={() => {
                setMode('signin');
                setError(null);
              }}
            >
              Sign in with password
            </button>
          ) : (
            <button
              type="button"
              className="sec-link"
              style={{ fontSize: '0.84rem', color: 'var(--text-3)' }}
              onClick={() => {
                setMode('magic');
                setError(null);
              }}
            >
              <IconEmail width={14} height={14} style={{ marginRight: 6 }} />
              Email me a sign-in link
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
