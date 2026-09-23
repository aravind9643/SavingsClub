import { useState } from 'react';
import { useSession } from '../context/SessionContext';
import { Sheet, List, Row, Notice, ErrorNote, initials, Tag } from './ui';
import { IconPlus, IconCheck } from './icons';

/**
 * The group switcher, opened from the brand mark in the tab bar or the app bar chip.
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

  const title = groups.length > 0 ? `Your groups (${groups.length})` : 'Your groups';

  return (
    <Sheet open title={title} onClose={onClose}>
      <ErrorNote error={error} />

      <List>
        {groups.map((g) => {
          const isCurrent = g.id === currentGroupId;
          const isDuplicate = groups.filter(
            (x) => x.name.trim().toLowerCase() === g.name.trim().toLowerCase(),
          ).length > 1;

          const roleText = g.status === 'pending'
            ? 'waiting for approval'
            : g.role !== 'member' ? g.role : 'member';

          const subParts = [roleText];
          if (!g.setup_complete && g.status !== 'pending') {
            subParts.push('setup incomplete');
          }
          if (isDuplicate) {
            subParts.push(`#${g.id.slice(0, 4)}`);
          }

          return (
            <Row
              key={g.id}
              icon={isCurrent ? <IconCheck width={17} height={17} /> : initials(g.name)}
              iconTone={isCurrent ? 'mint' : 'violet'}
              title={g.name}
              sub={subParts.join(' · ')}
              note={
                busy === g.id ? (
                  <span className="dim"><span className="spinner" />switching…</span>
                ) : isCurrent ? (
                  <Tag tone="mint">Active</Tag>
                ) : g.status === 'pending' ? (
                  <Tag tone="amber">Pending</Tag>
                ) : undefined
              }
              onClick={() => void pick(g.id)}
              chevron={!isCurrent}
            />
          );
        })}
      </List>

      {groups.some((g) => g.status === 'pending') && (
        <div style={{ marginTop: 14 }}>
          <Notice tone="warn">
            A group you have asked to join shows nothing until one of its officers
            approves you.
          </Notice>
        </div>
      )}

      <div className="btn-row stack" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="primary lg"
          onClick={() => { onClose(); onAddGroup(); }}
        >
          <IconPlus width={16} height={16} />
          <span>Start or join another group</span>
        </button>
      </div>
    </Sheet>
  );
}
