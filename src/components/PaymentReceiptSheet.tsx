import { Sheet, fmtDate } from './ui';
import { formatPaise } from '../lib/money';
import { haptic } from '../lib/haptics';
import { IconShare, IconCheck } from './icons';

export interface ReceiptData {
  id: string;
  groupName: string;
  memberName: string;
  memberPhone?: string | null;
  title: string;
  periodOrDetail: string;
  amountPaise: number;
  feeOrInterestPaise?: number;
  feeLabel?: string;
  paidOn: string;
  method?: string;
  notes?: string | null;
}

export function PaymentReceiptSheet({
  receipt,
  onClose,
}: {
  receipt: ReceiptData;
  onClose: () => void;
}) {
  const code = receipt.id.replace(/-/g, '').slice(0, 8).toUpperCase();
  const totalPaid = receipt.amountPaise + (receipt.feeOrInterestPaise || 0);

  const isLoanReceipt = receipt.title.toLowerCase().includes('loan');
  const personLabel = isLoanReceipt ? 'Borrower' : 'Member';

  const handleShareWhatsApp = () => {
    haptic(10);
    const cleanPhone = receipt.memberPhone ? receipt.memberPhone.replace(/[^\d+]/g, '') : '';
    const text =
      `🧾 *PAYMENT RECEIPT — ${receipt.groupName || 'SavingsClub'}*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `*Receipt No*: #REC-${code}\n` +
      `*${personLabel}*: ${receipt.memberName}\n` +
      `*Purpose*: ${receipt.title} (${receipt.periodOrDetail})\n` +
      `*Amount Paid*: ${formatPaise(receipt.amountPaise)}\n` +
      (receipt.feeOrInterestPaise && receipt.feeOrInterestPaise > 0
        ? `*${receipt.feeLabel || 'Late Fee / Charges'}*: ${formatPaise(receipt.feeOrInterestPaise)}\n*Total Paid*: ${formatPaise(totalPaid)}\n`
        : '') +
      `*Date*: ${fmtDate(receipt.paidOn)}\n` +
      `*Method*: ${(receipt.method || 'CASH').toUpperCase()}\n` +
      `*Status*: ✅ VERIFIED & RECORDED\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `_Official transaction record from SavingsClub_`;

    const url = cleanPhone
      ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  };

  return (
    <Sheet open title="Payment Receipt" onClose={onClose}>
      <div id="receipt-slip" style={{ padding: '4px 0' }}>
        <div
          style={{
            background: 'var(--surface-sunken)',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--r-lg)',
            padding: '20px 18px',
            textAlign: 'center',
            position: 'relative',
          }}
        >
          {/* Top Badge */}
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: '50%',
              background: 'var(--mint)',
              color: '#fff',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.4rem',
              marginBottom: 10,
              boxShadow: '0 4px 14px rgba(16, 185, 129, 0.35)',
            }}
          >
            <IconCheck width={24} height={24} />
          </div>

          <div style={{ fontSize: '0.82rem', fontWeight: 650, color: 'var(--mint)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Payment Confirmed
          </div>
          <div style={{ fontSize: '1.9rem', fontWeight: 800, color: 'var(--text)', marginTop: 4 }}>
            {formatPaise(totalPaid)}
          </div>
          <div className="dim" style={{ fontSize: '0.8rem', marginTop: 2 }}>
            #REC-{code} · {receipt.groupName || 'SavingsClub'}
          </div>

          <div
            style={{
              margin: '18px 0',
              borderTop: '1px dashed var(--hairline)',
              borderBottom: '1px dashed var(--hairline)',
              padding: '14px 0',
              textAlign: 'left',
              display: 'flex',
              flexDirection: 'column',
              gap: 9,
              fontSize: '0.85rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="dim">{personLabel} Name</span>
              <span style={{ fontWeight: 650, color: 'var(--text)' }}>{receipt.memberName}</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="dim">Payment For</span>
              <span style={{ fontWeight: 600, color: 'var(--text)' }}>{receipt.title}</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="dim">Period / Description</span>
              <span style={{ fontWeight: 600, color: 'var(--text-2)' }}>{receipt.periodOrDetail}</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="dim">Date of Payment</span>
              <span style={{ fontWeight: 600, color: 'var(--text)' }}>{fmtDate(receipt.paidOn)}</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="dim">Payment Method</span>
              <span style={{ fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-2)' }}>
                {receipt.method || 'CASH'}
              </span>
            </div>

            {receipt.feeOrInterestPaise && receipt.feeOrInterestPaise > 0 ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="dim">Base Principal / Deposit</span>
                  <span style={{ fontWeight: 600 }}>{formatPaise(receipt.amountPaise)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="dim">{receipt.feeLabel || 'Late Fee / Interest'}</span>
                  <span style={{ fontWeight: 600, color: 'var(--coral)' }}>
                    +{formatPaise(receipt.feeOrInterestPaise)}
                  </span>
                </div>
              </>
            ) : null}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: '0.74rem', color: 'var(--text-3)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--mint)' }} />
            Immutable entry recorded in group audit ledger
          </div>
        </div>
      </div>

      <div className="btn-row stack" style={{ marginTop: 18 }}>
        <button
          type="button"
          className="sec-link"
          style={{
            background: '#25D366',
            color: '#fff',
            padding: '12px 18px',
            borderRadius: 'var(--r-sm)',
            fontWeight: 700,
            fontSize: '0.92rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
          onClick={handleShareWhatsApp}
        >
          <IconShare width={16} height={16} />
          Send Receipt on WhatsApp
        </button>

        <button type="button" className="subtle" onClick={() => window.print()}>
          Print / Save PDF Slip
        </button>
      </div>
    </Sheet>
  );
}
