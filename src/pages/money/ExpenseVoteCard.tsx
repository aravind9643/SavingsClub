// Moved out of MoneyHub.tsx unchanged -- byte-identical to what was there,
// verified rather than assumed. MoneyHub.tsx is the screen that uses it.
import { supabase } from '../../lib/supabase';
import { useMutation } from '../../hooks/useQuery';
import { useSession, useIsOfficer } from '../../context/SessionContext';
import { formatPaise } from '../../lib/money';
import { Busy, ErrorNote } from '../../components/ui';
import type { ExpenseRow, Vote } from '../../lib/types';

export function ExpenseVoteCard({ expense, isLast }: { expense: ExpenseRow; isLast?: boolean }) {
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
