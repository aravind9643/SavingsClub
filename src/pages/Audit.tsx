import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery } from '../hooks/useQuery';
import { useSession } from '../context/SessionContext';
import { formatPaise } from '../lib/money';
import {
  Panel, List, Row, Empty, SkeletonList, Segments, Sheet, Busy, ago, fmtDateTime,
  roleLabel, labelForStatus,
} from '../components/ui';
import { IconAudit, IconCheck, IconClose, IconMore } from '../components/icons';
import type { AuditRow } from '../lib/types';

type Filter = 'all' | 'money' | 'loans' | 'people';

const GROUPS: Record<Filter, string[] | null> = {
  all: null,
  money: [
    'contributions',
    'contribution_periods',
    'loan_repayments',
    'expenses',
    'cash_ledger',
    'bank_statements',
    'member_payouts',
    'distributions',
    'distribution_lines',
  ],
  loans: ['loans', 'loan_votes', 'loan_repayments', 'loan_instalments'],
  people: [
    'members',
    'role_assignments',
    'groups',
    'group_invites',
    'meetings',
    'meeting_attendance',
    'expense_votes',
  ],
};

const PAGE_SIZE = 50;

export default function Audit() {
  const nav = useNavigate();
  const { currentGroupId } = useSession();
  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [open, setOpen] = useState<number | null>(null);

  const prevGroupRef = useRef(currentGroupId);
  const prevRowsRef = useRef<AuditRow[]>([]);

  if (prevGroupRef.current !== currentGroupId) {
    prevGroupRef.current = currentGroupId;
    prevRowsRef.current = [];
  }

  const handleFilterChange = (next: Filter) => {
    setFilter(next);
    setLimit(PAGE_SIZE);
    prevRowsRef.current = [];
  };

  const q = useQuery<AuditRow[]>(`audit:${filter}:${limit}`, async () => {
    let query = supabase.from('audit_log').select('*')
      .order('occurred_at', { ascending: false }).limit(limit);
    if (currentGroupId) query = query.eq('group_id', currentGroupId);
    const tables = GROUPS[filter];
    if (tables) query = query.in('table_name', tables);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as AuditRow[];
  });

  if (q.data) {
    prevRowsRef.current = q.data;
  }

  const activeRows = q.data ?? (q.loading ? prevRowsRef.current : []);
  const hasMore = (q.data ? q.data.length : prevRowsRef.current.length) >= limit;

  const names = useQuery<Record<string, string>>('members:names', async () => {
    let query = supabase.from('members').select('id, full_name');
    if (currentGroupId) query = query.eq('group_id', currentGroupId);
    const { data, error } = await query;
    if (error) throw error;
    const map: Record<string, string> = {};
    for (const m of (data ?? []) as { id: string; full_name: string }[]) map[m.id] = m.full_name;
    return map;
  });

  return (
    <Screen title="History" sub="Every change, and who made it" onBack={() => nav('/community')}>
      <Segments<Filter>
        value={filter}
        onChange={handleFilterChange}
        options={[
          { value: 'all', label: 'Everything' },
          { value: 'money', label: 'Money' },
          { value: 'loans', label: 'Loans' },
          { value: 'people', label: 'People & rules' },
        ]}
      />

      <Panel flush>
        {q.loading && activeRows.length === 0 ? (
          <SkeletonList rows={6} />
        ) : activeRows.length === 0 ? (
          <Empty icon={<IconAudit width={22} height={22} />}>Nothing recorded yet.</Empty>
        ) : (
          <>
            <List>
              {activeRows.map((r) => (
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
                  title={describe(r, names.data)}
                  sub={
                    <>
                      {r.actor_member_id
                        ? (names.data?.[r.actor_member_id] ?? 'Member')
                        : 'System'}
                      {' · '}{ago(r.occurred_at)}
                    </>
                  }
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                  chevron
                />
              ))}
            </List>
            {hasMore && (
              <div style={{ padding: '12px 14px', textAlign: 'center', borderTop: '1px solid var(--border)' }}>
                <Busy
                  className="ghost"
                  style={{ width: '100%' }}
                  pending={q.loading}
                  onClick={() => setLimit((l) => l + PAGE_SIZE)}
                >
                  Load older entries
                </Busy>
              </div>
            )}
          </>
        )}
      </Panel>

      {open !== null && (
        <Sheet open title="What changed" onClose={() => setOpen(null)}>
          <Detail row={activeRows.find((r) => r.id === open)} />
        </Sheet>
      )}

      <p className="dim" style={{ textAlign: 'center' }}>
        Entries here can never be edited or deleted — not even from the database.
      </p>
    </Screen>
  );
}

