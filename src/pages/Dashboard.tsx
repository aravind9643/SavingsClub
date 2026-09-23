import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { useFund } from '../context/FundContext';
import { useSession } from '../context/SessionContext';
import { useQuery } from '../hooks/useQuery';
import { supabase } from '../lib/supabase';
import { formatPaise, formatPaiseShort } from '../lib/money';
import { haptic } from '../lib/haptics';
import { toDateString } from '../lib/dates';
import {
  Hero, Chip, Notice, Panel, Stat, List, Row, Empty,
  initials, ago, fmtDate, SkeletonList, Sheet,
} from '../components/ui';
import {
  IconPlus, IconArrowUp, IconArrowDown, IconBank, IconInbox, IconCheck, IconShare,
} from '../components/icons';
import type {
  MemberPosition, BankStatement, LoanRow, AuditRow, UnpaidRow, FundSummary,
  ContributionPeriod, Contribution,
} from '../lib/types';

export default function Dashboard() {
  const nav = useNavigate();
  const { fund, alerts, loading } = useFund();
  const { member, config, group, currentGroupId } = useSession();
  const [reportOpen, setReportOpen] = useState(false);

  const positions = useQuery<MemberPosition[]>('positions', async () => {
    let q = supabase
      .from('v_member_positions').select('*').order('contributed_paise', { ascending: false });
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as MemberPosition[];
  });

  const unpaidQ = useQuery<UnpaidRow[]>('unpaid:mine', async () => {
    let q = supabase
      .from('v_unpaid_contributions').select('*');
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as UnpaidRow[];
  });

  const lastStatement = useQuery<BankStatement | null>('bank:last', async () => {
    let q = supabase
      .from('bank_statements').select('*')
      .order('as_of', { ascending: false }).limit(1);
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    return (data as BankStatement) ?? null;
  });

  const pending = useQuery<LoanRow[]>('loans:pending', async () => {
    let q = supabase
      .from('v_loan_status').select('*').eq('status', 'requested');
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as LoanRow[];
  });

  const feed = useQuery<AuditRow[]>('feed', async () => {
    let q = supabase
      .from('audit_log').select('*')
      .in('table_name', ['contributions', 'loans', 'loan_repayments', 'expenses', 'cash_ledger'])
      .order('occurred_at', { ascending: false }).limit(6);
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as AuditRow[];
  });

  const latestPeriod = useQuery<ContributionPeriod | null>('periods:latest', async () => {
    let q = supabase
      .from('contribution_periods')
      .select('*')
      .order('period_month', { ascending: false })
      .limit(1);
    if (currentGroupId) {
      q = q.eq('group_id', currentGroupId);
    }
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    return (data as ContributionPeriod) ?? null;
  });

  const myPaidContrib = useQuery<Contribution | null>(
    latestPeriod.data && member ? `contrib:${latestPeriod.data.id}:${member.id}` : null,
    async () => {
      if (!latestPeriod.data || !member) return null;
      let q = supabase
        .from('contributions')
        .select('*')
        .eq('period_id', latestPeriod.data.id)
        .eq('member_id', member.id);
      if (currentGroupId) {
        q = q.eq('group_id', currentGroupId);
      }
      const { data, error } = await q.maybeSingle();
      if (error) throw error;
      return (data as Contribution) ?? null;
    },
  );

  if (loading && !fund) {
    return (
      <Screen title="Home">
        <div className="hero skeleton" style={{ height: 168 }} />
        <SkeletonList rows={3} />
      </Screen>
    );
  }

  const myPosition = (positions.data ?? []).find((p) => p.member_id === member?.id);
  const myUnpaid = (unpaidQ.data ?? []).find((u) => u.member_id === member?.id);

  let monthStat = {
    v: 'Not opened',
    s: 'no active period',
    tone: undefined as 'mint' | 'amber' | 'coral' | undefined,
  };

  if (latestPeriod.data) {
    if (myUnpaid) {
      monthStat = {
        v: formatPaiseShort(myUnpaid.expected_paise),
        s: myUnpaid.is_overdue ? 'overdue' : `due ${fmtDate(myUnpaid.due_date)}`,
        tone: myUnpaid.is_overdue ? 'coral' : 'amber',
      };
    } else if (myPaidContrib.data) {
      monthStat = {
        v: 'Paid',
        s: 'up to date',
        tone: 'mint',
      };
    } else {
      monthStat = {
        v: 'Not due',
        s: 'exempt',
        tone: undefined,
      };
    }
  }

  const myVoteNeeded = (pending.data ?? []).filter((l) => l.can_i_vote);
  const diff = lastStatement.data?.difference_paise;
  const hour = new Date().getHours();
  const greetingTitle = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';

  return (
    <>
      <Screen
      title={greetingTitle}
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
          meter={
            fund.lendable_paise > 0
              ? { value: fund.outstanding_paise, limit: fund.lendable_paise }
              : undefined
          }
        />
      )}

      {/* Personal standing for the logged-in member */}
      {myPosition && (
        <Panel title="Your standing">
          <div className="stats three">
            <Stat
              k="Your savings"
              v={formatPaiseShort(myPosition.contributed_paise)}
              s={`${Number(myPosition.share_pct).toFixed(0)}% fund share`}
              tone="mint"
            />
            <Stat
              k="This month"
              v={monthStat.v}
              s={monthStat.s}
              tone={monthStat.tone}
            />
            <Stat
              k="Active loan"
              v={myPosition.outstanding_paise > 0 ? formatPaiseShort(myPosition.outstanding_paise) : 'None'}
              s={myPosition.outstanding_paise > 0 ? 'outstanding' : 'debt free'}
              tone={myPosition.outstanding_paise > 0 ? 'coral' : undefined}
            />
          </div>
        </Panel>
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
      {!loading && alerts.length === 0 && myVoteNeeded.length === 0 && (
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
            <Panel
              title="This month"
              action={
                <button
                  className="sec-link"
                  onClick={() => {
                    haptic(10);
                    setReportOpen(true);
                  }}
                >
                  Report
                </button>
              }
            >
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

    {reportOpen && fund && (
      <MonthlyReportSheet
        groupName={group?.name ?? 'Savings Group'}
        fund={fund}
        positions={positions.data ?? []}
        onClose={() => setReportOpen(false)}
      />
    )}
  </>
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

function MonthlyReportSheet({
  groupName, fund, positions, onClose,
}: {
  groupName: string;
  fund: FundSummary;
  positions: MemberPosition[];
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const totalContributed = positions.reduce((s, p) => s + p.contributed_paise, 0);

  const text = `📊 *${groupName} — Monthly Group Statement*
📅 *Period:* ${dateStr}

💰 *Fund Overview:*
• Total Fund: ${formatPaise(fund.total_fund_paise)}
• In Bank (Expected): ${formatPaise(fund.expected_bank_balance_paise)}
• Cash Float: ${formatPaise(fund.cash_float_paise)}
• 25% Statutory Reserve: ${formatPaise(fund.reserve_paise)}

📈 *Lending Status:*
• Outstanding Loans: ${formatPaise(fund.outstanding_paise)}
• Lending Capacity Left: ${formatPaise(fund.still_lendable_paise)}

👥 *Members & Equity:*
• Total Members: ${positions.length}
• Total Savings Contributed: ${formatPaise(totalContributed)}

_Generated via Sanchay Ledger_`;

  async function share() {
    haptic(12);
    if (navigator.share) {
      try {
        await navigator.share({
          title: `${groupName} - Statement (${dateStr})`,
          text,
        });
        return;
      } catch {
        /* fallback to wa.me */
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }

  async function copy() {
    haptic(10);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  function downloadCsv() {
    haptic(15);
    const rows: string[][] = [
      ['Group Financial Report', groupName],
      ['Date', now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })],
      [],
      ['Fund Metric', 'Amount (Rupees)'],
      ['Total Fund', (fund.total_fund_paise / 100).toFixed(2)],
      ['Expected Bank Balance', (fund.expected_bank_balance_paise / 100).toFixed(2)],
      ['Cash Float', (fund.cash_float_paise / 100).toFixed(2)],
      ['25% Statutory Reserve', (fund.reserve_paise / 100).toFixed(2)],
      ['Outstanding Loans Principal', (fund.outstanding_paise / 100).toFixed(2)],
      ['Lendable Capacity', (fund.still_lendable_paise / 100).toFixed(2)],
      [],
      ['Member Directory', 'Role', 'Total Contributed (Rs)', 'Fund Share %', 'Outstanding Debt (Rs)'],
      ...positions.map((p) => [
        `"${p.full_name.replace(/"/g, '""')}"`,
        p.role,
        (p.contributed_paise / 100).toFixed(2),
        `${Number(p.share_pct).toFixed(1)}%`,
        (p.outstanding_paise / 100).toFixed(2),
      ]),
    ];

    const csvContent = 'data:text/csv;charset=utf-8,' + rows.map((e) => e.join(',')).join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `${groupName.toLowerCase().replace(/\s+/g, '-')}-statement-${toDateString(now)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  return (
    <Sheet open title="Monthly Statement" onClose={onClose}>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: '1.8rem', fontWeight: 700, fontFamily: 'var(--display)' }}>
          {formatPaise(fund.total_fund_paise)}
        </div>
        <p className="dim" style={{ marginTop: 4 }}>
          {groupName} · {dateStr}
        </p>
      </div>

      <Panel title="Fund summary" flush>
        <List>
          <Row title="Bank expected balance" amount={formatPaise(fund.expected_bank_balance_paise)} amountTone="mint" />
          <Row title="Cash float" amount={formatPaise(fund.cash_float_paise)} />
          <Row title="Money on loan" amount={formatPaise(fund.outstanding_paise)} />
          <Row title="25% Minimum reserve" amount={formatPaise(fund.reserve_paise)} />
          <Row title="Available to lend" amount={formatPaise(fund.still_lendable_paise)} amountTone="mint" />
          <Row title="Active members" note={`${positions.length} members`} />
        </List>
      </Panel>

      <div className="btn-row stack" style={{ marginTop: 20 }}>
        <button type="button" className="primary lg" onClick={() => void share()}>
          <IconShare width={16} height={16} style={{ marginRight: 8 }} />
          Share to WhatsApp
        </button>
        <button type="button" className="subtle" onClick={() => void copy()}>
          {copied ? 'Copied to clipboard!' : 'Copy text statement'}
        </button>
        <button type="button" className="subtle" onClick={downloadCsv}>
          Download Excel / CSV
        </button>
      </div>
    </Sheet>
  );
}

