import { useState } from 'react';
import { useSession } from '../context/SessionContext';
import { Sheet, List, Row, Notice, ErrorNote, initials } from './ui';
import { IconPlus } from './icons';

/**
 * The group switcher, opened from the brand mark in the tab bar.
 *
 * Switching is a server round trip (set_active_group, then a token refresh), so
 * it can fail -- the sheet stays open and says so rather than closing on a
 * switch that did not happen.
 */
export default function GroupSwitcher({
  open, onClose, onAddGroup,
}: { open: boolean; onClose: () => void; onAddGroup: () => void }) {
  const { groups, currentGroupId, switchGroup } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!open) return null;

  async function pick(id: string) {
    if (id === currentGroupId) { onClose(); return; }
    setBusy(id);
    setError(null);
    try {
      await switchGroup(id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not switch group');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet open title="Your groups" onClose={onClose}>
      <ErrorNote error={error} />

      <List>
        {groups.map((g) => (
          <Row
            key={g.id}
            icon={initials(g.name)}
            iconTone={g.id === currentGroupId ? 'mint' : 'violet'}
            title={g.name}
            sub={
              g.status === 'pending'
                ? 'waiting for approval'
                : g.role !== 'member' ? g.role : 'member'
            }
            note={
              busy === g.id ? 'switching…'
                : g.id === currentGroupId ? 'open' : undefined
            }
            onClick={() => void pick(g.id)}
            chevron={g.id !== currentGroupId}
          />
        ))}
      </List>

      {groups.some((g) => g.status === 'pending') && (
        <div style={{ marginTop: 14 }}>
          <Notice tone="warn">
            A group you have asked to join shows nothing until one of its officers
            approves you.
          </Notice>
        </div>
      )}

      <div className="btn-row stack">
        <button className="lg" onClick={() => { onClose(); onAddGroup(); }}>
          <IconPlus width={16} height={16} />
          Start or join another group
        </button>
      </div>
    </Sheet>
  );
}
