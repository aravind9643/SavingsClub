import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery, useMutation } from '../hooks/useQuery';
import { useSession } from '../context/SessionContext';
import { useFund } from '../context/FundContext';
import {
  formatPaise, formatPaiseShort, paiseToRupees,
} from '../lib/money';
import { haptic } from '../lib/haptics';
import {
  Hero, Chip, Panel, List, Row, Empty, ErrorNote, Notice, Segments,
  SkeletonList, fmtDate, fmtDateTime,
} from '../components/ui';
import {
  IconPlus, IconBank, IconWallet, IconExpenses, IconCheck, IconArrowUp,
  IconArrowDown, IconShare, IconLoan,
} from '../components/icons';
import type {
  BankStatement, CashEntry, ExpenseRow, Distribution,
} from '../lib/types';
import { BankStatementSheet } from './money/BankStatementSheet';
import { CashMovementSheet } from './money/CashMovementSheet';
import { DistributionSheet } from './money/DistributionSheet';
import { ExpenseVoteCard } from './money/ExpenseVoteCard';
import { ProposeExpenseSheet } from './money/ProposeExpenseSheet';
import { TreasuryReportSheet } from './money/TreasuryReportSheet';

type HubTab = 'overview' | 'bank' | 'cash' | 'expenses';

export default function MoneyHub({ defaultTab }: { defaultTab?: HubTab }) {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const urlTab = params.get('tab') as HubTab | null;
  const [tab, setTab] = useState<HubTab>(defaultTab || urlTab || 'overview');
  const { role, config, currentGroupId } = useSession();
  const { fund } = useFund();

  useEffect(() => {
    if (defaultTab) {
      setTab(defaultTab);
    } else if (urlTab && ['overview', 'bank', 'cash', 'expenses'].includes(urlTab)) {
      setTab(urlTab as HubTab);
    }
  }, [defaultTab, urlTab]);

  // Dialog sheets
  const [bankSheet, setBankSheet] = useState(false);
  const [cashSheet, setCashSheet] = useState(false);
  const [expenseSheet, setExpenseSheet] = useState(false);
  const [reportSheet, setReportSheet] = useState(false);
  const [distSheet, setDistSheet] = useState(false);
  const [initialCashData, setInitialCashData] = useState<{
    direction: 'in' | 'out';
    amount: string;
    purpose: string;
  } | undefined>();

  const isCashier = role === 'cashier';
  const isAccountant = role === 'accountant';
  const isMoneyHandler = isCashier || isAccountant;

  // ------------------------------------------------ Bank Queries & Mutations
  const bankQ = useQuery<BankStatement[]>('bank', async () => {
    let q = supabase
      .from('bank_statements').select('*').order('as_of', { ascending: false });
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as BankStatement[];
  });

  const latestStatement = (bankQ.data ?? [])[0];

  // ------------------------------------------------ Cash Queries & Mutations
  const cashQ = useQuery<CashEntry[]>('cash', async () => {
    let q = supabase
      .from('cash_ledger').select('*').order('occurred_at', { ascending: false });
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as CashEntry[];
  });

  const reportCash = useMutation(
    async (id: string) => {
      const { error } = await supabase.rpc('report_cash_movement', { p_id: id });
      if (error) throw error;
    },
    { invalidates: ['cash', 'fund'] },
  );

  // -------------------------------------------- Expenses Queries & Mutations
  const expensesQ = useQuery<ExpenseRow[]>('expenses', async () => {
    let q = supabase
      .from('v_expense_status').select('*').order('incurred_on', { ascending: false });
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as ExpenseRow[];
  });

  const allExpenses = expensesQ.data ?? [];
  const votingExpenses = allExpenses.filter((e) => e.status === 'proposed');
  const paidExpenses = allExpenses.filter((e) => e.status === 'paid');
  const totalSpentPaise = paidExpenses.reduce((sum, e) => sum + e.amount_paise, 0);

  // ---------------------------------------- Distribution Queries & Mutations
  const distQ = useQuery<Distribution[]>('distributions', async () => {
    let q = supabase
      .from('distributions').select('*').order('proposed_at', { ascending: false });
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Distribution[];
  });

  const activeDist = (distQ.data ?? []).find((d) => d.status === 'proposed');

  const cashBalance = fund?.cash_float_paise ?? 0;
  const cashLimit = fund?.cash_float_limit_paise ?? 0;
  const expectedBankBalance = fund?.expected_bank_balance_paise ?? 0;
  const bankDiff = latestStatement?.difference_paise;

  const handleTabChange = (next: HubTab) => {
    haptic(10);
    setTab(next);
    setParams({ tab: next }, { replace: true });
  };

  return (
    <>
      <Screen
        title="Treasury"
        sub="Bank balance, cash in hand & spending"
        action={
          <button
            className="icon-btn"
            onClick={() => {
              haptic(10);
              setReportSheet(true);
            }}
            aria-label="Export monthly report"
            title="Export report"
          >
            <IconShare width={17} height={17} />
          </button>
        }
      >
        <Segments<HubTab>
          value={tab}
          onChange={handleTabChange}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'bank', label: 'Bank', count: bankDiff && bankDiff !== 0 ? 1 : undefined },
            { value: 'cash', label: 'Cash', count: cashBalance > cashLimit ? 1 : undefined },
            { value: 'expenses', label: 'Expenses', count: votingExpenses.length > 0 ? votingExpenses.length : undefined },
          ]}
        />

        {/* ------------------------------------------------------------- OVERVIEW TAB */}
        {tab === 'overview' && (
          <>
            {fund && (
              <Hero
                label="Liquid Group Treasury"
                paise={expectedBankBalance + cashBalance}
                meta={
                  <>
                    <Chip tone="mint">
                      In Bank <b>{formatPaiseShort(expectedBankBalance)}</b>
                    </Chip>
                    <Chip tone="violet">
                      In Cash <b>{formatPaiseShort(cashBalance)}</b>
                    </Chip>
                  </>
                }
              />
            )}

            {/* Asset Distribution Multi-segment Bar */}
            {fund && (
              (() => {
                const bAmt = Math.max(0, expectedBankBalance);
                const cAmt = Math.max(0, cashBalance);
                const lAmt = Math.max(0, fund.outstanding_paise);
                const totalAssets = bAmt + cAmt + lAmt;
                const bPct = totalAssets > 0 ? Math.round((bAmt / totalAssets) * 100) : 0;
                const cPct = totalAssets > 0 ? Math.round((cAmt / totalAssets) * 100) : 0;
                const lPct = totalAssets > 0 ? Math.max(0, 100 - bPct - cPct) : 0;

                return (
                  <div
                    className="panel"
                    style={{
                      background: 'linear-gradient(145deg, var(--surface), var(--surface-2))',
                      border: '1px solid var(--hairline)',
                      borderRadius: 'var(--r)',
                      padding: '14px 16px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      marginBottom: 14,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 700, color: 'var(--text-3)' }}>
                        Asset Allocation
                      </span>
                      <span style={{ fontSize: '0.8rem', fontWeight: 650, color: 'var(--text-2)' }}>
                        {formatPaiseShort(totalAssets)} Total Assets
                      </span>
                    </div>

                    <div
                      style={{
                        height: 10,
                        borderRadius: 'var(--r-full)',
                        background: 'var(--surface-3)',
                        overflow: 'hidden',
                        display: 'flex',
                        gap: 2,
                      }}
                    >
                      {bPct > 0 && (
                        <div
                          style={{
                            width: `${bPct}%`,
                            background: 'var(--mint)',
                            borderRadius: 'var(--r-full)',
                            transition: 'width 0.6s var(--swift)',
                          }}
                          title={`In Bank: ${bPct}%`}
                        />
                      )}
                      {cPct > 0 && (
                        <div
                          style={{
                            width: `${cPct}%`,
                            background: 'var(--amber)',
                            borderRadius: 'var(--r-full)',
                            transition: 'width 0.6s var(--swift)',
                          }}
                          title={`Cash in hand: ${cPct}%`}
                        />
                      )}
                      {lPct > 0 && (
                        <div
                          style={{
                            width: `${lPct}%`,
                            background: 'var(--violet)',
                            borderRadius: 'var(--r-full)',
                            transition: 'width 0.6s var(--swift)',
                          }}
                          title={`Active Loans: ${lPct}%`}
                        />
                      )}
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                      <div
                        style={{
                          padding: '8px 10px',
                          background: 'var(--surface-3)',
                          borderRadius: 'var(--r-sm)',
                          cursor: 'pointer',
                        }}
                        onClick={() => handleTabChange('bank')}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--mint)', flex: 'none' }} />
                          <span style={{ fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-2)' }}>Bank</span>
                        </div>
                        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>
                          {bPct}%
                        </div>
                        <div className="dim" style={{ fontSize: '0.72rem' }}>
                          {formatPaiseShort(bAmt)}
                        </div>
                      </div>

                      <div
                        style={{
                          padding: '8px 10px',
                          background: 'var(--surface-3)',
                          borderRadius: 'var(--r-sm)',
                          cursor: 'pointer',
                        }}
                        onClick={() => handleTabChange('cash')}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--amber)', flex: 'none' }} />
                          <span style={{ fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-2)' }}>Cash</span>
                        </div>
                        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>
                          {cPct}%
                        </div>
                        <div className="dim" style={{ fontSize: '0.72rem' }}>
                          {formatPaiseShort(cAmt)}
                        </div>
                      </div>

                      <div
                        style={{
                          padding: '8px 10px',
                          background: 'var(--surface-3)',
                          borderRadius: 'var(--r-sm)',
                          cursor: 'pointer',
                        }}
                        onClick={() => nav('/loans')}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--violet)', flex: 'none' }} />
                          <span style={{ fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-2)' }}>Loans</span>
                        </div>
                        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>
                          {lPct}%
                        </div>
                        <div className="dim" style={{ fontSize: '0.72rem' }}>
                          {formatPaiseShort(lAmt)}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()
            )}

            {activeDist && (
              <div
                className="panel"
                style={{
                  background: 'var(--amber-ghost)',
                  border: '1px solid var(--amber)',
                  borderRadius: 'var(--r)',
                  padding: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                  marginBottom: 14,
                }}
                onClick={() => {
                  haptic(10);
                  setDistSheet(true);
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="row-ico amber" style={{ width: 36, height: 36, borderRadius: 10 }}>
                    <IconLoan width={17} height={17} />
                  </span>
                  <div>
                    <div style={{ fontWeight: 650, color: 'var(--text)', fontSize: '0.92rem' }}>
                      {activeDist.kind === 'profit' ? 'Profit Share' : 'Group Wind-up'} Proposed
                    </div>
                    <div className="dim" style={{ fontSize: '0.8rem', marginTop: 1 }}>
                      {formatPaise(activeDist.total_paise)} · Awaiting second officer
                    </div>
                  </div>
                </div>
                <span className="tag amber">Review</span>
              </div>
            )}

            {/* Quick Status Cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Bank Card */}
              <div
                className="panel"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--hairline)',
                  borderRadius: 'var(--r)',
                  padding: 16,
                  cursor: 'pointer',
                }}
                onClick={() => handleTabChange('bank')}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="row-ico mint" style={{ width: 38, height: 38, borderRadius: 12 }}>
                      <IconBank width={18} height={18} />
                    </span>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.98rem' }}>Bank Reconciliation</div>
                      <div className="dim" style={{ fontSize: '0.82rem' }}>
                        {latestStatement
                          ? `Last verified ${fmtDate(latestStatement.as_of)}`
                          : 'No statements recorded yet'}
                      </div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontFamily: 'var(--display)', fontWeight: 650, fontSize: '1.05rem' }}>
                      {formatPaise(expectedBankBalance)}
                    </div>
                    {latestStatement ? (
                      <span className={`tag ${latestStatement.difference_paise === 0 ? 'mint' : 'coral'}`}>
                        {latestStatement.difference_paise === 0 ? '✓ Balanced' : `Off by ${formatPaiseShort(Math.abs(latestStatement.difference_paise))}`}
                      </span>
                    ) : (
                      <span className="tag amber">Unverified</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Cash Float Card */}
              <div
                className="panel"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--hairline)',
                  borderRadius: 'var(--r)',
                  padding: 16,
                  cursor: 'pointer',
                }}
                onClick={() => handleTabChange('cash')}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="row-ico violet" style={{ width: 38, height: 38, borderRadius: 12 }}>
                      <IconWallet width={18} height={18} />
                    </span>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.98rem' }}>Cash Float (in Hand)</div>
                      <div className="dim" style={{ fontSize: '0.82rem' }}>
                        Safety Limit: {formatPaiseShort(cashLimit)}
                      </div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontFamily: 'var(--display)', fontWeight: 650, fontSize: '1.05rem' }}>
                      {formatPaise(cashBalance)}
                    </div>
                    <span className={`tag ${cashBalance > cashLimit ? 'coral' : 'mint'}`}>
                      {cashBalance > cashLimit ? 'Exceeds limit' : 'Safe level'}
                    </span>
                  </div>
                </div>
                {cashLimit > 0 && (
                  <div className={`meter${cashBalance > cashLimit ? ' over' : ''}`} style={{ marginTop: 12 }}>
                    <i style={{ width: `${Math.min(100, (cashBalance / cashLimit) * 100)}%` }} />
                  </div>
                )}
              </div>

              {/* Expenses Card */}
              <div
                className="panel"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--hairline)',
                  borderRadius: 'var(--r)',
                  padding: 16,
                  cursor: 'pointer',
                }}
                onClick={() => handleTabChange('expenses')}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="row-ico amber" style={{ width: 38, height: 38, borderRadius: 12 }}>
                      <IconExpenses width={18} height={18} />
                    </span>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.98rem' }}>Group Expenses</div>
                      <div className="dim" style={{ fontSize: '0.82rem' }}>
                        {votingExpenses.length > 0
                          ? `${votingExpenses.length} awaiting votes`
                          : 'Trips, snacks & admin'}
                      </div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontFamily: 'var(--display)', fontWeight: 650, fontSize: '1.05rem' }}>
                      {formatPaise(totalSpentPaise)}
                    </div>
                    {votingExpenses.length > 0 ? (
                      <span className="tag amber">{votingExpenses.length} voting</span>
                    ) : (
                      <span className="tag">{paidExpenses.length} paid</span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Quick Actions Panel */}
            <Panel title="Quick Actions">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
                {isMoneyHandler && (
                  <button
                    type="button"
                    className="sec-link"
                    style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--hairline)',
                      borderRadius: 'var(--r-sm)',
                      padding: '12px 14px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 6,
                    }}
                    onClick={() => {
                      haptic(10);
                      setBankSheet(true);
                    }}
                  >
                    <IconBank width={16} height={16} style={{ color: 'var(--mint)' }} />
                    <span style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text)' }}>
                      Reconcile Bank
                    </span>
                  </button>
                )}

                {isCashier && (
                  <button
                    type="button"
                    className="sec-link"
                    style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--hairline)',
                      borderRadius: 'var(--r-sm)',
                      padding: '12px 14px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 6,
                    }}
                    onClick={() => {
                      haptic(10);
                      setInitialCashData(undefined);
                      setCashSheet(true);
                    }}
                  >
                    <IconWallet width={16} height={16} style={{ color: 'var(--violet)' }} />
                    <span style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text)' }}>
                      Record Cash
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  className="sec-link"
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--hairline)',
                    borderRadius: 'var(--r-sm)',
                    padding: '12px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 6,
                  }}
                  onClick={() => {
                    haptic(10);
                    setExpenseSheet(true);
                  }}
                >
                  <IconExpenses width={16} height={16} style={{ color: 'var(--amber)' }} />
                  <span style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text)' }}>
                    Add Expense
                  </span>
                </button>

                <button
                  type="button"
                  className="sec-link"
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--hairline)',
                    borderRadius: 'var(--r-sm)',
                    padding: '12px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 6,
                  }}
                  onClick={() => {
                    haptic(10);
                    setReportSheet(true);
                  }}
                >
                  <IconShare width={16} height={16} style={{ color: 'var(--text-2)' }} />
                  <span style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text)' }}>
                    Share Report
                  </span>
                </button>

                <button
                  type="button"
                  className="sec-link"
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--hairline)',
                    borderRadius: 'var(--r-sm)',
                    padding: '12px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 6,
                  }}
                  onClick={() => {
                    haptic(10);
                    setDistSheet(true);
                  }}
                >
                  <IconLoan width={16} height={16} style={{ color: 'var(--mint)' }} />
                  <span style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text)' }}>
                    Profit Share
                  </span>
                </button>
              </div>
            </Panel>
          </>
        )}

        {/* ---------------------------------------------------------------- BANK TAB */}
        {tab === 'bank' && (
          <>
            {fund && (
              <Hero
                label="Should be in the bank"
                paise={expectedBankBalance}
                meta={
                  <>
                    <Chip>Fund <b>{formatPaiseShort(fund.total_fund_paise)}</b></Chip>
                    <Chip tone="violet">− Loan <b>{formatPaiseShort(fund.outstanding_paise)}</b></Chip>
                    <Chip tone="amber">− Cash float <b>{formatPaiseShort(fund.cash_float_paise)}</b></Chip>
                  </>
                }
              />
            )}

            {latestStatement && (
              <Notice tone={latestStatement.difference_paise === 0 ? 'good' : 'danger'}>
                {latestStatement.difference_paise === 0
                  ? `Balanced as of ${fmtDate(latestStatement.as_of)}.`
                  : `Mismatch of ${formatPaise(Math.abs(latestStatement.difference_paise))} on ${fmtDate(latestStatement.as_of)} — check missing entries.`}
              </Notice>
            )}

            {isMoneyHandler && (
              <div className="btn-row">
                <button
                  type="button"
                  className="primary block"
                  onClick={() => {
                    haptic(10);
                    setBankSheet(true);
                  }}
                >
                  <IconPlus width={16} height={16} /> Record new statement balance
                </button>
              </div>
            )}

            <Panel title="Statement History" flush>
              {bankQ.loading && !bankQ.data ? (
                <SkeletonList rows={3} />
              ) : (bankQ.data ?? []).length === 0 ? (
                <Empty icon={<IconBank width={22} height={22} />}>
                  No bank checks yet. Check the bank once a month so the group
                  knows the books match.
                </Empty>
              ) : (
                <List>
                  {(bankQ.data ?? []).map((s) => (
                    <Row
                      key={s.id}
                      icon={<IconCheck width={17} height={17} />}
                      iconTone={s.difference_paise === 0 ? 'mint' : 'coral'}
                      title={fmtDate(s.as_of)}
                      sub={s.note || `Books expected ${formatPaiseShort(s.expected_balance_paise)}`}
                      amount={formatPaiseShort(s.closing_balance_paise)}
                      note={
                        s.difference_paise === 0
                          ? 'Balanced'
                          : `Off ${formatPaiseShort(Math.abs(s.difference_paise))}`
                      }
                      amountTone={s.difference_paise === 0 ? 'mint' : 'coral'}
                    />
                  ))}
                </List>
              )}
            </Panel>
          </>
        )}

        {/* ---------------------------------------------------------------- CASH TAB */}
        {tab === 'cash' && (
          <>
            <Hero
              label="Cash with Cashier"
              paise={cashBalance}
              meta={
                <>
                  <Chip tone={cashBalance > cashLimit ? 'coral' : 'mint'}>
                    Limit <b>{formatPaiseShort(cashLimit)}</b>
                  </Chip>
                  <Chip>Report window <b>{config?.cash_report_hours ?? 24}h</b></Chip>
                </>
              }
              meter={{ value: cashBalance, limit: Math.max(1, cashLimit) }}
            />

            {cashBalance > cashLimit && (
              <Notice
                tone="danger"
                onClick={
                  isCashier
                    ? () => {
                        haptic(10);
                        const excess = paiseToRupees(cashBalance - cashLimit);
                        setInitialCashData({
                          direction: 'out',
                          amount: String(excess),
                          purpose: 'Deposit excess cash into bank',
                        });
                        setCashSheet(true);
                      }
                    : undefined
                }
              >
                Cash float is over the limit by {formatPaise(cashBalance - cashLimit)}.
                {isCashier ? ' Tap to deposit the excess into the bank.' : ' The cashier should deposit the excess.'}
              </Notice>
            )}

            {isCashier && (
              <div className="btn-row">
                <button
                  type="button"
                  className="primary block"
                  onClick={() => {
                    haptic(10);
                    setInitialCashData(undefined);
                    setCashSheet(true);
                  }}
                >
                  <IconPlus width={16} height={16} /> Record Cash Movement
                </button>
              </div>
            )}

            {/* "Mark reported" sits inside a list row, where a notice cannot
                go. Surfacing its failure here means a refused report is seen
                rather than silently doing nothing. */}
            <ErrorNote error={reportCash.error} />

            <Panel title="Cash in and out" flush>
              {cashQ.loading && !cashQ.data ? (
                <SkeletonList rows={3} />
              ) : (cashQ.data ?? []).length === 0 ? (
                <Empty icon={<IconWallet width={22} height={22} />}>
                  No cash has come in or gone out yet.
                </Empty>
              ) : (
                <List>
                  {(cashQ.data ?? []).map((c) => (
                    <Row
                      key={c.id}
                      icon={c.direction === 'in' ? <IconArrowDown width={17} height={17} /> : <IconArrowUp width={17} height={17} />}
                      iconTone={c.direction === 'in' ? 'mint' : 'coral'}
                      title={c.purpose}
                      sub={`${fmtDateTime(c.occurred_at)}${c.counterparty ? ` · ${c.counterparty}` : ''}`}
                      amount={`${c.direction === 'in' ? '+' : '−'}${formatPaiseShort(c.amount_paise)}`}
                      amountTone={c.direction === 'in' ? 'mint' : 'coral'}
                      note={
                        c.reported_at ? (
                          'Reported'
                        ) : isCashier ? (
                          <button
                            type="button"
                            className="seg"
                            style={{ padding: '3px 8px', fontSize: '0.72rem' }}
                            disabled={reportCash.pending}
                            onClick={() => void reportCash.run(c.id)}
                          >
                            Mark reported
                          </button>
                        ) : (
                          'Unreported'
                        )
                      }
                    />
                  ))}
                </List>
              )}
            </Panel>
          </>
        )}

        {/* ------------------------------------------------------------ EXPENSES TAB */}
        {tab === 'expenses' && (
          <>
            <Hero
              label="Group Discretionary Spend"
              paise={totalSpentPaise}
              meta={
                <>
                  <Chip tone="mint">{paidExpenses.length} paid expenses</Chip>
                  {votingExpenses.length > 0 && (
                    <Chip tone="amber">{votingExpenses.length} awaiting votes</Chip>
                  )}
                </>
              }
            />

            <div className="btn-row">
              <button
                type="button"
                className="primary block"
                onClick={() => {
                  haptic(10);
                  setExpenseSheet(true);
                }}
              >
                <IconPlus width={16} height={16} /> Propose New Expense
              </button>
            </div>

            {votingExpenses.length > 0 && (
              <Panel title="Awaiting Group Approval">
                {votingExpenses.map((exp, idx) => (
                  <ExpenseVoteCard
                    key={exp.id}
                    expense={exp}
                    isLast={idx === votingExpenses.length - 1}
                  />
                ))}
              </Panel>
            )}

            <Panel title="What the group spent" flush>
              {expensesQ.loading && !expensesQ.data ? (
                <SkeletonList rows={3} />
              ) : paidExpenses.length === 0 ? (
                <Empty icon={<IconExpenses width={22} height={22} />}>
                  The group has not spent anything yet.
                </Empty>
              ) : (
                <List>
                  {paidExpenses.map((exp) => (
                    <Row
                      key={exp.id}
                      icon={<IconExpenses width={17} height={17} />}
                      iconTone="amber"
                      title={exp.description}
                      sub={`${exp.category} · ${fmtDate(exp.incurred_on)}`}
                      amount={formatPaiseShort(exp.amount_paise)}
                      note="Paid"
                    />
                  ))}
                </List>
              )}
            </Panel>
          </>
        )}
      </Screen>

      {/* ------------------------------------------------------- MODAL SHEETS */}
      {bankSheet && (
        <BankStatementSheet onClose={() => setBankSheet(false)} />
      )}
      {cashSheet && (
        <CashMovementSheet initial={initialCashData} onClose={() => setCashSheet(false)} />
      )}
      {expenseSheet && (
        <ProposeExpenseSheet onClose={() => setExpenseSheet(false)} />
      )}
      {reportSheet && (
        <TreasuryReportSheet onClose={() => setReportSheet(false)} />
      )}
      {distSheet && (
        <DistributionSheet onClose={() => setDistSheet(false)} />
      )}
    </>
  );
}

// ============================================================================
// Subcomponents & Sheets
// ============================================================================

