import { paiseToRupees } from './money';
import { fmtDate } from '../components/ui';
import { today } from './dates';

export interface GroupExportData {
  group: { id: string; name: string; currency: string; created_at: string };
  members: { id: string; full_name: string; phone: string | null; email: string | null; is_active: boolean }[];
  periods: { id: string; period_month: string; amount_paise: number; due_date: string; grace_date: string; closed_at: string | null }[];
  contributions: { id: string; member_id: string; period_id: string; amount_paise: number; late_fee_paise: number; paid_on: string; method: string }[];
  loans: {
    id: string; borrower_id: string; guarantor_id: string; principal_paise: number;
    rate_bp: number; term_months: number; status: string; requested_at: string;
    disbursed_on: string | null; due_on: string | null; closed_on: string | null;
    purpose: string | null;
  }[];
  loan_repayments: { id: string; loan_id: string; paid_on: string; principal_paise: number; interest_paise: number; penalty_paise: number; method: string }[];
  expenses: { id: string; title: string; category: string; amount_paise: number; incurred_on: string; status: string }[];
  cash_ledger: { id: string; occurred_at: string; direction: string; amount_paise: number; reason: string; balance_after_paise: number }[];
  bank_statements: { id: string; statement_date: string; balance_paise: number; verified_at: string }[];
  payouts: { id: string; member_id: string; net_paid_paise: number; paid_on: string; reason: string }[];
  distributions: { id: string; kind: string; total_paise: number; proposed_at: string; confirmed_at: string | null; status: string }[];
  distribution_lines: { id: string; distribution_id: string; member_id: string; amount_paise: number }[];
  meetings: { id: string; held_on: string; location: string | null; notes: string | null }[];
  summary: {
    total_fund_paise: number;
    expected_bank_balance_paise: number;
    cash_float_paise: number;
    total_outstanding_principal_paise: number;
    accrued_receivable_paise: number;
  };
}

function downloadCSV(filename: string, csvContent: string) {
  // \uFEFF BOM ensures Excel interprets UTF-8 correctly
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function escapeCSV(val: unknown): string {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

export function exportContributionsCSV(data: GroupExportData, groupName: string) {
  const memberMap = new Map(data.members.map((m) => [m.id, m.full_name]));
  const periodMap = new Map(data.periods.map((p) => [p.id, p.period_month.slice(0, 7)]));

  const headers = ['Member Name', 'Period (YYYY-MM)', 'Paid On', 'Amount (Rs.)', 'Late Fee (Rs.)', 'Payment Method'];
  const rows = (data.contributions || []).map((c) => [
    escapeCSV(memberMap.get(c.member_id) ?? 'Unknown Member'),
    escapeCSV(periodMap.get(c.period_id) ?? c.period_id),
    escapeCSV(c.paid_on ? fmtDate(c.paid_on) : ''),
    escapeCSV(paiseToRupees(c.amount_paise)),
    escapeCSV(paiseToRupees(c.late_fee_paise)),
    escapeCSV(c.method ? c.method.toUpperCase() : 'CASH'),
  ]);

  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const safeName = (groupName || 'SavingsClub').replace(/\s+/g, '_');
  downloadCSV(`${safeName}_Payments_${today()}.csv`, csv);
}

export function exportLoansCSV(data: GroupExportData, groupName: string) {
  const memberMap = new Map(data.members.map((m) => [m.id, m.full_name]));
  const repayMap = new Map<string, { principal: number; interest: number }>();

  for (const r of data.loan_repayments || []) {
    const cur = repayMap.get(r.loan_id) ?? { principal: 0, interest: 0 };
    cur.principal += r.principal_paise;
    cur.interest += r.interest_paise + (r.penalty_paise || 0);
    repayMap.set(r.loan_id, cur);
  }

  const headers = [
    'Borrower',
    'Guarantor',
    'Loan amount (Rs.)',
    'Repaid so far (Rs.)',
    'Still to repay (Rs.)',
    'Total Interest Paid (Rs.)',
    'Monthly Rate (%)',
    'Months',
    'Status',
    'Requested On',
    'Due Date',
    'Purpose',
  ];

  const rows = (data.loans || []).map((l) => {
    const rep = repayMap.get(l.id) ?? { principal: 0, interest: 0 };
    const outstanding = Math.max(0, l.principal_paise - rep.principal);

    return [
      escapeCSV(memberMap.get(l.borrower_id) ?? 'Unknown'),
      escapeCSV(memberMap.get(l.guarantor_id) ?? 'Unknown'),
      escapeCSV(paiseToRupees(l.principal_paise)),
      escapeCSV(paiseToRupees(rep.principal)),
      escapeCSV(paiseToRupees(outstanding)),
      escapeCSV(paiseToRupees(rep.interest)),
      escapeCSV((l.rate_bp / 100).toFixed(2)),
      escapeCSV(l.term_months),
      escapeCSV(l.status.toUpperCase()),
      escapeCSV(l.requested_at ? fmtDate(l.requested_at.slice(0, 10)) : ''),
      escapeCSV(l.due_on ? fmtDate(l.due_on) : ''),
      escapeCSV(l.purpose || ''),
    ];
  });

  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const safeName = (groupName || 'SavingsClub').replace(/\s+/g, '_');
  downloadCSV(`${safeName}_Loans_Portfolio_${today()}.csv`, csv);
}

export function exportTreasuryCSV(data: GroupExportData, groupName: string) {
  const headers = ['Date / Time', 'Direction', 'Amount (Rs.)', 'Balance After (Rs.)', 'Description'];
  const rows = (data.cash_ledger || []).map((cl) => [
    escapeCSV(cl.occurred_at ? cl.occurred_at.replace('T', ' ').slice(0, 19) : ''),
    escapeCSV(cl.direction.toUpperCase()),
    escapeCSV(paiseToRupees(cl.amount_paise)),
    escapeCSV(paiseToRupees(cl.balance_after_paise)),
    escapeCSV(cl.reason || ''),
  ]);

  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const safeName = (groupName || 'SavingsClub').replace(/\s+/g, '_');
  downloadCSV(`${safeName}_Cash_in_and_out_${today()}.csv`, csv);
}
