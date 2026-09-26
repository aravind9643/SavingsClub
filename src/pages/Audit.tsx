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

  const periods = useQuery<Record<string, string>>('periods:months', async () => {
    let query = supabase.from('contribution_periods').select('id, period_month');
    if (currentGroupId) query = query.eq('group_id', currentGroupId);
    const { data, error } = await query;
    if (error) throw error;
    const map: Record<string, string> = {};
    for (const p of (data ?? []) as { id: string; period_month: string }[]) {
      map[p.id] = fmtMonth(p.period_month);
    }
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
          <Detail
            row={activeRows.find((r) => r.id === open)}
            memberNames={names.data}
            periodNames={periods.data}
          />
        </Sheet>
      )}

      <p className="dim" style={{ textAlign: 'center' }}>
        Entries here can never be edited or deleted — not even from the database.
      </p>
    </Screen>
  );
}

const HIDDEN_KEYS = new Set([
  'id',
  'group_id',
  'created_at',
  'updated_at',
  'instance_id',
  'borrower_role_at_request',
]);

const KEY_LABELS: Record<string, string> = {
  amount_paise: 'Amount',
  late_fee_paise: 'Late fee',
  principal_paise: 'Principal',
  interest_paise: 'Interest',
  penalty_paise: 'Late penalty',
  closing_balance_paise: 'Closing balance',
  fund_total_at_request_paise: 'Fund reserve at request',
  member_id: 'Member',
  recorded_by: 'Recorded by',
  borrower_id: 'Borrower',
  guarantor_id: 'Guarantor',
  voter_id: 'Voter',
  created_by: 'Created by',
  proposed_by: 'Proposed by',
  period_id: 'Contribution period',
  loan_id: 'Loan reference',
  rate_bp: 'Monthly interest rate',
  overdue_rate_bp: 'Overdue interest rate',
  term_months: 'Term duration',
  outside_borrower_name: 'Borrower name',
  outside_borrower_phone: 'Borrower phone',
  outside_borrower_address: 'Borrower address',
  paid_on: 'Payment date',
  due_on: 'Due date',
  incurred_on: 'Date incurred',
  occurred_at: 'Date & time',
  method: 'Payment method',
  status: 'Status',
  purpose: 'Purpose / Note',
  description: 'Description',
  category: 'Category',
  full_name: 'Full name',
  phone: 'Phone number',
  email: 'Email address',
  nominee_name: 'Family contact',
  nominee_phone: 'Family contact phone',
  note: 'Note',
  direction: 'Direction',
  counterparty: 'Counterparty',
};

const MEMBER_ID_KEYS = new Set([
  'member_id',
  'recorded_by',
  'borrower_id',
  'guarantor_id',
  'voter_id',
  'created_by',
  'proposed_by',
]);

const PRIORITY_ORDER = [
  'full_name',
  'member_id',
  'borrower_id',
  'outside_borrower_name',
  'outside_borrower_phone',
  'guarantor_id',
  'amount_paise',
  'principal_paise',
  'interest_paise',
  'late_fee_paise',
  'penalty_paise',
  'period_id',
  'paid_on',
  'due_on',
  'method',
  'status',
  'category',
  'description',
  'purpose',
  'note',
  'counterparty',
  'recorded_by',
  'created_by',
  'rate_bp',
  'term_months',
];

