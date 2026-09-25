import { useState } from 'react';
import { Sheet, Busy, fmtDate } from './ui';
import { formatPaise, formatPaiseShort } from '../lib/money';
import { today } from '../lib/dates';
import type { GroupExportData } from '../lib/export';

export function PrintableStatementModal({
  data,
  groupName,
  onClose,
}: {
  data: GroupExportData;
  groupName: string;
  onClose: () => void;
}) {
  const [printing, setPrinting] = useState(false);

  const totalContributions = (data.contributions || []).reduce((acc, c) => acc + c.amount_paise, 0);
  const totalLateFees = (data.contributions || []).reduce((acc, c) => acc + (c.late_fee_paise || 0), 0);
  const totalInterestEarned = (data.loan_repayments || []).reduce(
    (acc, r) => acc + r.interest_paise + (r.penalty_paise || 0),
    0,
  );
  const totalExpenses = (data.expenses || []).reduce((acc, e) => acc + e.amount_paise, 0);
  const totalPayouts = (data.payouts || []).reduce((acc, p) => acc + p.net_paid_paise, 0);
  const totalDistributions = (data.distributions || []).reduce(
    (acc, d) => acc + (d.status === 'confirmed' ? d.total_paise : 0),
    0,
  );

  const handlePrint = () => {
    setPrinting(true);
    setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 150);
  };

  const s = data.summary || {
    total_fund_paise: 0,
    expected_bank_balance_paise: 0,
    cash_float_paise: 0,
    total_outstanding_principal_paise: 0,
    accrued_receivable_paise: 0,
  };

  return (
    <Sheet open title="Annual Financial Statement" onClose={onClose}>
      <div id="printable-statement" style={{ padding: '4px 0' }}>
        <div
          style={{
            background: 'var(--surface-sunken)',
            padding: 16,
            borderRadius: 'var(--r-sm)',
            border: '1px solid var(--hairline)',
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--text)' }}>
                {groupName || 'SavingsClub'}
              </div>
              <div className="dim" style={{ fontSize: '0.82rem', marginTop: 2 }}>
                Statement as of {fmtDate(today())}
              </div>
            </div>
            <div
              style={{
                fontSize: '0.78rem',
                fontWeight: 700,
                padding: '4px 8px',
                borderRadius: 4,
                background: 'var(--mint-ghost)',
                color: 'var(--mint)',
                textTransform: 'uppercase',
              }}
            >
              Audited Ledger
            </div>
          </div>
        </div>

        {/* Balance Sheet Asset Position */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-3)', marginBottom: 8 }}>
            Current Asset Distribution
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: 8,
            }}
          >
            <div style={{ background: 'var(--surface-2)', padding: 10, borderRadius: 'var(--r-sm)' }}>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-3)' }}>In Bank Account</div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--mint)', marginTop: 2 }}>
                {formatPaiseShort(s.expected_bank_balance_paise)}
              </div>
            </div>
            <div style={{ background: 'var(--surface-2)', padding: 10, borderRadius: 'var(--r-sm)' }}>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-3)' }}>Cash Float (Cashier)</div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--amber)', marginTop: 2 }}>
                {formatPaiseShort(s.cash_float_paise)}
              </div>
            </div>
            <div style={{ background: 'var(--surface-2)', padding: 10, borderRadius: 'var(--r-sm)' }}>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-3)' }}>Active Loans</div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--violet)', marginTop: 2 }}>
                {formatPaiseShort(s.total_outstanding_principal_paise)}
              </div>
            </div>
          </div>
        </div>

        {/* Operating Inflows & Outflows */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-3)', marginBottom: 8 }}>
            Income & Cash Movement Summary
          </div>

          <div style={{ border: '1px solid var(--hairline)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--hairline)', background: 'var(--surface-2)', fontSize: '0.84rem' }}>
              <span>Total Member Contributions</span>
              <strong style={{ color: 'var(--text)' }}>{formatPaise(totalContributions)}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--hairline)', fontSize: '0.84rem' }}>
              <span>Loan Interest & Penalties Earned</span>
              <strong style={{ color: 'var(--mint)' }}>+{formatPaise(totalInterestEarned)}</strong>
            </div>
            {totalLateFees > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--hairline)', fontSize: '0.84rem' }}>
                <span>Late Payment Fines</span>
                <strong style={{ color: 'var(--mint)' }}>+{formatPaise(totalLateFees)}</strong>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--hairline)', fontSize: '0.84rem' }}>
              <span>Approved Group Expenses</span>
              <strong style={{ color: 'var(--coral)' }}>-{formatPaise(totalExpenses)}</strong>
            </div>
            {totalDistributions > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--hairline)', fontSize: '0.84rem' }}>
                <span>Dividends Distributed</span>
                <strong style={{ color: 'var(--violet)' }}>-{formatPaise(totalDistributions)}</strong>
              </div>
            )}
            {totalPayouts > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--hairline)', fontSize: '0.84rem' }}>
                <span>Departing Member Payouts</span>
                <strong style={{ color: 'var(--text-2)' }}>-{formatPaise(totalPayouts)}</strong>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 14px', background: 'var(--surface-3)', fontSize: '0.92rem', fontWeight: 700 }}>
              <span>Net Group Capital</span>
              <span style={{ color: 'var(--mint)' }}>{formatPaise(s.total_fund_paise)}</span>
            </div>
          </div>
        </div>

        {/* Signatures block for paper reports */}
        <div
          style={{
            marginTop: 24,
            paddingTop: 16,
            borderTop: '1px dashed var(--hairline)',
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12,
            textAlign: 'center',
            fontSize: '0.76rem',
            color: 'var(--text-3)',
          }}
        >
          <div>
            <div style={{ height: 28 }} />
            <div style={{ borderTop: '1px solid var(--hairline)', paddingTop: 4 }}>Accountant</div>
          </div>
          <div>
            <div style={{ height: 28 }} />
            <div style={{ borderTop: '1px solid var(--hairline)', paddingTop: 4 }}>Cashier</div>
          </div>
          <div>
            <div style={{ height: 28 }} />
            <div style={{ borderTop: '1px solid var(--hairline)', paddingTop: 4 }}>Admin</div>
          </div>
        </div>
      </div>

      <div className="btn-row stack" style={{ marginTop: 20 }}>
        <Busy className="primary lg" pending={printing} onClick={handlePrint}>
          Print / Save PDF Statement
        </Busy>
        <button type="button" className="subtle" onClick={onClose}>
          Close
        </button>
      </div>
    </Sheet>
  );
}
