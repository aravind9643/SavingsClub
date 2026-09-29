import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { useQuery, invalidate } from '../hooks/useQuery';
import { useSession } from './SessionContext';
import { formatPaise, formatPaiseShort } from '../lib/money';
import { daysBetween, today } from '../lib/dates';
import { fmtDate } from '../components/ui';
import type {
  FundSummary, CashAlert, LoanRow, UnpaidRow, PendingMember, ExpenseRow,
  ContributionPeriod, Distribution, BankStatement,
} from '../lib/types';

export const FUND_KEY = 'fund';

/**
 * `danger` is something wrong, `warn` is something someone must do, `info` is
 * a status the reader is waiting on -- their own loan request, say. All three
 * belong on Home: a member who asked for a loan should not have to open the
 * Loans tab to learn it is still one vote short.
 */
export interface Alert {
  id: string;
  severity: 'danger' | 'warn' | 'info';
  message: string;
  to: string;
}

interface FundValue {
  fund: FundSummary | undefined;
  alerts: Alert[];
  loading: boolean;
  error: string | null;
  /** Every query behind the alert list that failed. A failed query must not
      read as "nothing needs attention". */
  errors: string[];
  /** True once every alert query has answered, so "all caught up" is only
      ever said when it has actually been checked. */
  settled: boolean;
  retry: () => void;
}

const SEVERITY_ORDER: Record<Alert['severity'], number> = { danger: 0, warn: 1, info: 2 };

function monthName(periodMonth: string): string {
  const [y, m] = periodMonth.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long' });
}

const Ctx = createContext<FundValue | null>(null);

