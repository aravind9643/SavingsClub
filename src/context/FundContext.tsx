import { createContext, useContext, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { useQuery } from '../hooks/useQuery';
import { useSession } from './SessionContext';
import type { FundSummary, CashAlert, LoanRow, UnpaidRow } from '../lib/types';

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
  const { member } = useSession();
  const enabled = Boolean(member);

  const fundQ = useQuery<FundSummary>(enabled ? FUND_KEY : null, async () => {
    const { data, error } = await supabase
      .from('v_fund_summary').select('*').single();
    if (error) throw error;
    return data as FundSummary;
  });

  const overdueQ = useQuery<LoanRow[]>(enabled ? `${FUND_KEY}:overdue` : null, async () => {
    const { data, error } = await supabase
      .from('v_loan_status').select('*').eq('is_overdue', true);
    if (error) throw error;
    return (data ?? []) as LoanRow[];
  });

  const cashQ = useQuery<CashAlert[]>(enabled ? `${FUND_KEY}:cash` : null, async () => {
    const { data, error } = await supabase
      .from('v_cash_alerts').select('*').eq('reporting_breached', true);
    if (error) throw error;
    return (data ?? []) as CashAlert[];
  });

  const unpaidQ = useQuery<UnpaidRow[]>(enabled ? `${FUND_KEY}:unpaid` : null, async () => {
    const { data, error } = await supabase
      .from('v_unpaid_contributions').select('*').eq('is_overdue', true);
    if (error) throw error;
    return (data ?? []) as UnpaidRow[];
  });

  const offices = useQuery<{ role: string }[]>(enabled ? 'roles' : null, async () => {
    const { data, error } = await supabase
      .from('role_assignments').select('role').is('end_date', null);
    if (error) throw error;
    return (data ?? []) as { role: string }[];
  });

  const alerts: Alert[] = [];
  const fund = fundQ.data;

  if (fund && fund.cash_float_paise > fund.cash_float_limit_paise) {
    alerts.push({
      id: 'float',
      severity: 'danger',
      message: 'Cash float is over the limit — deposit the excess into the bank',
      to: '/cash',
    });
  }
  if (overdueQ.data?.length) {
    alerts.push({
      id: 'overdue',
      severity: 'danger',
      message: `${overdueQ.data.length} loan(s) past the due date`,
      to: '/loans',
    });
  }
  if (cashQ.data?.length) {
    alerts.push({
      id: 'unreported',
      severity: 'danger',
      message: `${cashQ.data.length} cash spend(s) not reported to the group in time`,
      to: '/cash',
    });
  }
  if (unpaidQ.data?.length) {
    alerts.push({
      id: 'unpaid',
      severity: 'warn',
      message: `${unpaidQ.data.length} contribution(s) unpaid past the grace date`,
      to: '/contributions',
    });
  }
  // Only worth saying once there IS a fund. On a brand-new group everything is
  // zero, and "no lending capacity" then describes an empty pot rather than a
  // problem anyone can act on.
  if (fund && fund.total_fund_paise > 0 && fund.still_lendable_paise <= 0) {
    alerts.push({
      id: 'nolend',
      severity: 'warn',
      message: 'No lending capacity left — the 25% reserve is the floor',
      to: '/loans',
    });
  }

  // Until both money offices are filled, contributions, loans and cash cannot
  // be recorded at all -- the RPCs require one of those roles. Worth saying on
  // the dashboard rather than letting people discover it as a failed save.
  if (offices.data) {
    const has = (r: string) => offices.data!.some((o) => o.role === r);
    if (!has('cashier') || !has('accountant')) {
      alerts.push({
        id: 'offices',
        severity: 'danger',
        message:
          'No cashier or accountant yet — money cannot be recorded until both are assigned',
        to: '/members',
      });
    }
  }

  const value: FundValue = {
    fund,
    alerts,
    loading: fundQ.loading,
    error: fundQ.error,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFund(): FundValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFund must be used inside FundProvider');
  return v;
}
