// Moved out of MoneyHub.tsx unchanged -- byte-identical to what was there,
// verified rather than assumed. MoneyHub.tsx is the screen that uses it.
import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useMutation } from '../../hooks/useQuery';
import { rupeesToPaise } from '../../lib/money';
import { Sheet, Field, AmountField, Busy, ErrorNote } from '../../components/ui';
import { today } from '../../lib/dates';

export function BankStatementSheet({ onClose }: { onClose: () => void }) {
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
