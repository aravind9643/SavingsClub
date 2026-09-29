import { useEffect, useMemo, useState } from 'react';
import { Panel, List, Row, Tag, Notice, SkeletonList } from '../../components/ui';
import { formatPaise } from '../../lib/money';
import { superAdmin } from '../../lib/superAdmin';

export interface TableInfo { name: string; pk: string; edit: boolean }

/**
 * Every allowlisted table, row by row. The list comes from the server's own
 * registry, so a table the function will not serve never appears here.
 */
export function TableBrowser({
  groupFilter, search, reloadKey, describe, onOpen,
}: {
  groupFilter: string;
  search: string;
  /** Bumped by the parent after any write, so this list is never stale. */
  reloadKey: number;
  describe: (col: string, value: unknown) => string | undefined;
  onOpen: (table: TableInfo, row: Record<string, unknown>) => void;
}) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [table, setTable] = useState<string>('contribution_periods');
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    superAdmin<{ tables: TableInfo[] }>('tables')
      .then((r) => setTables(r.tables))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    superAdmin<{ rows: Record<string, unknown>[]; truncated: boolean }>('list_table', { table })
      .then((r) => { if (!cancelled) { setRows(r.rows); setTruncated(r.truncated); } })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [table, reloadKey]);

  const info = tables.find((t) => t.name === table) ?? { name: table, pk: 'id', edit: false };
  const q = search.trim().toLowerCase();

  const visible = useMemo(() => (rows ?? []).filter((r) => {
    if (groupFilter !== 'all' && 'group_id' in r && r.group_id !== groupFilter) return false;
    if (!q) return true;
    // Search the values AND the names they resolve to, so "Rajendar" finds
    // his deposits even though the row only holds his member_id.
    return Object.entries(r).some(([c, v]) => {
      if (v === null || typeof v === 'object') return false;
      if (String(v).toLowerCase().includes(q)) return true;
      return describe(c, v)?.toLowerCase().includes(q) ?? false;
    });
  }), [rows, groupFilter, q, describe]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <select value={table} onChange={(e) => setTable(e.target.value)} aria-label="Table">
        {(tables.length ? tables : [info]).map((t) => (
          <option key={t.name} value={t.name}>{t.name}{t.edit ? '' : ' (read-only)'}</option>
        ))}
      </select>

      {error && <Notice tone="danger">{error}</Notice>}
      {truncated && <Notice tone="warn">Showing the newest 1,000 rows only.</Notice>}

      {rows === null && !error ? <SkeletonList rows={4} /> : (
        <Panel title={`${table} (${visible.length}${visible.length !== (rows?.length ?? 0) ? ` of ${rows?.length}` : ''})`} flush>
          {visible.length === 0 ? (
            <div className="empty" style={{ padding: '28px 16px' }}>
              {rows?.length ? 'Nothing matches the current search or group filter.' : 'This table is empty.'}
            </div>
          ) : (
            <List>
              {visible.map((r) => {
                const { title, sub, amount } = summarise(table, r, describe);
                return (
                  <Row
                    key={String(r[info.pk])}
                    title={title}
                    sub={sub}
                    amount={amount}
                    note={info.edit ? undefined : <Tag>view</Tag>}
                    chevron
                    onClick={() => onOpen(info, r)}
                  />
                );
              })}
            </List>
          )}
        </Panel>
      )}
    </div>
  );
}

// A row line a person can scan: the most name-like column as the title, the
// first money column as the amount, a date and status underneath.
function summarise(
  table: string,
  r: Record<string, unknown>,
  describe: (col: string, value: unknown) => string | undefined,
): { title: string; sub: string; amount?: string } {
  const str = (c: string) => (r[c] === null || r[c] === undefined ? '' : String(r[c]));
  const titleCol = ['full_name', 'name', 'display_name', 'description', 'purpose', 'subject', 'code', 'table_name']
    .find((c) => str(c));
  const personCol = ['member_id', 'borrower_id', 'voter_id', 'created_by', 'recorded_by', 'proposed_by']
    .find((c) => r[c]);
  const title = (titleCol && str(titleCol))
    || (personCol && describe(personCol, r[personCol]))
    || `${table} ${str('id').slice(0, 8)}`;

  const dateCol = ['period_month', 'paid_on', 'held_on', 'as_of', 'due_on', 'incurred_on', 'occurred_at',
    'start_date', 'requested_at', 'created_at'].find((c) => str(c));
  const sub = [
    personCol && titleCol ? describe(personCol, r[personCol]) : null,
    str('status') || str('role') || str('vote') || str('action') || str('direction') || str('kind') || null,
    dateCol ? str(dateCol).slice(0, 10) : null,
  ].filter(Boolean).join(' · ');

  const moneyCol = Object.keys(r).find((c) => c.endsWith('_paise') && r[c] !== null);
  return { title, sub, amount: moneyCol ? formatPaise(r[moneyCol] as number) : undefined };
}
