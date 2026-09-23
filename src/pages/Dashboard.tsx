import { useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { useFund } from '../context/FundContext';
import { useSession } from '../context/SessionContext';
import { useQuery } from '../hooks/useQuery';
import { supabase } from '../lib/supabase';
import { formatPaise, formatPaiseShort } from '../lib/money';
import {
  Hero, Chip, Notice, Panel, Stat, List, Row, Empty,
  initials, ago, fmtDate, SkeletonList,
} from '../components/ui';
import {
  IconPlus, IconArrowUp, IconArrowDown, IconBank, IconInbox, IconCheck,
} from '../components/icons';
import type { MemberPosition, BankStatement, LoanRow, AuditRow } from '../lib/types';

export default function Dashboard() {
  const nav = useNavigate();
  const { fund, alerts, loading } = useFund();
  const { member, config, group } = useSession();

  const positions = useQuery<MemberPosition[]>('positions', async () => {
    const { data, error } = await supabase
      .from('v_member_positions').select('*').order('contributed_paise', { ascending: false });
    if (error) throw error;
    return (data ?? []) as MemberPosition[];
  });

  const lastStatement = useQuery<BankStatement | null>('bank:last', async () => {
    const { data, error } = await supabase
      .from('bank_statements').select('*')
      .order('as_of', { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return (data as BankStatement) ?? null;
  });

  const pending = useQuery<LoanRow[]>('loans:pending', async () => {
    const { data, error } = await supabase
      .from('v_loan_status').select('*').eq('status', 'requested');
    if (error) throw error;
    return (data ?? []) as LoanRow[];
  });

  const feed = useQuery<AuditRow[]>('feed', async () => {
    const { data, error } = await supabase
      .from('audit_log').select('*')
      .in('table_name', ['contributions', 'loans', 'loan_repayments', 'expenses', 'cash_ledger'])
      .order('occurred_at', { ascending: false }).limit(6);
    if (error) throw error;
    return (data ?? []) as AuditRow[];
  });

  if (loading && !fund) {
    return (
      <Screen title="Home">
        <div className="hero skeleton" style={{ height: 168 }} />
        <SkeletonList rows={3} />
      </Screen>
    );
  }

  const myVoteNeeded = (pending.data ?? []).filter((l) => l.can_i_vote);
  const diff = lastStatement.data?.difference_paise;
  const greeting = new Date().getHours() < 12
    ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <Screen
      title={greeting.split(' ')[1] === 'morning' ? 'Morning' : greeting.replace('Good ', '')}
      sub={member?.full_name}
      action={
        <button className="icon-btn avatar" onClick={() => nav('/more')} aria-label="Profile">
          {initials(member?.full_name)}
        </button>
      }
    >
      {fund && (
        <Hero
          label={`${group?.name ?? 'Group'} · total fund`}
          paise={fund.total_fund_paise}
          meta={
            <>
              <Chip tone="mint">
                Lendable <b>{formatPaiseShort(fund.still_lendable_paise)}</b>
              </Chip>
              <Chip tone="violet">
                On loan <b>{formatPaiseShort(fund.outstanding_paise)}</b>
              </Chip>
              <Chip>
                Reserve <b>{formatPaiseShort(fund.reserve_paise)}</b>
              </Chip>
            </>
          }
          meter={{
            value: fund.outstanding_paise,
            limit: Math.max(1, fund.lendable_paise),
          }}
        />
      )}

      {/* Anything that needs a human, first. */}
      {myVoteNeeded.length > 0 && (
        <Notice tone="warn" onClick={() => nav('/loans')}>
          <strong>{myVoteNeeded.length} loan request{myVoteNeeded.length > 1 ? 's' : ''}</strong>
          {' '}waiting for your vote
        </Notice>
      )}
      {alerts.map((a) => (
        <Notice key={a.id} tone={a.severity === 'danger' ? 'danger' : 'warn'} onClick={() => nav(a.to)}>
          {a.message}
        </Notice>
      ))}
      {alerts.length === 0 && myVoteNeeded.length === 0 && (
        <Notice tone="good">Everything is in order — nothing needs attention.</Notice>
      )}

      <div className="two-col">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Panel title="Quick actions" flush>
            <List>
              <Row
                icon={<IconArrowDown width={18} height={18} />}
                iconTone="mint"
                title="Record a contribution"
                sub="Monthly chanda received"
                onClick={() => nav('/contributions')}
                chevron
              />
              <Row
                icon={<IconPlus width={18} height={18} />}
                iconTone="violet"
                title="Request a loan"
                sub={`Up to ${formatPaiseShort(fund?.per_member_cap_paise ?? 0)} for you`}
                onClick={() => nav('/loans/new')}
                chevron
              />
              <Row
                icon={<IconArrowUp width={18} height={18} />}
                iconTone="amber"
                title="Add an expense"
                sub="Trip, party or admin cost"
                onClick={() => nav('/expenses')}
                chevron
              />
              <Row
                icon={<IconBank width={18} height={18} />}
                iconTone="coral"
                title="Reconcile the bank"
                sub={
                  diff === undefined
                    ? 'No statement recorded yet'
                    : diff === 0
                      ? `Balanced on ${fmtDate(lastStatement.data?.as_of)}`
                      : `Off by ${formatPaise(Math.abs(diff))}`
                }
                onClick={() => nav('/bank')}
                chevron
              />
            </List>
          </Panel>

          {fund && (
            <Panel title="This month">
              <div className="stats three">
                <Stat
                  k="In bank"
                  v={formatPaiseShort(fund.expected_bank_balance_paise)}
                  s="expected"
                />
                <Stat
                  k="Cash float"
                  v={formatPaiseShort(fund.cash_float_paise)}
                  s={`of ${formatPaiseShort(fund.cash_float_limit_paise)}`}
                  tone={fund.cash_float_paise > fund.cash_float_limit_paise ? 'coral' : undefined}
                />
                <Stat
                  k="Difference"
                  v={diff === undefined ? '—' : formatPaiseShort(diff)}
                  s={diff === 0 ? 'balanced' : diff === undefined ? 'no statement' : 'check this'}
                  tone={diff === 0 ? 'mint' : diff === undefined ? undefined : 'coral'}
                />
              </div>
              {config && (
                <p className="dim" style={{ marginTop: 12, marginBottom: 0 }}>
                  {formatPaise(config.monthly_contribution_paise)} due by the {config.due_day}th ·
                  {' '}{(config.loan_rate_bp / 100).toFixed(0)}% per month on loans
                </p>
              )}
            </Panel>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Panel
            title="Members"
            action={<button className="sec-link" onClick={() => nav('/members')}>See all</button>}
            flush
          >
            {positions.loading && !positions.data ? (
              <SkeletonList rows={3} />
            ) : (
              <List>
                {(positions.data ?? []).slice(0, 5).map((p) => (
                  <Row
                    key={p.member_id}
                    icon={initials(p.full_name)}
                    iconTone={p.cap_breached ? 'coral' : 'violet'}
                    title={
                      <>
                        {p.full_name}
                        {p.member_id === member?.id ? ' · you' : ''}
                      </>
                    }
                    sub={p.role === 'member' ? `${Number(p.share_pct).toFixed(0)}% of the fund` : p.role}
                    amount={formatPaiseShort(p.contributed_paise)}
                    note={
                      p.outstanding_paise > 0
                        ? `owes ${formatPaiseShort(p.outstanding_paise)}`
                        : undefined
                    }
                  />
                ))}
              </List>
            )}
          </Panel>

          <Panel
            title="Recent activity"
            action={<button className="sec-link" onClick={() => nav('/audit')}>History</button>}
            flush
          >
            {feed.loading && !feed.data ? (
              <SkeletonList rows={3} />
            ) : (feed.data ?? []).length === 0 ? (
              <Empty icon={<IconInbox width={22} height={22} />}>
                Nothing has happened yet.
              </Empty>
            ) : (
              <List>
                {(feed.data ?? []).map((r) => (
                  <Row
                    key={r.id}
                    icon={<IconCheck width={16} height={16} />}
                    iconTone={r.action === 'INSERT' ? 'mint' : 'violet'}
                    title={describe(r)}
                    sub={ago(r.occurred_at)}
                  />
                ))}
              </List>
            )}
          </Panel>
        </div>
      </div>
    </Screen>
  );
}

/** A feed line a member can read, rather than a table name and a row id. */
function describe(r: AuditRow): string {
  const d = (r.new_data ?? r.old_data ?? {}) as Record<string, unknown>;
  const amt = (k: string) => {
    const v = d[k];
    return typeof v === 'number' || typeof v === 'string' ? formatPaise(v) : '';
  };

  switch (r.table_name) {
    case 'contributions':
      return `Contribution of ${amt('amount_paise')} recorded`;
    case 'loans':
      if (r.action === 'INSERT') return `Loan of ${amt('principal_paise')} requested`;
      return `Loan ${String(d.status ?? 'updated')}`;
    case 'loan_repayments':
      return `Repayment of ${amt('principal_paise')} received`;
    case 'expenses':
      return `${String(d.description ?? 'Expense')} — ${amt('amount_paise')}`;
    case 'cash_ledger':
      return `Cash ${d.direction === 'in' ? 'in' : 'out'} ${amt('amount_paise')}`;
    default:
      return `${r.table_name} ${r.action.toLowerCase()}`;
  }
}