export function FundProvider({ children }: { children: ReactNode }) {
  const { member, currentGroupId, group, isOfficer, role } = useSession();
  const isMoneyHandler = role === 'cashier' || role === 'accountant';
  const enabled = Boolean(member && currentGroupId);

  // Group-level realtime live update across devices
  useEffect(() => {
    if (!currentGroupId) return;
    const ch = supabase.channel(`group-live-${currentGroupId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'contributions', filter: `group_id=eq.${currentGroupId}` },
        () => invalidate('fund', 'contributions', 'positions', 'feed'))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'loans', filter: `group_id=eq.${currentGroupId}` },
        () => invalidate('fund', 'loans', 'feed'))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'cash_ledger', filter: `group_id=eq.${currentGroupId}` },
        () => invalidate('fund', 'cash', 'feed'))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'expenses', filter: `group_id=eq.${currentGroupId}` },
        () => invalidate('fund', 'expenses', 'feed'))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'members', filter: `group_id=eq.${currentGroupId}` },
        () => invalidate('members', 'positions', 'fund'))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'role_assignments', filter: `group_id=eq.${currentGroupId}` },
        () => invalidate('fund', 'roles', 'members', 'positions'))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'loan_votes', filter: `group_id=eq.${currentGroupId}` },
        () => invalidate('fund', 'loans', 'feed'))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'bank_statements', filter: `group_id=eq.${currentGroupId}` },
        () => invalidate('fund', 'bank', 'feed'))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'loan_repayments', filter: `group_id=eq.${currentGroupId}` },
        () => invalidate('fund', 'loans', 'loan', 'positions', 'feed'))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'expense_votes', filter: `group_id=eq.${currentGroupId}` },
        () => invalidate('fund', 'expenses'))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'contribution_periods', filter: `group_id=eq.${currentGroupId}` },
        () => invalidate('fund', 'periods'))
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'distributions', filter: `group_id=eq.${currentGroupId}` },
        () => invalidate('fund', 'distributions'))
      .subscribe();

    return () => { void supabase.removeChannel(ch); };
  }, [currentGroupId]);

  const fundQ = useQuery<FundSummary>(enabled ? FUND_KEY : null, async () => {
    let q = supabase
      .from('v_fund_summary').select('*');
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q.single();
    if (error) throw error;
    return data as FundSummary;
  });

  // Every loan still in play, in one read: votes owed, the reader's own
  // requests, approved loans nobody has paid out, and loans falling behind are
  // all derived from it below.
  const openLoansQ = useQuery<LoanRow[]>(enabled ? `${FUND_KEY}:openloans` : null, async () => {
    let q = supabase
      .from('v_loan_status').select('*').in('status', ['requested', 'approved', 'disbursed']);
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as LoanRow[];
  });

  const periodsQ = useQuery<ContributionPeriod[]>(enabled ? `${FUND_KEY}:periods` : null, async () => {
    let q = supabase
      .from('contribution_periods').select('*')
      .order('period_month', { ascending: false }).limit(12);
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as ContributionPeriod[];
  });

  const distributionsQ = useQuery<Distribution[]>(enabled ? `${FUND_KEY}:distributions` : null, async () => {
    let q = supabase
      .from('distributions').select('*').eq('status', 'proposed');
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Distribution[];
  });

  // Officers only: they are the ones who can act on a mismatch.
  const bankQ = useQuery<BankStatement | null>(
    enabled && isOfficer ? `${FUND_KEY}:bank` : null,
    async () => {
      let q = supabase
        .from('bank_statements').select('*')
        .order('as_of', { ascending: false }).limit(1);
      if (currentGroupId) q = q.eq('group_id', currentGroupId);
      const { data, error } = await q.maybeSingle();
      if (error) throw error;
      return (data as BankStatement) ?? null;
    },
  );

  // Someone who joined with an invite code sits in `status = 'pending'` and
  // can read NOTHING until an officer approves them. Nothing told the officer,
  // so the joiner waited on a screen that never changed while the officer had
  // no reason to open Members. Officers only -- for everyone else the query
  // does not run.
  const pendingQ = useQuery<PendingMember[]>(
    enabled && isOfficer ? `${FUND_KEY}:pending` : null,
    async () => {
      const { data, error } = await supabase.rpc('pending_members');
      if (error) throw error;
      return (data ?? []) as PendingMember[];
    },
  );

  // Expense votes are surfaced on the expenses tab and nowhere else, while
  // loan votes get a dashboard line. Same mechanism, same deadlock if nobody
  // looks: an expense needs votes to pass and the voters are not told.
  const expenseQ = useQuery<ExpenseRow[]>(
    enabled ? `${FUND_KEY}:expenses` : null,
    async () => {
      let q = supabase
        .from('v_expense_status').select('*').eq('status', 'proposed');
      if (currentGroupId) q = q.eq('group_id', currentGroupId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ExpenseRow[];
    },
  );

  const cashQ = useQuery<CashAlert[]>(enabled ? `${FUND_KEY}:cash` : null, async () => {
    let q = supabase
      .from('v_cash_alerts').select('*').eq('reporting_breached', true);
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as CashAlert[];
  });

  // All shortfalls, not only overdue ones: the reader's own amount due is an
  // action before it is late.
  const unpaidQ = useQuery<UnpaidRow[]>(enabled ? `${FUND_KEY}:unpaid` : null, async () => {
    let q = supabase
      .from('v_unpaid_contributions').select('*');
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as UnpaidRow[];
  });

  const offices = useQuery<{ role: string }[]>(enabled ? `${FUND_KEY}:roles` : null, async () => {
    let q = supabase
      .from('role_assignments').select('role').is('end_date', null);
    if (currentGroupId) {
      q = q.eq('group_id', currentGroupId);
    }
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as { role: string }[];
  });

  const memberCountQ = useQuery<number>(enabled ? `${FUND_KEY}:membercount` : null, async () => {
    let q = supabase
      .from('members')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active');
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
  });

  const alerts: Alert[] = [];
  const fund = fundQ.data;

  if (fund && fund.cash_float_paise > fund.cash_float_limit_paise) {
    alerts.push({
      id: 'float',
      severity: 'danger',
      message: 'Too much cash in hand — put the extra in the bank',
      to: '/cash',
    });
  }
  const me = member?.id;
  const openLoans = openLoansQ.data ?? [];
  const isMine = (l: LoanRow) => Boolean(me) && l.borrower_id === me;

  // ---- the reader's own position first: what they owe, and what they wait on.
  const myUnpaid = (unpaidQ.data ?? []).filter((u) => u.member_id === me);
  if (myUnpaid.length) {
    // The shortfall, not the full month -- a part payment must reduce what
    // the member is told they owe, or the figure contradicts their receipt.
    const owed = myUnpaid.reduce((s, u) => s + u.shortfall_paise, 0);
    const late = myUnpaid.some((u) => u.is_overdue);
    const first = myUnpaid[0];
    alerts.push({
      id: 'my-unpaid',
      severity: late ? 'danger' : 'warn',
      message: late
        ? `Your ${formatPaise(owed)} contribution is overdue — please pay it`
        : `Pay your ${formatPaise(owed)} for ${monthName(first.period_month)} by ${fmtDate(first.grace_date)}`,
      to: '/deposits',
    });
  }

  for (const l of openLoans.filter(isMine)) {
    if (l.status === 'disbursed' && l.is_overdue) {
      alerts.push({
        id: `my-loan-late:${l.id}`,
        severity: 'danger',
        message: l.arrears_paise > 0
          ? `Your loan is ${formatPaise(l.arrears_paise)} behind — please repay`
          : `Your loan was due on ${fmtDate(l.due_on)} — ${formatPaise(l.total_due_paise)} still owed`,
        to: `/loans/${l.id}`,
      });
    } else if (l.status === 'disbursed' && l.next_due_on && daysBetween(today(), l.next_due_on.slice(0, 10)) <= 7) {
      alerts.push({
        id: `my-loan-due:${l.id}`,
        severity: 'warn',
        message: `Your next loan instalment is due ${fmtDate(l.next_due_on)}`,
        to: `/loans/${l.id}`,
      });
    } else if (l.status === 'requested') {
      alerts.push({
        id: `my-loan-req:${l.id}`,
        severity: 'info',
        message: `Your ${formatPaiseShort(l.principal_paise)} loan request is waiting for votes — `
          + `${l.approvals} of ${l.required_approvals} approvals so far`,
        to: `/loans/${l.id}`,
      });
    } else if (l.status === 'approved') {
      alerts.push({
        id: `my-loan-ok:${l.id}`,
        severity: 'info',
        message: `Your ${formatPaiseShort(l.principal_paise)} loan is approved — waiting to be paid out`,
        to: `/loans/${l.id}`,
      });
    }
  }

  const myExpenses = (expenseQ.data ?? []).filter((e) => e.created_by === me);
  for (const e of myExpenses) {
    alerts.push({
      id: `my-expense:${e.id}`,
      severity: 'info',
      message: `Your spending request "${e.description}" is waiting for votes — `
        + `${e.approvals} of ${e.required_approvals} so far`,
      to: '/expenses',
    });
  }

  // ---- things the reader is asked to do for the group.
  const loanVotes = openLoans.filter((l) => l.can_i_vote);
  if (loanVotes.length) {
    alerts.push({
      id: 'loanvote',
      severity: 'warn',
      message: loanVotes.length === 1
        ? `${loanVotes[0].borrower_name}'s ${formatPaiseShort(loanVotes[0].principal_paise)} loan request needs your vote`
        : `${loanVotes.length} loan requests are waiting for your vote`,
      to: loanVotes.length === 1 ? `/loans/${loanVotes[0].id}` : '/loans',
    });
  }

  // disburse_loan is a cashier/accountant RPC, and a borrower may not pay
  // their own loan out -- the same gate LoanDetail uses for the button.
  const toPayOut = isMoneyHandler
    ? openLoans.filter((l) => l.status === 'approved' && !isMine(l))
    : [];
  if (toPayOut.length) {
    alerts.push({
      id: 'payout',
      severity: 'warn',
      message: toPayOut.length === 1
        ? `Pay out ${toPayOut[0].borrower_name}'s approved ${formatPaiseShort(toPayOut[0].principal_paise)} loan`
        : `${toPayOut.length} approved loans are waiting to be paid out`,
      to: toPayOut.length === 1 ? `/loans/${toPayOut[0].id}` : '/loans',
    });
  }

  const overdue = openLoans.filter((l) => l.status === 'disbursed' && l.is_overdue && !isMine(l));
  if (overdue.length) {
    alerts.push({
      id: 'overdue',
      severity: 'danger',
      // is_overdue means "behind on the plan OR past the final date" since
      // 0027. Saying "past its due date" is wrong for the common case: a
      // borrower nine months into a twelve-month loan who has missed
      // instalments is behind, not past the end.
      message: (() => {
        const n = overdue.length;
        const behind = overdue.filter((l) => (l.arrears_paise ?? 0) > 0).length;
        if (behind === n) {
          return n === 1 ? '1 loan is behind on repayments'
                         : `${n} loans are behind on repayments`;
        }
        if (behind === 0) {
          return n === 1 ? '1 loan is past its final date'
                         : `${n} loans are past their final date`;
        }
        return `${n} loans need chasing — ${behind} behind on repayments`;
      })(),
      to: '/loans',
    });
  }
  if (cashQ.data?.length) {
    alerts.push({
      id: 'unreported',
      severity: 'danger',
      message: cashQ.data.length === 1
        ? '1 cash payment was not told to the group in time'
        : `${cashQ.data.length} cash payments were not told to the group in time`,
      to: '/cash',
    });
  }
  if (pendingQ.data?.length) {
    alerts.push({
      id: 'pending',
      severity: 'warn',
      message: pendingQ.data.length === 1
        ? '1 person is waiting to be let into the group'
        : `${pendingQ.data.length} people are waiting to be let into the group`,
      to: '/members',
    });
  }
  const expenseVotes = (expenseQ.data ?? []).filter((e) => e.can_i_vote);
  if (expenseVotes.length) {
    alerts.push({
      id: 'expensevote',
      severity: 'warn',
      message: expenseVotes.length === 1
        ? `"${expenseVotes[0].description}" (${formatPaiseShort(expenseVotes[0].amount_paise)}) needs your vote`
        : `${expenseVotes.length} spending requests are waiting for your vote`,
      to: '/expenses',
    });
  }
  // Other people's late payments. The reader's own is said above, in their
  // own words, so it is not counted twice.
  const othersLate = new Set(
    (unpaidQ.data ?? []).filter((u) => u.is_overdue && u.member_id !== me).map((u) => u.member_id),
  );
  if (othersLate.size) {
    alerts.push({
      id: 'unpaid',
      severity: 'warn',
      message: othersLate.size === 1
        ? '1 member is late with their contribution'
        : `${othersLate.size} members are late with their contributions`,
      to: '/deposits',
    });
  }

  // ---- the month cycle. Only once money can be recorded at all: before the
  // offices are filled open_period refuses, and the offices alert below says
  // what to do first.
  const memberCount = memberCountQ.data;
  const officesFilled = memberCount !== undefined && memberCount > 1 && Boolean(offices.data)
    && offices.data!.some((o) => o.role === 'cashier')
    && offices.data!.some((o) => o.role === 'accountant');
  const periods = periodsQ.data;
  if (periods && officesFilled) {
    const thisMonth = today().slice(0, 7);
    if (isOfficer && !periods.some((p) => p.period_month.slice(0, 7) === thisMonth)) {
      alerts.push({
        id: 'open-month',
        severity: 'warn',
        message: `${monthName(`${thisMonth}-01`)} is not open yet — open it so payments can be recorded`,
        to: '/deposits',
      });
    }
    // close_period refuses before the grace date, so it is only offered after.
    const toClose = isMoneyHandler
      ? periods.filter((p) => !p.closed_at && p.grace_date.slice(0, 10) < today())
      : [];
    if (toClose.length) {
      alerts.push({
        id: 'close-month',
        severity: 'info',
        message: toClose.length === 1
          ? `${monthName(toClose[0].period_month)} is past its grace date — close it to lock the entries`
          : `${toClose.length} past months are still open — close them to lock the entries`,
        to: '/deposits',
      });
    }
  }

  // ---- share-outs. Proposed by one officer, agreed by another; everyone can
  // see one is pending, because it is the largest movement a group makes.
  for (const d of distributionsQ.data ?? []) {
    const label = d.kind === 'final' ? 'final share-out' : 'profit share-out';
    const mine = d.proposed_by === me;
    alerts.push({
      id: `distribution:${d.id}`,
      severity: isOfficer && !mine ? 'warn' : 'info',
      message: isOfficer && !mine
        ? `A ${formatPaise(d.total_paise)} ${label} is waiting for you to agree it`
        : mine
          ? `Your ${formatPaise(d.total_paise)} ${label} is waiting for another officer to agree it`
          : `A ${formatPaise(d.total_paise)} ${label} has been proposed`,
      to: '/treasury',
    });
  }

  // ---- reconciliation. A statement that does not match the books is the one
  // number in the app that says something is wrong with the others.
  //
  // It names both figures and the likeliest cause. "₹2,000 more than the
  // books expect" left the officer to work out what to do; the usual cause
  // of "bank has more" is cash that was paid in at the bank without the
  // cash-to-bank move being recorded, so the books still think it is in hand.
  const bank = bankQ.data;
  if (bank && bank.difference_paise !== 0) {
    const on = new Date(`${bank.as_of.slice(0, 10)}T00:00:00`)
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const more = bank.difference_paise > 0;
    const hint = more && (fund?.cash_float_paise ?? 0) > 0
      ? ' — if cash was paid into the bank, record it under Treasury → Cash'
      : more ? '' : ' — look for a withdrawal or charge not yet recorded';
    alerts.push({
      id: 'bank-mismatch',
      severity: 'danger',
      message: `Bank shows ${formatPaise(bank.closing_balance_paise)} on ${on}, books expect `
        + `${formatPaise(bank.expected_balance_paise)}${hint}`,
      to: '/bank',
    });
  }
  // Only worth saying once there IS a fund. On a brand-new group everything is
  // zero, and "no lending capacity" then describes an empty pot rather than a
  // problem anyone can act on.
  if (fund && fund.total_fund_paise > 0 && fund.still_lendable_paise <= 0) {
    alerts.push({
      id: 'nolend',
      severity: 'warn',
      message: 'Nothing left to lend — the rest must stay in the bank',
      to: '/loans',
    });
  }

  // Until both money offices are filled, contributions, loans and cash cannot
  // be recorded at all -- the RPCs require one of those roles.
  // But if there is only 1 member (the creator), they cannot fill both offices yet
  // because cashier and accountant must be different people. Prompt them to invite members first!
  if (memberCount !== undefined && memberCount <= 1) {
    alerts.push({
      id: 'invite',
      severity: 'warn',
      message: 'Invite members to join — you need at least 2 members to assign cashier and accountant',
      to: '/settings',
    });
  } else if (offices.data) {
    const has = (r: string) => offices.data!.some((o) => o.role === r);
    if (!has('cashier') || !has('accountant')) {
      alerts.push({
        id: 'offices',
        severity: 'danger',
        message:
          'Pick a cashier and an accountant — until then no money can be recorded',
        to: '/members',
      });
    }
  }

  if (group && !group.setup_complete) {
    alerts.push({
      id: 'setup',
      severity: 'warn',
      message: 'Finish setting up — check the group rules and save them',
      to: '/settings',
    });
  }

  alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // A disabled query (key null) reports loading=false and no error, so it
  // counts as settled -- which is right: an officer-only query has nothing to
  // say to a member.
  const queries = [
    fundQ, openLoansQ, periodsQ, distributionsQ, bankQ, pendingQ, expenseQ,
    cashQ, unpaidQ, offices, memberCountQ,
  ];
  const errors = [...new Set(queries.map((q) => q.error).filter((e): e is string => Boolean(e)))];

  const value: FundValue = {
    fund,
    alerts,
    loading: fundQ.loading || offices.loading,
    error: fundQ.error || offices.error,
    errors,
    settled: enabled && queries.every((q) => !q.loading && !q.error),
    retry: () => invalidate(FUND_KEY),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFund(): FundValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFund must be used inside FundProvider');
  return v;
}
