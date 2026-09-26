import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { useFund } from '../context/FundContext';
import { useSession } from '../context/SessionContext';
import { useQuery } from '../hooks/useQuery';
import { supabase } from '../lib/supabase';
import { formatPaise, formatPaiseShort } from '../lib/money';
import { haptic } from '../lib/haptics';
import { toDateString, today } from '../lib/dates';
import {
  Hero, Chip, Notice, Panel, Stat, List, Row, Empty,
  initials, ago, fmtDate, SkeletonList, Sheet, roleLabel, labelForStatus,
} from '../components/ui';
import {
  IconInbox, IconCheck, IconShare, IconWallet, IconDeposits, IconLoans, IconExpenses,
  IconTreasury, IconMeeting, IconHelp,
} from '../components/icons';
import type {
  MemberPosition, LoanRow, AuditRow, UnpaidRow, FundSummary,
  ContributionPeriod, Contribution, GroupInvite, Meeting,
} from '../lib/types';
import { FundGrowthChart } from '../components/FundGrowthChart';

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

  const inviteQ = useQuery<GroupInvite | null>('invite:active', async () => {
    let q = supabase
      .from('group_invites').select('*')
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1);
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    return (data as GroupInvite) ?? null;
  });

  const pastPeriodsQ = useQuery<ContributionPeriod[]>('periods:past', async () => {
    let q = supabase
      .from('contribution_periods')
      .select('*')
      .order('period_month', { ascending: true })
      .limit(6);
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as ContributionPeriod[];
  });

  const nextMeetingQ = useQuery<Meeting | null>('meetings:next', async () => {
    let q = supabase
      .from('meetings')
      .select('*')
      .gte('held_on', today())
      .order('held_on', { ascending: true })
      .limit(1);
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    return (data as Meeting) ?? null;
  });

  const chartPoints = useMemo(() => {
    const periods = [...(pastPeriodsQ.data ?? [])];
    periods.sort((a: ContributionPeriod, b: ContributionPeriod) => a.period_month.localeCompare(b.period_month));
    if (periods.length < 2) return [];

    const totalFund = fund?.total_fund_paise ?? 0;
    const count = periods.length;
    return periods.map((p: ContributionPeriod, idx: number) => {
      const d = new Date(p.period_month);
      const label = d.toLocaleDateString('en-US', { month: 'short' });
      const factor = (idx + 1) / count;
      const cap = Math.round(totalFund * factor);
      const interest = Math.round(cap * 0.05);
      return {
        label,
        month: p.period_month.slice(0, 7),
        capital: cap,
        interest,
      };
    });
  }, [pastPeriodsQ.data, fund?.total_fund_paise]);

  const memberNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of positions.data ?? []) {
      map.set(p.member_id, p.full_name);
    }
    return map;
  }, [positions.data]);

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

  const nextMeeting = nextMeetingQ.data;
  const daysToMeeting = nextMeeting
    ? Math.ceil((new Date(nextMeeting.held_on).getTime() - new Date(today()).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return (
    <>
      <Screen
        title="Overview"
        sub={homeSub}
        action={
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              haptic(10);
              nav('/help');
            }}
            aria-label="User Guide & Tutorials"
            title="User Guide & Tutorials"
          >
            <IconHelp width={17} height={17} />
          </button>
        }
      >
        {/* ======================================= 1. PERSONAL STANDING CARD */}
        {myPosition && (
          <div
            className="panel"
            style={{
              background: 'linear-gradient(145deg, var(--surface), var(--surface-2))',
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--r-lg)',
              padding: 18,
              boxShadow: 'var(--shadow-1)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="dim" style={{ fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 650 }}>
                  Your Account
                </span>
                <span className="tag mint" style={{ fontSize: '0.72rem' }}>
                  {roleLabel(role)}
                </span>
              </div>
              <span className="dim" style={{ fontSize: '0.82rem' }}>
                {Number(myPosition.share_pct).toFixed(1)}% group share
              </span>
            </div>

            <div className="stats three" style={{ margin: 0 }}>
              <Stat
                k="You have saved"
                v={formatPaiseShort(myPosition.contributed_paise)}
                s="total accumulated"
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
                s={myPosition.outstanding_paise > 0 ? 'to repay' : `can borrow up to ${formatPaiseShort(fund?.per_member_cap_paise ?? 0)}`}
                tone={myPosition.outstanding_paise > 0 ? 'coral' : undefined}
              />
            </div>

            {/* Quick contextual CTA */}
            {dueThisMonth > 0 && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.86rem', color: myUnpaid?.is_overdue ? 'var(--coral)' : 'var(--amber)' }}>
                  {myUnpaid?.is_overdue ? '⚠️ Payment overdue' : 'Payment due this month'}
                </span>
                <button
                  type="button"
                  className="sec-link"
                  style={{
                    background: 'var(--mint-ghost)',
                    color: 'var(--mint)',
                    padding: '5px 12px',
                    borderRadius: 'var(--r-sm)',
                    fontWeight: 600,
                    fontSize: '0.82rem',
                  }}
                  onClick={() => {
                    haptic(10);
                    nav('/deposits');
                  }}
                >
                  View Deposits →
                </button>
              </div>
            )}
          </div>
        )}

        {/* ======================================= 1B. QUICK ACTIONS BAR */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, margin: '2px 0' }}>
          <button
            type="button"
            className="sec-link"
            onClick={() => {
              haptic(10);
              nav('/deposits');
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '12px 6px',
              background: 'var(--surface)',
              borderRadius: 'var(--r)',
              border: '1px solid var(--hairline)',
              textAlign: 'center',
            }}
          >
            <span
              style={{
                width: 38,
                height: 38,
                borderRadius: '50%',
                background: 'var(--mint-ghost)',
                color: 'var(--mint)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <IconDeposits width={17} height={17} />
            </span>
            <span style={{ fontSize: '0.74rem', fontWeight: 650, color: 'var(--text)' }}>
              Deposit
            </span>
          </button>

          <button
            type="button"
            className="sec-link"
            onClick={() => {
              haptic(10);
              nav('/loans/new');
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '12px 6px',
              background: 'var(--surface)',
              borderRadius: 'var(--r)',
              border: '1px solid var(--hairline)',
              textAlign: 'center',
            }}
          >
            <span
              style={{
                width: 38,
                height: 38,
                borderRadius: '50%',
                background: 'var(--amber-ghost)',
                color: 'var(--amber)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <IconLoans width={17} height={17} />
            </span>
            <span style={{ fontSize: '0.74rem', fontWeight: 650, color: 'var(--text)' }}>
              Get Loan
            </span>
          </button>

          <button
            type="button"
            className="sec-link"
            onClick={() => {
              haptic(10);
              if (inviteQ.data) {
                const link = `${window.location.origin}/join?code=${inviteQ.data.code}`;
                const text = `👋 Join our savings group *${group?.name || 'SavingsClub'}*!\n\n` +
                  `Use this invite link:\n${link}\n\n` +
                  `Or enter code in the app: *${inviteQ.data.code}*\n` +
                  `(Code expires in 7 days)`;
                window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
              } else {
                nav('/settings');
              }
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '12px 6px',
              background: 'var(--surface)',
              borderRadius: 'var(--r)',
              border: '1px solid var(--hairline)',
              textAlign: 'center',
            }}
          >
            <span
              style={{
                width: 38,
                height: 38,
                borderRadius: '50%',
                background: 'var(--violet-ghost)',
                color: 'var(--violet)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <IconShare width={17} height={17} />
            </span>
            <span style={{ fontSize: '0.74rem', fontWeight: 650, color: 'var(--text)' }}>
              Invite
            </span>
          </button>

          <button
            type="button"
            className="sec-link"
            onClick={() => {
              haptic(10);
              setReportOpen(true);
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '12px 6px',
              background: 'var(--surface)',
              borderRadius: 'var(--r)',
              border: '1px solid var(--hairline)',
              textAlign: 'center',
            }}
          >
            <span
              style={{
                width: 38,
                height: 38,
                borderRadius: '50%',
                background: 'var(--surface-3)',
                color: 'var(--text-2)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <IconTreasury width={17} height={17} />
            </span>
            <span style={{ fontSize: '0.74rem', fontWeight: 650, color: 'var(--text)' }}>
              Statement
            </span>
          </button>
        </div>

        {/* Upcoming Meeting Banner */}
        {nextMeeting && (
          <div
            className="panel"
            style={{
              background: 'linear-gradient(135deg, var(--surface-2), var(--surface))',
              border: '1px solid var(--accent)',
              padding: '14px 16px',
              borderRadius: 'var(--r-lg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              margin: '10px 0',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <span
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 'var(--r-sm)',
                  background: 'var(--accent-ghost)',
                  color: 'var(--accent)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flex: 'none',
                }}
              >
                <IconMeeting width={18} height={18} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text)' }}>
                    Next Group Meeting
                  </span>
                  <span
                    style={{
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      background: daysToMeeting === 0 ? 'var(--mint-ghost)' : 'var(--surface-3)',
                      color: daysToMeeting === 0 ? 'var(--mint)' : 'var(--text-2)',
                      padding: '2px 6px',
                      borderRadius: 4,
                    }}
                  >
                    {daysToMeeting === 0 ? 'Today' : daysToMeeting === 1 ? 'Tomorrow' : `In ${daysToMeeting} days`}
                  </span>
                </div>
                <div className="dim" style={{ fontSize: '0.78rem', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  📅 {fmtDate(nextMeeting.held_on)} {nextMeeting.note ? `· ${nextMeeting.note}` : ''}
                </div>
              </div>
            </div>

            <button
              type="button"
              className="sec-link"
              style={{
                background: 'var(--mint-ghost)',
                color: 'var(--mint)',
                padding: '6px 12px',
                borderRadius: 'var(--r-sm)',
                fontSize: '0.8rem',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                flex: 'none',
              }}
              onClick={() => {
                haptic(10);
                const text = `📢 *Upcoming Meeting Reminder — ${group?.name || 'SavingsClub'}*\n\n` +
                  `📅 *Date*: ${fmtDate(nextMeeting.held_on)}\n` +
                  (nextMeeting.note ? `📝 *Agenda*: ${nextMeeting.note}\n` : '') +
                  (nextMeeting.absent_fee_paise > 0 ? `⚠️ *Absent Fine*: ${formatPaise(nextMeeting.absent_fee_paise)}\n\n` : '\n') +
                  `Please attend on time! See you there.`;
                window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
              }}
            >
              <IconShare width={13} height={13} />
              Share
            </button>
          </div>
        )}

        {/* Visual Fund Growth & Member Return Chart */}
        {chartPoints.length >= 2 && (
          <FundGrowthChart points={chartPoints} mySharePct={myPosition?.share_pct} />
        )}

        {/* ======================================= 2. ACTION CENTER */}
        {myVoteNeeded.length > 0 && (
          <Notice tone="warn" onClick={() => { haptic(10); nav('/loans'); }}>
            <strong>🗳️ {myVoteNeeded.length} loan request{myVoteNeeded.length > 1 ? 's' : ''}</strong> waiting for your approval vote — tap to review
          </Notice>
        )}
        {alerts.map((a) => (
          <Notice key={a.id} tone={a.severity === 'danger' ? 'danger' : 'warn'} onClick={() => { haptic(10); nav(a.to); }}>
            {a.message}
          </Notice>
        ))}

        {/* ======================================= 3. GROUP VAULT (COMMUNITY FUND) */}
        {fund && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 2px' }}>
              <h2 style={{ fontSize: '1.15rem', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>
                Group Vault
              </h2>
              <button
                type="button"
                className="sec-link"
                style={{ fontSize: '0.82rem', fontWeight: 600 }}
                onClick={() => {
                  haptic(10);
                  setReportOpen(true);
                }}
              >
                Statement →
              </button>
            </div>

            <Hero
              label="Total Pooled Savings"
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

            <div
              style={{
                padding: '11px 14px',
                background: 'var(--surface)',
                borderRadius: 'var(--r-sm)',
                border: '1px solid var(--hairline)',
                fontSize: '0.82rem',
                color: 'var(--text-2)',
                lineHeight: 1.45,
                display: 'flex',
                alignItems: 'center',
                gap: 9,
              }}
            >
              <span style={{ flex: 'none', fontSize: '1.05rem' }}>🛡️</span>
              <div>
                <b>{formatPaiseShort(fund.reserve_paise)}</b> safety reserve locked.
                {config ? ` Group earns ${(config.loan_rate_bp / 100).toFixed(1)}% monthly interest on active loans.` : ''}
              </div>
            </div>
          </div>
        )}

        <div className="two-col">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {/* Recent Activity Feed */}
            <Panel
              title="Recent Activity"
              flush
              action={
                <button
                  className="sec-link"
                  onClick={() => {
                    haptic(10);
                    nav('/audit');
                  }}
                >
                  History
                </button>
              }
            >
              {(feed.data ?? []).length === 0 ? (
                <Empty icon={<IconInbox width={22} height={22} />}>
                  No activity recorded yet.
                </Empty>
              ) : (
                <List>
                  {(feed.data ?? []).map((row) => (
                    <Row
                      key={row.id}
                      icon={
                        row.table_name === 'contributions' ? <IconDeposits width={17} height={17} />
                          : row.table_name === 'loans' ? <IconLoans width={17} height={17} />
                            : row.table_name === 'loan_repayments' ? <IconCheck width={17} height={17} />
                              : row.table_name === 'expenses' ? <IconExpenses width={17} height={17} />
                                : <IconWallet width={17} height={17} />
                      }
                      iconTone={
                        row.table_name === 'contributions' ? 'mint'
                          : row.table_name === 'loans' ? 'violet'
                            : row.table_name === 'loan_repayments' ? 'mint'
                              : row.table_name === 'expenses' ? 'amber'
                                : 'coral'
                      }
                      title={describe(row, memberNames)}
                      sub={ago(row.occurred_at)}
                      chevron
                      onClick={() => {
                        haptic(10);
                        nav('/audit');
                      }}
                    />
                  ))}
                </List>
              )}
            </Panel>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {/* Members Savings Leaderboard */}
            <Panel
              title="Member Savings"
              flush
              action={
                <button
                  className="sec-link"
                  onClick={() => {
                    haptic(10);
                    nav('/members');
                  }}
                >
                  See all
                </button>
              }
            >
              {(positions.data ?? []).length === 0 ? (
                <Empty icon={<IconCheck width={22} height={22} />}>No members found.</Empty>
              ) : (
                <List>
                  {(positions.data ?? []).slice(0, 5).map((pos) => (
                    <Row
                      key={pos.member_id}
                      icon={initials(pos.full_name)}
                      title={pos.full_name}
                      sub={pos.role === 'member' ? `${pos.periods_paid} months paid` : `${roleLabel(pos.role)} · ${pos.periods_paid} months`}
                      amount={formatPaiseShort(pos.contributed_paise)}
                      note={`${Number(pos.share_pct).toFixed(0)}%`}
                      chevron
                      onClick={() => {
                        haptic(10);
                        nav('/members');
                      }}
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
function describe(r: AuditRow, memberNames?: Map<string, string>): string {
  const d = (r.new_data ?? r.old_data ?? {}) as Record<string, unknown>;
  const amt = (k: string) => {
    const v = d[k];
    return typeof v === 'number' || typeof v === 'string' ? formatPaise(v) : '';
  };
  const memberName = (k = 'member_id') => {
    const id = d[k];
    return id && memberNames ? memberNames.get(String(id)) : undefined;
  };

  switch (r.table_name) {
    case 'contributions': {
      const who = memberName();
      return who ? `${amt('amount_paise')} paid in · ${who}` : `${amt('amount_paise')} paid in`;
    }
    case 'loans': {
      const who = d.outside_borrower_name ? String(d.outside_borrower_name) : memberName('borrower_id');
      const suffix = who ? ` · ${who}` : '';
      if (r.action === 'INSERT') return `Loan asked for — ${amt('principal_paise')}${suffix}`;
      return `Loan ${labelForStatus(String(d.status ?? 'updated'))}${suffix}`;
    }
    case 'loan_repayments': {
      const who = memberName('recorded_by');
      return who ? `${amt('principal_paise')} paid back · by ${who}` : `${amt('principal_paise')} paid back`;
    }
    case 'expenses':
      return `${String(d.description ?? 'Expense')} — ${amt('amount_paise')}`;
    case 'cash_ledger': {
      const cp = d.counterparty ? ` · ${String(d.counterparty)}` : '';
      return `Cash ${d.direction === 'in' ? 'in' : 'out'} ${amt('amount_paise')}${cp}`;
    }
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

_Sent from SavingsClub_`;

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

