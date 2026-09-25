import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useMutation } from '../hooks/useQuery';
import { useSession } from '../context/SessionContext';
import { ErrorNote, Field, Busy, Notice } from '../components/ui';
import {
  IconPlus, IconArrowLeft, IconKey, IconVault, IconCheck,
} from '../components/icons';
import { haptic } from '../lib/haptics';
import type { InvitePreview } from '../lib/types';

type Mode = 'choose' | 'create' | 'join';

/**
 * Shown when a signed-in person belongs to no group yet, or wants to join/start another.
 */
export default function Onboard({ onDone }: { onDone?: () => void }) {
  const { session, signOut, groups } = useSession();
  const [mode, setMode] = useState<Mode>('choose');

  const inApp = groups.length > 0;
  const back = () => {
    haptic(10);
    setMode('choose');
  };

  return (
    <div className="auth">
      <div className="auth-card">
        {mode === 'choose' && (
          <>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
              <div className="auth-logo" style={{ marginBottom: 0 }}>
                <IconVault width={24} height={24} />
              </div>
              <div>
                <h1 style={{ fontFamily: 'var(--display)', fontSize: '1.45rem', fontWeight: 750, letterSpacing: '-0.02em', margin: 0 }}>
                  {inApp ? 'Another group' : 'SavingsClub'}
                </h1>
                <span className="dim" style={{ fontSize: '0.78rem' }}>
                  {inApp ? 'Expand your community savings' : 'Welcome to group savings'}
                </span>
              </div>
            </div>

            <p className="muted" style={{ marginTop: 4, marginBottom: 20, lineHeight: 1.45, fontSize: '0.88rem' }}>
              {inApp
                ? 'You can belong to as many groups as you like. Each keeps its own money, members, and rules.'
                : <>Signed in as <strong style={{ color: 'var(--text)' }}>{session?.user.email}</strong>. How would you like to get started?</>}
            </p>

            {/* Interactive Choice Cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <button
                type="button"
                className="onboard-card"
                onClick={() => {
                  haptic(10);
                  setMode('create');
                }}
              >
                <div className="onboard-card-ico mint">
                  <IconPlus width={20} height={20} />
                </div>
                <div className="onboard-card-main">
                  <div className="onboard-card-title">Start a new group</div>
                  <div className="onboard-card-sub">
                    You become the admin, configure rules & invite friends
                  </div>
                </div>
              </button>

              <button
                type="button"
                className="onboard-card"
                onClick={() => {
                  haptic(10);
                  setMode('join');
                }}
              >
                <div className="onboard-card-ico violet">
                  <IconKey width={19} height={19} />
                </div>
                <div className="onboard-card-main">
                  <div className="onboard-card-title">Join with an invite code</div>
                  <div className="onboard-card-sub">
                    Enter the code shared by your group organizer
                  </div>
                </div>
              </button>
            </div>

            {/* Bottom action */}
            <div style={{ marginTop: 22, textAlign: 'center' }}>
              {inApp ? (
                <button
                  type="button"
                  className="sec-link"
                  style={{ fontSize: '0.86rem', color: 'var(--text-3)' }}
                  onClick={() => onDone?.()}
                >
                  Cancel and return
                </button>
              ) : (
                <button
                  type="button"
                  className="sec-link"
                  style={{ fontSize: '0.86rem', color: 'var(--text-3)' }}
                  onClick={() => void signOut()}
                >
                  Sign out
                </button>
              )}
            </div>
          </>
        )}

        {mode === 'create' && <CreateGroup onBack={back} onDone={onDone} />}
        {mode === 'join' && <JoinGroup onBack={back} onDone={onDone} />}
      </div>
    </div>
  );
}

function CreateGroup({ onBack, onDone }: { onBack: () => void; onDone?: () => void }) {
  const { refresh } = useSession();
  const [groupName, setGroupName] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');

  const create = useMutation(
    async () => {
      const { data, error } = await supabase.rpc('create_group', {
        p_group_name: groupName.trim(),
        p_full_name: fullName.trim(),
        p_phone: phone.trim() || null,
      });
      if (error) throw error;
      await supabase.auth.refreshSession();
      return data;
    },
    { onSuccess: () => { refresh(); onDone?.(); } },
  );

  const ok = Boolean(groupName.trim() && fullName.trim());

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button
          type="button"
          className="icon-btn"
          onClick={onBack}
          aria-label="Back"
          style={{ width: 36, height: 36 }}
        >
          <IconArrowLeft width={15} height={15} />
        </button>
        <div>
          <h1 style={{ fontFamily: 'var(--display)', fontSize: '1.35rem', fontWeight: 750, margin: 0 }}>
            Start your group
          </h1>
          <span className="dim" style={{ fontSize: '0.78rem' }}>
            You will become the admin
          </span>
        </div>
      </div>

      <ErrorNote error={create.error} />

      <Field label="Group name">
        <input
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
          placeholder="e.g. Friends Savings Club"
          autoFocus
        />
      </Field>

      <Field label="Your full name">
        <input
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="e.g. Aravind Merugu"
        />
      </Field>

      <Field label="Your phone (optional)">
        <input
          inputMode="tel"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+91 98765 43210"
        />
      </Field>

      <div style={{ marginTop: 14 }}>
        <Notice tone="good">
          You will configure monthly contributions, interest rate, and officer roles once created.
        </Notice>
      </div>

      <div className="btn-row stack" style={{ marginTop: 18 }}>
        <Busy
          className="primary lg"
          pending={create.pending}
          disabled={!ok}
          onClick={() => void create.run()}
        >
          Create group
        </Busy>
      </div>
    </>
  );
}

