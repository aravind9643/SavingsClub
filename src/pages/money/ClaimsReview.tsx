import { useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useQuery, useMutation } from '../../hooks/useQuery';
import { supabase } from '../../lib/supabase';
import { formatPaise } from '../../lib/money';
import { haptic } from '../../lib/haptics';
import { Panel, Busy, ErrorNote, Field, Sheet, Tag, fmtDate, ago } from '../../components/ui';
import type { PaymentClaim } from '../../lib/types';

/**
 * "I've paid" claims waiting for the cashier or accountant.
 *
 * The job here is to look at the bank (or the UPI app) and say whether the
 * money is there. So each claim shows what to look FOR -- amount, date,
 * transaction ID -- and nothing is counted until Confirm. Confirm runs
 * record_contribution() on the server, so a claim for a closed month or more
 * than is owed is refused there, with its reason, like any other payment.
 */
export default function ClaimsReview({ names }: { names: Map<string, string> }) {
  const { role, member, currentGroupId } = useSession();
  const canDecide = role === 'cashier' || role === 'accountant';
  const [rejecting, setRejecting] = useState<PaymentClaim | null>(null);
  const [reason, setReason] = useState('');

  const q = useQuery<PaymentClaim[]>(canDecide ? 'fund:claims:review' : null, async () => {
    const { data, error } = await supabase.from('payment_claims').select('*')
      .eq('group_id', currentGroupId!).eq('status', 'pending')
      .order('submitted_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as PaymentClaim[];
  });

  const invalidates = ['fund', 'claims', 'contributions', 'positions', 'feed'];
  const confirm = useMutation(async (id: string) => {
    const { error } = await supabase.rpc('confirm_payment_claim', { p_claim_id: id });
    if (error) throw error;
  }, { invalidates, onSuccess: () => haptic(20) });
  const reject = useMutation(async () => {
    const { error } = await supabase.rpc('reject_payment_claim', {
      p_claim_id: rejecting!.id, p_reason: reason,
    });
    if (error) throw error;
  }, { invalidates, onSuccess: () => { setRejecting(null); setReason(''); } });

  const claims = q.data ?? [];
  if (!canDecide || claims.length === 0) return null;

  return (
    <>
      <Panel title={`Payments to confirm (${claims.length})`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p className="dim" style={{ margin: 0 }}>
            Check each one arrived in the bank or UPI app before confirming. Until then it is not counted.
          </p>
          {claims.map((c) => {
            const mine = c.member_id === member?.id;
            return (
              <div key={c.id} className="panel" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ flex: 1, minWidth: 0 }}>{names.get(c.member_id) ?? 'Member'}</strong>
                  <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatPaise(c.amount_paise)}</strong>
                </div>
                <div className="dim" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Tag tone="violet">{c.method.toUpperCase()}</Tag>
                  <span>paid {fmtDate(c.paid_on)}</span>
                  {c.reference && <code style={{ overflowWrap: 'anywhere' }}>{c.reference}</code>}
                  <span>· sent {ago(c.submitted_at)}</span>
                </div>
                {mine ? (
                  <span className="dim">Your own payment — the other money officer confirms it.</span>
                ) : (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Busy className="primary" style={{ flex: 1 }} pending={confirm.pending}
                      onClick={() => void confirm.run(c.id)}>
                      Confirm
                    </Busy>
                    <button type="button" className="subtle" onClick={() => { setRejecting(c); setReason(''); }}>
                      Not received
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <ErrorNote error={confirm.error} />
        </div>
      </Panel>

      {rejecting && (
        <Sheet open title="Not received" onClose={() => setRejecting(null)}>
          <p style={{ marginTop: 0 }}>
            {names.get(rejecting.member_id) ?? 'The member'} will see your reason on their Home screen.
          </p>
          <Field label="Reason">
            <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus
              placeholder="e.g. Not in the bank statement yet — check the transaction ID" />
          </Field>
          <ErrorNote error={reject.error} />
          <div className="btn-row stack">
            <Busy className="danger" pending={reject.pending} disabled={!reason.trim()}
              onClick={() => void reject.run()}>
              Turn down {formatPaise(rejecting.amount_paise)}
            </Busy>
          </div>
        </Sheet>
      )}
    </>
  );
}
