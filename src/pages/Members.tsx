import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery, useMutation } from '../hooks/useQuery';
import { useSession } from '../context/SessionContext';
import { formatPaise, formatPaiseShort } from '../lib/money';
import {
  Panel, List, Row, Sheet, Field, Busy, ErrorNote, Notice,
  SkeletonList, initials, roleLabel, Stat, Tag, fmtDate,
} from '../components/ui';
import { IconPlus } from '../components/icons';
import type { MemberPosition, Member, Role, PendingMember } from '../lib/types';
import { today } from '../lib/dates';

interface RoleRow {
  id: string; member_id: string; role: string;
  start_date: string; end_date: string | null;
}

// The three jobs. The names stay as they are -- these are the titles the group
// uses out loud and the ones written into the signed agreement, so inventing
// plainer words here would only make the app disagree with the paperwork.
// What each one DOES is said plainly instead.
const OFFICES: { role: Role; label: string; note: string }[] = [
  { role: 'cashier', label: 'Cashier', note: 'Takes money in and holds the cash' },
  { role: 'accountant', label: 'Accountant', note: 'Keeps the records and checks the bank' },
  { role: 'admin', label: 'Admin', note: 'Settles disagreements, does not handle money' },
];

export default function Members() {
  const nav = useNavigate();
  const { member: me, isOfficer, currentGroupId } = useSession();
  const [sheet, setSheet] = useState<'add' | 'roles' | null>(null);
  const [inspectId, setInspectId] = useState<string | null>(null);

  const positions = useQuery<MemberPosition[]>('positions', async () => {
    let q = supabase
      .from('v_member_positions').select('*').order('full_name');
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as MemberPosition[];
  });

  const membersQ = useQuery<Member[]>('members', async () => {
    let q = supabase.from('members').select('*').order('full_name');
    if (currentGroupId) {
      q = q.eq('group_id', currentGroupId);
    }
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Member[];
  });

  const rolesQ = useQuery<RoleRow[]>('roles', async () => {
    let q = supabase
      .from('role_assignments').select('*').is('end_date', null);
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as RoleRow[];
  });

  // Only officers may call this; for everyone else it returns nothing, so the
  // panel below simply does not render rather than needing its own guard.
  const pendingQ = useQuery<PendingMember[]>(isOfficer ? 'pending' : null, async () => {
    const { data, error } = await supabase.rpc('pending_members');
    if (error) throw error;
    return (data ?? []) as PendingMember[];
  });

  const byId = new Map((membersQ.data ?? []).map((m) => [m.id, m]));
  const inspectPosition = (positions.data ?? []).find((p) => p.member_id === inspectId);
  const current = (rolesQ.data ?? []).filter((r) => r.role !== 'member');
  const cashier = current.find((r) => r.role === 'cashier');
  const accountant = current.find((r) => r.role === 'accountant');
  const clash = Boolean(cashier && accountant && cashier.member_id === accountant.member_id);
  const missing = !cashier || !accountant;
  const unlinked = (membersQ.data ?? []).filter((m) => m.is_active && !m.auth_user_id);

  return (
    <>
      <Screen
        title="Members"
        sub={`${(positions.data ?? []).filter((p) => p.is_active).length} active`}
      >
        {clash && (
          <Notice tone="danger">
            One person is both cashier and accountant. Give one job to someone else.
          </Notice>
        )}
        {missing && !clash && (
          <Notice tone="danger">
            No cashier or accountant yet — no money can be recorded until both are picked.
          </Notice>
        )}
        {unlinked.length > 0 && (
          <Notice tone="warn" onClick={() => nav('/settings')}>
            {unlinked.length} member{unlinked.length > 1 ? 's have' : ' has'} not signed in
            yet. Share an invite code from Rules so they can join.
          </Notice>
        )}

        {isOfficer && (pendingQ.data?.length ?? 0) > 0 && (
          <PendingPanel rows={pendingQ.data ?? []} />
        )}

        {isOfficer && (
          <Panel title="Who does what" flush>
            <List>
              {OFFICES.map((o) => {
                const holder = current.find((r) => r.role === o.role);
                return (
                  <Row
                    key={o.role}
                    icon={initials(holder ? byId.get(holder.member_id)?.full_name : '?')}
                    iconTone={holder ? 'mint' : 'coral'}
                    title={o.label}
                    sub={o.note}
                    note={holder ? byId.get(holder.member_id)?.full_name : 'nobody'}
                    onClick={() => setSheet('roles')}
                    chevron
                  />
                );
              })}
            </List>
          </Panel>
        )}

        <Panel title="Everyone" flush>
          {positions.loading && !positions.data ? (
            <SkeletonList rows={5} />
          ) : (
            <List>
              {(positions.data ?? []).map((p) => {
                const m = byId.get(p.member_id);
                return (
                  <Row
                    key={p.member_id}
                    icon={initials(p.full_name)}
                    iconTone={p.cap_breached ? 'coral' : p.role !== 'member' ? 'mint' : 'violet'}
                    title={
                      <>
                        {p.full_name}
                        {p.member_id === me?.id ? ' · you' : ''}
                        {!p.is_active ? ' · left' : ''}
                      </>
                    }
                    sub={
                      m?.is_active && !m?.auth_user_id
                        ? `${m.email ?? 'no email'} · not signed in`
                        : p.role !== 'member'
                          ? roleLabel(p.role)
                          : `${Number(p.share_pct).toFixed(0)}% of the fund`
                    }
                    amount={formatPaiseShort(p.contributed_paise)}
                    note={
                      p.outstanding_paise > 0
                        ? `owes ${formatPaiseShort(p.outstanding_paise)}`
                        : m?.nominee_name ? undefined : 'no family contact'
                    }
                    onClick={() => setInspectId(p.member_id)}
                    chevron
                  />
                );
              })}
            </List>
          )}
        </Panel>
      </Screen>

      {isOfficer && (
        <button className="fab" onClick={() => setSheet('add')}>
          <IconPlus width={18} height={18} />
          Member
        </button>
      )}

      {sheet === 'add' && <AddSheet onClose={() => setSheet(null)} />}
      {sheet === 'roles' && (
        <RolesSheet
          members={(membersQ.data ?? []).filter((m) => m.is_active)}
          current={current}
          onClose={() => setSheet(null)}
        />
      )}
      {inspectPosition && (
        <MemberDetailSheet
          position={inspectPosition}
          member={byId.get(inspectPosition.member_id)}
          isOfficer={isOfficer}
          onClose={() => setInspectId(null)}
        />
      )}
    </>
  );
}