/** Codes are shown as ABCD-EFGH-JKLM; normalises whatever is typed. */
function formatCode(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12);
  return clean.replace(/(.{4})(?=.)/g, '$1-');
}

function JoinGroup({ onBack, onDone }: { onBack: () => void; onDone?: () => void }) {
  const { refresh } = useSession();
  const [code, setCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [preview, setPreview] = useState<InvitePreview | null>(null);

  const check = useMutation(
    async () => {
      const { data, error } = await supabase.rpc('preview_invite', { p_code: code });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as InvitePreview | undefined;
      return row ?? null;
    },
    { onSuccess: (row) => setPreview(row) },
  );

  const join = useMutation(
    async () => {
      const { error } = await supabase.rpc('join_group_with_code', {
        p_code: code,
        p_full_name: fullName.trim(),
      });
      if (error) throw error;
      await supabase.auth.refreshSession();
    },
    { onSuccess: () => { refresh(); onDone?.(); } },
  );

  const ready = code.replace(/-/g, '').length === 12;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button
          type="button"
          className="icon-btn"
          onClick={onBack}
          aria-label="Back"
          style={{ width: 36, height: 36 }}
        >
          <IconArrowLeft width={15} height={15} />
        </button>
        <div>
          <h1 style={{ fontFamily: 'var(--display)', fontSize: '1.35rem', fontWeight: 750, margin: 0 }}>
            Join a group
          </h1>
          <span className="dim" style={{ fontSize: '0.78rem' }}>
            Enter your 12-character invite code
          </span>
        </div>
      </div>

      <ErrorNote error={check.error ?? join.error} />

      <Field label="Invite code">
        <div style={{ position: 'relative' }}>
          <input
            value={code}
            onChange={(e) => {
              setCode(formatCode(e.target.value));
              setPreview(null);
            }}
            placeholder="ABCD-EFGH-JKLM"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            style={{
              fontFamily: 'var(--mono, ui-monospace, monospace)',
              letterSpacing: '0.14em',
              textAlign: 'center',
              fontSize: '1.15rem',
              fontWeight: 700,
              padding: '12px 14px',
            }}
            autoFocus
          />
        </div>
      </Field>

      {/* Invalid invite */}
      {preview && !preview.valid && (
        <div style={{ marginTop: 14 }}>
          <Notice tone="danger">{preview.reason ?? 'That invite code is invalid or expired'}</Notice>
        </div>
      )}

      {/* Valid group preview card */}
      {preview?.valid && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 16 }}>
          <div
            style={{
              background: 'var(--surface-2)',
              border: '1px solid color-mix(in srgb, var(--mint) 30%, var(--hairline))',
              borderRadius: 'var(--r)',
              padding: '14px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span
              className="row-ico mint"
              style={{ width: 42, height: 42, borderRadius: 13 }}
            >
              <IconCheck width={18} height={18} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: '1.02rem' }}>
                {preview.group_name}
              </div>
              <div className="dim" style={{ fontSize: '0.78rem' }}>
                {preview.member_count} member{preview.member_count === 1 ? '' : 's'}
              </div>
            </div>
          </div>

          <Field label="Your full name in this group">
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Nagaraju Sandela"
              autoFocus
            />
          </Field>

          <Notice tone="warn">
            An officer must approve your join request before you can see group transactions.
          </Notice>
        </div>
      )}

      {/* Action Button */}
      <div className="btn-row stack" style={{ marginTop: 18 }}>
        {preview?.valid ? (
          <Busy
            className="primary lg"
            pending={join.pending}
            disabled={!fullName.trim()}
            onClick={() => void join.run()}
          >
            Request to join
          </Busy>
        ) : (
          <Busy
            className="primary lg"
            pending={check.pending}
            disabled={!ready}
            onClick={() => void check.run()}
          >
            Check the code
          </Busy>
        )}
      </div>
    </>
  );
}

/**
 * Shown while a join request is waiting on an officer.
 */
export function AwaitingApproval() {
  const { group, session, signOut, refresh, groups, switchGroup } = useSession();
  const [error, setError] = useState<string | null>(null);
  const others = groups.filter((g) => g.status === 'active');

  async function go(id: string) {
    setError(null);
    try {
      await switchGroup(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not switch group');
    }
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-logo" style={{ background: 'linear-gradient(135deg, var(--amber), #f78c2a)' }}>
          <IconVault width={24} height={24} />
        </div>
        <h1 style={{ fontFamily: 'var(--display)', fontSize: '1.45rem', fontWeight: 750 }}>
          Waiting for approval
        </h1>
        <p className="muted" style={{ marginTop: 8, lineHeight: 1.5 }}>
          You requested to join <strong style={{ color: 'var(--text)' }}>{group?.name}</strong> as{' '}
          <strong style={{ color: 'var(--text)' }}>{session?.user.email}</strong>.
        </p>

        <div style={{ margin: '16px 0' }}>
          <Notice tone="warn">
            An admin, cashier, or accountant must approve your request before ledger access is granted.
          </Notice>
        </div>

        <ErrorNote error={error} />

        <div className="btn-row stack">
          <button type="button" className="primary lg" onClick={() => refresh()}>
            Check approval status
          </button>
          {others.map((g) => (
            <button key={g.id} type="button" className="lg" onClick={() => void go(g.id)}>
              Go to {g.name}
            </button>
          ))}
          <button type="button" className="ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
