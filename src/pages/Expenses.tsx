import { useState } from 'react';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery, useMutation } from '../hooks/useQuery';
import { useSession, useIsOfficer } from '../context/SessionContext';
import { formatPaise, formatPaiseShort, rupeesToPaise } from '../lib/money';
import {
  Panel, List, Row, Empty, SkeletonList, Sheet, Field, AmountField, Busy,
  ErrorNote, Segments, fmtDate, toneForStatus,
} from '../components/ui';
import { IconPlus, IconExpenses } from '../components/icons';
import type { ExpenseRow, ExpenseCategory, PaymentMethod, Vote } from '../lib/types';

const CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: 'trip', label: 'Trip' },
  { value: 'party', label: 'Party' },
  { value: 'celebration', label: 'Celebration' },
  { value: 'other', label: 'Other' },
  { value: 'bank_charge', label: 'Bank charge' },
  { value: 'admin', label: 'Admin cost' },
];

type Filter = 'all' | 'voting' | 'paid';

export default function Expenses() {
  const [sheet, setSheet] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');

  const q = useQuery<ExpenseRow[]>('expenses', async () => {
    const { data, error } = await supabase
      .from('v_expense_status').select('*').order('incurred_on', { ascending: false });
    if (error) throw error;
    return (data ?? []) as ExpenseRow[];
  });

  const all = q.data ?? [];
  const voting = all.filter((e) => e.status === 'proposed');
  const paid = all.filter((e) => e.status === 'paid');
  const shown = filter === 'voting' ? voting : filter === 'paid' ? paid : all;

  return (
    <>
      <Screen title="Expenses" sub={`${formatPaiseShort(paid.reduce((s, e) => s + e.amount_paise, 0))} spent`}>
        <Segments<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: all.length },
            { value: 'voting', label: 'Voting', count: voting.length },
            { value: 'paid', label: 'Paid', count: paid.length },
          ]}
        />

        {voting.length > 0 && filter !== 'paid' && (
          <Panel title="Waiting for votes">
            {voting.map((e) => <VoteCard key={e.id} expense={e} />)}
          </Panel>
        )}

        <Panel title={filter === 'voting' ? 'All proposals' : 'History'} flush>
          {q.loading && !q.data ? (
            <SkeletonList rows={4} />
          ) : shown.filter((e) => e.status !== 'proposed' || filter === 'voting').length === 0 ? (
            <Empty icon={<IconExpenses width={22} height={22} />}>
              Nothing recorded yet.
            </Empty>
          ) : (
            <List>
              {shown
                .filter((e) => e.status !== 'proposed' || filter === 'voting')
                .map((e) => <ExpenseRowItem key={e.id} expense={e} />)}
            </List>
          )}
        </Panel>
      </Screen>

      <button className="fab" onClick={() => setSheet(true)}>
        <IconPlus width={18} height={18} />
        Expense
      </button>

      {sheet && <ProposeSheet onClose={() => setSheet(false)} />}
    </>
  );
}

function ExpenseRowItem({ expense }: { expense: ExpenseRow }) {
  const isOfficer = useIsOfficer();
  const pay = useMutation(
    async () => {
      const { error } = await supabase.rpc('mark_expense_paid', { p_expense_id: expense.id });
      if (error) throw error;
    },
    { invalidates: ['expenses', 'fund', 'cash', 'feed'] },
  );

  return (
    <Row
      icon={<IconExpenses width={17} height={17} />}
      iconTone={toneForStatus(expense.status)}
      title={expense.description}
      sub={`${expense.category} · ${fmtDate(expense.incurred_on)}`}
      amount={formatPaiseShort(expense.amount_paise)}
      note={
        expense.status === 'approved' && isOfficer ? (
          <button
            className="seg"
            style={{ padding: '3px 9px', fontSize: '0.7rem' }}
            disabled={pay.pending}
            onClick={() => void pay.run()}
          >
            Mark paid
          </button>
        ) : (
          expense.status
        )
      }
    />
  );
}

