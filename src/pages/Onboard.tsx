import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useMutation } from '../hooks/useQuery';
import { useSession } from '../context/SessionContext';
import { ErrorNote, Field, Busy, Notice } from '../components/ui';
import type { InvitePreview } from '../lib/types';

type Mode = 'choose' | 'create' | 'join';

/**
 * Shown when a signed-in person belongs to no group yet. Two ways in: start one,
 * or join an existing one with the code an officer gave them.
 */
export default function Onboard({ onDone }: { onDone?: () => void }) {
  const { session, signOut, groups } = useSession();
  const [mode, setMode] = useState<Mode>('choose');

  // Reached from inside the app there is somewhere to go back to; reached
  // because this login has no group at all, the only way out is signing out.
  const inApp = groups.length > 0;
  const back = () => setMode('choose');

  return (
    <div className="auth">
      <div className="auth-card">
        {mode === 'choose' && (
          <>
            <div className="auth-logo">✦</div>
            <h1>{inApp ? 'Another group' : 'Sanchay'}</h1>
            <p className="muted" style={{ marginTop: 8, marginBottom: 22 }}>
              {inApp
                ? 'You can belong to as many groups as you like. Each keeps its own money, members and rules.'
                : <>You are signed in as <strong>{session?.user.email}</strong>. Start a
                    group of your own, or join one you have been given a code for.</>}
            </p>

            <div className="btn-row stack">
              <button className="primary lg" onClick={() => setMode('create')}>
                Start a new group
              </button>
              <button className="lg" onClick={() => setMode('join')}>
                Join with a code
              </button>
              {inApp ? (
                <button className="ghost" onClick={() => onDone?.()}>Cancel</button>
              ) : (
                <button className="ghost" onClick={() => void signOut()}>Sign out</button>
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
        p_group_name: groupName,
        p_full_name: fullName,
        p_phone: phone || null,
      });
      if (error) throw error;
      // The new group is now this login's active one server-side; pick up the
      // claim before any query runs against it.
      await supabase.auth.refreshSession();
      return data;
    },
    { onSuccess: () => { refresh(); onDone?.(); } },
  );

  return (
    <>
      <h1>Start your group</h1>
      <p className="muted" style={{ marginTop: 8, marginBottom: 20 }}>
        You become the admin, which lets you invite everyone else and set the
        rules.
      </p>

      <ErrorNote error={create.error} />

      <Field label="Group name">
        <input
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
          placeholder="Friends Savings Group"
          autoFocus
        />
      </Field>

      <Field label="Your name">
        <input
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="Your full name"
        />
      </Field>

      <Field label="Your phone (optional)">
        <input
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+91 …"
        />
      </Field>

      <div style={{ marginTop: 16 }}>
        <Notice tone="warn">
          Give the cashier and accountant roles to two different people once
          everyone has joined — money cannot be recorded until you do.
        </Notice>
      </div>

      <div className="btn-row stack">
        <Busy
          className="primary lg"
          pending={create.pending}
          disabled={!groupName.trim() || !fullName.trim()}
          onClick={() => void create.run()}
        >
          Create the group
        </Busy>
        <button className="ghost" onClick={onBack}>Back</button>
      </div>
    </>
  );
}

/** Codes are shown as ABCD-EFGH-JKLM; the server normalises whatever is typed. */
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
        p_full_name: fullName,
      });
      if (error) throw error;
      await supabase.auth.refreshSession();
    },
    { onSuccess: () => { refresh(); onDone?.(); } },
  );

  const ready = code.replace(/-/g, '').length === 12;

  return (
    <>
      <h1>Join a group</h1>
      <p className="muted" style={{ marginTop: 8, marginBottom: 20 }}>
        Enter the code someone from the group gave you.
      </p>

      <ErrorNote error={check.error ?? join.error} />

      <Field label="Invite code">
        <input
          value={code}
          onChange={(e) => { setCode(formatCode(e.target.value)); setPreview(null); }}
          placeholder="ABCD-EFGH-JKLM"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          style={{
            fontFamily: 'var(--mono, ui-monospace, monospace)',
            letterSpacing: '0.12em',
            textAlign: 'center',
            fontSize: '1.05rem',
          }}
          autoFocus
        />
      </Field>

      {preview && !preview.valid && (
        <div style={{ marginTop: 14 }}>
          <Notice tone="danger">{preview.reason ?? 'That code cannot be used'}</Notice>
        </div>
      )}

      {preview?.valid && (
        <>
          <div style={{ marginTop: 14 }}>
            <Notice tone="good">
              <strong>{preview.group_name}</strong> · {preview.member_count} member
              {preview.member_count === 1 ? '' : 's'}
            </Notice>
          </div>

          <Field label="Your name">
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Your full name"
              autoFocus
            />
          </Field>

          <div style={{ marginTop: 14 }}>
            <Notice tone="warn">
              Someone from the group has to let you in before you can see the money.
            </Notice>
          </div>
        </>
      )}

      <div className="btn-row stack">
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
        <button className="ghost" onClick={onBack}>Back</button>
      </div>
    </>
  );
}

/**
 * Shown while a join request is waiting on an officer.
 *
 * Joining a second group makes it the active one, so someone who already had a
 * working group lands here and would otherwise be cut off from it. Every group
 * they can actually use is listed, not just the first.
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
        <div className="auth-logo">⏳</div>
        <h1>Waiting for approval</h1>
        <p className="muted" style={{ marginTop: 10 }}>
          You asked to join <strong>{group?.name}</strong> as{' '}
          <strong>{session?.user.email}</strong>. The cashier, accountant or
          admin will let you in. You will see the money once they do.
        </p>

        <ErrorNote error={error} />

        <div className="btn-row stack">
          <button className="primary lg" onClick={() => refresh()}>Check again</button>
          {others.map((g) => (
            <button key={g.id} className="lg" onClick={() => void go(g.id)}>
              Go to {g.name}
            </button>
          ))}
          <button className="ghost" onClick={() => void signOut()}>Sign out</button>
        </div>
      </div>
    </div>
  );
}
