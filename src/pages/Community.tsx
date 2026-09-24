import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen, useAppTheme, useGroupSwitcher } from '../App';
import { useSession, useIsOfficer } from '../context/SessionContext';
import { supabase } from '../lib/supabase';
import { useQuery, useMutation } from '../hooks/useQuery';
import { haptic } from '../lib/haptics';
import {
  List, Row, Panel, Sheet, Field, Busy, ErrorNote, Notice, initials, Tag, roleLabel,
} from '../components/ui';
import {
  IconMembers, IconSettings, IconAudit, IconSun, IconMoon, IconLogout,
  IconPlus, IconChevronDown, IconShare,
} from '../components/icons';
import type { GroupInvite, PendingMember } from '../lib/types';

export default function Community() {
  const nav = useNavigate();
  const { member, role, group, groups, signOut, currentGroupId } = useSession();
  const isOfficer = useIsOfficer();
  const { theme, setTheme } = useAppTheme();
  const openSwitcher = useGroupSwitcher();
  const [editingProfile, setEditingProfile] = useState(false);
  const [copied, setCopied] = useState(false);

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