/**
 * People who joined with an invite code and are waiting to be let in.
 *
 * Approving is what makes the group's money visible to someone, and a code may
 * well have been forwarded to people it was never meant for -- so each decision
 * is an explicit confirm against a named person, not a tap in a list.
 */
function PendingPanel({ rows }: { rows: PendingMember[] }) {
  const [confirming, setConfirming] = useState<PendingMember | null>(null);

  return (
    <>
      <Panel title={`Requests to join · ${rows.length}`} flush>
        <List>
          {rows.map((p) => (
            <Row
              key={p.id}
              icon={initials(p.full_name)}
              iconTone="amber"
              title={p.full_name}
              sub={p.email ?? 'no email'}
              note="review"
              onClick={() => setConfirming(p)}
              chevron
            />
          ))}
        </List>
      </Panel>

      {confirming && (
        <ReviewJoinSheet row={confirming} onClose={() => setConfirming(null)} />
      )}
    </>
  );
}

function ReviewJoinSheet({
  row, onClose,
}: { row: PendingMember; onClose: () => void }) {
  const decide = useMutation(
    async (approve: boolean) => {
      const { error } = await supabase.rpc(
        approve ? 'approve_pending_member' : 'reject_pending_member',
        { p_member_id: row.id },
      );
      if (error) throw error;
    },
    {
      invalidates: ['pending', 'members', 'positions', 'fund', 'roles'],
      onSuccess: onClose,
    },
  );

  return (
    <Sheet open title="Wants to join" onClose={onClose}>
      <ErrorNote error={decide.error} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
        <span
          className="row-ico amber"
          style={{ width: 48, height: 48, borderRadius: 16, fontSize: '1rem' }}
        >
          {initials(row.full_name)}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--display)', fontSize: '1.05rem', fontWeight: 600 }}>
            {row.full_name}
          </div>
          <div className="dim" style={{ marginTop: 2 }}>{row.email ?? 'no email'}</div>
        </div>
      </div>

      <Notice tone="warn">
        Once you let them in they can see every payment, loan and expense in the
        group. Only let in someone you know — codes get forwarded around.
      </Notice>

      <div className="btn-row stack">
        <Busy
          className="primary lg"
          pending={decide.pending}
          onClick={() => void decide.run(true)}
        >
          Approve {row.full_name.split(' ')[0]}
        </Busy>
        <Busy
          className="lg danger"
          pending={decide.pending}
          onClick={() => void decide.run(false)}
        >
          Reject
        </Busy>
      </div>
    </Sheet>
  );
}

