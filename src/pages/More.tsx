import { useNavigate } from 'react-router-dom';
import { Screen, useAppTheme } from '../App';
import { useSession } from '../context/SessionContext';
import { List, Row, Panel, initials, Tag } from '../components/ui';
import {
  IconExpenses, IconBank, IconMembers, IconSettings, IconAudit,
  IconSun, IconMoon, IconLogout,
} from '../components/icons';

/**
 * The tab bar holds five destinations; everything else lives here. Grouping by
 * what a person is trying to do beats one long undifferentiated list.
 */
export default function More() {
  const nav = useNavigate();
  const { member, role, group, signOut, isOfficer } = useSession();
  const { theme, setTheme } = useAppTheme();

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
            {member?.email}
          </div>
          <div style={{ marginTop: 7 }}>
            {role === 'member'
              ? <Tag>member</Tag>
              : <Tag tone="mint">{role}</Tag>}
            {' '}
            <Tag tone="violet">{group?.name}</Tag>
          </div>
        </div>
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
    </Screen>
  );
}
