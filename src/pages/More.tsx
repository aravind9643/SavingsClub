import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen, useAppTheme, useGroupSwitcher } from '../App';
import { useSession } from '../context/SessionContext';
import { supabase } from '../lib/supabase';
import { useMutation } from '../hooks/useQuery';
import { List, Row, Panel, Sheet, Field, Busy, ErrorNote, initials, Tag } from '../components/ui';
import {
  IconExpenses, IconBank, IconMembers, IconSettings, IconAudit,
  IconSun, IconMoon, IconLogout, IconPlus, IconChevronDown,
} from '../components/icons';

/**
 * The tab bar holds five destinations; everything else lives here. Grouping by
 * what a person is trying to do beats one long undifferentiated list.
 */
export default function More() {
  const nav = useNavigate();
  const { member, role, group, groups, signOut, isOfficer } = useSession();
  const { theme, setTheme } = useAppTheme();
  const openSwitcher = useGroupSwitcher();
  const [editingProfile, setEditingProfile] = useState(false);

  return (
    <Screen title="More">
      <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span
          className="row-ico violet"
          style={{ width: 52, height: 52, borderRadius: 18, fontSize: '1.1rem' }}
        >
          {initials(member?.full_name)}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: 'var(--display)', fontSize: '1.1rem', fontWeight: 600 }}>
            {member?.full_name}
          </div>
          <div className="dim" style={{ marginTop: 2 }}>
            {member?.email ?? (member?.phone ? member.phone : 'Member')}
          </div>
          <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {role === 'member'
              ? <Tag>member</Tag>
              : <Tag tone="mint">{role}</Tag>}
            {openSwitcher && group ? (
              <button
                type="button"
                className="tag violet"
                onClick={openSwitcher}
                title="Switch or manage groups"
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
          onClick={() => setEditingProfile(true)}
          style={{ fontSize: '0.85rem' }}
        >
          Edit
        </button>
      </div>

      <Panel title="Money" flush>
        <List>
          <Row
            icon={<IconExpenses width={18} height={18} />}
            iconTone="amber"
            title="Expenses"
            sub="Trips, parties and admin costs"
            onClick={() => nav('/expenses')}
            chevron
          />
          <Row
            icon={<IconBank width={18} height={18} />}
            iconTone="mint"
            title="Bank & reconciliation"
            sub="Match the books to the statement"
            onClick={() => nav('/bank')}
            chevron
          />
        </List>
      </Panel>

      <Panel title="Group" flush>
        <List>
          <Row
            icon={<IconPlus width={18} height={18} />}
            iconTone="violet"
            title="Switch or create group"
            sub={groups.length > 1 ? `${groups.length} groups · Current: ${group?.name}` : 'Start or join another group'}
            onClick={openSwitcher ?? undefined}
            chevron
          />
          <Row
            icon={<IconMembers width={18} height={18} />}
            iconTone="violet"
            title="Members"
            sub={isOfficer ? 'Add people and assign roles' : 'Who is in the group'}
            onClick={() => nav('/members')}
            chevron
          />
          <Row
            icon={<IconSettings width={18} height={18} />}
            iconTone="violet"
            title="Rules"
            sub="Interest, caps, approvals"
            onClick={() => nav('/settings')}
            chevron
          />
          <Row
            icon={<IconAudit width={18} height={18} />}
            iconTone="coral"
            title="Audit log"
            sub="Every change, and who made it"
            onClick={() => nav('/audit')}
            chevron
          />
        </List>
      </Panel>

      <Panel title="App" flush>
        <List>
          <Row
            icon={theme === 'dark' ? <IconMoon width={18} height={18} /> : <IconSun width={18} height={18} />}
            title="Appearance"
            sub={theme === 'dark' ? 'Dark' : 'Light'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            amount={
              <span className="seg on" style={{ pointerEvents: 'none' }}>
                {theme === 'dark' ? 'Dark' : 'Light'}
              </span>
            }
          />
          <Row
            icon={<IconLogout width={18} height={18} />}
            iconTone="coral"
            title="Sign out"
            onClick={() => void signOut()}
          />
        </List>
      </Panel>

      <p className="dim" style={{ textAlign: 'center', paddingBottom: 8 }}>
        Sanchay · your group's books
      </p>

      {editingProfile && (
        <EditProfileSheet onClose={() => setEditingProfile(false)} />
      )}
    </Screen>
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
      // Goes through update_member() rather than a direct table UPDATE. The
      // direct write only worked because of the narrow column grant on
      // members, so it was one grant change away from breaking, and it
      // skipped the RPC's own ownership check. Writes are RPC-only here.
      const { error } = await supabase.rpc('update_member', {
        p_member_id: member.id,
        p_full_name: null,
        p_email: null,
        p_phone: phone.trim() || null,
        p_nominee_name: nomineeName.trim() || null,
        p_nominee_phone: nomineePhone.trim() || null,
      });
      if (error) throw error;
    },
    {
      invalidates: ['members', 'positions'],
      onSuccess: () => {
        refresh();
        onClose();
      },
    },
  );

  return (
    <Sheet open title="Your details" onClose={onClose}>
      <p className="dim" style={{ marginTop: -4, marginBottom: 14 }}>
        Update your contact and nominee information for {member?.full_name}.
        Leaving a field blank keeps what is already recorded.
      </p>
      <ErrorNote error={save.error} />
      <Field label="Phone number">
        <input
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+91 98765 43210"
        />
      </Field>
      <div className="field-row" style={{ marginTop: 14 }}>
        <Field label="Nominee name" hint="Who receives your fund share in emergency">
          <input
            value={nomineeName}
            onChange={(e) => setNomineeName(e.target.value)}
            placeholder="Spouse / Parent / Sibling"
          />
        </Field>
        <Field label="Nominee phone">
          <input
            type="tel"
            inputMode="tel"
            value={nomineePhone}
            onChange={(e) => setNomineePhone(e.target.value)}
            placeholder="+91 98765 43210"
          />
        </Field>
      </div>
      <div className="btn-row stack" style={{ marginTop: 20 }}>
        <Busy className="primary lg" pending={save.pending} onClick={() => void save.run()}>
          Save details
        </Busy>
      </div>
    </Sheet>
  );
}