function Detail({ row }: { row: AuditRow | undefined }) {
  if (!row) return null;
  const keys = (row.changed_keys && row.changed_keys.length > 0)
    ? row.changed_keys
    : Object.keys(row.new_data ?? row.old_data ?? {});
  return (
    <>
      <p className="dim" style={{ marginTop: 0, marginBottom: 14 }}>
        {row.table_name.replace(/_/g, ' ')} · {row.action.toLowerCase()} · {fmtDateTime(row.occurred_at)}
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {keys.filter((k) => k !== 'id' && k !== 'created_at').slice(0, 16).map((k) => (
          <div
            key={k}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: '10px 12px',
              borderRadius: 'var(--r-sm)',
              background: 'var(--surface-2)',
              fontSize: '0.85rem',
            }}
          >
            <span className="dim" style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
              {k.replace(/_/g, ' ')}
            </span>
            <span style={{ minWidth: 0, wordBreak: 'break-word', fontWeight: 550 }}>
              {row.action === 'UPDATE' && row.old_data ? (
                <>
                  <s style={{ color: 'var(--text-3)', marginRight: 6 }}>{fmt(k, row.old_data[k])}</s>
                  <span style={{ color: 'var(--mint)', marginRight: 6 }}>→</span>
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

function fmtMonth(d: unknown): string {
  if (!d || typeof d !== 'string') return '';
  const m = /^(\d{4})-(\d{2})/.exec(d);
  if (!m) return '';
  const date = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  return date.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

function describe(r: AuditRow, memberNames?: Record<string, string>): string {
  const d = (r.new_data ?? r.old_data ?? {}) as Record<string, unknown>;
  const amt = (k: string) => {
    const v = d[k];
    return typeof v === 'number' || typeof v === 'string' ? formatPaise(v) : '';
  };
  const memberName = (k = 'member_id') => {
    const id = d[k];
    return id && memberNames ? memberNames[String(id)] : undefined;
  };

  switch (r.table_name) {
    case 'contributions': {
      const who = memberName();
      const amount = amt('amount_paise');
      return who ? `Paid in ${amount} · ${who}` : `Paid in ${amount}`;
    }
    case 'contribution_periods': {
      const month = fmtMonth(d.period_month);
      const label = month ? ` · ${month}` : '';
      if (r.action === 'INSERT') return `Opened period${label}`;
      if (r.action === 'DELETE') return `Removed period${label}`;
      if (d.closed_at) return `Closed period${label}`;
      return `Updated period${label}`;
    }
    case 'loans': {
      const who = memberName();
      if (r.action === 'INSERT') {
        return `Loan asked for ${amt('principal_paise')}${who ? ` · ${who}` : ''}`;
      }
      return `Loan ${labelForStatus(String(d.status ?? 'changed'))}${who ? ` · ${who}` : ''}`;
    }
    case 'loan_votes':
      return `Voted ${String(d.vote ?? '')} on loan`;
    case 'loan_repayments': {
      const who = memberName();
      return `Paid back ${amt('principal_paise')}${who ? ` · ${who}` : ''}`;
    }
    case 'loan_instalments':
      return 'Loan repayment schedule set';
    case 'expenses':
      return `${String(d.description ?? 'Expense')} ${amt('amount_paise')}`;
    case 'expense_votes':
      return `Voted ${String(d.vote ?? '')} on expense`;
    case 'cash_ledger':
      return `Cash ${d.direction === 'in' ? 'in' : 'out'} ${amt('amount_paise')}`;
    case 'bank_statements':
      return `Bank checked ${amt('closing_balance_paise')}`;
    case 'members': {
      const name = String(d.full_name ?? '').trim();
      if (r.action === 'INSERT') return name ? `New member: ${name}` : 'New member joined';
      if (r.action === 'DELETE') return name ? `Member removed: ${name}` : 'Member removed';
      return name ? `Member updated: ${name}` : 'Member details updated';
    }
    case 'role_assignments': {
      const who = memberName();
      const role = roleLabel(String(d.role ?? ''));
      if (r.action === 'DELETE') {
        return `Role ended: ${role}${who ? ` · ${who}` : ''}`;
      }
      return `Role assigned: ${role}${who ? ` · ${who}` : ''}`;
    }
    case 'groups':
      return 'Group rules changed';
    case 'group_invites':
      return r.action === 'INSERT' ? 'Invite code made' : 'Invite code cancelled';
    case 'member_payouts': {
      const who = memberName();
      return `Member payout ${amt('amount_paise')}${who ? ` · ${who}` : ''}`;
    }
    case 'distributions':
      return `Profit distribution ${amt('total_paise')}`;
    case 'distribution_lines': {
      const who = memberName();
      return `Share payout ${amt('amount_paise')}${who ? ` · ${who}` : ''}`;
    }
    case 'meetings': {
      if (r.action === 'DELETE') return 'Meeting deleted';
      return `Meeting held${d.held_on ? ` · ${String(d.held_on)}` : ''}`;
    }
    case 'meeting_attendance': {
      const who = memberName();
      const st = String(d.status ?? 'recorded');
      return `Attendance: ${st}${who ? ` · ${who}` : ''}`;
    }
    default: {
      const clean = r.table_name.replace(/_/g, ' ');
      return r.action === 'INSERT'
        ? `Added ${clean}`
        : r.action === 'DELETE'
          ? `Removed ${clean}`
          : `Updated ${clean}`;
    }
  }
}
