// Moved out of MoneyHub.tsx unchanged -- byte-identical to what was there,
// verified rather than assumed. MoneyHub.tsx is the screen that uses it.
import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useQuery, useMutation } from '../../hooks/useQuery';
import { useSession } from '../../context/SessionContext';
import {
  formatPaise,
  formatPaiseShort,
  rupeesToPaise,
  paiseToRupees,
} from '../../lib/money';
import { haptic } from '../../lib/haptics';
import {
  List,
  Row,
  Sheet,
  Field,
  AmountField,
  Busy,
  ErrorNote,
  Notice,
  fmtDate,
} from '../../components/ui';
import type { Distribution, DistributionLine, DistributionKind } from '../../lib/types';
import { today } from '../../lib/dates';

export function DistributionSheet({ onClose }: { onClose: () => void }) {
  const { member, isOfficer, currentGroupId } = useSession();
  const [kind, setKind] = useState<DistributionKind>('profit');
  const [amountRupees, setAmountRupees] = useState('');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');

  // 1. Fetch active proposal if one exists
  const distQ = useQuery<Distribution[]>('distributions', async () => {
    let q = supabase
      .from('distributions')
      .select('*')
      .order('proposed_at', { ascending: false });
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Distribution[];
  });

  const activeDist = (distQ.data ?? []).find((d) => d.status === 'proposed');

  // 2. Fetch lines if active proposal exists
  const linesQ = useQuery<DistributionLine[]>(
    activeDist ? `dist_lines_${activeDist.id}` : null,
    async () => {
      if (!activeDist) return [];
      let q = supabase
        .from('v_distribution_lines')
        .select('*')
        .eq('distribution_id', activeDist.id)
        .order('full_name');
      if (currentGroupId) q = q.eq('group_id', currentGroupId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as DistributionLine[];
    }
  );

  // 3. Fetch distributable profit available
  const profitQ = useQuery<number>(`distributable_${kind}`, async () => {
    const { data, error } = await supabase.rpc('fn_distributable_paise', {
      p_kind: kind,
      ...(currentGroupId ? { p_group_id: currentGroupId } : {}),
    });
    if (error) throw error;
    return Number(data ?? 0);
  });

  const maxDistributable = profitQ.data ?? 0;

  // Set default amount when distributable pool loaded and field is empty
  useEffect(() => {
    if (!activeDist && maxDistributable > 0 && !amountRupees) {
      setAmountRupees(String(paiseToRupees(maxDistributable)));
    }
  }, [maxDistributable, activeDist]);

  const propose = useMutation(
    async () => {
      const paise = rupeesToPaise(amountRupees);
      if (paise <= 0) throw new Error('Please enter a valid amount');
      if (paise > maxDistributable) {
        throw new Error(`Amount cannot exceed distributable pool of ${formatPaise(maxDistributable)}`);
      }
      const { error } = await supabase.rpc('propose_distribution', {
        p_kind: kind,
        p_amount_paise: paise,
        p_as_of: date,
        p_note: note.trim() || null,
      });
      if (error) throw error;
    },
    {
      invalidates: ['distributions', 'fund', 'members'],
      onSuccess: () => {
        haptic(20);
      },
    }
  );

  const confirm = useMutation(
    async () => {
      if (!activeDist) return;
      const { error } = await supabase.rpc('confirm_distribution', {
        p_distribution_id: activeDist.id,
      });
      if (error) throw error;
    },
    {
      invalidates: ['distributions', 'fund', 'members'],
      onSuccess: () => {
        haptic(20);
        onClose();
      },
    }
  );

  const cancel = useMutation(
    async () => {
      if (!activeDist) return;
      const { error } = await supabase.rpc('cancel_distribution', {
        p_distribution_id: activeDist.id,
      });
      if (error) throw error;
    },
    {
      invalidates: ['distributions', 'fund', 'members'],
      onSuccess: () => {
        haptic(10);
      },
    }
  );

  const isProposer = Boolean(activeDist && member && activeDist.proposed_by === member.id);
  const lines = linesQ.data ?? [];

  return (
    <Sheet open title="Profit Share & Dividends" onClose={onClose}>
      {activeDist ? (
        <>
          <div style={{ marginBottom: 14 }}>
            <span className="tag amber" style={{ marginBottom: 6 }}>
              Proposed · Awaiting Second Officer
            </span>
            <div style={{ fontFamily: 'var(--display)', fontSize: '1.4rem', fontWeight: 700 }}>
              {formatPaise(activeDist.total_paise)}
            </div>
            <div className="dim" style={{ fontSize: '0.85rem', marginTop: 4 }}>
              {activeDist.kind === 'profit' ? 'Annual Profit Distribution' : 'Final Group Share-out'} · As of {fmtDate(activeDist.as_of)}
            </div>
            {activeDist.note && (
              <div style={{ marginTop: 6, fontSize: '0.9rem', fontStyle: 'italic' }}>
                "{activeDist.note}"
              </div>
            )}
          </div>

          <div style={{ maxHeight: 220, overflowY: 'auto', marginBlock: 12 }}>
            <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 8 }} className="dim">
              Member Payout Breakdown (Pro-rata):
            </div>
            <List>
              {lines.map((l) => (
                <Row
                  key={l.id}
                  title={l.full_name}
                  amount={formatPaise(l.amount_paise)}
                  amountTone="mint"
                />
              ))}
            </List>
          </div>

          {isProposer ? (
            <Notice tone="warn">
              You proposed this profit share. Another group leader (Cashier, Accountant, or Admin) must review the numbers and confirm them before money is paid.
            </Notice>
          ) : isOfficer ? (
            <Notice tone="good">
              Check that you have enough bank balance for these payouts. Confirming will record the payments to members.
            </Notice>
          ) : (
            <Notice>
              Proposed by group leaders. Awaiting approval at the group meeting.
            </Notice>
          )}

          <ErrorNote error={confirm.error || cancel.error} />

          <div className="btn-row stack" style={{ marginTop: 14 }}>
            {!isProposer && isOfficer && (
              <Busy className="primary lg" pending={confirm.pending} onClick={() => void confirm.run()}>
                Approve & Pay Out
              </Busy>
            )}
            {isOfficer && (
              <Busy className="coral lg" pending={cancel.pending} onClick={() => void cancel.run()}>
                Cancel Proposal
              </Busy>
            )}
          </div>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 14 }}>
            <div className="dim" style={{ fontSize: '0.85rem' }}>Available profit to share:</div>
            <div style={{ fontFamily: 'var(--display)', fontSize: '1.35rem', fontWeight: 700, color: 'var(--mint)' }}>
              {formatPaise(maxDistributable)}
            </div>
            <div className="dim" style={{ fontSize: '0.8rem', marginTop: 2 }}>
              Total interest earned minus group expenses and previous profit shares.
            </div>
          </div>

          {isOfficer ? (
            <>
              <div className="field-row">
                <Field label="Type of payout">
                  <select
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value as DistributionKind);
                    }}
                  >
                    <option value="profit">Yearly profit share (Bonus)</option>
                    <option value="final">Closing group (Final payout)</option>
                  </select>
                </Field>
                <Field label="Payment date">
                  <input
                    type="date"
                    value={date}
                    max={today()}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </Field>
              </div>

              <Field
                label="Total amount to share (₹)"
                hint={`Max today: ${formatPaiseShort(maxDistributable)}`}
              >
                <AmountField
                  value={amountRupees}
                  onChange={setAmountRupees}
                />
              </Field>

              <Field label="Note or festival (optional)">
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. Diwali 2026 profit share"
                />
              </Field>

              <Notice>
                Calculates each member's fair share based on how much they saved. Another leader must approve this before money is paid out.
              </Notice>

              <ErrorNote error={propose.error} />

              <div className="btn-row stack" style={{ marginTop: 14 }}>
                <Busy
                  className="primary lg"
                  pending={propose.pending}
                  disabled={
                    maxDistributable <= 0 ||
                    !amountRupees ||
                    rupeesToPaise(amountRupees) <= 0 ||
                    rupeesToPaise(amountRupees) > maxDistributable
                  }
                  onClick={() => void propose.run()}
                >
                  Calculate & Propose Payout
                </Busy>
              </div>
            </>
          ) : (
            <Notice>
              Only group leaders (Admin, Cashier, Accountant) can propose profit shares.
            </Notice>
          )}
        </>
      )}
    </Sheet>
  );
}
