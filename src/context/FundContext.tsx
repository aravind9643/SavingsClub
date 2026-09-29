import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { useQuery, invalidate } from '../hooks/useQuery';
import { useSession } from './SessionContext';
import { formatPaise, formatPaiseShort } from '../lib/money';
import { daysBetween, today } from '../lib/dates';
import { useT, useLang, dateIn, monthIn } from '../lib/i18n';
import type {
  FundSummary, CashAlert, LoanRow, UnpaidRow, PendingMember, ExpenseRow,
  ContributionPeriod, Distribution, BankStatement, PaymentClaim,
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
  /** The reader's own "I've paid" claims still waiting for an officer. */
  myPendingClaimsPaise: number;
}

const SEVERITY_ORDER: Record<Alert['severity'], number> = { danger: 0, warn: 1, info: 2 };

const Ctx = createContext<FundValue | null>(null);

export function FundProvider({ children }: { children: ReactNode }) {
  const { member, currentGroupId, group, isOfficer, role, config } = useSession();
  const t = useT();
  const [lang] = useLang();
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
      // 0046: a member says they paid -> the cashier's queue; the cashier
      // decides -> the member's Home.
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'payment_claims', filter: `group_id=eq.${currentGroupId}` },
        () => invalidate('fund', 'claims', 'contributions', 'positions'))
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
  // requests, approved loans nobody has paid out, loans falling behind, and
  // loans the reader vouched for are all derived from it below.
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

  // "I've paid" claims (0046): every pending one in the group -- the reader's
  // own change what Home tells them they owe, and an officer confirms the
  // rest -- plus the reader's own turned down this past week, with the reason.
  const claimsQ = useQuery<PaymentClaim[]>(enabled ? `${FUND_KEY}:claims` : null, async () => {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [pending, rejected] = await Promise.all([
      supabase.from('payment_claims').select('*')
        .eq('group_id', currentGroupId!).eq('status', 'pending'),
      supabase.from('payment_claims').select('*')
        .eq('group_id', currentGroupId!).eq('member_id', member!.id)
        .eq('status', 'rejected').gt('decided_at', weekAgo),
    ]);
    if (pending.error) throw pending.error;
    if (rejected.error) throw rejected.error;
    return [...(pending.data ?? []), ...(rejected.data ?? [])] as PaymentClaim[];
  });

  const namesQ = useQuery<Map<string, string>>(enabled ? `${FUND_KEY}:names` : null, async () => {
    const { data, error } = await supabase.from('members').select('id, full_name').eq('group_id', currentGroupId!);
    if (error) throw error;
    return new Map((data ?? []).map((m) => [m.id as string, m.full_name as string]));
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
  const d = (iso: string | null | undefined) => dateIn(lang, iso);
  const month = (iso: string) => monthIn(lang, iso);

  // Both "too much cash" and "bank shows more" are fixed the same way, so
  // both land on the deposit sheet rather than on a screen to hunt through.
  if (fund && fund.cash_float_paise > fund.cash_float_limit_paise) {
    alerts.push({ id: 'float', severity: 'danger', message: t('a.float'), to: '/cash?deposit=1' });
  }
  const me = member?.id;
  const openLoans = openLoansQ.data ?? [];
  const isMine = (l: LoanRow) => Boolean(me) && l.borrower_id === me;
  const claims = claimsQ.data ?? [];
  const names = namesQ.data ?? new Map<string, string>();

  // ---- the reader's own position first: what they owe, and what they wait on.
  const myPending = claims.filter((c) => c.status === 'pending' && c.member_id === me);
  const myPendingPaise = myPending.reduce((s, c) => s + c.amount_paise, 0);
  const myUnpaid = (unpaidQ.data ?? []).filter((u) => u.member_id === me);
  if (myUnpaid.length) {
    // The shortfall, not the full month -- a part payment must reduce what
    // the member is told they owe, or the figure contradicts their receipt.
    // And less what they have already sent and are waiting on: telling a
    // member who paid an hour ago to pay is how they pay twice.
    const owed = myUnpaid.reduce((s, u) => s + u.shortfall_paise, 0) - myPendingPaise;
    if (owed > 0) {
      const late = myUnpaid.some((u) => u.is_overdue);
      const first = myUnpaid[0];
      alerts.push({
        id: 'my-unpaid',
        severity: late ? 'danger' : 'warn',
        message: late
          ? t('a.my.overdue', { amount: formatPaise(owed) })
          : t('a.my.due', { amount: formatPaise(owed), month: month(first.period_month), date: d(first.grace_date) }),
        to: '/deposits?pay=1',
      });
    }
  }
  if (myPendingPaise > 0) {
    alerts.push({
      id: 'my-claim', severity: 'info',
      message: t('a.my.claim', { amount: formatPaise(myPendingPaise) }), to: '/deposits?pay=1',
    });
  }
  for (const c of claims.filter((x) => x.status === 'rejected' && x.member_id === me)) {
    alerts.push({
      id: `my-claim-no:${c.id}`, severity: 'warn',
      message: t('a.my.claim.rejected', { amount: formatPaise(c.amount_paise), reason: c.decision_note ?? '' }),
      to: '/deposits?pay=1',
    });
  }

  for (const l of openLoans.filter(isMine)) {
    if (l.status === 'disbursed' && l.is_overdue) {
      alerts.push({
        id: `my-loan-late:${l.id}`,
        severity: 'danger',
        message: l.arrears_paise > 0
          ? t('a.my.loan.behind', { amount: formatPaise(l.arrears_paise) })
          : t('a.my.loan.late', { date: d(l.due_on), amount: formatPaise(l.total_due_paise) }),
        to: `/loans/${l.id}`,
      });
    } else if (l.status === 'disbursed' && l.next_due_on && daysBetween(today(), l.next_due_on.slice(0, 10)) <= 7) {
      alerts.push({
        id: `my-loan-due:${l.id}`, severity: 'warn',
        message: t('a.my.loan.next', { date: d(l.next_due_on) }), to: `/loans/${l.id}`,
      });
    } else if (l.status === 'requested') {
      alerts.push({
        id: `my-loan-req:${l.id}`, severity: 'info',
        message: t('a.my.loan.req', {
          amount: formatPaiseShort(l.principal_paise), yes: l.approvals, need: l.required_approvals,
        }),
        to: `/loans/${l.id}`,
      });
    } else if (l.status === 'approved') {
      alerts.push({
        id: `my-loan-ok:${l.id}`, severity: 'info',
        message: t('a.my.loan.ok', { amount: formatPaiseShort(l.principal_paise) }), to: `/loans/${l.id}`,
      });
    }
  }

  // ---- loans the reader vouched for. A guarantor answers for the loan if
  // the borrower stops paying, and used to learn it only by going to look.
  for (const l of openLoans.filter((x) => x.guarantor_id === me && !isMine(x) && x.status === 'disbursed' && x.is_overdue)) {
    alerts.push({
      id: `guarantee:${l.id}`,
      severity: 'danger',
      message: l.arrears_paise > 0
        ? t('a.guarantee.behind', { name: l.borrower_name, amount: formatPaise(l.arrears_paise) })
        : t('a.guarantee.late', { name: l.borrower_name }),
      to: `/loans/${l.id}`,
    });
  }

  const myExpenses = (expenseQ.data ?? []).filter((e) => e.created_by === me);
  for (const e of myExpenses) {
    alerts.push({
      id: `my-expense:${e.id}`, severity: 'info',
      message: t('a.my.expense', { what: e.description, yes: e.approvals, need: e.required_approvals }),
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
        ? t('a.loanvote.one', { name: loanVotes[0].borrower_name, amount: formatPaiseShort(loanVotes[0].principal_paise) })
        : t('a.loanvote.many', { n: loanVotes.length }),
      to: loanVotes.length === 1 ? `/loans/${loanVotes[0].id}` : '/loans',
    });
  }

  // Claims only the OTHER money officer can confirm are not this reader's job.
  const toConfirm = isMoneyHandler
    ? claims.filter((c) => c.status === 'pending' && c.member_id !== me)
    : [];
  if (toConfirm.length) {
    alerts.push({
      id: 'claims',
      severity: 'warn',
      message: toConfirm.length === 1
        ? t('a.claims.one', { name: names.get(toConfirm[0].member_id) ?? '—', amount: formatPaise(toConfirm[0].amount_paise) })
        : t('a.claims.many', { n: toConfirm.length, amount: formatPaise(toConfirm.reduce((s, c) => s + c.amount_paise, 0)) }),
      to: '/deposits',
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
        ? t('a.payout.one', { name: toPayOut[0].borrower_name, amount: formatPaiseShort(toPayOut[0].principal_paise) })
        : t('a.payout.many', { n: toPayOut.length }),
      to: toPayOut.length === 1 ? `/loans/${toPayOut[0].id}` : '/loans',
    });
  }

  // The reader's own loans are said above, and loans they vouched for too.
  const overdue = openLoans.filter((l) => l.status === 'disbursed' && l.is_overdue && !isMine(l) && l.guarantor_id !== me);
  if (overdue.length) {
    // is_overdue means "behind on the plan OR past the final date" since
    // 0027. Saying "past its due date" is wrong for the common case: a
    // borrower nine months into a twelve-month loan who has missed
    // instalments is behind, not past the end.
    const n = overdue.length;
    const behind = overdue.filter((l) => (l.arrears_paise ?? 0) > 0).length;
    const message = behind === n
      ? (n === 1 ? t('a.overdue.behind.one') : t('a.overdue.behind.many', { n }))
      : behind === 0
        ? (n === 1 ? t('a.overdue.final.one') : t('a.overdue.final.many', { n }))
        : t('a.overdue.mixed', { n, behind });
    alerts.push({ id: 'overdue', severity: 'danger', message, to: '/loans' });
  }
  if (cashQ.data?.length) {
    alerts.push({
      id: 'unreported', severity: 'danger',
      message: cashQ.data.length === 1 ? t('a.unreported.one') : t('a.unreported.many', { n: cashQ.data.length }),
      to: '/cash',
    });
  }
  if (pendingQ.data?.length) {
    alerts.push({
      id: 'pending', severity: 'warn',
      message: pendingQ.data.length === 1 ? t('a.pending.one') : t('a.pending.many', { n: pendingQ.data.length }),
      to: '/members',
    });
  }
  const expenseVotes = (expenseQ.data ?? []).filter((e) => e.can_i_vote);
  if (expenseVotes.length) {
    alerts.push({
      id: 'expensevote', severity: 'warn',
      message: expenseVotes.length === 1
        ? t('a.expvote.one', { what: expenseVotes[0].description, amount: formatPaiseShort(expenseVotes[0].amount_paise) })
        : t('a.expvote.many', { n: expenseVotes.length }),
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
      id: 'unpaid', severity: 'warn',
      message: othersLate.size === 1 ? t('a.late.one') : t('a.late.many', { n: othersLate.size }),
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
        id: 'open-month', severity: 'warn',
        message: t('a.open', { month: month(`${thisMonth}-01`) }), to: '/deposits',
      });
    }
    // close_period refuses before the grace date, so it is only offered after.
    const toClose = isMoneyHandler
      ? periods.filter((p) => !p.closed_at && p.grace_date.slice(0, 10) < today())
      : [];
    if (toClose.length) {
      alerts.push({
        id: 'close-month', severity: 'info',
        message: toClose.length === 1
          ? t('a.close.one', { month: month(toClose[0].period_month) })
          : t('a.close.many', { n: toClose.length }),
        to: '/deposits',
      });
    }
  }
  // Members can only pay from the app once an officer says where to.
  if (isOfficer && officesFilled && !config?.upi_id) {
    alerts.push({ id: 'upi', severity: 'info', message: t('a.upi'), to: '/settings' });
  }

  // ---- share-outs. Proposed by one officer, agreed by another; everyone can
  // see one is pending, because it is the largest movement a group makes.
  for (const dist of distributionsQ.data ?? []) {
    const kind = t(dist.kind === 'final' ? 'a.dist.final' : 'a.dist.profit');
    const mine = dist.proposed_by === me;
    const amount = formatPaise(dist.total_paise);
    alerts.push({
      id: `distribution:${dist.id}`,
      severity: isOfficer && !mine ? 'warn' : 'info',
      message: isOfficer && !mine
        ? t('a.dist.agree', { amount, kind })
        : mine ? t('a.dist.mine', { amount, kind }) : t('a.dist.seen', { amount, kind }),
      to: '/treasury',
    });
  }

  // ---- reconciliation. A statement that does not match the books is the one
  // number in the app that says something is wrong with the others.
  //
  // It names both figures and the likeliest cause. The usual cause of "bank
  // has more" is cash paid in at the bank without the deposit being
  // recorded, so the books still think it is in hand -- and that case opens
  // the deposit sheet directly.
  const bank = bankQ.data;
  if (bank && bank.difference_paise !== 0) {
    const more = bank.difference_paise > 0;
    const cashy = more && (fund?.cash_float_paise ?? 0) > 0;
    alerts.push({
      id: 'bank-mismatch',
      severity: 'danger',
      message: t('a.bank', {
        bank: formatPaise(bank.closing_balance_paise), date: d(bank.as_of),
        books: formatPaise(bank.expected_balance_paise),
      }) + (cashy ? t('a.bank.cash') : more ? '' : t('a.bank.less')),
      to: cashy && role === 'cashier' ? '/cash?deposit=1' : '/bank',
    });
  }
  // Only worth saying once there IS a fund. On a brand-new group everything is
  // zero, and "no lending capacity" then describes an empty pot rather than a
  // problem anyone can act on.
  if (fund && fund.total_fund_paise > 0 && fund.still_lendable_paise <= 0) {
    alerts.push({ id: 'nolend', severity: 'warn', message: t('a.nolend'), to: '/loans' });
  }

  // Until both money offices are filled, contributions, loans and cash cannot
  // be recorded at all -- the RPCs require one of those roles. A group of one
  // cannot fill both (cashier and accountant must be different people), so it
  // is asked to invite first.
  if (memberCount !== undefined && memberCount <= 1) {
    alerts.push({ id: 'invite', severity: 'warn', message: t('a.invite'), to: '/settings' });
  } else if (offices.data) {
    const has = (r: string) => offices.data!.some((o) => o.role === r);
    if (!has('cashier') || !has('accountant')) {
      alerts.push({ id: 'offices', severity: 'danger', message: t('a.offices'), to: '/members' });
    }
  }

  if (group && !group.setup_complete) {
    alerts.push({ id: 'setup', severity: 'warn', message: t('a.setup'), to: '/settings' });
  }

  alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // A disabled query (key null) reports loading=false and no error, so it
  // counts as settled -- which is right: an officer-only query has nothing to
  // say to a member.
  const queries = [
    fundQ, openLoansQ, periodsQ, distributionsQ, bankQ, pendingQ, expenseQ,
    cashQ, unpaidQ, claimsQ, namesQ, offices, memberCountQ,
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
    myPendingClaimsPaise: myPendingPaise,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFund(): FundValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFund must be used inside FundProvider');
  return v;
}
