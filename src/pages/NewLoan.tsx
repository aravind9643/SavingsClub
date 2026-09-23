import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery, useMutation } from '../hooks/useQuery';
import { useSession } from '../context/SessionContext';
import { useFund } from '../context/FundContext';
import { formatPaise, formatPaiseShort, rupeesToPaise, paiseToRupees } from '../lib/money';
import {
  Panel, Field, AmountField, Busy, ErrorNote, Notice, Chip, Stat,
} from '../components/ui';
import { IconClose } from '../components/icons';
import type { Member, MemberPosition } from '../lib/types';

export default function NewLoan() {
  const nav = useNavigate();
  const { member, config, currentGroupId } = useSession();
  const { fund } = useFund();

  const [amount, setAmount] = useState('');
  const [term, setTerm] = useState('6');
  const [guarantor, setGuarantor] = useState('');
  const [purpose, setPurpose] = useState('');

  const membersQ = useQuery<Member[]>('members', async () => {
    let q = supabase.from('members').select('*').eq('status', 'active').is('left_on', null).order('full_name');
    if (currentGroupId) {
      q = q.eq('group_id', currentGroupId);
    }
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Member[];
  });

  const myPos = useQuery<MemberPosition | null>(
    member ? `position:${member.id}` : null,
    async () => {
      const { data, error } = await supabase
        .from('v_member_positions').select('*').eq('member_id', member!.id).maybeSingle();
      if (error) throw error;
      return (data as MemberPosition) ?? null;
    },
  );

  const create = useMutation(
    async () => {
      const { data, error } = await supabase.rpc('request_loan', {
        p_guarantor_id: guarantor,
        p_principal_paise: rupeesToPaise(amount),
        p_term_months: Number(term),
        p_purpose: purpose || null,
      });
      if (error) throw error;
      return data as { id: string };
    },
    {
      invalidates: ['loans', 'fund', 'feed'],
      onSuccess: (row) => { if (row?.id) nav(`/loans/${row.id}`); },
    },
  );

  const wanted = rupeesToPaise(amount || 0);
  const owed = myPos.data?.outstanding_paise ?? 0;
  const cap = fund?.per_member_cap_paise ?? 0;
  const available = fund?.still_lendable_paise ?? 0;
  const headroom = Math.max(0, Math.min(cap - owed, available));

  const overCap = wanted > 0 && owed + wanted > cap;
  const overFund = wanted > 0 && wanted > available;
  const ok = Boolean(amount && guarantor && Number(term) > 0) && !overCap && !overFund;

  // Roughly what the loan costs if repaid on schedule — simple interest on a
  // balance that falls evenly, which is what the reducing-balance rule gives.
  const months = Number(term) || 1;
  const rate = (config?.loan_rate_bp ?? 200) / 10000;
  const estInterest = Math.round(wanted * rate * ((months + 1) / 2));

  return (
    <Screen
      title="Request a loan"
      action={
        <button className="icon-btn" onClick={() => nav('/loans')} aria-label="Cancel">
          <IconClose />
        </button>
      }
    >
      <div className="hero" style={{ padding: '18px' }}>
        <div className="hero-label">You can borrow up to</div>
        <div className="hero-amount" style={{ fontSize: 'clamp(2rem, 9vw, 2.6rem)' }}>
          {formatPaise(headroom)}
        </div>
        <div className="hero-meta">
          <Chip>Your cap <b>{formatPaiseShort(cap)}</b></Chip>
          {owed > 0 && <Chip tone="amber">Already owe <b>{formatPaiseShort(owed)}</b></Chip>}
          <Chip tone="violet">Fund has <b>{formatPaiseShort(available)}</b></Chip>
        </div>
      </div>

      <ErrorNote error={create.error} />

      <Panel title="How much">
        <AmountField value={amount} onChange={setAmount} autoFocus />

        <div className="seg-grid" style={{ marginTop: 14 }}>
          {[25, 50, 75, 100].map((p) => (
            <button
              key={p}
              className="seg"
              onClick={() => setAmount(String(Math.floor(paiseToRupees(headroom) * (p / 100))))}
            >
              {p === 100 ? 'Max' : `${p}%`}
            </button>
          ))}
        </div>

        {(overCap || overFund) && (
          <div style={{ marginTop: 14 }}>
            <Notice tone="danger">
              {overCap
                ? `That takes your borrowing to ${formatPaise(owed + wanted)}, above your ${formatPaise(cap)} limit.`
                : `Only ${formatPaise(available)} can be lent without breaking the reserve.`}
            </Notice>
          </div>
        )}
      </Panel>

      <Panel title="Details">
        <Field label="Pay back within">
          <select value={term} onChange={(e) => setTerm(e.target.value)}>
            {Array.from({ length: config?.max_loan_months ?? 6 }, (_v, i) => i + 1).map((m) => (
              <option key={m} value={m}>{m} month{m > 1 ? 's' : ''}</option>
            ))}
          </select>
        </Field>

        <Field label="Who will vouch for you" hint="A member who agrees to cover it if you cannot pay back">
          <select value={guarantor} onChange={(e) => setGuarantor(e.target.value)}>
            <option value="">Choose a member…</option>
            {Array.from(new Map((membersQ.data ?? []).filter((m) => m.id !== member?.id).map((m) => [m.id, m])).values()).map((m) => (
              <option key={m.id} value={m.id}>{m.full_name}</option>
            ))}
          </select>
        </Field>

        <Field label="What is it for (optional)">
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="Medical, education, business…"
          />
        </Field>

        {wanted > 0 && (
          <div className="stats" style={{ marginTop: 14 }}>
            <Stat
              k="Interest, roughly"
              v={formatPaiseShort(estInterest)}
              s={`${(rate * 100).toFixed(0)}% a month on the falling balance`}
            />
            <Stat
              k="Total to repay"
              v={formatPaiseShort(wanted + estInterest)}
              s={`over ${months} month${months > 1 ? 's' : ''}`}
            />
          </div>
        )}
      </Panel>

      <p className="dim">
        {(config?.loan_required_approvals && config.loan_required_approvals > 0)
          ? `${config.loan_required_approvals} members must approve.`
          : `Majority of members (${Math.max(2, Math.floor((((membersQ.data ?? []).filter(m => m.id !== member?.id).length) / 2) + 1))}) must approve.`}{' '}
        You cannot vote on your own request.
      </p>

      <div className="btn-row stack" style={{ paddingBottom: 12 }}>
        <Busy className="primary lg" pending={create.pending} disabled={!ok}
          onClick={() => void create.run()}>
          Send for approval
        </Busy>
      </div>
    </Screen>
  );
}
