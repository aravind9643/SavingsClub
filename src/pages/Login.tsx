import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase, friendlyError } from '../lib/supabase';
import { ErrorNote, Field, Busy, Notice } from '../components/ui';
import { IconEye, IconEyeSlash, IconEmail, IconVault, IconKey } from '../components/icons';
import { haptic } from '../lib/haptics';

type Mode = 'signin' | 'signup' | 'magic';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const [inviteCode] = useState<string | null>(() => {
    const q = searchParams.get('code');
    if (q) {
      try { sessionStorage.setItem('sanchay:pending_invite_code', q); } catch { /* private window */ }
      return q;
    }
    try { return sessionStorage.getItem('sanchay:pending_invite_code'); } catch { /* private window */ }
    return null;
  });

  const [mode, setMode] = useState<Mode>(() => {
    if (location.pathname === '/signup') return 'signup';
    return 'signin';
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
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
        const redirectTo = inviteCode
          ? `${window.location.origin}/join?code=${encodeURIComponent(inviteCode)}`
          : window.location.origin;
        const { error: e } = await supabase.auth.signInWithOtp({
          email: email.trim(),
          options: { emailRedirectTo: redirectTo },
        });
        if (e) throw e;
        setSent(true);
        return;
      }
      if (mode === 'signup') {
        const redirectTo = inviteCode
          ? `${window.location.origin}/join?code=${encodeURIComponent(inviteCode)}`
          : window.location.origin;
        const { data, error: e } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: fullName.trim() ? { full_name: fullName.trim() } : undefined,
            emailRedirectTo: redirectTo,
          },
        });
        if (e) throw e;
        if (!data.session) {
          setInfo('Account created! Please check your email to confirm, then sign in.');
          setMode('signin');
          navigate('/login', { replace: true });
        } else {
          if (inviteCode) {
            navigate(`/join?code=${encodeURIComponent(inviteCode)}`, { replace: true });
          } else {
            navigate('/', { replace: true });
          }
        }
        return;
      }
      const { error: e } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (e) throw e;
      if (inviteCode) {
        navigate(`/join?code=${encodeURIComponent(inviteCode)}`, { replace: true });
      } else {
        navigate('/', { replace: true });
      }
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

        {inviteCode && (
          <div style={{ marginBottom: 14 }}>
            <Notice tone="good">
              You&apos;ve been invited to join a savings group. Sign in or create an account to continue.
            </Notice>
          </div>
        )}

        {/* Tab switch between Sign In and Sign Up */}
        {mode !== 'magic' ? (
          <div className="auth-switcher" data-active={mode === 'signup' ? 'right' : 'left'}>
            <button
              type="button"
              className={`auth-switcher-tab${mode === 'signin' ? ' active' : ''}`}
              onClick={() => {
                haptic(10);
                setMode('signin');
                setError(null);
                setInfo(null);
                if (location.pathname !== '/login') {
                  navigate('/login', { replace: true });
                }
              }}
            >
              Sign in
            </button>
            <button
              type="button"
              className={`auth-switcher-tab${mode === 'signup' ? ' active' : ''}`}
              onClick={() => {
                haptic(10);
                setMode('signup');
                setError(null);
                setInfo(null);
                if (location.pathname !== '/signup') {
                  navigate('/signup', { replace: true });
                }
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

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ok && !busy) void submit();
          }}
        >
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

          {/* Animated collapsible name field for signup */}
          <div className={`auth-extra-field${mode === 'signup' ? ' open' : ''}`}>
            <Field label="Your full name">
              <input
                type="text"
                value={fullName}
                autoComplete="name"
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Aravind Merugu"
                autoFocus={mode === 'signup'}
              />
            </Field>
          </div>

          {/* Email Field */}
          <Field label="Email address">
            <div className="input-with-action">
              <input
                type="email"
                value={email}
                autoComplete="email"
                inputMode="email"
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoFocus={mode !== 'signup'}
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
              type="submit"
              className="primary lg"
              pending={busy}
              disabled={!ok}
            >
              {mode === 'signup'
                ? 'Create account'
                : mode === 'magic'
                ? 'Send magic link'
                : 'Sign in'}
            </Busy>
          </div>
        </form>

        {/* Secondary options */}
        <div className="auth-footer">
          {mode === 'magic' ? (
            <button
              type="button"
              className="auth-footer-btn"
              onClick={() => {
                haptic(10);
                setMode('signin');
                setError(null);
                if (location.pathname !== '/login') {
                  navigate('/login', { replace: true });
                }
              }}
            >
              <span className="auth-footer-ico">
                <IconKey width={13} height={13} />
              </span>
              <span>Sign in with password instead</span>
            </button>
          ) : (
            <div className="auth-footer-stack">
              <span className="auth-footer-hint">Can&apos;t remember your password?</span>
              <button
                type="button"
                className="auth-footer-btn"
                onClick={() => {
                  haptic(10);
                  setMode('magic');
                  setError(null);
                }}
              >
                <span className="auth-footer-ico">
                  <IconEmail width={13} height={13} />
                </span>
                <span>Email me a sign-in link</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
