import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { useQuery, invalidate } from '../hooks/useQuery';
import { useSession } from './SessionContext';
import type {
  FundSummary, CashAlert, LoanRow, UnpaidRow, PendingMember, ExpenseRow,
} from '../lib/types';

export const FUND_KEY = 'fund';

export interface Alert {
  id: string;
  severity: 'danger' | 'warn';
  message: string;
  to: string;
}

interface FundValue {
  fund: FundSummary | undefined;
  alerts: Alert[];
  loading: boolean;
  error: string | null;
}

const Ctx = createContext<FundValue | null>(null);

export function FundProvider({ children }: { children: ReactNode }) {
  const { member, currentGroupId, group, isOfficer } = useSession();
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

  const overdueQ = useQuery<LoanRow[]>(enabled ? `${FUND_KEY}:overdue` : null, async () => {
    let q = supabase
      .from('v_loan_status').select('*').eq('is_overdue', true);
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as LoanRow[];
  });

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
  const expenseVoteQ = useQuery<ExpenseRow[]>(
    enabled ? `${FUND_KEY}:expensevotes` : null,
    async () => {
      let q = supabase
        .from('v_expense_status').select('*').eq('can_i_vote', true);
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

  const unpaidQ = useQuery<UnpaidRow[]>(enabled ? `${FUND_KEY}:unpaid` : null, async () => {
    let q = supabase
      .from('v_unpaid_contributions').select('*').eq('is_overdue', true);
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
  if (overdueQ.data?.length) {
    alerts.push({
      id: 'overdue',
      severity: 'danger',
      // is_overdue means "behind on the plan OR past the final date" since
      // 0027. Saying "past its due date" is wrong for the common case: a
      // borrower nine months into a twelve-month loan who has missed
      // instalments is behind, not past the end.
      message: (() => {
        const n = overdueQ.data!.length;
        const behind = overdueQ.data!.filter((l) => (l.arrears_paise ?? 0) > 0).length;
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
  if (expenseVoteQ.data?.length) {
    alerts.push({
      id: 'expensevote',
      severity: 'warn',
      message: expenseVoteQ.data.length === 1
        ? '1 spending request is waiting for your vote'
        : `${expenseVoteQ.data.length} spending requests are waiting for your vote`,
      to: '/expenses',
    });
  }
  if (unpaidQ.data?.length) {
    alerts.push({
      id: 'unpaid',
      severity: 'warn',
      message: unpaidQ.data.length === 1
        ? '1 member has not paid this month yet'
        : `${unpaidQ.data.length} members have not paid this month yet`,
      to: '/deposits',
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
  const memberCount = memberCountQ.data;
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

  const value: FundValue = {
    fund,
    alerts,
    loading: fundQ.loading || offices.loading,
    error: fundQ.error || offices.error,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFund(): FundValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFund must be used inside FundProvider');
  return v;
}
