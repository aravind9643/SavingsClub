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
  initials, ago, fmtDate, SkeletonList, Sheet, roleLabel, labelForStatus,
} from '../components/ui';
import {
  IconPlus, IconArrowUp, IconArrowDown, IconBank, IconInbox, IconCheck, IconShare,
  IconWallet,
} from '../components/icons';
import type {
  MemberPosition, BankStatement, LoanRow, AuditRow, UnpaidRow, FundSummary,
  ContributionPeriod, Contribution,
} from '../lib/types';

export default function Dashboard() {
  const nav = useNavigate();
  const { fund, alerts, loading } = useFund();
  const { member, config, group, currentGroupId, role } = useSession();
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
    v: 'Not started',
    s: 'this month is not open yet',
    tone: undefined as 'mint' | 'amber' | 'coral' | undefined,
  };

  if (latestPeriod.data) {
    if (myUnpaid) {
      monthStat = {
        v: formatPaiseShort(myUnpaid.shortfall_paise),
        s: myUnpaid.is_overdue ? 'overdue' : `due ${fmtDate(myUnpaid.due_date)}`,
        tone: myUnpaid.is_overdue ? 'coral' : 'amber',
      };
    } else if (myPaidContrib.data) {
      monthStat = {
        v: 'Paid',
        s: 'thank you',
        tone: 'mint',
      };
    } else {
      monthStat = {
        v: 'Nothing due',
        s: 'you joined after this month',
        tone: undefined,
      };
    }
  }

  const myVoteNeeded = (pending.data ?? []).filter((l) => l.can_i_vote);
  const diff = lastStatement.data?.difference_paise;

  // The subtitle carries the one thing worth knowing before you scroll: what
  // you owe this month, or that you are clear. A greeting went here before --
  // "Morning, Aravind" -- which told the reader the time of day and their own
  // name, then pushed the fund total off the top of the screen. It also made
  // the header the only part of the app that changes for no reason, which is
  // how a region trains people to stop looking at it.
  // The shortfall, not the full month -- a part payment must reduce what
  // the member is told they owe, or the figure contradicts their receipt.
  const dueThisMonth = myUnpaid?.shortfall_paise ?? 0;
  const homeSub = dueThisMonth > 0
    ? `${formatPaiseShort(dueThisMonth)} ${myUnpaid?.is_overdue ? 'late' : 'to pay this month'}`
    : myPosition
      ? `${formatPaiseShort(myPosition.contributed_paise)} saved · nothing to pay`
      : undefined;

  // Who may actually do each thing, matching the RPCs exactly. Offering an
  // action the database will refuse is worse than not offering it: the person
  // fills in a form, presses save, and gets a permission error for something
  // they were invited to do.
  //
  // record_contribution / record_repayment / record_bank_statement:
  //   cashier or accountant only -- the admin is deliberately NOT a money
  //   handler, which is the whole point of separating the offices.
  const isMoneyHandler = role === 'cashier' || role === 'accountant';
  const isCashier = role === 'cashier';

  return (
    <>
      <Screen
      title="Home"
      sub={homeSub}
      action={
        // The initials are decorative; the label is what a screen reader
        // announces, so it carries the name the header no longer prints.
        <button
          className="icon-btn avatar"
          onClick={() => nav('/more')}
          aria-label={member?.full_name ? `${member.full_name} — profile and settings` : 'Profile'}
        >
          {initials(member?.full_name)}
        </button>
      }
    >
      {fund && (
        // The group name is already in the header chip a few pixels above, so
        // the hero's one label goes to what the number actually is.
        <Hero
          label="Total fund"
          paise={fund.total_fund_paise}
          meta={
            <>
              <Chip tone="mint">
                Can lend <b>{formatPaiseShort(fund.still_lendable_paise)}</b>
              </Chip>
              <Chip tone="violet">
                On loan <b>{formatPaiseShort(fund.outstanding_paise)}</b>
              </Chip>
              <Chip>
                Kept back <b>{formatPaiseShort(fund.reserve_paise)}</b>
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
        <Panel title="Where you stand">
          <div className="stats three">
            <Stat
              k="You have saved"
              v={formatPaiseShort(myPosition.contributed_paise)}
              s={`${Number(myPosition.share_pct).toFixed(0)}% of the fund`}
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
              s={myPosition.outstanding_paise > 0 ? 'still to repay' : 'nothing to repay'}
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
              {/* Recording money is the cashier's and accountant's job. For
                  everyone else this row becomes "see who has paid", which is
                  what the same screen offers them. */}
              <Row
                icon={<IconArrowDown width={18} height={18} />}
                iconTone="mint"
                title={isMoneyHandler ? 'Take a payment' : "This month's collection"}
                sub={isMoneyHandler
                  ? 'Record money received'
                  : 'See who has paid so far'}
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
                sub="Trip, party or running cost"
                onClick={() => nav('/expenses')}
                chevron
              />
              {isCashier && (
                <Row
                  icon={<IconWallet width={18} height={18} />}
                  iconTone="violet"
                  title="Cash in or out"
                  sub="Money the cashier holds"
                  onClick={() => nav('/cash')}
                  chevron
                />
              )}
              {isMoneyHandler && (
                <Row
                  icon={<IconBank width={18} height={18} />}
                  iconTone="coral"
                  title="Check the bank"
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
              )}
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
                  k="Cash in hand"
                  v={formatPaiseShort(fund.cash_float_paise)}
                  s={`of ${formatPaiseShort(fund.cash_float_limit_paise)}`}
                  tone={fund.cash_float_paise > fund.cash_float_limit_paise ? 'coral' : undefined}
                />
                <Stat
                  k="Difference"
                  v={diff === undefined ? '—' : formatPaiseShort(diff)}
                  s={diff === 0 ? 'matches' : diff === undefined ? 'not checked yet' : 'does not match'}
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
                    sub={p.role === 'member' ? `${Number(p.share_pct).toFixed(0)}% of the fund` : roleLabel(p.role)}
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
      return `${amt('amount_paise')} paid in`;
    case 'loans':
      if (r.action === 'INSERT') return `Loan asked for — ${amt('principal_paise')}`;
      return `Loan ${labelForStatus(String(d.status ?? 'updated'))}`;
    case 'loan_repayments':
      return `${amt('principal_paise')} paid back`;
    case 'expenses':
      return `${String(d.description ?? 'Expense')} — ${amt('amount_paise')}`;
    case 'cash_ledger':
      return `Cash ${d.direction === 'in' ? 'in' : 'out'} ${amt('amount_paise')}`;
    // A table name is not a sentence. Anything unmapped says something true
    // and plain rather than printing 'loan_votes update' at the reader.
    default:
      return r.action === 'INSERT' ? 'Something was added'
        : r.action === 'DELETE' ? 'Something was removed'
          : 'Something was changed';
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

  // This is the text people paste into the group's WhatsApp, so it is the most
  // widely read copy in the app. It used to be the least plain -- "Statutory
  // Reserve", "Lending Capacity", "Members & Equity".
  const text = `📊 *${groupName} — ${dateStr}*

💰 *Our money*
• Total fund: ${formatPaise(fund.total_fund_paise)}
• Should be in the bank: ${formatPaise(fund.expected_bank_balance_paise)}
• Cash in hand: ${formatPaise(fund.cash_float_paise)}
• Kept back as safety: ${formatPaise(fund.reserve_paise)}

📈 *Loans*
• Money on loan: ${formatPaise(fund.outstanding_paise)}
• Can lend now: ${formatPaise(fund.still_lendable_paise)}

👥 *Members*
• Members: ${positions.length}
• Collected so far: ${formatPaise(totalContributed)}

_Sent from Sanchay_`;

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
      ['What', 'Amount (Rupees)'],
      ['Total fund', (fund.total_fund_paise / 100).toFixed(2)],
      ['Should be in the bank', (fund.expected_bank_balance_paise / 100).toFixed(2)],
      ['Cash in hand', (fund.cash_float_paise / 100).toFixed(2)],
      ['Kept back as safety', (fund.reserve_paise / 100).toFixed(2)],
      ['Money on loan', (fund.outstanding_paise / 100).toFixed(2)],
      ['Can lend now', (fund.still_lendable_paise / 100).toFixed(2)],
      [],
      ['Member', 'Role', 'Saved (Rs)', 'Share of fund %', 'Still owes (Rs)'],
      ...positions.map((p) => [
        `"${p.full_name.replace(/"/g, '""')}"`,
        roleLabel(p.role),
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
    <Sheet open title="This month's summary" onClose={onClose}>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: '1.8rem', fontWeight: 700, fontFamily: 'var(--display)' }}>
          {formatPaise(fund.total_fund_paise)}
        </div>
        <p className="dim" style={{ marginTop: 4 }}>
          {groupName} · {dateStr}
        </p>
      </div>

      <Panel title="Where the money is" flush>
        <List>
          <Row title="Should be in the bank" amount={formatPaise(fund.expected_bank_balance_paise)} amountTone="mint" />
          <Row title="Cash in hand" amount={formatPaise(fund.cash_float_paise)} />
          <Row title="Money on loan" amount={formatPaise(fund.outstanding_paise)} />
          <Row title="Kept back as safety" amount={formatPaise(fund.reserve_paise)} />
          <Row title="Can lend now" amount={formatPaise(fund.still_lendable_paise)} amountTone="mint" />
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

