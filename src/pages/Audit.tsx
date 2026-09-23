import { useState } from 'react';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery } from '../hooks/useQuery';
import { formatPaise } from '../lib/money';
import {
  Panel, List, Row, Empty, SkeletonList, Segments, ago, fmtDateTime,
} from '../components/ui';
import { IconAudit, IconCheck, IconClose, IconMore } from '../components/icons';
import type { AuditRow } from '../lib/types';

type Filter = 'all' | 'money' | 'loans' | 'people';

const GROUPS: Record<Filter, string[] | null> = {
  all: null,
  money: ['contributions', 'loan_repayments', 'expenses', 'cash_ledger', 'bank_statements'],
  loans: ['loans', 'loan_votes'],
  // 'groups' carries the rule settings that used to live in app_config.
  people: ['members', 'role_assignments', 'groups'],
};

export default function Audit() {
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<number | null>(null);

  const q = useQuery<AuditRow[]>(`audit:${filter}`, async () => {
    let query = supabase.from('audit_log').select('*')
      .order('occurred_at', { ascending: false }).limit(200);
    const tables = GROUPS[filter];
    if (tables) query = query.in('table_name', tables);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as AuditRow[];
  });

  const names = useQuery<Record<string, string>>('members:names', async () => {
    const { data, error } = await supabase.from('members').select('id, full_name');
    if (error) throw error;
    const map: Record<string, string> = {};
    for (const m of (data ?? []) as { id: string; full_name: string }[]) map[m.id] = m.full_name;
    return map;
  });

  return (
    <Screen title="Audit" sub="Every change, and who made it">
      <Segments<Filter>
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'Everything' },
          { value: 'money', label: 'Money' },
          { value: 'loans', label: 'Loans' },
          { value: 'people', label: 'People & rules' },
        ]}
      />

      <Panel flush>
        {q.loading && !q.data ? (
          <SkeletonList rows={6} />
        ) : (q.data ?? []).length === 0 ? (
          <Empty icon={<IconAudit width={22} height={22} />}>Nothing recorded yet.</Empty>
        ) : (
          <List>
            {(q.data ?? []).map((r) => (
              <Row
                key={r.id}
                icon={
                  r.action === 'INSERT' ? <IconCheck width={16} height={16} />
                    : r.action === 'DELETE' ? <IconClose width={16} height={16} />
                      : <IconMore width={16} height={16} />
                }
                iconTone={
                  r.action === 'INSERT' ? 'mint' : r.action === 'DELETE' ? 'coral' : 'violet'
                }
                title={describe(r)}
                sub={
                  <>
                    {r.actor_member_id
                      ? (names.data?.[r.actor_member_id] ?? 'a member')
                      : 'direct database'}
                    {' · '}{ago(r.occurred_at)}
                  </>
                }
                onClick={() => setOpen(open === r.id ? null : r.id)}
              />
            ))}
          </List>
        )}
      </Panel>

      {open !== null && (
        <Panel title="Detail">
          <Detail row={(q.data ?? []).find((r) => r.id === open)} />
        </Panel>
      )}

      <p className="dim" style={{ textAlign: 'center' }}>
        Entries here can never be edited or deleted — not even from the database.
      </p>
    </Screen>
  );
}

function Detail({ row }: { row: AuditRow | undefined }) {
  if (!row) return null;
  const keys = row.changed_keys ?? Object.keys(row.new_data ?? {});
  return (
    <>
      <p className="dim" style={{ marginTop: 0 }}>
        {row.table_name} · {row.action.toLowerCase()} · {fmtDateTime(row.occurred_at)}
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {keys.filter((k) => k !== 'id' && k !== 'created_at').slice(0, 12).map((k) => (
          <div key={k} style={{ display: 'flex', gap: 10, fontSize: '0.85rem' }}>
            <span className="dim" style={{ minWidth: 120 }}>{k}</span>
            <span style={{ minWidth: 0, wordBreak: 'break-word' }}>
              {row.action === 'UPDATE' && row.old_data ? (
                <>
                  <s style={{ color: 'var(--text-3)' }}>{fmt(k, row.old_data[k])}</s>
                  {' → '}
                </>
              ) : null}
              {fmt(k, row.new_data?.[k])}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

const MONEY = /_paise$/;

function fmt(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (MONEY.test(key) && (typeof value === 'number' || typeof value === 'string')) {
    return formatPaise(value);
  }
  const s = String(value);
  return s.length > 48 ? `${s.slice(0, 48)}…` : s;
}

function describe(r: AuditRow): string {
  const d = (r.new_data ?? r.old_data ?? {}) as Record<string, unknown>;
  const amt = (k: string) => {
    const v = d[k];
    return typeof v === 'number' || typeof v === 'string' ? formatPaise(v) : '';
  };
  switch (r.table_name) {
    case 'contributions': return `Contribution ${amt('amount_paise')}`;
    case 'loans':
      return r.action === 'INSERT'
        ? `Loan requested ${amt('principal_paise')}`
        : `Loan ${String(d.status ?? 'changed')}`;
    case 'loan_votes': return `Vote: ${String(d.vote ?? '')}`;
    case 'loan_repayments': return `Repayment ${amt('principal_paise')}`;
    case 'expenses': return `${String(d.description ?? 'Expense')} ${amt('amount_paise')}`;
    case 'cash_ledger': return `Cash ${d.direction === 'in' ? 'in' : 'out'} ${amt('amount_paise')}`;
    case 'bank_statements': return `Bank statement ${amt('closing_balance_paise')}`;
    case 'members': return `Member ${String(d.full_name ?? '')}`;
    case 'role_assignments': return `Role ${String(d.role ?? '')}`;
    case 'groups': return 'Group rules changed';
    default: return `${r.table_name} ${r.action.toLowerCase()}`;
  }
}
