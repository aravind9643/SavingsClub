// Moved out of MoneyHub.tsx, which is the screen that uses it. Its CSV now goes
// through lib/export (exact paise, formula-safe cells, Blob not data: URI).
import { useSession } from '../../context/SessionContext';
import { useFund } from '../../context/FundContext';
import { formatPaise, formatPaiseShort } from '../../lib/money';
import { Sheet, Stat } from '../../components/ui';
import { today } from '../../lib/dates';
import { downloadCsv, paiseToCsv } from '../../lib/export';

export function TreasuryReportSheet({ onClose }: { onClose: () => void }) {
  const { fund } = useFund();
  const { group } = useSession();

  const handleExportCSV = () => {
    if (!fund) return;
    const safeName = (group?.name || 'SavingsClub').replace(/[^\p{L}\p{N}]+/gu, '_');
    downloadCsv(`${safeName}_Treasury_${today()}.csv`, [
      ['Metric', 'Amount (Rs)'],
      ['Total Group Fund', paiseToCsv(fund.total_fund_paise)],
      ['Expected in Bank', paiseToCsv(fund.expected_bank_balance_paise)],
      ['Cash in hand', paiseToCsv(fund.cash_float_paise)],
      ['Still out on loan', paiseToCsv(fund.outstanding_paise)],
      ['Safety Reserve Kept Back', paiseToCsv(fund.reserve_paise)],
      ['Total Expenses Paid', paiseToCsv(fund.expenses_paise)],
    ]);
  };

  const handleShareWhatsApp = () => {
    if (!fund) return;
    const text = `📊 *${group?.name || 'SavingsClub'} Financial Snapshot*\n` +
      `📅 Date: ${today()}\n\n` +
      `💰 *Total Fund*: ${formatPaise(fund.total_fund_paise)}\n` +
      `🏦 *In Bank*: ${formatPaise(fund.expected_bank_balance_paise)}\n` +
      `💵 *Cash in Hand*: ${formatPaise(fund.cash_float_paise)}\n` +
      `🤝 *Active Loans*: ${formatPaise(fund.outstanding_paise)}\n` +
      `🛡️ *Safety Reserve*: ${formatPaise(fund.reserve_paise)}\n\n` +
      `_Automated summary from SavingsClub._`;
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
