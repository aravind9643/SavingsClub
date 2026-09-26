import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery, useMutation } from '../hooks/useQuery';
import { useSession } from '../context/SessionContext';
import { useFund } from '../context/FundContext';
import { formatPaise, formatPaiseShort, rupeesToPaise, paiseToRupees } from '../lib/money';
import {
  Panel, Field, AmountField, Busy, ErrorNote, Notice, Chip, Stat, Sheet, Segments,
} from '../components/ui';
import type { Member, MemberPosition } from '../lib/types';

export default function NewLoan() {
  const nav = useNavigate();
  const { member, config, currentGroupId } = useSession();
  const { fund } = useFund();

  const [borrowerType, setBorrowerType] = useState<'member' | 'outside'>('member');
  const [amount, setAmount] = useState('');
  const [term, setTerm] = useState('6');
  const [guarantor, setGuarantor] = useState('');
  const [purpose, setPurpose] = useState('');

  // Outside borrower fields
  const [outsideName, setOutsideName] = useState('');
  const [outsidePhone, setOutsidePhone] = useState('');
  const [outsideAddress, setOutsideAddress] = useState('');
  const [customRate, setCustomRate] = useState(
    ((config?.loan_rate_bp ?? 200) / 100).toFixed(1),
  );

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

  // Sync default rate and clamp term when group config arrives
  const [rateTouched, setRateTouched] = useState(false);
  useEffect(() => {
    if (!rateTouched && config?.loan_rate_bp != null) {
      setCustomRate((config.loan_rate_bp / 100).toFixed(1));
    }
    if (config?.max_loan_months && Number(term) > config.max_loan_months) {
      setTerm(String(config.max_loan_months));
    }
  }, [config?.loan_rate_bp, config?.max_loan_months, rateTouched, term]);

  const create = useMutation(
    async () => {
      if (borrowerType === 'outside') {
        const rateBp = Math.round((parseFloat(customRate) || 0) * 100);
        const { data, error } = await supabase.rpc('request_outside_loan', {
          p_borrower_name: outsideName.trim(),
          p_borrower_phone: outsidePhone.trim() || null,
          p_borrower_address: outsideAddress.trim() || null,
          p_principal_paise: rupeesToPaise(amount),
          p_term_months: Number(term),
          p_rate_bp: rateBp,
          p_guarantor_id: member?.id ?? null,
          p_purpose: purpose || null,
        });
        if (error) throw error;
        return data as { id: string };
      }

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
  const owed = borrowerType === 'member' ? (myPos.data?.outstanding_paise ?? 0) : 0;
  const cap = fund?.per_member_cap_paise ?? 0;
  const available = fund?.still_lendable_paise ?? 0;
  const headroom = Math.max(0, Math.min(cap - owed, available));

  const overCap = wanted > 0 && (owed + wanted > cap);
  const overFund = wanted > 0 && wanted > available;

  const ok = borrowerType === 'outside'
    ? Boolean(wanted > 0 && outsideName.trim() && Number(term) > 0 && parseFloat(customRate) >= 0) && !overCap && !overFund
    : Boolean(wanted > 0 && guarantor && Number(term) > 0) && !overCap && !overFund;

  const [showSchedule, setShowSchedule] = useState(false);

  const months = Number(term) || 1;
  const rate = borrowerType === 'outside'
    ? (parseFloat(customRate) || 0) / 100
    : (config?.loan_rate_bp ?? 200) / 10000;
  const estInterest = Math.round(wanted * rate * ((months + 1) / 2));

  const schedule = useMemo(() => {
    if (wanted <= 0 || months <= 0) return [];
    const basePrincipal = Math.floor(wanted / months);
    const remainder = wanted - basePrincipal * months;
    let balance = wanted;
    const items = [];

    for (let i = 1; i <= months; i++) {
      const p = i === 1 ? basePrincipal + remainder : basePrincipal;
      const interest = Math.round(balance * rate);
      const totalDue = p + interest;
      balance = Math.max(0, balance - p);
      items.push({
        month: i,
        principal: p,
        interest,
        totalDue,
        remainingBalance: balance,
      });
    }
    return items;
  }, [wanted, months, rate]);

  const month1Payment = schedule[0]?.totalDue ?? 0;
  const monthLastPayment = schedule[schedule.length - 1]?.totalDue ?? 0;

  return (
    <Screen
      title="Request a loan"
      onBack={() => nav('/loans')}
    >
      <div style={{ marginBottom: 14 }}>
        <Segments<'member' | 'outside'>
          value={borrowerType}
          onChange={(val) => {
            setBorrowerType(val);
            if (val === 'outside') {
              setCustomRate(((config?.loan_rate_bp ?? 200) / 100).toFixed(1));
            }
          }}
          options={[
            { value: 'member', label: 'Member Loan (Self)' },
            { value: 'outside', label: 'Outside Borrower' },
          ]}
        />
      </div>

      <div className="hero" style={{ padding: '18px' }}>
        <div className="hero-label">
          {borrowerType === 'outside' ? 'Maximum lendable amount' : 'You can borrow up to'}
        </div>
        <div className="hero-amount" style={{ fontSize: 'clamp(2rem, 9vw, 2.6rem)' }}>
          {formatPaise(headroom)}
        </div>
        <div className="hero-meta">
          <Chip>Loan cap <b>{formatPaiseShort(cap)}</b></Chip>
          {owed > 0 && <Chip tone="amber">Already owe <b>{formatPaiseShort(owed)}</b></Chip>}
          <Chip tone="violet">Fund has <b>{formatPaiseShort(available)}</b></Chip>
        </div>
      </div>

      <ErrorNote error={create.error} />

      {borrowerType === 'outside' && (
        <Panel title="Outside Borrower Info">
          <Field label="Borrower full name *">
            <input
              value={outsideName}
              onChange={(e) => setOutsideName(e.target.value)}
              placeholder="e.g. Ramesh Kumar"
              autoFocus
            />
          </Field>

          <Field label="Phone number (optional)" hint="Used for payment reminders via WhatsApp">
            <input
              type="tel"
              value={outsidePhone}
              onChange={(e) => setOutsidePhone(e.target.value)}
              placeholder="+91 98765 43210"
            />
          </Field>

          <Field label="Address / notes (optional)">
            <input
              value={outsideAddress}
              onChange={(e) => setOutsideAddress(e.target.value)}
              placeholder="Address, village, reference…"
            />
          </Field>

          <div style={{ marginTop: 12 }}>
            <Notice tone="warn">
              <strong>Member Guarantor:</strong> You (<strong>{member?.full_name}</strong>) will be recorded as the guarantor. You are responsible for follow-up and cannot vote on this loan.
            </Notice>
          </div>
        </Panel>
      )}

      <Panel title="Loan Amount">
        <AmountField value={amount} onChange={setAmount} autoFocus={borrowerType === 'member'} />

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
                ? `That takes borrowing to ${formatPaise(owed + wanted)}, above the ${formatPaise(cap)} limit.`
                : `Only ${formatPaise(available)} can be lent without breaking the reserve.`}
            </Notice>
          </div>
        )}
      </Panel>

      <Panel title="Terms & Interest">
        <Field label="Pay back within">
          <select value={term} onChange={(e) => setTerm(e.target.value)}>
            {Array.from({ length: config?.max_loan_months ?? 6 }, (_v, i) => i + 1).map((m) => (
              <option key={m} value={m}>{m} month{m > 1 ? 's' : ''}</option>
            ))}
          </select>
        </Field>

        {borrowerType === 'outside' ? (
          <Field label="Interest rate (% per month)" hint={`Group default is ${((config?.loan_rate_bp ?? 200) / 100).toFixed(1)}%/mo`}>
            <input
              type="number"
              step="0.1"
              min="0"
              value={customRate}
              onChange={(e) => {
                setRateTouched(true);
                setCustomRate(e.target.value);
              }}
              placeholder="e.g. 2.5"
            />
          </Field>
        ) : (
          <Field label="Who will vouch for you" hint="An active member who agrees to cover it if you cannot pay back">
            <select value={guarantor} onChange={(e) => setGuarantor(e.target.value)}>
              <option value="">Choose a member…</option>
              {Array.from(new Map((membersQ.data ?? []).filter((m) => m.id !== member?.id).map((m) => [m.id, m])).values()).map((m) => (
                <option key={m.id} value={m.id}>{m.full_name}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label="What is it for (optional)">
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="Medical, agriculture, business, personal…"
          />
        </Field>

        {wanted > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="stats three">
              <Stat
                k="Month 1 Payment"
                v={formatPaiseShort(month1Payment)}
                s="highest payment"
              />
              <Stat
                k={`Month ${months} Payment`}
                v={formatPaiseShort(monthLastPayment)}
                s="lowest (reducing)"
                tone="mint"
              />
              <Stat
                k="Total Interest"
                v={formatPaiseShort(estInterest)}
                s={`over ${months} mo`}
                tone="amber"
              />
            </div>

            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <button
                type="button"
                className="sec-link"
                style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--accent)' }}
                onClick={() => setShowSchedule(true)}
              >
                📅 View monthly payment schedule →
              </button>
            </div>
          </div>
        )}
      </Panel>

      <p className="dim">
        {(config?.loan_required_approvals && config.loan_required_approvals > 0)
          ? `${config.loan_required_approvals} members must approve.`
          : `Majority of active members must approve.`}{' '}
        The guarantor cannot vote on this request.
      </p>

      <div className="btn-row stack" style={{ paddingBottom: 12 }}>
        <Busy className="primary lg" pending={create.pending} disabled={!ok}
          onClick={() => void create.run()}>
          Send for approval
        </Busy>
      </div>

      {showSchedule && (
        <Sheet open title="Repayment Schedule" onClose={() => setShowSchedule(false)}>
          <p className="dim" style={{ fontSize: '0.84rem', margin: '0 0 14px' }}>
            Reducing balance schedule for {formatPaise(wanted)} over {months} months at {(rate * 100).toFixed(1)}%/month.
          </p>
          <div style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid var(--hairline)', borderRadius: 'var(--r-sm)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', textAlign: 'right' }}>
              <thead>
                <tr style={{ background: 'var(--surface-3)', borderBottom: '1px solid var(--hairline)', color: 'var(--text-3)' }}>
                  <th style={{ padding: '8px 10px', textAlign: 'left' }}>Month</th>
                  <th style={{ padding: '8px 10px' }}>Principal</th>
                  <th style={{ padding: '8px 10px' }}>Interest</th>
                  <th style={{ padding: '8px 10px' }}>Total Due</th>
                </tr>
              </thead>
              <tbody>
                {schedule.map((row) => (
                  <tr key={row.month} style={{ borderBottom: '1px solid var(--hairline)' }}>
                    <td style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>#{row.month}</td>
                    <td style={{ padding: '8px 10px' }}>{formatPaise(row.principal)}</td>
                    <td style={{ padding: '8px 10px', color: 'var(--amber)' }}>{formatPaise(row.interest)}</td>
                    <td style={{ padding: '8px 10px', fontWeight: 700, color: 'var(--text)' }}>{formatPaise(row.totalDue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="btn-row stack" style={{ marginTop: 16 }}>
            <button type="button" className="primary lg" onClick={() => setShowSchedule(false)}>
              Got it
            </button>
          </div>
        </Sheet>
      )}
    </Screen>
  );
}