function VoteCard({ expense }: { expense: ExpenseRow }) {
  const vote = useMutation(
    async (v: Vote) => {
      const { error } = await supabase.rpc('cast_expense_vote', {
        p_expense_id: expense.id, p_vote: v, p_note: null,
      });
      if (error) throw error;
    },
    { invalidates: ['expenses', 'fund', 'feed'] },
  );

  const pct = (expense.approvals / Math.max(1, expense.required_approvals)) * 100;

  return (
    <div style={{ paddingBottom: 14, marginBottom: 14, borderBottom: '1px solid var(--hairline)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <strong style={{ flex: 1, minWidth: 0 }}>{expense.description}</strong>
        <span style={{ fontFamily: 'var(--display)', fontWeight: 650 }}>
          {formatPaise(expense.amount_paise)}
        </span>
      </div>
      <p className="dim" style={{ margin: '3px 0 8px' }}>
        {expense.category} · proposed by {expense.created_by_name}
      </p>
      <div className="meter"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
      <p className="dim" style={{ margin: '7px 0 0' }}>
        {expense.approvals} of {expense.required_approvals} approvals
      </p>

      <ErrorNote error={vote.error} />

      {expense.my_vote ? (
        <p className="dim" style={{ marginTop: 8 }}>You voted to {expense.my_vote}.</p>
      ) : expense.can_i_vote ? (
        <div className="btn-row">
          <Busy className="primary" style={{ flex: 1 }} pending={vote.pending}
            onClick={() => void vote.run('approve')}>
            Approve
          </Busy>
          <Busy className="danger" style={{ flex: 1 }} pending={vote.pending}
            onClick={() => void vote.run('reject')}>
            Reject
          </Busy>
        </div>
      ) : null}
    </div>
  );
}

function ProposeSheet({ onClose }: { onClose: () => void }) {
  const { config } = useSession();
  const [category, setCategory] = useState<ExpenseCategory>('trip');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [incurredOn, setIncurredOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<PaymentMethod>('bank');

  const save = useMutation(
    async () => {
      const { error } = await supabase.rpc('propose_expense', {
        p_category: category,
        p_description: description,
        p_amount_paise: rupeesToPaise(amount),
        p_incurred_on: incurredOn,
        p_method: method,
      });
      if (error) throw error;
    },
    { invalidates: ['expenses', 'fund', 'feed'], onSuccess: onClose },
  );

  const needsVote = !['bank_charge', 'admin'].includes(category);

  return (
    <Sheet open title="New expense" onClose={onClose}>
      <ErrorNote error={save.error} />

      <AmountField value={amount} onChange={setAmount} autoFocus />

      <div className="scroller" style={{ marginBlock: 14 }}>
        {CATEGORIES.map((c) => (
          <button
            key={c.value}
            className={`seg${category === c.value ? ' on' : ''}`}
            onClick={() => setCategory(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <Field label="What is it for">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Annual trip to Araku"
        />
      </Field>

      <div className="field-row" style={{ marginTop: 14 }}>
        <Field label="Date">
          <input type="date" value={incurredOn} onChange={(e) => setIncurredOn(e.target.value)} />
        </Field>
        <Field label="Pay by">
          <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            <option value="bank">Bank</option>
            <option value="cash">Cash</option>
          </select>
        </Field>
      </div>

      <p className="dim" style={{ marginTop: 14 }}>
        {needsVote
          ? `${config?.expense_required_approvals ?? 5} members must approve. Group expenses are capped at ${(config?.expense_annual_pct_bp ?? 2000) / 100}% of the fund per year.`
          : 'Admin costs do not need a vote.'}
      </p>

      <div className="btn-row stack">
        <Busy
          className="primary lg"
          pending={save.pending}
          disabled={!description || !amount}
          onClick={() => void save.run()}
        >
          {needsVote ? 'Send for approval' : 'Record'}
        </Busy>
      </div>
    </Sheet>
  );
}