function AddSheet({ onClose }: { onClose: () => void }) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [nominee, setNominee] = useState('');

  const add = useMutation(
    async () => {
      const { error } = await supabase.rpc('add_member', {
        p_full_name: fullName,
        p_email: email || null,
        p_phone: phone || null,
        p_nominee_name: nominee || null,
        p_nominee_phone: null,
      });
      if (error) throw error;
    },
    { invalidates: ['members', 'positions', 'fund'], onSuccess: onClose },
  );

  return (
    <Sheet open title="Add someone" onClose={onClose}>
      <ErrorNote error={add.error} />
      <Field label="Full name">
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus />
      </Field>
      <Field label="Email" hint="If they join with this same email, their name links up automatically">
        <input
          type="email" inputMode="email" value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="friend@example.com"
        />
      </Field>
      <div className="field-row" style={{ marginTop: 14 }}>
        <Field label="Phone">
          <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Family contact">
          <input value={nominee} onChange={(e) => setNominee(e.target.value)} />
        </Field>
      </div>
      <div className="btn-row stack">
        <Busy className="primary lg" pending={add.pending} disabled={!fullName.trim()}
          onClick={() => void add.run()}>
          Add member
        </Busy>
      </div>
    </Sheet>
  );
}

function RolesSheet({
  members, current, onClose,
}: { members: Member[]; current: RoleRow[]; onClose: () => void }) {
  const distinctMembers = useMemo<Member[]>(() => {
    const seen = new Set<string>();
    return members.filter((m: Member) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }, [members]);

  const assign = useMutation(
    async ({ memberId, role }: { memberId: string; role: Role }) => {
      if (memberId) {
        const { error } = await supabase.rpc('assign_role', {
          p_member_id: memberId, p_role: role,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.rpc('release_role', { p_role: role });
        if (error) throw error;
      }
    },
    { invalidates: ['roles', 'members', 'positions', 'fund'] },
  );

  return (
    <Sheet open title="Who does what" onClose={onClose}>
      <p className="dim" style={{ marginTop: -4, marginBottom: 14 }}>
        Change these every year. The cashier and the accountant must be two different people.
      </p>
      <ErrorNote error={assign.error} />
      {OFFICES.map((o) => (
        <Field key={o.role} label={o.label} hint={o.note}>
          <select
            value={current.find((r) => r.role === o.role)?.member_id ?? ''}
            disabled={assign.pending}
            onChange={(e) => void assign.run({ memberId: e.target.value, role: o.role })}
          >
            {o.role !== 'admin' && <option value="">Nobody</option>}
            {distinctMembers.map((m) => (
              <option key={m.id} value={m.id}>{m.full_name}</option>
            ))}
          </select>
        </Field>
      ))}
      <div className="btn-row stack">
        <button className="primary lg" onClick={onClose}>Done</button>
      </div>
    </Sheet>
  );
}

function MemberDetailSheet({
  position, member, isOfficer, onClose,
}: {
  position: MemberPosition;
  member?: Member;
  isOfficer: boolean;
  onClose: () => void;
}) {
  const [confirmExit, setConfirmExit] = useState(false);

  const remove = useMutation(
    async () => {
      const { error } = await supabase.rpc('remove_member', {
        p_member_id: position.member_id,
        p_left_on: today(),
      });
      if (error) throw error;
    },
    {
      invalidates: ['members', 'positions', 'fund'],
      onSuccess: onClose,
    },
  );

  const payout = useMutation(
    async () => {
      // Amount left null: the server works out the share itself, from the
      // same function the screen read. Sending the displayed figure back
      // would let a stale screen decide what the group pays out.
      const { error } = await supabase.rpc('pay_out_member', {
        p_member_id: position.member_id,
        p_kind: 'exit',
        p_paid_on: today(),
      });
      if (error) throw error;
    },
    { invalidates: ['members', 'positions', 'fund', 'cash'] },
  );

  const hasDebt = position.outstanding_paise > 0;
  const isAdmin = position.role === 'admin';
  // A rupee of slack, matching the server's own tolerance for the rounding
  // remainder -- otherwise a fully paid member is blocked by a stray paise.
  const owedShare = position.share_paise > 100;

  return (
    <Sheet open title={position.full_name} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <span
          className="row-ico violet"
          style={{ width: 48, height: 48, borderRadius: 16, fontSize: '1.1rem' }}
        >
          {initials(position.full_name)}
        </span>
        <div>
          <div style={{ fontWeight: 600, fontSize: '1.05rem' }}>{position.full_name}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <Tag tone={position.role !== 'member' ? 'mint' : undefined}>{roleLabel(position.role)}</Tag>
            {!position.is_active && <Tag tone="coral">Left</Tag>}
          </div>
        </div>
      </div>

      <ErrorNote error={remove.error ?? payout.error} />

      <div className="stats three" style={{ marginBottom: 16 }}>
        <Stat k="Paid in" v={formatPaiseShort(position.contributed_paise)} />
        <Stat
          k="Still owes"
          v={formatPaiseShort(position.outstanding_paise)}
          tone={hasDebt ? 'coral' : undefined}
        />
        {/* What they would actually get if they left today -- the figure that
            matters at the moment someone asks. The percentage alone never
            answered the only question anyone asks here. */}
        <Stat k="Would get back" v={formatPaiseShort(position.share_paise)} />
      </div>

      {position.paid_out_paise > 0 && (
        <Notice>
          Already paid back: {formatPaise(position.paid_out_paise)}
        </Notice>
      )}

      <Panel title="Contact details" flush>
        <List>
          {member?.phone && (
            <Row
              title="Phone"
              note={member.phone}
              onClick={() => { window.location.href = `tel:${member.phone}`; }}
            />
          )}
          {member?.email && (
            <Row
              title="Email"
              note={member.email}
              onClick={() => { window.location.href = `mailto:${member.email}`; }}
            />
          )}
          {member?.joined_on && (
            <Row title="Joined" note={fmtDate(member.joined_on)} />
          )}
          <Row
            title="Family contact"
            sub={member?.nominee_phone ? `Phone: ${member.nominee_phone}` : undefined}
            note={member?.nominee_name ?? 'None registered'}
          />
        </List>
      </Panel>

      {isOfficer && position.is_active && (
        <div style={{ marginTop: 20 }}>
          {isAdmin ? (
            <Notice tone="warn">
              Make someone else the admin first, then remove them.
            </Notice>
          ) : hasDebt ? (
            <Notice tone="warn">
              This member still owes {formatPaise(position.outstanding_paise)}.
              The loan must be settled before they can leave.
            </Notice>
          ) : owedShare ? (
            /* The money has to go back before the person is marked gone.
               Leaving first would absorb their savings into the fund and
               quietly enlarge everyone else's share. */
            <div className="btn-row stack">
              <Notice tone="warn">
                {position.full_name} is owed {formatPaise(position.share_paise)} —
                their savings plus their share of what the group earned.
                Pay this back before marking them as left.
              </Notice>
              <Busy
                className="primary lg"
                pending={payout.pending}
                onClick={() => void payout.run()}
              >
                Pay back {formatPaise(position.share_paise)}
              </Busy>
            </div>
          ) : confirmExit ? (
            <div className="btn-row stack">
              <Notice tone="danger">
                Mark {position.full_name} as left? They have been paid back in
                full. Their record stays in the books.
              </Notice>
              <Busy className="danger lg" pending={remove.pending} onClick={() => void remove.run()}>
                Yes, mark as left
              </Busy>
              <button type="button" onClick={() => setConfirmExit(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="btn-row stack">
              <button
                type="button"
                className="subtle"
                style={{ color: 'var(--coral)', width: '100%' }}
                onClick={() => setConfirmExit(true)}
              >
                Mark as left
              </button>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
