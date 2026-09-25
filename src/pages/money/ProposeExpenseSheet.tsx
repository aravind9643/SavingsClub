// Moved out of MoneyHub.tsx unchanged -- byte-identical to what was there,
// verified rather than assumed. MoneyHub.tsx is the screen that uses it.
import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useMutation } from '../../hooks/useQuery';
import { useIsOfficer } from '../../context/SessionContext';
import { rupeesToPaise } from '../../lib/money';
import {
  Sheet,
  Field,
  AmountField,
  Busy,
  ErrorNote,
  Notice,
} from '../../components/ui';
import type { ExpenseCategory } from '../../lib/types';
import { today } from '../../lib/dates';
import { EXPENSE_CATEGORIES } from './categories';

export function ProposeExpenseSheet({ onClose }: { onClose: () => void }) {
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
