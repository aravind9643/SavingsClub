import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useMutation } from '../../hooks/useQuery';
import { formatPaise } from '../../lib/money';
import { today } from '../../lib/dates';
import { haptic } from '../../lib/haptics';
import { Sheet, Field, AmountField, Busy, ErrorNote } from '../../components/ui';

/**
 * "I put the cash in the bank."
 *
 * The most common thing a cashier does with cash, which used to be a generic
 * cash-out with a typed purpose -- and when it was skipped, the books kept
 * the money "in hand" while the bank statement already showed it: a mismatch
 * alert with no money missing. deposit_cash_to_bank() (0046) refuses more
 * than is held; the fund does not move, only where the money sits.
 */
function toRupees(p: number): string {
  const r = Math.floor(p / 100); const c = p % 100;
  return c ? `${r}.${String(c).padStart(2, '0')}` : String(r);
}

export function DepositToBankSheet({
  heldPaise, suggestPaise, onClose,
}: { heldPaise: number; suggestPaise?: number; onClose: () => void }) {
  const [amount, setAmount] = useState(toRupees(Math.min(heldPaise, suggestPaise ?? heldPaise)));
  const [on, setOn] = useState(today());
  const [reference, setReference] = useState('');

  const parsed = (() => {
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim().replace(/,/g, ''));
    return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : NaN;
  })();

  const submit = useMutation(async () => {
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('Enter the amount deposited');
    const { error } = await supabase.rpc('deposit_cash_to_bank', {
      p_amount_paise: parsed, p_deposited_on: on, p_reference: reference.trim() || null,
    });
    if (error) throw error;
  }, { invalidates: ['cash', 'fund', 'bank', 'feed'], onSuccess: () => { haptic(20); onClose(); } });

  return (
    <Sheet open title="Deposit cash in bank" onClose={onClose}>
      <p className="dim" style={{ marginTop: 0 }}>
        {formatPaise(heldPaise)} is in hand. The group's total does not change — only where the money sits.
      </p>
      <AmountField value={amount} onChange={setAmount} autoFocus />
      <Field label="Deposited on">
        <input type="date" value={on} max={today()} onChange={(e) => setOn(e.target.value)} />
      </Field>
      <Field label="Deposit slip / reference (optional)">
        <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. SBI slip 0042" />
      </Field>
      <ErrorNote error={submit.error} />
      <div className="btn-row stack">
        <Busy className="primary lg" pending={submit.pending}
          disabled={!Number.isFinite(parsed) || parsed <= 0 || parsed > heldPaise}
          onClick={() => void submit.run()}>
          {Number.isFinite(parsed) && parsed > heldPaise
            ? `Only ${formatPaise(heldPaise)} is in hand`
            : `Record ${Number.isFinite(parsed) ? formatPaise(parsed) : ''} deposited`}
        </Busy>
      </div>
    </Sheet>
  );
}