function Detail({
  row,
  memberNames,
  periodNames,
}: {
  row: AuditRow | undefined;
  memberNames?: Record<string, string>;
  periodNames?: Record<string, string>;
}) {
  if (!row) return null;
  const rawKeys = (row.changed_keys && row.changed_keys.length > 0)
    ? row.changed_keys
    : Object.keys(row.new_data ?? row.old_data ?? {});

  const displayKeys: string[] = rawKeys
    .filter((k) => !HIDDEN_KEYS.has(k));
  displayKeys.sort((a, b) => {
    const ia = PRIORITY_ORDER.indexOf(a);
    const ib = PRIORITY_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
  const visibleKeys = displayKeys.slice(0, 16);

  return (
    <>
      <p className="dim" style={{ marginTop: 0, marginBottom: 14 }}>
        {row.table_name.replace(/_/g, ' ')} · {row.action.toLowerCase()} · {fmtDateTime(row.occurred_at)}
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {visibleKeys.map((k) => (
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
              {KEY_LABELS[k] ?? k.replace(/_/g, ' ')}
            </span>
            <span style={{ minWidth: 0, wordBreak: 'break-word', fontWeight: 550 }}>
              {row.action === 'UPDATE' && row.old_data ? (
                <>
                  <s style={{ color: 'var(--text-3)', marginRight: 6 }}>
                    {fmt(k, row.old_data[k], memberNames, periodNames)}
                  </s>
                  <span style={{ color: 'var(--mint)', marginRight: 6 }}>→</span>
                </>
              ) : null}
              {fmt(k, row.new_data?.[k], memberNames, periodNames)}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

const MONEY = /_paise$/;

function fmt(
  key: string,
  value: unknown,
  memberNames?: Record<string, string>,
  periodNames?: Record<string, string>,
): string {
  if (value === null || value === undefined || value === '') return '—';

  // Member names lookup
  if (MEMBER_ID_KEYS.has(key) && typeof value === 'string') {
    if (memberNames && memberNames[value]) {
      return memberNames[value];
    }
  }

  // Contribution periods lookup
  if (key === 'period_id' && typeof value === 'string') {
    if (periodNames && periodNames[value]) {
      return periodNames[value];
    }
  }

  // Money fields
  if (MONEY.test(key) && (typeof value === 'number' || typeof value === 'string')) {
    return formatPaise(value);
  }

  // Interest rates (basis points)
  if ((key === 'rate_bp' || key === 'overdue_rate_bp') && (typeof value === 'number' || typeof value === 'string')) {
    const num = Number(value);
    return `${(num / 100).toFixed(num % 100 === 0 ? 0 : 1)}% / month`;
  }

  // Repayment terms
  if (key === 'term_months' && (typeof value === 'number' || typeof value === 'string')) {
    return `${value} month${Number(value) > 1 ? 's' : ''}`;
  }

  // Payment method
  if (key === 'method' && typeof value === 'string') {
    return value.toUpperCase();
  }

  // Booleans
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  const s = String(value);
  // Shorten raw UUIDs if unresolved
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return `#${s.slice(0, 8)}`;
  }

  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
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
      const who = d.outside_borrower_name ? String(d.outside_borrower_name) : memberName('borrower_id');
      if (r.action === 'INSERT') {
        return `Loan asked for ${amt('principal_paise')}${who ? ` · ${who}` : ''}`;
      }
      return `Loan ${labelForStatus(String(d.status ?? 'changed'))}${who ? ` · ${who}` : ''}`;
    }
    case 'loan_votes': {
      const who = memberName('voter_id');
      return `Voted ${String(d.vote ?? '')} on loan${who ? ` · ${who}` : ''}`;
    }
    case 'loan_repayments': {
      const who = memberName('recorded_by');
      return `Paid back ${amt('principal_paise')}${who ? ` · recorded by ${who}` : ''}`;
    }
    case 'loan_instalments':
      return 'Loan repayment schedule set';
    case 'expenses':
      return `${String(d.description ?? 'Expense')} ${amt('amount_paise')}`;
    case 'expense_votes': {
      const who = memberName('voter_id');
      return `Voted ${String(d.vote ?? '')} on expense${who ? ` · ${who}` : ''}`;
    }
    case 'cash_ledger': {
      const cp = d.counterparty ? String(d.counterparty) : '';
      const purpose = d.purpose ? ` (${String(d.purpose)})` : '';
      return `Cash ${d.direction === 'in' ? 'in' : 'out'} ${amt('amount_paise')}${cp ? ` · ${cp}${purpose}` : ''}`;
    }
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
