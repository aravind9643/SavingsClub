// Moved out of MoneyHub.tsx unchanged -- byte-identical to what was there,
// verified rather than assumed. MoneyHub.tsx is the screen that uses it.
import { useSession } from '../../context/SessionContext';
import { useFund } from '../../context/FundContext';
import { formatPaise, formatPaiseShort } from '../../lib/money';
import { Sheet, Stat } from '../../components/ui';
import { today } from '../../lib/dates';

export function TreasuryReportSheet({ onClose }: { onClose: () => void }) {
  const { fund } = useFund();
  const { group } = useSession();

  const handleExportCSV = () => {
    if (!fund) return;
    const rows = [
      ['Metric', 'Amount (Rs)'],
      ['Total Group Fund', (fund.total_fund_paise / 100).toFixed(2)],
      ['Expected in Bank', (fund.expected_bank_balance_paise / 100).toFixed(2)],
      ['Cash in hand', (fund.cash_float_paise / 100).toFixed(2)],
      ['Still out on loan', (fund.outstanding_paise / 100).toFixed(2)],
      ['Safety Reserve Kept Back', (fund.reserve_paise / 100).toFixed(2)],
      ['Total Expenses Paid', (fund.expenses_paise / 100).toFixed(2)],
    ];
    const csvContent = 'data:text/csv;charset=utf-8,' + rows.map((e) => e.join(',')).join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `${group?.name || 'SavingsClub'}_Treasury_${today()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
