import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery, useMutation } from '../hooks/useQuery';
import { useSession, useIsOfficer } from '../context/SessionContext';
import { useFund } from '../context/FundContext';
import {
  formatPaise, formatPaiseShort, rupeesToPaise, paiseToRupees,
} from '../lib/money';
import { haptic } from '../lib/haptics';
import {
  Hero, Chip, Panel, List, Row, Empty, Sheet, Field, AmountField,
  Busy, ErrorNote, Notice, Stat, Segments, fmtDate, fmtDateTime,
} from '../components/ui';
import {
  IconPlus, IconBank, IconWallet, IconExpenses, IconCheck, IconArrowUp,
  IconArrowDown, IconShare,
} from '../components/icons';
import type {
  BankStatement, CashEntry, ExpenseRow, ExpenseCategory, Vote,
} from '../lib/types';
import { today } from '../lib/dates';

type HubTab = 'overview' | 'bank' | 'cash' | 'expenses';

const EXPENSE_CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: 'trip', label: 'Trip' },
  { value: 'party', label: 'Party' },
  { value: 'celebration', label: 'Celebration' },
  { value: 'other', label: 'Other' },
  { value: 'bank_charge', label: 'Bank charge' },
  { value: 'admin', label: 'Admin cost' },
];

export default function MoneyHub({ defaultTab }: { defaultTab?: HubTab }) {
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
        sub="Bank balance, cash float & expenses"
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
                    <Chip>Total Fund <b>{formatPaiseShort(fund.total_fund_paise)}</b></Chip>
                    <Chip tone="violet">− On loan <b>{formatPaiseShort(fund.outstanding_paise)}</b></Chip>
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
              <div className="btn-row" style={{ marginBlock: 12 }}>
                <button
                  type="button"
                  className="primary lg"
                  style={{ width: '100%' }}
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
              {(bankQ.data ?? []).length === 0 ? (
                <Empty icon={<IconBank width={22} height={22} />}>
                  No statements recorded yet. Reconcile once each month to verify bank balances.
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
              <div className="btn-row" style={{ marginBlock: 12 }}>
                <button
                  type="button"
                  className="primary lg"
                  style={{ width: '100%' }}
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

            <Panel title="Cash Ledger" flush>
              {(cashQ.data ?? []).length === 0 ? (
                <Empty icon={<IconWallet width={22} height={22} />}>No cash transactions logged yet.</Empty>
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

            <div className="btn-row" style={{ marginBlock: 12 }}>
              <button
                type="button"
                className="primary lg"
                style={{ width: '100%' }}
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

            <Panel title="Expense Ledger" flush>
              {paidExpenses.length === 0 ? (
                <Empty icon={<IconExpenses width={22} height={22} />}>No approved expenses recorded yet.</Empty>
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
    </>
  );
}

// ============================================================================
// Subcomponents & Sheets
// ============================================================================

function ExpenseVoteCard({ expense, isLast }: { expense: ExpenseRow; isLast?: boolean }) {
  const { member } = useSession();
  const isOfficer = useIsOfficer();
  const isProposer = member?.id === expense.created_by;

  const voteM = useMutation(
    async (v: Vote) => {
      const { error } = await supabase.rpc('cast_expense_vote', {
        p_expense_id: expense.id,
        p_vote: v,
        p_note: null,
      });
      if (error) throw error;
    },
    { invalidates: ['expenses', 'fund'] },
  );

  const cancelM = useMutation(
    async () => {
      const { error } = await supabase.rpc('cancel_expense', {
        p_expense_id: expense.id,
      });
      if (error) throw error;
    },
    { invalidates: ['expenses', 'fund'] },
  );

  const pct = (expense.approvals / Math.max(1, expense.required_approvals)) * 100;

  return (
    <div
      style={{
        paddingBottom: isLast ? 0 : 14,
        marginBottom: isLast ? 0 : 14,
        borderBottom: isLast ? 'none' : '1px solid var(--hairline)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <strong>{expense.description}</strong>
        <span style={{ fontFamily: 'var(--display)', fontWeight: 650 }}>
          {formatPaise(expense.amount_paise)}
        </span>
      </div>
      <p className="dim" style={{ margin: '4px 0 8px', fontSize: '0.84rem' }}>
        {expense.category} · proposed by {expense.created_by_name}
      </p>
      <div className="meter">
        <i style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <p className="dim" style={{ margin: '6px 0 0', fontSize: '0.82rem' }}>
        {expense.approvals} of {expense.required_approvals} approvals needed
      </p>

      <ErrorNote error={voteM.error || cancelM.error} />

      {expense.my_vote ? (
        <p className="dim" style={{ marginTop: 8, fontSize: '0.84rem' }}>
          You voted to {expense.my_vote}.
        </p>
      ) : isProposer ? (
        <p className="dim" style={{ marginTop: 8, fontSize: '0.84rem' }}>
          You proposed this expense — you cannot vote on it.
        </p>
      ) : expense.can_i_vote ? (
        <div className="btn-row" style={{ marginTop: 10 }}>
          <Busy
            className="primary"
            style={{ flex: 1 }}
            pending={voteM.pending}
            onClick={() => void voteM.run('approve')}
          >
            Approve
          </Busy>
          <Busy
            className="danger"
            style={{ flex: 1 }}
            pending={voteM.pending}
            onClick={() => void voteM.run('reject')}
          >
            Reject
          </Busy>
        </div>
      ) : null}

      {(isProposer || isOfficer) && (
        <Busy
          className="subtle"
          style={{ color: 'var(--coral)', marginTop: 8, fontSize: '0.82rem', padding: '4px 0' }}
          pending={cancelM.pending}
          onClick={() => void cancelM.run()}
        >
          Cancel this request
        </Busy>
      )}
    </div>
  );
}

function BankStatementSheet({ onClose }: { onClose: () => void }) {
  const [balance, setBalance] = useState('');
  const [asOf, setAsOf] = useState(today());
  const [note, setNote] = useState('');

  const submit = useMutation(
    async () => {
      const closing = rupeesToPaise(balance);
      if (closing < 0) throw new Error('Balance cannot be negative');
      const { error } = await supabase.rpc('record_bank_statement', {
        p_as_of: asOf,
        p_closing_balance_paise: closing,
        p_note: note || null,
      });
      if (error) throw error;
    },
    { invalidates: ['bank', 'fund'], onSuccess: onClose },
  );

  return (
    <Sheet open title="Record bank statement" onClose={onClose}>
      <AmountField value={balance} onChange={setBalance} autoFocus />
      <Field label="Statement date">
        <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
      </Field>
      <Field label="Note (optional)">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="SBI statement page 1" />
      </Field>
      <ErrorNote error={submit.error} />
      <div className="btn-row stack">
        <Busy className="primary lg" pending={submit.pending} onClick={() => void submit.run()}>
          Record statement
        </Busy>
      </div>
    </Sheet>
  );
}

function CashMovementSheet({
  initial,
  onClose,
}: {
  initial?: { direction: 'in' | 'out'; amount: string; purpose: string };
  onClose: () => void;
}) {
  const [direction, setDirection] = useState<'in' | 'out'>(initial?.direction ?? 'in');
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [purpose, setPurpose] = useState(initial?.purpose ?? '');
  const [counterparty, setCounterparty] = useState('');

  const submit = useMutation(
    async () => {
      const amt = rupeesToPaise(amount);
      if (amt <= 0) throw new Error('Amount must be positive');
      if (!purpose.trim()) throw new Error('Please describe the purpose');

      const { error } = await supabase.rpc('record_cash_movement', {
        p_direction: direction,
        p_amount_paise: amt,
        p_purpose: purpose.trim(),
        p_counterparty: counterparty.trim() || null,
        p_report_now: true,
      });
      if (error) throw error;
    },
    { invalidates: ['cash', 'fund'], onSuccess: onClose },
  );

  return (
    <Sheet open title="Record cash movement" onClose={onClose}>
      <div className="seg-row" style={{ marginBottom: 14 }}>
        <button
          type="button"
          className={`seg${direction === 'in' ? ' on' : ''}`}
          onClick={() => setDirection('in')}
        >
          Cash Taken In (+)
        </button>
        <button
          type="button"
          className={`seg${direction === 'out' ? ' on' : ''}`}
          onClick={() => setDirection('out')}
        >
          Cash Paid Out (−)
        </button>
      </div>

      <AmountField value={amount} onChange={setAmount} autoFocus />

      <Field label="Purpose">
        <input
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="e.g. Deposit to bank, Snacks for meeting"
        />
      </Field>

      <Field label="Counterparty (optional)">
        <input
          value={counterparty}
          onChange={(e) => setCounterparty(e.target.value)}
          placeholder="Bank branch, vendor name, etc."
        />
      </Field>

      <ErrorNote error={submit.error} />
      <div className="btn-row stack">
        <Busy className="primary lg" pending={submit.pending} onClick={() => void submit.run()}>
          Record {direction === 'in' ? 'Cash Received' : 'Cash Paid'}
        </Busy>
      </div>
    </Sheet>
  );
}

function ProposeExpenseSheet({ onClose }: { onClose: () => void }) {
  const isOfficer = useIsOfficer();
  const [category, setCategory] = useState<ExpenseCategory>('trip');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');

  const submit = useMutation(
    async () => {
      const amt = rupeesToPaise(amount);
      if (amt <= 0) throw new Error('Amount must be positive');
      if (!description.trim()) throw new Error('Please describe what this expense is for');

      const { error } = await supabase.rpc('propose_expense', {
        p_category: category,
        p_description: description.trim(),
        p_amount_paise: amt,
        p_incurred_on: today(),
        p_method: 'bank',
      });
      if (error) throw error;
    },
    { invalidates: ['expenses', 'fund'], onSuccess: onClose },
  );

  const categories = EXPENSE_CATEGORIES.filter(
    (c) => isOfficer || !['bank_charge', 'admin'].includes(c.value),
  );

  return (
    <Sheet open title="Propose group expense" onClose={onClose}>
      <AmountField value={amount} onChange={setAmount} autoFocus />

      <div className="scroller" style={{ marginBlock: 14 }}>
        {categories.map((c) => (
          <button
            key={c.value}
            type="button"
            className={`seg${category === c.value ? ' on' : ''}`}
            onClick={() => setCategory(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <Field label="Description">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Travel tickets for team visit"
        />
      </Field>

      <Notice>
        Regular expenses require voting approval from the group before being marked paid.
      </Notice>

      <ErrorNote error={submit.error} />
      <div className="btn-row stack">
        <Busy className="primary lg" pending={submit.pending} onClick={() => void submit.run()}>
          Submit proposal
        </Busy>
      </div>
    </Sheet>
  );
}

function TreasuryReportSheet({ onClose }: { onClose: () => void }) {
  const { fund } = useFund();
  const { group } = useSession();

  const handleExportCSV = () => {
    if (!fund) return;
    const rows = [
      ['Metric', 'Amount (Rs)'],
      ['Total Group Fund', (fund.total_fund_paise / 100).toFixed(2)],
      ['Expected in Bank', (fund.expected_bank_balance_paise / 100).toFixed(2)],
      ['Cash Float in Hand', (fund.cash_float_paise / 100).toFixed(2)],
      ['Outstanding on Loan', (fund.outstanding_paise / 100).toFixed(2)],
      ['Safety Reserve Kept Back', (fund.reserve_paise / 100).toFixed(2)],
      ['Total Expenses Paid', (fund.expenses_paise / 100).toFixed(2)],
    ];
    const csvContent = 'data:text/csv;charset=utf-8,' + rows.map((e) => e.join(',')).join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `${group?.name || 'Sanchay'}_Treasury_${today()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleShareWhatsApp = () => {
    if (!fund) return;
    const text = `📊 *${group?.name || 'Sanchay'} Financial Snapshot*\n` +
      `📅 Date: ${today()}\n\n` +
      `💰 *Total Fund*: ${formatPaise(fund.total_fund_paise)}\n` +
      `🏦 *In Bank*: ${formatPaise(fund.expected_bank_balance_paise)}\n` +
      `💵 *Cash in Hand*: ${formatPaise(fund.cash_float_paise)}\n` +
      `🤝 *Active Loans*: ${formatPaise(fund.outstanding_paise)}\n` +
      `🛡️ *Safety Reserve*: ${formatPaise(fund.reserve_paise)}\n\n` +
      `_Automated summary from Sanchay._`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  };

  return (
    <Sheet open title="Treasury Statement" onClose={onClose}>
      {fund && (
        <div className="stats three" style={{ marginBlock: 12 }}>
          <Stat k="Total Fund" v={formatPaiseShort(fund.total_fund_paise)} tone="mint" />
          <Stat k="In Bank" v={formatPaiseShort(fund.expected_bank_balance_paise)} />
          <Stat k="In Cash" v={formatPaiseShort(fund.cash_float_paise)} />
        </div>
      )}

      <div className="btn-row stack" style={{ marginTop: 18 }}>
        <button type="button" className="primary lg" onClick={handleShareWhatsApp}>
          Share to WhatsApp
        </button>
        <button type="button" className="lg" onClick={handleExportCSV}>
          Download Excel / CSV
        </button>
      </div>
    </Sheet>
  );
}
