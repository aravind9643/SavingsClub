// Moved out of MoneyHub.tsx unchanged -- byte-identical to what was there,
// verified rather than assumed. MoneyHub.tsx is the screen that uses it.
import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useMutation } from '../../hooks/useQuery';
import { rupeesToPaise } from '../../lib/money';
import { Sheet, Field, AmountField, Busy, ErrorNote } from '../../components/ui';

export function CashMovementSheet({
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
        <Busy
          className="primary lg"
          pending={submit.pending}
          disabled={!amount || !purpose.trim()}
          onClick={() => void submit.run()}
        >
          Record {direction === 'in' ? 'Cash Received' : 'Cash Paid'}
        </Busy>
      </div>
    </Sheet>
  );
}
