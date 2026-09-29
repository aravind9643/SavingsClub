import { useEffect, useState } from 'react';
import { useT, useLang } from '../lib/i18n';
import { pushState, enablePush, disablePush, syncPushLanguage, type PushState } from '../lib/push';
import { useSession } from '../context/SessionContext';
import { useAppTheme, useGroupSwitcher } from '../App';
import { supabase } from '../lib/supabase';
import { useMutation } from '../hooks/useQuery';
import {
  Sheet, List, Row, Field, Busy, ErrorNote, initials, Tag, roleLabel,
} from './ui';
import {
  IconSun, IconMoon, IconLogout, IconUserEdit, IconSwitch, IconBell,
} from './icons';
import { haptic } from '../lib/haptics';

export default function ProfileSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { member, role, group, groups, signOut, refresh } = useSession();
  const openSwitcher = useGroupSwitcher();
  const { theme, setTheme } = useAppTheme();

  const t = useT();
  const [lang, setLang] = useLang();
  const [pushSt, setPushSt] = useState<PushState>('unconfigured');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  useEffect(() => {
    if (open) void pushState().then(setPushSt).catch(() => setPushSt('unsupported'));
  }, [open]);

  const [editing, setEditing] = useState(false);
  const [fullName, setFullName] = useState(member?.full_name ?? '');
  const [phone, setPhone] = useState(member?.phone ?? '');
  const [nomineeName, setNomineeName] = useState(member?.nominee_name ?? '');
  const [nomineePhone, setNomineePhone] = useState(member?.nominee_phone ?? '');

  const saveProfile = useMutation(
    async () => {
      if (!member) return;
      const cleanName = fullName.trim();
      if (!cleanName) {
        throw new Error('Your name cannot be empty');
      }
      const { error } = await supabase
        .from('members')
        .update({
          full_name: cleanName,
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
        haptic(20);
        refresh();
        setEditing(false);
      },
    },
  );

  if (!open) return null;

  if (editing) {
    return (
      <Sheet open title="Edit Profile" onClose={() => setEditing(false)}>
        <Field label="Your full name">
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Your full name"
            autoFocus
          />
        </Field>
        <Field label="Phone number">
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91 98765 43210"
          />
        </Field>
        <Field label="Family contact name">
          <input
            value={nomineeName}
            onChange={(e) => setNomineeName(e.target.value)}
            placeholder="Contact if you cannot be reached"
          />
        </Field>
        <Field label="Family contact phone">
          <input
            type="tel"
            value={nomineePhone}
            onChange={(e) => setNomineePhone(e.target.value)}
            placeholder="+91 98765 43210"
          />
        </Field>
        <ErrorNote error={saveProfile.error} />
        <div className="btn-row stack" style={{ marginTop: 16 }}>
          <Busy
            className="primary lg"
            pending={saveProfile.pending}
            onClick={() => void saveProfile.run()}
          >
            Save changes
          </Busy>
          <button
            type="button"
            className="sec-link"
            style={{ textAlign: 'center', marginTop: 8 }}
            onClick={() => setEditing(false)}
          >
            Cancel
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open title="Your Profile" onClose={onClose}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px',
          background: 'var(--surface-2)',
          borderRadius: 'var(--r)',
          border: '1px solid var(--hairline)',
          marginBottom: 16,
        }}
      >
        <span
          className="row-ico violet"
          style={{ width: 48, height: 48, borderRadius: 16, fontSize: '1.1rem', flex: 'none' }}
        >
          {initials(member?.full_name)}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontFamily: 'var(--display)',
              fontSize: '1.15rem',
              fontWeight: 700,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: 'var(--text)',
            }}
          >
            {member?.full_name || 'Member'}
          </div>
          <div
            className="dim"
            style={{
              fontSize: '0.82rem',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginTop: 2,
            }}
          >
            {member?.email || member?.phone || 'Signed in'}
          </div>
          <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Tag tone={role === 'member' ? undefined : 'mint'}>
              {roleLabel(role)}
            </Tag>
            {group?.name && (
              <Tag tone="violet">{group.name}</Tag>
            )}
          </div>
        </div>
      </div>

      <List>
        <Row
          icon={<IconUserEdit width={18} height={18} />}
          iconTone="violet"
          title="Edit profile"
          sub="Update your name, phone and family contact"
          onClick={() => {
            haptic(10);
            setFullName(member?.full_name ?? '');
            setPhone(member?.phone ?? '');
            setNomineeName(member?.nominee_name ?? '');
            setNomineePhone(member?.nominee_phone ?? '');
            setEditing(true);
          }}
          chevron
        />

        {openSwitcher && (
          <Row
            icon={<IconSwitch width={18} height={18} />}
            iconTone="mint"
            title="Switch group"
            sub={group ? `${group.name}${groups.length > 1 ? ` · ${groups.length} groups` : ''}` : 'Change active group'}
            onClick={() => {
              haptic(10);
              onClose();
              openSwitcher();
            }}
            chevron
          />
        )}

        <Row
          icon={theme === 'dark' ? <IconSun width={18} height={18} /> : <IconMoon width={18} height={18} />}
          title="Appearance"
          sub={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          note={theme === 'dark' ? 'Dark' : 'Light'}
          onClick={() => {
            haptic(10);
            setTheme(theme === 'dark' ? 'light' : 'dark');
          }}
        />

        <Row
          icon={<span style={{ fontWeight: 700, fontSize: '0.8rem' }}>{lang === 'te' ? 'తె' : 'En'}</span>}
          iconTone="amber"
          title={t('prof.lang')}
          sub={t('prof.lang.sub')}
          note={lang === 'te' ? 'తెలుగు' : 'English'}
          onClick={() => {
            haptic(10);
            setLang(lang === 'te' ? 'en' : 'te');
            void syncPushLanguage().catch(() => {});
          }}
        />

        {pushSt !== 'unconfigured' && (
          <Row
            icon={<IconBell width={18} height={18} />}
            iconTone={pushSt === 'on' ? 'mint' : undefined}
            title={t('prof.notify')}
            sub={pushSt === 'on' ? t('prof.notify.on')
              : pushSt === 'blocked' ? t('prof.notify.blocked')
                : pushSt === 'unsupported' ? t('prof.notify.unsupported')
                  : pushSt === 'needs-install' ? t('prof.notify.ios')
                    : t('prof.notify.off')}
            note={pushBusy ? '…' : pushSt === 'on' ? 'On' : pushSt === 'off' ? 'Off' : undefined}
            onClick={pushSt === 'on' || pushSt === 'off' ? () => {
              haptic(10);
              setPushBusy(true);
              setPushError(null);
              (pushSt === 'on' ? disablePush() : enablePush())
                .then(setPushSt)
                .catch((e: Error) => setPushError(e.message))
                .finally(() => setPushBusy(false));
            } : undefined}
          />
        )}

        <Row
          icon={<IconLogout width={18} height={18} />}
          iconTone="coral"
          title="Sign out"
          sub="Leave this account on this device"
          onClick={() => {
            haptic(10);
            onClose();
            // A phone passed to someone else must not keep receiving this
            // person's digest.
            void disablePush().catch(() => {}).finally(() => void signOut());
          }}
        />
      </List>
      <ErrorNote error={pushError} />
    </Sheet>
  );
}
