import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery, useMutation, invalidate } from '../hooks/useQuery';
import { useSession, useIsOfficer } from '../context/SessionContext';
import { formatPaise, formatPaiseShort, rupeesToPaise } from '../lib/money';
import {
  Panel, Stat, List, Row, Sheet, Field, AmountField, Busy, ErrorNote,
  Tag, Notice, Loading, fmtDate, ago, toneForStatus,
} from '../components/ui';
import { IconCheck, IconClose, IconArrowDown } from '../components/icons';
import type { LoanRow, Vote, PaymentMethod } from '../lib/types';

interface VoteRow {
  id: string; voter_id: string; vote: Vote; note: string | null; voted_at: string;
  members: { full_name: string } | null;
}

interface RepaymentRow {
  id: string; paid_on: string; principal_paise: number;
  interest_paise: number; penalty_paise: number; method: PaymentMethod;
}

export default function LoanDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { member } = useSession();
  const isOfficer = useIsOfficer();
  const [sheet, setSheet] = useState<'repay' | 'disburse' | null>(null);

  const loanQ = useQuery<LoanRow | null>(id ? `loan:${id}` : null, async () => {
    const { data, error } = await supabase
      .from('v_loan_status').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return (data as LoanRow) ?? null;
  });

  const votesQ = useQuery<VoteRow[]>(id ? `loan:${id}:votes` : null, async () => {
    const { data, error } = await supabase
      .from('loan_votes')
      .select('id, voter_id, vote, note, voted_at, members!loan_votes_voter_id_fkey(full_name)')
      .eq('loan_id', id).order('voted_at');
    if (error) throw error;
    return (data ?? []) as unknown as VoteRow[];
  });

  const repaysQ = useQuery<RepaymentRow[]>(id ? `loan:${id}:repay` : null, async () => {
    const { data, error } = await supabase
      .from('loan_repayments').select('*').eq('loan_id', id).order('paid_on');
    if (error) throw error;
    return (data ?? []) as RepaymentRow[];
  });

  // The tally should move for everyone watching, not just whoever voted.
  useEffect(() => {
    if (!id) return;
    const ch = supabase.channel(`loan-${id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'loan_votes', filter: `loan_id=eq.${id}` },
        () => invalidate(`loan:${id}`))
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'loans', filter: `id=eq.${id}` },
        () => invalidate(`loan:${id}`, 'fund', 'loans'))
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [id]);

  const loan = loanQ.data;
  if (loanQ.loading && !loan) return <Screen title="Loan"><Loading /></Screen>;
  if (!loan) return <Screen title="Loan"><div className="empty">Not found.</div></Screen>;

  const isBorrower = member?.id === loan.borrower_id;
  const dueInterest = Math.max(
    0, loan.accrued_interest_paise + loan.accrued_penalty_paise - loan.interest_paid_paise);

  return (
    <>
      <Screen
        title={loan.borrower_name}
        sub={`Loan · ${loan.status}`}
        action={
          <button className="icon-btn" onClick={() => nav('/loans')} aria-label="Back">
            <IconClose />
          </button>
        }
      >
        <div className="hero">
          <div className="hero-label">
            {loan.status === 'disbursed' ? 'Outstanding' : 'Loan amount'}
          </div>
          <div className="hero-amount">
            {formatPaise(
              loan.status === 'disbursed'
                ? loan.outstanding_principal_paise
                : loan.principal_paise,
            )}
          </div>
          <div className="hero-meta">
            <Tag tone={loan.is_overdue ? 'coral' : toneForStatus(loan.status)}>
              {loan.is_overdue ? `${loan.days_overdue} days overdue` : loan.status}
            </Tag>
            <Tag>{(loan.rate_bp / 100).toFixed(0)}% / month</Tag>
            <Tag>{loan.term_months} months</Tag>
          </div>
        </div>

        {loan.status === 'requested' && (
          <VotePanel loan={loan} isBorrower={isBorrower} votes={votesQ.data ?? []} />
        )}

        <Panel title="Details">
          <div className="stats">
            <Stat k="Principal" v={formatPaiseShort(loan.principal_paise)} />
            <Stat k="Repaid" v={formatPaiseShort(loan.principal_paid_paise)} tone="mint" />
            <Stat
              k="Interest due"
              v={formatPaiseShort(dueInterest)}
              tone={loan.accrued_penalty_paise > 0 ? 'coral' : undefined}
              s={loan.accrued_penalty_paise > 0
                ? `incl. ${formatPaiseShort(loan.accrued_penalty_paise)} penalty`
                : 'on reducing balance'}
            />
            <Stat k="Due date" v={fmtDate(loan.due_on)} s={loan.disbursed_on ? `from ${fmtDate(loan.disbursed_on)}` : 'not paid out'} />
          </div>
          <div style={{ marginTop: 12 }}>
            <p className="dim" style={{ margin: 0 }}>
              Guarantor <strong style={{ color: 'var(--text-2)' }}>{loan.guarantor_name}</strong>
              {loan.purpose ? <> · {loan.purpose}</> : null}
            </p>
          </div>
        </Panel>

        {loan.status !== 'requested' && (votesQ.data ?? []).length > 0 && (
          <Panel title="How the group voted" flush>
            <VoteList votes={votesQ.data ?? []} />
          </Panel>
        )}

        {(loan.status === 'disbursed' || loan.status === 'closed') && (
          <Panel
            title="Repayments"
            action={
              loan.status === 'disbursed' && isOfficer
                ? <button className="sec-link" onClick={() => setSheet('repay')}>Add</button>
                : undefined
            }
            flush
          >
            {(repaysQ.data ?? []).length === 0 ? (
              <div className="empty">Nothing repaid yet.</div>
            ) : (
              <List>
                {(repaysQ.data ?? []).map((r) => (
                  <Row
                    key={r.id}
                    icon={<IconArrowDown width={17} height={17} />}
                    iconTone="mint"
                    title={formatPaise(r.principal_paise + r.interest_paise + r.penalty_paise)}
                    sub={`${fmtDate(r.paid_on)} · ${r.method}`}
                    note={
                      r.interest_paise + r.penalty_paise > 0
                        ? `${formatPaiseShort(r.interest_paise + r.penalty_paise)} interest`
                        : undefined
                    }
                  />
                ))}
              </List>
            )}
          </Panel>
        )}

        {loan.status === 'approved' && isOfficer && !isBorrower && (
          <div className="btn-row stack">
            <button className="primary lg" onClick={() => setSheet('disburse')}>
              Pay out {formatPaise(loan.principal_paise)}
            </button>
          </div>
        )}
        {loan.status === 'approved' && isBorrower && (
          <Notice tone="warn">
            You cannot pay out your own loan — the other office holder must do it.
          </Notice>
        )}
      </Screen>

      {sheet === 'repay' && (
        <RepaySheet loan={loan} dueInterest={dueInterest} onClose={() => setSheet(null)} />
      )}
      {sheet === 'disburse' && (
        <DisburseSheet loan={loan} onClose={() => setSheet(null)} />
      )}
    </>
  );
}

function VotePanel({
  loan, isBorrower, votes,
}: { loan: LoanRow; isBorrower: boolean; votes: VoteRow[] }) {
  const [note, setNote] = useState('');
  const vote = useMutation(
    async (v: Vote) => {
      const { error } = await supabase.rpc('cast_loan_vote', {
        p_loan_id: loan.id, p_vote: v, p_note: note || null,
      });
      if (error) throw error;
    },
    { invalidates: [`loan:${loan.id}`, 'loans', 'fund', 'feed'] },
  );

  const need = Math.max(0, loan.required_approvals - loan.approvals);
  const pct = (loan.approvals / loan.required_approvals) * 100;

  return (
    <Panel title="Approval">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{
          fontFamily: 'var(--display)', fontSize: '2rem', fontWeight: 700,
          letterSpacing: '-0.03em',
        }}>
          {loan.approvals}
        </span>
        <span className="muted">of {loan.required_approvals} approvals</span>
        {loan.rejections > 0 && (
          <span style={{ marginLeft: 'auto' }}><Tag tone="coral">{loan.rejections} rejected</Tag></span>
        )}
      </div>
      <div className="meter" style={{ marginTop: 10 }}>
        <i style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <p className="dim" style={{ marginTop: 8, marginBottom: 0 }}>
        {need > 0 ? `${need} more needed` : 'Threshold reached'} ·
        {' '}{loan.eligible_voter_count} can vote (never the borrower)
      </p>

      <ErrorNote error={vote.error} />

      {isBorrower ? (
        <div style={{ marginTop: 14 }}>
          <Notice tone="warn">This is your own loan — you cannot vote on it.</Notice>
        </div>
      ) : (
        <>
          {loan.my_vote && (
            <div style={{ marginTop: 14 }}>
              <Notice tone="good">
                You voted to {loan.my_vote}. You can change it until the vote closes.
              </Notice>
            </div>
          )}
          <div style={{ marginTop: 14 }}>
            <Field label="Note (optional)">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why you are voting this way"
              />
            </Field>
          </div>
          <div className="btn-row">
            <Busy
              className="primary"
              style={{ flex: 1 }}
              pending={vote.pending}
              onClick={() => void vote.run('approve')}
            >
              Approve
            </Busy>
            <Busy
              className="danger"
              style={{ flex: 1 }}
              pending={vote.pending}
              onClick={() => void vote.run('reject')}
            >
              Reject
            </Busy>
          </div>
        </>
      )}

      {votes.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <VoteList votes={votes} />
        </div>
      )}
    </Panel>
  );
}

function VoteList({ votes }: { votes: VoteRow[] }) {
  return (
    <List>
      {votes.map((v) => (
        <Row
          key={v.id}
          icon={v.vote === 'approve'
            ? <IconCheck width={16} height={16} />
            : <IconClose width={16} height={16} />}
          iconTone={v.vote === 'approve' ? 'mint' : v.vote === 'reject' ? 'coral' : undefined}
          title={v.members?.full_name ?? 'Member'}
          sub={v.note || ago(v.voted_at)}
          note={v.vote}
        />
      ))}
    </List>
  );
}

function RepaySheet({
  loan, dueInterest, onClose,
}: { loan: LoanRow; dueInterest: number; onClose: () => void }) {
  const [principal, setPrincipal] = useState('');
  const [interest, setInterest] = useState('');
  const [penalty, setPenalty] = useState('');
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<PaymentMethod>('bank');

  const save = useMutation(
    async () => {
      const { error } = await supabase.rpc('record_repayment', {
        p_loan_id: loan.id,
        p_principal_paise: rupeesToPaise(principal || 0),
        p_interest_paise: rupeesToPaise(interest || 0),
        p_penalty_paise: rupeesToPaise(penalty || 0),
        p_paid_on: paidOn,
        p_method: method,
      });
      if (error) throw error;
    },
    { invalidates: [`loan:${loan.id}`, 'loans', 'fund', 'cash', 'feed'], onSuccess: onClose },
  );

  return (
    <Sheet open title="Record a repayment" onClose={onClose}>
      <p className="dim" style={{ marginTop: -4, marginBottom: 14 }}>
        {formatPaise(loan.outstanding_principal_paise)} principal ·
        {' '}{formatPaise(dueInterest)} interest still due
      </p>

      <ErrorNote error={save.error} />

      <label>Principal</label>
      <AmountField value={principal} onChange={setPrincipal} autoFocus />

      <div className="field-row" style={{ marginTop: 14 }}>
        <Field label="Interest (₹)">
          <input inputMode="decimal" value={interest}
            onChange={(e) => setInterest(e.target.value)} placeholder="0" />
        </Field>
        <Field label="Penalty (₹)">
          <input inputMode="decimal" value={penalty}
            onChange={(e) => setPenalty(e.target.value)} placeholder="0" />
        </Field>
      </div>

      <div className="field-row" style={{ marginTop: 14 }}>
        <Field label="Paid on">
          <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="Method">
          <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            <option value="bank">Bank</option>
            <option value="cash">Cash</option>
          </select>
        </Field>
      </div>

      <div className="btn-row stack">
        <Busy
          className="primary lg"
          pending={save.pending}
          disabled={!principal && !interest && !penalty}
          onClick={() => void save.run()}
        >
          Save repayment
        </Busy>
      </div>
    </Sheet>
  );
}

function DisburseSheet({ loan, onClose }: { loan: LoanRow; onClose: () => void }) {
  const [on, setOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<PaymentMethod>('bank');

  const go = useMutation(
    async () => {
      const { error } = await supabase.rpc('disburse_loan', {
        p_loan_id: loan.id, p_disbursed_on: on, p_method: method,
      });
      if (error) throw error;
    },
    { invalidates: [`loan:${loan.id}`, 'loans', 'fund', 'cash', 'feed'], onSuccess: onClose },
  );

  return (
    <Sheet open title="Pay out the loan" onClose={onClose}>
      <p className="dim" style={{ marginTop: -4, marginBottom: 14 }}>
        {formatPaise(loan.principal_paise)} to {loan.borrower_name}
      </p>
      <ErrorNote error={go.error} />
      <div className="field-row">
        <Field label="Paid out on">
          <input type="date" value={on} onChange={(e) => setOn(e.target.value)} />
        </Field>
        <Field label="Method">
          <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            <option value="bank">Bank transfer</option>
            <option value="cash">Cash from float</option>
          </select>
        </Field>
      </div>
      <div className="btn-row stack">
        <Busy className="primary lg" pending={go.pending} onClick={() => void go.run()}>
          Confirm payout
        </Busy>
      </div>
    </Sheet>
  );
}
