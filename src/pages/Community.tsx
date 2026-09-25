import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { useSession, useIsOfficer } from '../context/SessionContext';
import { supabase } from '../lib/supabase';
import { useQuery, useMutation } from '../hooks/useQuery';
import { haptic } from '../lib/haptics';
import {
  List, Row, Panel, Sheet, Field, Busy, ErrorNote, Notice, initials, roleLabel,
  Segments, fmtDate, SkeletonList,
} from '../components/ui';
import {
  IconSettings, IconAudit, IconShare, IconMeeting,
} from '../components/icons';
import type {
  GroupInvite, PendingMember, Meeting, AttendanceSummary, Attendance, Member, MemberPosition,
} from '../lib/types';
import { today } from '../lib/dates';
import { formatPaise, formatPaiseShort } from '../lib/money';

interface RoleRow {
  id: string; member_id: string; role: string;
  start_date: string; end_date: string | null;
}

export default function Community() {
  const nav = useNavigate();
  const { member, group, currentGroupId } = useSession();
  const isOfficer = useIsOfficer();
  const [meetingSheet, setMeetingSheet] = useState(false);
  const [copied, setCopied] = useState(false);

  // Group roles query
  const rolesQ = useQuery<RoleRow[]>('roles', async () => {
    let q = supabase.from('role_assignments').select('*').is('end_date', null);
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as RoleRow[];
  });

  // Member standings & positions query
  const positionsQ = useQuery<MemberPosition[]>('positions', async () => {
    let q = supabase.from('v_member_positions').select('*').order('full_name');
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as MemberPosition[];
  });

  // Meetings query
  const meetingsQ = useQuery<Meeting[]>('meetings', async () => {
    let q = supabase
      .from('meetings').select('*').order('held_on', { ascending: false });
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Meeting[];
  });

  const latestMeeting = (meetingsQ.data ?? [])[0];

  // Invite query
  const inviteQ = useQuery<GroupInvite | null>('invite:active', async () => {
    let q = supabase
      .from('group_invites').select('*')
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1);
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    return (data as GroupInvite) ?? null;
  });

  // Pending members query
  const pendingQ = useQuery<PendingMember[]>(isOfficer ? 'pending' : null, async () => {
    const { data, error } = await supabase.rpc('pending_members');
    if (error) throw error;
    return (data ?? []) as PendingMember[];
  });

  const pendingMembers = pendingQ.data ?? [];
  const positions = positionsQ.data ?? [];
  const activePositions = positions.filter((p) => p.is_active);

  const byId = useMemo(
    () => new Map(positions.map((p) => [p.member_id, p.full_name])),
    [positions],
  );

  const currentRoles = (rolesQ.data ?? []).filter((r) => r.role !== 'member');
  const cashier = currentRoles.find((r) => r.role === 'cashier');
  const accountant = currentRoles.find((r) => r.role === 'accountant');
  const admin = currentRoles.find((r) => r.role === 'admin');

  const handleShareInvite = () => {
    haptic(10);
    if (!inviteQ.data) return;
    const text = `Join our savings group *${group?.name || 'SavingsClub'}*!\n` +
      `Use invite code: *${inviteQ.data.code}*\n` +
      `Valid for 7 days. Open the app to join.`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  };

  const handleCopyCode = () => {
    haptic(10);
    if (!inviteQ.data) return;
    void navigator.clipboard?.writeText(inviteQ.data.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <Screen
        title="Community"
        sub={group ? `${group.name} · ${activePositions.length} active members` : 'Members & Group'}
      >
        {/* ======================================= 1. GROUP LEADERSHIP */}
        <div
          className="panel"
          style={{
            background: 'linear-gradient(135deg, var(--surface), var(--surface-2))',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--r)',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--display)', fontSize: '1.05rem', fontWeight: 650, color: 'var(--text)' }}>
              Group Leadership
            </span>
            <button
              type="button"
              className="sec-link"
              onClick={() => nav('/members')}
              style={{ fontSize: '0.8rem' }}
            >
              {isOfficer ? 'Manage roles →' : 'View roles →'}
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
            <div style={{ background: 'var(--surface-3)', border: '1px solid var(--hairline-soft)', padding: '10px 6px', borderRadius: 'var(--r-sm)', textAlign: 'center', minWidth: 0 }}>
              <span className="dim" style={{ fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, display: 'block' }}>
                Admin
              </span>
              <span style={{ fontSize: '0.82rem', fontWeight: 650, color: 'var(--text)', display: 'block', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {admin ? byId.get(admin.member_id) ?? 'Assigned' : 'Unassigned'}
              </span>
            </div>

            <div style={{ background: 'var(--surface-3)', border: '1px solid var(--hairline-soft)', padding: '10px 6px', borderRadius: 'var(--r-sm)', textAlign: 'center', minWidth: 0 }}>
              <span className="dim" style={{ fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, display: 'block' }}>
                Cashier
              </span>
              <span style={{ fontSize: '0.82rem', fontWeight: 650, color: 'var(--text)', display: 'block', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {cashier ? byId.get(cashier.member_id) ?? 'Assigned' : 'Unassigned'}
              </span>
            </div>

            <div style={{ background: 'var(--surface-3)', border: '1px solid var(--hairline-soft)', padding: '10px 6px', borderRadius: 'var(--r-sm)', textAlign: 'center', minWidth: 0 }}>
              <span className="dim" style={{ fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, display: 'block' }}>
                Accountant
              </span>
              <span style={{ fontSize: '0.82rem', fontWeight: 650, color: 'var(--text)', display: 'block', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {accountant ? byId.get(accountant.member_id) ?? 'Assigned' : 'Unassigned'}
              </span>
            </div>
          </div>
        </div>

        {/* ======================================= 2. PENDING APPROVALS */}
        {pendingMembers.length > 0 && (
          <div
            className="panel"
            style={{
              background: 'var(--amber-ghost)',
              border: '1px solid var(--amber)',
              borderRadius: 'var(--r)',
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              cursor: 'pointer',
            }}
            onClick={() => nav('/members')}
          >
            <div>
              <strong style={{ color: 'var(--amber)' }}>{pendingMembers.length} member{pendingMembers.length > 1 ? 's' : ''}</strong>
              <span style={{ marginLeft: 6, fontSize: '0.88rem' }}>waiting for approval</span>
            </div>
            <span style={{ color: 'var(--amber)', fontSize: '0.82rem', fontWeight: 600 }}>Review →</span>
          </div>
        )}

        {/* ======================================= 3. ACTIVE INVITE CODE */}
        {inviteQ.data && (
          <div
            className="panel"
            style={{
              background: 'linear-gradient(135deg, var(--surface), var(--surface-2))',
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--r)',
              padding: '14px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="dim" style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>
                Group Invite Code
              </span>
              <span className="dim" style={{ fontSize: '0.78rem' }}>
                7-day access
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <code
                style={{
                  fontSize: 'clamp(1rem, 4.2vw, 1.22rem)',
                  fontFamily: 'var(--mono)',
                  letterSpacing: '0.06em',
                  fontWeight: 700,
                  color: 'var(--text)',
                  whiteSpace: 'nowrap',
                  userSelect: 'all',
                }}
              >
                {inviteQ.data.code}
              </code>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0, marginLeft: 'auto' }}>
                <button
                  type="button"
                  className="sec-link"
                  onClick={handleCopyCode}
                  style={{
                    background: 'var(--surface-3)',
                    border: '1px solid var(--hairline-soft)',
                    padding: '6px 13px',
                    borderRadius: 'var(--r-sm)',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                  }}
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
                <button
                  type="button"
                  className="sec-link"
                  onClick={handleShareInvite}
                  style={{
                    background: 'var(--mint-ghost)',
                    border: '1px solid color-mix(in srgb, var(--mint) 25%, transparent)',
                    color: 'var(--mint)',
                    padding: '6px 13px',
                    borderRadius: 'var(--r-sm)',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <IconShare width={13} height={13} />
                  Share
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ======================================= 4. MEMBERS DIRECTORY */}
        <Panel
          title={`Members (${activePositions.length})`}
          action={
            <button
              type="button"
              className="sec-link"
              onClick={() => nav('/members')}
              style={{ fontSize: '0.8rem', fontWeight: 600 }}
            >
              View all & standing →
            </button>
          }
          flush
        >
          {positionsQ.loading && positions.length === 0 ? (
            <SkeletonList rows={4} />
          ) : (
            <List>
              {positions.slice(0, 6).map((p) => {
                const isMe = p.member_id === member?.id;
                return (
                  <Row
                    key={p.member_id}
                    icon={initials(p.full_name)}
                    iconTone={p.role !== 'member' ? 'mint' : 'violet'}
                    title={
                      <>
                        {p.full_name}
                        {isMe ? ' · you' : ''}
                      </>
                    }
                    sub={
                      p.role !== 'member'
                        ? roleLabel(p.role)
                        : `${Number(p.share_pct).toFixed(0)}% fund share`
                    }
                    amount={formatPaiseShort(p.contributed_paise)}
                    note={p.outstanding_paise > 0 ? `owes ${formatPaiseShort(p.outstanding_paise)}` : undefined}
                    onClick={() => nav('/members')}
                    chevron
                  />
                );
              })}
            </List>
          )}
        </Panel>

        {/* ======================================= 5. GOVERNANCE & MEETINGS */}
        <Panel title="Governance & Meetings" flush>
          <List>
            <Row
              icon={<IconMeeting width={18} height={18} />}
              iconTone="mint"
              title="Monthly Meetings"
              sub={latestMeeting ? `Last held on ${fmtDate(latestMeeting.held_on)}` : 'Attendance, fines & meeting records'}
              onClick={() => {
                haptic(10);
                setMeetingSheet(true);
              }}
              chevron
            />
            <Row
              icon={<IconSettings width={18} height={18} />}
              iconTone="amber"
              title="Group Rules & Settings"
              sub="Monthly deposits, interest rate & loan rules"
              onClick={() => {
                haptic(10);
                nav('/settings');
              }}
              chevron
            />
            <Row
              icon={<IconAudit width={18} height={18} />}
              iconTone="violet"
              title="Activity History"
              sub="Immutable audit log of all group changes"
              onClick={() => {
                haptic(10);
                nav('/audit');
              }}
              chevron
            />
          </List>
        </Panel>
      </Screen>

      {meetingSheet && (
        <MeetingSheet onClose={() => setMeetingSheet(false)} />
      )}
    </>
  );
}

function MeetingSheet({ onClose }: { onClose: () => void }) {
  const { currentGroupId, config } = useSession();
  const isOfficer = useIsOfficer();
  const [tab, setTab] = useState<'record' | 'attendance' | 'history'>(isOfficer ? 'record' : 'attendance');
  const [heldOn, setHeldOn] = useState(today());
  const [note, setNote] = useState('');
  const [attendance, setAttendance] = useState<Record<string, Attendance>>({});

  const membersQ = useQuery<Member[]>('members:active', async () => {
    let q = supabase
      .from('members')
      .select('*')
      .eq('status', 'active')
      .order('full_name');
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Member[];
  });

  const attendanceQ = useQuery<AttendanceSummary[]>('attendance_summary', async () => {
    let q = supabase
      .from('v_member_attendance_summary')
      .select('*')
      .order('full_name');
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as AttendanceSummary[];
  });

  const meetingsQ = useQuery<Meeting[]>('meetings', async () => {
    let q = supabase
      .from('meetings')
      .select('*')
      .order('held_on', { ascending: false });
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Meeting[];
  });

  const members = membersQ.data ?? [];
  const summaries = attendanceQ.data ?? [];
  const meetings = meetingsQ.data ?? [];

  const saveMeeting = useMutation(
    async () => {
      const payload: Record<string, Attendance> = {};
      for (const m of members) {
        payload[m.id] = attendance[m.id] || 'present';
      }
      const { error } = await supabase.rpc('record_meeting', {
        p_held_on: heldOn,
        p_attendance: payload,
        p_note: note.trim() || null,
      });
      if (error) throw error;
    },
    {
      invalidates: ['meetings', 'attendance_summary', 'fund'],
      onSuccess: () => {
        haptic(20);
        setTab('history');
      },
    },
  );

  const absentFee = config?.meeting_absent_fee_paise ?? 0;

  const counts = useMemo(() => {
    let pres = 0;
    let abs = 0;
    let exc = 0;
    for (const m of members) {
      const st = attendance[m.id] || 'present';
      if (st === 'present') pres++;
      else if (st === 'absent') abs++;
      else exc++;
    }
    return { pres, abs, exc };
  }, [members, attendance]);

  return (
    <Sheet open title="Meetings & Attendance" onClose={onClose}>
      <Segments<'record' | 'attendance' | 'history'>
        value={tab}
        onChange={(next) => {
          haptic(10);
          setTab(next);
        }}
        options={[
          ...(isOfficer ? [{ value: 'record' as const, label: 'Attendance' }] : []),
          { value: 'attendance' as const, label: 'Summary' },
          { value: 'history' as const, label: 'History', count: meetings.length > 0 ? meetings.length : undefined },
        ]}
      />

      {tab === 'record' && isOfficer && (
        <div style={{ marginTop: 14 }}>
          <Field label="Meeting date">
            <input
              type="date"
              value={heldOn}
              max={today()}
              onChange={(e) => setHeldOn(e.target.value)}
            />
          </Field>

          <Field label="Meeting notes (optional)">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Monthly collection and loan review"
            />
          </Field>

          <div style={{ marginTop: 12 }}>
            {absentFee > 0 ? (
              <Notice tone="warn">
                Missing without informing has a fine of <strong>{formatPaise(absentFee)}</strong> as per group rules.
              </Notice>
            ) : (
              <Notice>
                Mark who attended today. Members who informed in advance can be marked Excused.
              </Notice>
            )}
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div>
                <span style={{ fontWeight: 650, fontSize: '0.88rem', color: 'var(--text)' }}>
                  Attendance
                </span>
                <span className="dim" style={{ fontSize: '0.78rem', marginLeft: 6 }}>
                  ({members.length})
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span
                  style={{
                    fontSize: '0.74rem',
                    fontWeight: 650,
                    padding: '2px 8px',
                    borderRadius: 'var(--r-full)',
                    background: 'var(--mint-ghost)',
                    color: 'var(--mint)',
                  }}
                >
                  {counts.pres} Present
                </span>
                {counts.abs > 0 && (
                  <span
                    style={{
                      fontSize: '0.74rem',
                      fontWeight: 650,
                      padding: '2px 8px',
                      borderRadius: 'var(--r-full)',
                      background: 'var(--coral-ghost)',
                      color: 'var(--coral)',
                    }}
                  >
                    {counts.abs} Absent
                  </span>
                )}
                {counts.exc > 0 && (
                  <span
                    style={{
                      fontSize: '0.74rem',
                      fontWeight: 650,
                      padding: '2px 8px',
                      borderRadius: 'var(--r-full)',
                      background: 'var(--amber-ghost)',
                      color: 'var(--amber)',
                    }}
                  >
                    {counts.exc} Excused
                  </span>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 'min(340px, 45vh)', overflowY: 'auto', paddingRight: 2 }}>
              {members.map((m) => {
                const cur = attendance[m.id] || 'present';
                return (
                  <div
                    key={m.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '7px 10px',
                      background: 'var(--surface)',
                      borderRadius: 'var(--r-sm)',
                      border: '1px solid var(--hairline)',
                      gap: 6,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, flex: 1, marginRight: 2 }}>
                      <span
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: '50%',
                          background: 'var(--surface-3)',
                          color: 'var(--text)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 650,
                          fontSize: '0.72rem',
                          flex: 'none',
                        }}
                      >
                        {initials(m.full_name)}
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: '0.84rem',
                            color: 'var(--text)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {m.full_name}
                        </div>
                      </div>
                    </div>

                    <div
                      role="group"
                      aria-label={`Attendance for ${m.full_name}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        background: 'var(--surface-2)',
                        padding: 2,
                        borderRadius: 'var(--r-full)',
                        border: '1px solid var(--hairline)',
                        gap: 2,
                        flex: 'none',
                      }}
                    >
                      {(['present', 'absent', 'excused'] as Attendance[]).map((st) => {
                        const isSel = cur === st;
                        let activeBg = 'var(--mint)';
                        let activeColor = '#041c10';
                        let activeShadow = '0 1px 6px rgb(61 220 151 / 28%)';
                        if (st === 'absent') {
                          activeBg = 'var(--coral)';
                          activeColor = '#ffffff';
                          activeShadow = '0 1px 6px rgb(255 92 122 / 28%)';
                        } else if (st === 'excused') {
                          activeBg = 'var(--amber)';
                          activeColor = '#241700';
                          activeShadow = '0 1px 6px rgb(255 182 72 / 28%)';
                        }

                        return (
                          <button
                            key={st}
                            type="button"
                            style={{
                              background: isSel ? activeBg : 'transparent',
                              color: isSel ? activeColor : 'var(--text-2)',
                              border: 0,
                              padding: '4px 8px',
                              borderRadius: 'var(--r-full)',
                              fontSize: '0.72rem',
                              fontWeight: isSel ? 700 : 500,
                              cursor: 'pointer',
                              textTransform: 'capitalize',
                              boxShadow: isSel ? activeShadow : 'none',
                              transition: 'all 0.14s ease',
                              whiteSpace: 'nowrap',
                              lineHeight: 1.2,
                            }}
                            onClick={() => {
                              haptic(5);
                              setAttendance((prev) => ({ ...prev, [m.id]: st }));
                            }}
                          >
                            {st}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <ErrorNote error={saveMeeting.error} />
          <div className="btn-row stack">
            <Busy className="primary lg" pending={saveMeeting.pending} onClick={() => void saveMeeting.run()}>
              Save Attendance
            </Busy>
          </div>
        </div>
      )}

      {tab === 'attendance' && (
        <div style={{ marginTop: 14 }}>
          {summaries.length === 0 ? (
            <div className="dim" style={{ textAlign: 'center', padding: 24 }}>No attendance recorded yet.</div>
          ) : (
            <List>
              {summaries.map((s) => (
                <Row
                  key={s.member_id}
                  title={s.full_name}
                  sub={`${s.present_count} present · ${s.absent_count} absent · ${s.excused_count} excused`}
                  amount={s.fines_paise > 0 ? formatPaise(s.fines_paise) : undefined}
                  amountTone={s.fines_paise > 0 ? 'coral' : undefined}
                  note={s.fines_paise > 0 ? 'Fine due' : 'All clear'}
                />
              ))}
            </List>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div style={{ marginTop: 14 }}>
          {meetings.length === 0 ? (
            <div className="dim" style={{ textAlign: 'center', padding: 24 }}>No meetings recorded yet.</div>
          ) : (
            <List>
              {meetings.map((mt) => (
                <Row
                  key={mt.id}
                  icon={<IconMeeting width={16} height={16} />}
                  iconTone="mint"
                  title={fmtDate(mt.held_on)}
                  sub={mt.note || 'Monthly meeting'}
                  note={mt.absent_fee_paise > 0 ? `Fine: ${formatPaiseShort(mt.absent_fee_paise)}` : undefined}
                />
              ))}
            </List>
          )}
        </div>
      )}
    </Sheet>
  );
}
