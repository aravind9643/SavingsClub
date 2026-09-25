import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen, useAppTheme, useGroupSwitcher } from '../App';
import { useSession, useIsOfficer } from '../context/SessionContext';
import { supabase } from '../lib/supabase';
import { useQuery, useMutation } from '../hooks/useQuery';
import { haptic } from '../lib/haptics';
import {
  List, Row, Panel, Sheet, Field, Busy, ErrorNote, Notice, initials, Tag, roleLabel,
  Segments, fmtDate,
} from '../components/ui';
import {
  IconMembers, IconSettings, IconAudit, IconSun, IconMoon, IconLogout,
  IconPlus, IconChevronDown, IconShare, IconContributions,
} from '../components/icons';
import type {
  GroupInvite, PendingMember, Meeting, AttendanceSummary, Attendance, Member,
} from '../lib/types';
import { today } from '../lib/dates';
import { formatPaise, formatPaiseShort } from '../lib/money';

export default function Community() {
  const nav = useNavigate();
  const { member, role, group, groups, signOut, currentGroupId } = useSession();
  const isOfficer = useIsOfficer();
  const { theme, setTheme } = useAppTheme();
  const openSwitcher = useGroupSwitcher();
  const [editingProfile, setEditingProfile] = useState(false);
  const [meetingSheet, setMeetingSheet] = useState(false);
  const [copied, setCopied] = useState(false);

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

  const handleShareInvite = () => {
    haptic(10);
    if (!inviteQ.data) return;
    const text = `Join our savings group *${group?.name || 'Sanchay'}*!\n` +
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
      <Screen title="Community" sub="Members, rules & governance">
        {/* User Profile Card */}
        <div
          className="panel"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            background: 'var(--surface)',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--r)',
            padding: 16,
          }}
        >
          <span
            className="row-ico violet"
            style={{ width: 50, height: 50, borderRadius: 16, fontSize: '1.15rem' }}
          >
            {initials(member?.full_name)}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontFamily: 'var(--display)', fontSize: '1.12rem', fontWeight: 650 }}>
              {member?.full_name}
            </div>
            <div className="dim" style={{ marginTop: 2, fontSize: '0.85rem' }}>
              {member?.email || member?.phone || 'Member'}
            </div>
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {role === 'member' ? (
                <Tag>Member</Tag>
              ) : (
                <Tag tone="mint">{roleLabel(role)}</Tag>
              )}
              {openSwitcher && group ? (
                <button
                  type="button"
                  className="tag violet"
                  onClick={openSwitcher}
                  title="Switch group"
                  style={{ cursor: 'pointer' }}
                >
                  <span>{group.name}</span>
                  <IconChevronDown width={9} height={9} style={{ opacity: 0.75, flex: 'none' }} />
                </button>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className="sec-link"
            onClick={() => {
              haptic(10);
              setEditingProfile(true);
            }}
            style={{ fontSize: '0.85rem' }}
          >
            Edit
          </button>
        </div>

        {/* Pending Approval Alert */}
        {pendingMembers.length > 0 && (
          <Notice tone="warn" onClick={() => nav('/members')}>
            <strong>{pendingMembers.length} member{pendingMembers.length > 1 ? 's' : ''}</strong> waiting for your approval
          </Notice>
        )}

        {/* Invite Code Quick Banner */}
        {inviteQ.data && (
          <div
            className="panel"
            style={{
              background: 'linear-gradient(135deg, var(--surface), var(--surface-2))',
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--r)',
              padding: 16,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span className="dim" style={{ fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: 0.6 }}>
                Active Invite Code
              </span>
              <span className="dim" style={{ fontSize: '0.8rem' }}>
                7-day access
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <code style={{ fontSize: '1.25rem', fontFamily: 'monospace', letterSpacing: 1.5, fontWeight: 700 }}>
                {inviteQ.data.code}
              </code>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="sec-link"
                  onClick={handleCopyCode}
                  style={{
                    background: 'var(--surface-3)',
                    padding: '6px 12px',
                    borderRadius: 'var(--r-sm)',
                    fontSize: '0.82rem',
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
                    color: 'var(--mint)',
                    padding: '6px 12px',
                    borderRadius: 'var(--r-sm)',
                    fontSize: '0.82rem',
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

        {/* Community Destinations */}
        <Panel title="Group Management" flush>
          <List>
            <Row
              icon={<IconMembers width={18} height={18} />}
              iconTone="violet"
              title="Members & Roles"
              sub="Roster, officer roles & savings shares"
              onClick={() => {
                haptic(10);
                nav('/members');
              }}
              chevron
              note={pendingMembers.length > 0 ? `${pendingMembers.length} pending` : undefined}
            />
            <Row
              icon={<IconContributions width={18} height={18} />}
              iconTone="mint"
              title="Monthly Meetings"
              sub={latestMeeting ? `Last held on ${fmtDate(latestMeeting.held_on)}` : 'Log meetings & track attendance'}
              onClick={() => {
                haptic(10);
                setMeetingSheet(true);
              }}
              chevron
              note={latestMeeting ? fmtDate(latestMeeting.held_on) : undefined}
            />
            <Row
              icon={<IconSettings width={18} height={18} />}
              iconTone="amber"
              title="Group Rules & Constitution"
              sub="Monthly chanda, interest rate, reserve cap"
              onClick={() => {
                haptic(10);
                nav('/settings');
              }}
              chevron
            />
            <Row
              icon={<IconAudit width={18} height={18} />}
              iconTone="mint"
              title="Audit Ledger"
              sub="Immutable history of every change made"
              onClick={() => {
                haptic(10);
                nav('/audit');
              }}
              chevron
            />
            <Row
              icon={<IconPlus width={18} height={18} />}
              iconTone="violet"
              title="Switch or Start a Group"
              sub={groups.length > 1 ? `${groups.length} groups · Current: ${group?.name}` : 'Start or join another group'}
              onClick={openSwitcher ?? undefined}
              chevron
            />
          </List>
        </Panel>

        {/* Preferences & System */}
        <Panel title="Preferences" flush>
          <List>
            <Row
              icon={theme === 'dark' ? <IconMoon width={18} height={18} /> : <IconSun width={18} height={18} />}
              title="Appearance"
              sub={theme === 'dark' ? 'Dark theme active' : 'Light theme active'}
              onClick={() => {
                haptic(10);
                setTheme(theme === 'dark' ? 'light' : 'dark');
              }}
              note={theme === 'dark' ? 'Dark' : 'Light'}
            />
            <Row
              icon={<IconLogout width={18} height={18} />}
              iconTone="coral"
              title="Sign out"
              sub={member?.email || 'Leave this session'}
              onClick={() => {
                haptic(10);
                void signOut();
              }}
            />
          </List>
        </Panel>
      </Screen>

      {editingProfile && (
        <EditProfileSheet onClose={() => setEditingProfile(false)} />
      )}
      {meetingSheet && (
        <MeetingSheet onClose={() => setMeetingSheet(false)} />
      )}
    </>
  );
}

function EditProfileSheet({ onClose }: { onClose: () => void }) {
  const { member, refresh } = useSession();
  const [phone, setPhone] = useState(member?.phone ?? '');
  const [nomineeName, setNomineeName] = useState(member?.nominee_name ?? '');
  const [nomineePhone, setNomineePhone] = useState(member?.nominee_phone ?? '');

  const save = useMutation(
    async () => {
      if (!member) return;
      const { error } = await supabase
        .from('members')
        .update({
          phone: phone.trim() || null,
          nominee_name: nomineeName.trim() || null,
          nominee_phone: nomineePhone.trim() || null,
        })
        .eq('id', member.id);
      if (error) throw error;
    },
    {
      invalidates: ['members', 'session'],
      onSuccess: () => {
        refresh();
        onClose();
      },
    },
  );

  return (
    <Sheet open title="Edit profile" onClose={onClose}>
      <Field label="Phone number">
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+91 98765 43210"
        />
      </Field>
      <Field label="Nominee name">
        <input
          value={nomineeName}
          onChange={(e) => setNomineeName(e.target.value)}
          placeholder="Contact if you cannot be reached"
        />
      </Field>
      <Field label="Nominee phone">
        <input
          type="tel"
          value={nomineePhone}
          onChange={(e) => setNomineePhone(e.target.value)}
          placeholder="+91 98765 43210"
        />
      </Field>
      <ErrorNote error={save.error} />
      <div className="btn-row stack">
        <Busy className="primary lg" pending={save.pending} onClick={() => void save.run()}>
          Save profile
        </Busy>
      </div>
    </Sheet>
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

  return (
    <Sheet open title="Group Meetings & Attendance" onClose={onClose}>
      <Segments<'record' | 'attendance' | 'history'>
        value={tab}
        onChange={(next) => {
          haptic(10);
          setTab(next);
        }}
        options={[
          ...(isOfficer ? [{ value: 'record' as const, label: 'Log Meeting' }] : []),
          { value: 'attendance' as const, label: 'Member Roster' },
          { value: 'history' as const, label: 'History', count: meetings.length > 0 ? meetings.length : undefined },
        ]}
      />

      {tab === 'record' && isOfficer && (
        <div style={{ marginTop: 14 }}>
          <div className="field-row">
            <Field label="Meeting Date">
              <input
                type="date"
                value={heldOn}
                max={today()}
                onChange={(e) => setHeldOn(e.target.value)}
              />
            </Field>
          </div>

          <Field label="Meeting Agenda / Note (optional)">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Monthly chanda collection & loan review"
            />
          </Field>

          {absentFee > 0 ? (
            <Notice tone="warn">
              Unexcused absence incurs a fine of <strong>{formatPaise(absentFee)}</strong> as set in group rules.
            </Notice>
          ) : (
            <Notice>
              Take attendance for all active members. Excused members do not incur absence marks.
            </Notice>
          )}

          <div style={{ marginBlock: 14 }}>
            <div style={{ fontWeight: 650, fontSize: '0.88rem', marginBottom: 10 }} className="dim">
              Mark Attendance ({members.length} members):
            </div>
            <div style={{ maxHeight: 280, overflowY: 'auto', paddingRight: 4 }}>
              {members.map((m) => {
                const cur = attendance[m.id] || 'present';
                return (
                  <div
                    key={m.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 0',
                      borderBottom: '1px solid var(--hairline)',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '0.92rem' }}>{m.full_name}</div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {(['present', 'absent', 'excused'] as Attendance[]).map((st) => {
                        const isSel = cur === st;
                        const color = st === 'present' ? 'var(--mint)' : st === 'absent' ? 'var(--coral)' : 'var(--amber)';
                        const bg = isSel
                          ? (st === 'present' ? 'var(--mint-ghost)' : st === 'absent' ? 'var(--coral-ghost)' : 'var(--amber-ghost)')
                          : 'var(--surface-2)';
                        return (
                          <button
                            key={st}
                            type="button"
                            style={{
                              background: bg,
                              color: isSel ? color : 'var(--text-3)',
                              border: `1px solid ${isSel ? color : 'var(--hairline)'}`,
                              padding: '5px 10px',
                              borderRadius: 'var(--r-sm)',
                              fontSize: '0.78rem',
                              fontWeight: isSel ? 700 : 500,
                              cursor: 'pointer',
                              textTransform: 'capitalize',
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
          <div className="btn-row stack" style={{ marginTop: 14 }}>
            <Busy className="primary lg" pending={saveMeeting.pending} onClick={() => void saveMeeting.run()}>
              Save Meeting Record
            </Busy>
          </div>
        </div>
      )}

      {tab === 'attendance' && (
        <div style={{ marginTop: 14 }}>
          {summaries.length === 0 ? (
            <div className="dim" style={{ textAlign: 'center', padding: 24 }}>No attendance records found.</div>
          ) : (
            <List>
              {summaries.map((s) => (
                <Row
                  key={s.member_id}
                  title={s.full_name}
                  sub={`${s.present_count} present · ${s.absent_count} absent · ${s.excused_count} excused`}
                  amount={s.fines_paise > 0 ? formatPaise(s.fines_paise) : undefined}
                  amountTone={s.fines_paise > 0 ? 'coral' : undefined}
                  note={s.fines_paise > 0 ? 'Fines' : 'Good'}
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
                  icon={<IconContributions width={16} height={16} />}
                  iconTone="mint"
                  title={fmtDate(mt.held_on)}
                  sub={mt.note || 'Regular group meeting'}
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
