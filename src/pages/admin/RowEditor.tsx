import { useMemo, useState } from 'react';
import { Sheet, Field, Notice, Tag } from '../../components/ui';
import { formatPaise } from '../../lib/money';
import { superAdmin } from '../../lib/superAdmin';

import { kindOf, toInput, fromInput, type Kind } from './columns';

/**
 * Edits any one row of any allowlisted table, a column at a time (column
 * kinds and conversions: ./columns.ts).
 *
 * Only the columns that changed are sent. The server re-checks every one
 * (table allowlisted, column exists, not the key or group_id, integers stay
 * integers), so this form is a convenience, not the guard.
 */

// Tables whose rows ARE the money. Editing one restates balances, shares and
// reconciliation, and skips the checks the app's RPCs would have made.
const MONEY_TABLES = new Set([
  'contributions', 'loans', 'loan_repayments', 'loan_instalments', 'expenses',
  'cash_ledger', 'bank_statements', 'member_payouts', 'distributions', 'distribution_lines',
  'contribution_periods', 'groups',
]);

const label = (c: string) => c.replace(/_/g, ' ');

export interface RowEditorProps {
  table: string;
  pk: string;
  row: Record<string, unknown>;
  editable: boolean;
  /** A readable name for an id column's value, when one is known. */
  describe: (col: string, value: unknown) => string | undefined;
  onClose: () => void;
  onSaved: (message: string) => void;
  onDelete?: () => void;
}

export function RowEditor({ table, pk, row, editable, describe, onClose, onSaved, onDelete }: RowEditorProps) {
  const cols = useMemo(() => Object.keys(row), [row]);
  const kinds = useMemo(
    () => Object.fromEntries(cols.map((c) => [c, kindOf(c, row[c], pk, editable)])) as Record<string, Kind>,
    [cols, row, pk, editable],
  );
  const initial = useMemo(
    () => Object.fromEntries(cols.map((c) => [c, toInput(kinds[c], row[c])])) as Record<string, string>,
    [cols, kinds, row],
  );
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = cols.filter((c) => kinds[c] !== 'readonly' && kinds[c] !== 'json' && draft[c] !== initial[c]);

  const save = async () => {
    setError(null);
    let values: Record<string, unknown>;
    try {
      values = Object.fromEntries(changed.map((c) => [c, fromInput(kinds[c], c, draft[c])]));
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setSaving(true);
    try {
      const r = await superAdmin<{ changed: number }>('update_row', { table, pk: String(row[pk]), values });
      onSaved(`Saved ${r.changed} change${r.changed === 1 ? '' : 's'} to ${table}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open title={`${editable ? 'Edit' : 'View'} · ${table}`} onClose={() => { if (!saving) onClose(); }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {editable && MONEY_TABLES.has(table) && (
          <Notice tone="warn">
            This edits the books directly. Database constraints and the audit log still apply, but the app’s own
            rules (overpayment, closed months, vote thresholds) are skipped. Every balance and share computed from
            this row changes with it.
          </Notice>
        )}
        {!editable && <Notice tone="info">This table is read-only in the console.</Notice>}

        {cols.map((c) => {
          const kind = kinds[c];
          const value = row[c];
          const hint = describe(c, value);
          const isChanged = changed.includes(c);
          const title = (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {label(c)}
              {kind === 'paise' && <span className="dim">₹</span>}
              {kind === 'bp' && <span className="dim">basis points (200 = 2%)</span>}
              {isChanged && <Tag tone="amber">changed</Tag>}
            </span>
          );

          if (kind === 'readonly' || kind === 'json') {
            return (
              <div key={c} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-3)' }}>{label(c)}</span>
                {kind === 'json' ? (
                  <pre style={{ margin: 0, fontSize: '0.74rem', background: 'var(--surface-2)', padding: 10,
                    borderRadius: 'var(--r-sm)', maxHeight: 160, overflow: 'auto' }}>{initial[c]}</pre>
                ) : (
                  <code style={{ fontSize: '0.82rem', overflowWrap: 'anywhere', color: 'var(--text-2)' }}>
                    {initial[c] || '—'}{hint ? ` · ${hint}` : ''}
                  </code>
                )}
              </div>
            );
          }

          return (
            <Field
              key={c}
              label={title}
              hint={hint ?? (kind === 'paise' && value !== null ? `now ${formatPaise(value as number)}` : undefined)}
            >
              {kind === 'bool' ? (
                <select value={draft[c]} onChange={(e) => setDraft({ ...draft, [c]: e.target.value })}>
                  <option value="true">true</option>
                  <option value="false">false</option>
                  <option value="">— none —</option>
                </select>
              ) : (
                <input
                  type={kind === 'date' ? 'date' : 'text'}
                  inputMode={kind === 'paise' ? 'decimal' : kind === 'int' || kind === 'bp' ? 'numeric' : undefined}
                  value={draft[c]}
                  placeholder="empty = none"
                  onChange={(e) => setDraft({ ...draft, [c]: e.target.value })}
                  style={isChanged ? { borderColor: 'var(--amber)' } : undefined}
                />
              )}
            </Field>
          );
        })}

        {error && <Notice tone="danger">{error}</Notice>}

        <div className="btn-row stack" style={{ marginTop: 4 }}>
          {editable && (
            <button type="button" className="primary lg" disabled={saving || changed.length === 0} onClick={() => void save()}>
              {saving ? 'Saving…' : changed.length === 0 ? 'No changes' : `Save ${changed.length} change${changed.length === 1 ? '' : 's'}`}
            </button>
          )}
          {onDelete && (
            <button type="button" className="danger" disabled={saving} onClick={onDelete}>Delete this row</button>
          )}
          <button type="button" onClick={onClose} disabled={saving}>Close</button>
        </div>
      </div>
    </Sheet>
  );
}
