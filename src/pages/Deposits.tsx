import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery, useMutation } from '../hooks/useQuery';
import { useSession } from '../context/SessionContext';
import { useFund } from '../context/FundContext';
import { formatPaise, formatPaiseShort, rupeesToPaise, paiseToRupees } from '../lib/money';
import { haptic } from '../lib/haptics';
import {
  List, Row, Panel, Empty, SkeletonList, Sheet, Field, AmountField, Busy,
  ErrorNote, Segments, initials, fmtDate, Notice,
} from '../components/ui';
import { IconContributions, IconCheck, IconShare } from '../components/icons';
import type { Member, ContributionPeriod, Contribution } from '../lib/types';
import { today } from '../lib/dates';

type MemberFilter = 'all' | 'unpaid' | 'paid';

export default function Deposits() {
  const nav = useNavigate();
  const { config, role, currentGroupId, group } = useSession();
  const { fund } = useFund();
  const [periodId, setPeriodId] = useState<string>('');
  const [memberFilter, setMemberFilter] = useState<MemberFilter>('all');
  const [search, setSearch] = useState('');
  const [paying, setPaying] = useState<{ period: ContributionPeriod; member: Member } | null>(null);
  const [reminding, setReminding] = useState<{ period: ContributionPeriod; member: Member } | null>(null);
  const [unpaidAction, setUnpaidAction] = useState<{ period: ContributionPeriod; member: Member } | null>(null);
  const [receiptData, setReceiptData] = useState<{
    memberName: string; amountPaise: number; lateFeePaise: number;
    month: string; paidOn: string; method: string;
  } | null>(null);

  const membersQ = useQuery<Member[]>('members', async () => {
    let q = supabase.from('members').select('*').order('full_name');
    if (currentGroupId) {
      q = q.eq('group_id', currentGroupId);
    }
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Member[];
  });

  const periodsQ = useQuery<ContributionPeriod[]>('periods', async () => {
    let q = supabase
      .from('contribution_periods').select('*').order('period_month', { ascending: false });
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as ContributionPeriod[];
  });

  const contribsQ = useQuery<Contribution[]>('contributions', async () => {
    let q = supabase.from('contributions').select('*');
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Contribution[];
  });

  const rolesQ = useQuery<{ role: string }[]>('roles:active', async () => {
    let q = supabase
      .from('role_assignments')
      .select('role')
      .is('end_date', null);
    if (currentGroupId) {
      q = q.eq('group_id', currentGroupId);
    }
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as { role: string }[];
  });

  const hasMoneyOfficer = (rolesQ.data ?? []).some(
    (r) => r.role === 'cashier' || r.role === 'accountant',
  );
  const canOpen = role === 'admin' || role === 'cashier' || role === 'accountant';
  const isMoneyHandler = role === 'cashier' || role === 'accountant';

  const openPeriod = useMutation(
    async () => {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const p_month = `${year}-${month}-01`;
      const { error } = await supabase.rpc('open_period', { p_month });
      if (error) throw error;
    },
    { invalidates: ['periods', 'fund', 'periods:latest'] },
  );

  // Closing a month is what freezes it: record_contribution refuses a closed
  // period, so this is the control that stops a settled month being reopened
  // by a late entry. The RPC has existed since 0004 with no way to call it.
  const closePeriod = useMutation(
    async (periodIdToClose: string) => {
      const { error } = await supabase.rpc('close_period', {
        p_period_id: periodIdToClose,
      });
      if (error) throw error;
    },
    { invalidates: ['periods', 'fund', 'periods:latest', 'contributions'] },
  );

  const periods = periodsQ.data ?? [];

  // Default to the newest month once periods arrive.
  useEffect(() => {
    if (!periodId && periods.length) setPeriodId(periods[0].id);
  }, [periods, periodId]);

  const period = periods.find((p) => p.id === periodId) ?? periods[0];
  const allActiveMembers = useMemo(() => {
    const map = new Map<string, Member>();
    for (const mem of (membersQ.data ?? []).filter((x) => x.is_active)) {
      if (!map.has(mem.id)) map.set(mem.id, mem);
    }
    return Array.from(map.values());
  }, [membersQ.data]);

  const members = useMemo(() => {
    if (!period) return allActiveMembers;
    const parts = period.period_month.slice(0, 10).split('-').map(Number);
    const endOfMonth = new Date(parts[0], parts[1], 0, 23, 59, 59, 999);
    return allActiveMembers.filter((m) => {
      if (!m.joined_on) return true;
      const jParts = m.joined_on.slice(0, 10).split('-').map(Number);
      const joined = new Date(jParts[0], jParts[1] - 1, jParts[2] || 1);
      return joined <= endOfMonth;
    });
  }, [allActiveMembers, period]);

  // A member can now pay a month in instalments, so this sums their rows
  // instead of keeping the last one. Mapping member -> single Contribution
  // meant a second payment overwrote the first on screen, and "has a row"
  // counted as "paid in full" -- which is exactly how a half-paid member
  // used to disappear off the chase-list.
  const paidMap = useMemo(() => {
    const map = new Map<string, { rows: Contribution[]; paid: number; fees: number }>();
    for (const c of contribsQ.data ?? []) {
      if (c.period_id !== period?.id) continue;
      const at = map.get(c.member_id) ?? { rows: [], paid: 0, fees: 0 };
      at.rows.push(c);
      at.paid += c.amount_paise;
      at.fees += c.late_fee_paise;
      map.set(c.member_id, at);
    }
    return map;
  }, [contribsQ.data, period?.id]);

  // Per member for this month. The group-wide total is `expectedTotal` below.
  const perMember = period?.amount_paise ?? 0;
  const isSettled = (id: string) =>
    perMember > 0 && (paidMap.get(id)?.paid ?? 0) >= perMember;

  const paidCount = members.filter((m) => isSettled(m.id)).length;
  const unpaidCount = members.length - paidCount;

  const shownMembers = useMemo(() => {
    let list = members;
    if (memberFilter === 'paid') list = members.filter((m) => isSettled(m.id));
    if (memberFilter === 'unpaid') list = members.filter((m) => !isSettled(m.id));
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((m) =>
      m.full_name.toLowerCase().includes(q) || (m.phone && m.phone.includes(q))
    );
  }, [members, paidMap, memberFilter, perMember, search]);

  const collected = members.reduce((sum, m) => {
    const c = paidMap.get(m.id);
    return sum + (c ? c.paid + c.fees : 0);
  }, 0);
  const expectedTotal = (period?.amount_paise ?? 0) * members.length;

  const handleBroadcastWhatsApp = () => {
    haptic(10);
    if (!period) return;
    const pct = expectedTotal > 0 ? Math.round((collected / expectedTotal) * 100) : 0;
    const text = `📢 *${group?.name || 'SavingsClub'} — ${monthLabel(period.period_month)} Collection Update*\n\n` +
      `💰 *Collected*: ${formatPaise(collected)} of ${formatPaise(expectedTotal)} (${pct}%)\n` +
      `✅ *Paid*: ${paidCount} member${paidCount === 1 ? '' : 's'}\n` +
      `⏳ *Pending*: ${unpaidCount} member${unpaidCount === 1 ? '' : 's'}\n` +
      `📅 *Due Date*: ${fmtDate(period.due_date)} (Grace until ${fmtDate(period.grace_date)})\n\n` +
      `_Sent from SavingsClub_`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  };

  if ((periodsQ.loading && !periodsQ.data) || (rolesQ.loading && !rolesQ.data)) {
    return <Screen title="Monthly Deposits"><SkeletonList rows={5} /></Screen>;
  }

  if (periods.length === 0) {
    return (
      <Screen title="Monthly Deposits">
        <Empty icon={<IconContributions width={22} height={22} />}>
          This month has not been started yet.
          {!hasMoneyOfficer ? (
            role === 'admin' ? (
              <>
                <p className="dim" style={{ marginTop: 8, maxWidth: 360, marginInline: 'auto' }}>
                  Pick a cashier and an accountant first. Until then nobody can take money in.
                </p>
                <div className="btn-row stack" style={{ marginTop: 18, maxWidth: 320, marginInline: 'auto' }}>
                  <button type="button" className="primary lg" onClick={() => nav('/members')}>
                    Choose who does what
                  </button>
                </div>
              </>
            ) : (
              <p className="dim" style={{ marginTop: 8 }}>
                The cashier will start this month when collection begins.
              </p>
            )
          ) : canOpen ? (
            <div className="btn-row stack" style={{ marginTop: 18, maxWidth: 320, marginInline: 'auto' }}>
              <Busy className="primary lg" pending={openPeriod.pending}
                onClick={() => void openPeriod.run()}>
                Start this month
              </Busy>
            </div>
          ) : (
            <p className="dim" style={{ marginTop: 8 }}>
              The cashier will start this month when collection begins.
            </p>
          )}
        </Empty>
      </Screen>
    );
  }

  return (
    <>
      <Screen
        title="Monthly Deposits"
        sub={period ? `${monthLabel(period.period_month)} · ${paidCount} of ${members.length} paid` : undefined}
      >
        <Segments
          value={period?.id ?? ''}
          onChange={(id) => {
            haptic(10);
            setPeriodId(id);
          }}
          options={periods.slice(0, 12).map((p) => ({
            value: p.id,
            label: monthLabel(p.period_month, true),
          }))}
        />

        {period && (
          <div className="hero" style={{ padding: '18px 18px 16px' }}>
            <div className="hero-label">Collected this month</div>
            <div className="hero-amount" style={{ fontSize: 'clamp(2rem, 9vw, 2.5rem)' }}>
              {formatPaise(collected)}
            </div>
            <div className="dim" style={{ marginTop: 2 }}>
              {paidCount} of {members.length} paid · {formatPaiseShort(expectedTotal)} expected
            </div>
            <div className="meter">
              <i style={{ width: `${expectedTotal ? (collected / expectedTotal) * 100 : 0}%` }} />
            </div>
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-start' }}>
              <button
                type="button"
                className="sec-link"
                onClick={handleBroadcastWhatsApp}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'var(--mint-ghost)',
                  color: 'var(--mint)',
                  padding: '6px 12px',
                  borderRadius: 'var(--r-sm)',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                }}
              >
                <IconShare width={13} height={13} />
                Share status to WhatsApp group
              </button>
            </div>
          </div>
        )}

        {period?.closed_at && (
          <Notice tone="warn">This month is closed — entries can no longer be changed.</Notice>
        )}

        <ErrorNote error={closePeriod.error} />

        {/* Offered only once the grace date has passed: close_period refuses
            earlier, so showing it sooner would just produce an error. */}
        {isMoneyHandler && period && !period.closed_at
          && period.grace_date < today() && (
          <Notice tone="good">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: 180 }}>
                The grace date has passed. Closing this month locks its entries.
              </span>
              <Busy
                pending={closePeriod.pending}
                onClick={() => {
                  if (confirm(
                    'Close this month? Payments can no longer be recorded '
                    + 'against it, and this cannot be undone.',
                  )) void closePeriod.run(period.id);
                }}
              >
                Close month
              </Busy>
            </div>
          </Notice>
        )}

        <div style={{ margin: '14px 0 8px' }}>
          <Segments<MemberFilter>
            value={memberFilter}
            onChange={(f) => {
              haptic(8);
              setMemberFilter(f);
            }}
            options={[
              { value: 'all', label: 'All', count: members.length },
              { value: 'unpaid', label: 'Unpaid', count: unpaidCount },
              { value: 'paid', label: 'Paid', count: paidCount },
            ]}
          />
        </div>

        {/* Search input */}
        <div style={{ position: 'relative', margin: '8px 0 12px' }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search member by name or phone..."
            style={{
              paddingLeft: 36,
              paddingRight: search ? 36 : 14,
              minHeight: 40,
              fontSize: '0.86rem',
              borderRadius: 'var(--r-sm)',
              border: '1px solid var(--hairline)',
              background: 'var(--surface)',
            }}
          />
          <span
            style={{
              position: 'absolute',
              left: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-3)',
              pointerEvents: 'none',
              fontSize: '0.88rem',
            }}
          >
            🔍
          </span>
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 0,
                padding: '4px 8px',
                color: 'var(--text-3)',
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          )}
        </div>

        <Panel
          title="Members"
          action={
            canOpen && !periods.some((p) => isThisMonth(p.period_month)) ? (
              <button className="sec-link" onClick={() => void openPeriod.run()}>
                Start this month
              </button>
            ) : undefined
          }
          flush
        >
          {shownMembers.length === 0 ? (
            <Empty icon={<IconCheck width={22} height={22} />}>
              {memberFilter === 'unpaid' ? 'All members have paid for this month!' : 'No members found.'}
            </Empty>
          ) : (
            <List>
              {shownMembers.map((m) => {
                const c = paidMap.get(m.id);
                const settled = isSettled(m.id);
                // Part paid is its own state. Showing a tick for someone who
                // has paid half is how the group stops chasing the rest.
                const part = !!c && !settled;
                const short = perMember - (c?.paid ?? 0);
                const last = c?.rows[c.rows.length - 1];
                const overdue = !settled && period && new Date(period.grace_date) < new Date();
                return (
                  <Row
                    key={m.id}
                    icon={settled ? <IconCheck width={17} height={17} /> : initials(m.full_name)}
                    iconTone={settled ? 'mint' : overdue ? 'coral' : undefined}
                    title={m.full_name}
                    sub={
                      settled
                        ? `Paid ${fmtDate(last?.paid_on)}${(c?.fees ?? 0) > 0 ? ' · late' : ''}`
                        : part
                          ? `${formatPaiseShort(short)} still to pay`
                          : overdue
                            ? `Overdue since ${fmtDate(period?.grace_date)}`
                            : `Due ${fmtDate(period?.due_date)}`
                    }
                    amount={c ? formatPaiseShort(c.paid) : '—'}
                    // Only a settled month gets the green figure. A part
                    // payment is left plain rather than coloured: it is
                    // neither done nor a problem, and the shortfall in `sub`
                    // already says what is missing.
                    amountTone={settled ? 'mint' : undefined}
                    note={c && c.fees > 0 ? `+${formatPaiseShort(c.fees)} fee` : undefined}
                    onClick={() => {
                      haptic(10);
                      if (settled && last) {
                        setReceiptData({
                          memberName: m.full_name,
                          amountPaise: c!.paid,
                          lateFeePaise: c!.fees,
                          month: monthLabel(period.period_month),
                          paidOn: last.paid_on,
                          method: last.method,
                        });
                      } else if (isMoneyHandler && period && !period.closed_at) {
                        setUnpaidAction({ period, member: m });
                      } else if (period) {
                        setReminding({ period, member: m });
                      }
                    }}
                    chevron
                  />
                );
              })}
            </List>
          )}
        </Panel>
      </Screen>

      {unpaidAction && (
        <UnpaidActionSheet
          member={unpaidAction.member}
          period={unpaidAction.period}
          isOfficer={isMoneyHandler}
          onRecord={() => setPaying({ period: unpaidAction.period, member: unpaidAction.member })}
          onRemind={() => setReminding({ period: unpaidAction.period, member: unpaidAction.member })}
          onClose={() => setUnpaidAction(null)}
        />
      )}

      {paying && config && (
        <RecordSheet
          period={paying.period}
          member={paying.member}
          // What is still owed, not the full month -- someone topping up a
          // part payment should not have to clear the field first.
          defaultPaise={Math.max(
            0,
            (paying.period.amount_paise ?? config.monthly_contribution_paise)
              - (paidMap.get(paying.member.id)?.paid ?? 0),
          )}
          alreadyPaid={paidMap.get(paying.member.id)?.paid ?? 0}
          onClose={() => setPaying(null)}
          onRecorded={(r) => setReceiptData(r)}
        />
      )}

      {reminding && (
        <ReminderSheet
          member={reminding.member}
          period={reminding.period}
          groupName={group?.name ?? 'Savings Group'}
          onClose={() => setReminding(null)}
        />
      )}

      {receiptData && (
        <ReceiptSheet
          receipt={receiptData}
          groupName={group?.name ?? 'Savings Group'}
          fundTotalPaise={fund?.total_fund_paise}
          onClose={() => setReceiptData(null)}
        />
      )}
    </>
  );
}

function parseISODateParts(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return { year: y, month: (m || 1) - 1, day: d || 1 };
}

function monthLabel(iso: string, short = false): string {
  const { year, month } = parseISODateParts(iso);
  const d = new Date(year, month, 1);
  return d.toLocaleDateString('en-IN', {
    month: short ? 'short' : 'long',
    year: short ? '2-digit' : 'numeric',
  });
}

function isThisMonth(iso: string): boolean {
  const parts = parseISODateParts(iso);
  const n = new Date();
  return parts.month === n.getMonth() && parts.year === n.getFullYear();
}

function RecordSheet({
  period, member, defaultPaise, alreadyPaid, onClose, onRecorded,
}: {
  period: ContributionPeriod;
  member: Member;
  defaultPaise: number;
  /** Paid toward this month already. Non-zero means this is a top-up. */
  alreadyPaid: number;
  onClose: () => void;
  onRecorded: (r: { memberName: string; amountPaise: number; lateFeePaise: number; month: string; paidOn: string; method: string }) => void;
}) {
  const { config } = useSession();
  const [amount, setAmount] = useState(String(paiseToRupees(defaultPaise)));
  const [paidOn, setPaidOn] = useState(() => today());
  const [method, setMethod] = useState<'bank' | 'cash'>('bank');

  const late = new Date(paidOn) > new Date(period.grace_date);

  const save = useMutation(
    async () => {
      const { error } = await supabase.rpc('record_contribution', {
        p_period_id: period.id,
        p_member_id: member.id,
        p_amount_paise: rupeesToPaise(amount),
        p_paid_on: paidOn,
        p_method: method,
      });
      if (error) throw error;
    },
    {
      invalidates: ['contributions', 'positions', 'fund', 'cash', 'feed'],
      onSuccess: () => {
        onClose();
        onRecorded({
          memberName: member.full_name,
          amountPaise: rupeesToPaise(amount),
          lateFeePaise: late ? (config?.late_fee_paise ?? 0) : 0,
          month: monthLabel(period.period_month),
          paidOn,
          method,
        });
      },
    },
  );

  return (
    <Sheet open title={member.full_name} onClose={onClose}>
      <p className="dim" style={{ marginTop: -4, marginBottom: 14 }}>
        {monthLabel(period.period_month)} · due {fmtDate(period.due_date)}
      </p>

      <ErrorNote error={save.error} />

      {alreadyPaid > 0 && (
        <div style={{ marginBottom: 14 }}>
          <Notice>
            Already paid {formatPaise(alreadyPaid)} of{' '}
            {formatPaise(period.amount_paise)} this month.
          </Notice>
        </div>
      )}

      <AmountField value={amount} onChange={setAmount} autoFocus />

      <p className="dim" style={{ marginTop: 8, fontSize: '0.85rem' }}>
        A part payment is fine — record the rest whenever it arrives.
      </p>

      <div className="field-row" style={{ marginTop: 14 }}>
        <Field label="Paid on">
          <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="Method">
          <select value={method} onChange={(e) => setMethod(e.target.value as 'bank' | 'cash')}>
            <option value="bank">Bank</option>
            <option value="cash">Cash</option>
          </select>
        </Field>
      </div>

      {late && (
        <div style={{ marginTop: 14 }}>
          <Notice tone="warn">
            After the grace date — a late fee is added automatically.
          </Notice>
        </div>
      )}

      <div className="btn-row stack">
        <Busy
          className="primary lg"
          pending={save.pending}
          disabled={!amount}
          onClick={() => void save.run()}
        >
          Record {amount ? formatPaise(rupeesToPaise(amount)) : 'payment'}
        </Busy>
      </div>
    </Sheet>
  );
}

function ReceiptSheet({
  receipt, groupName, fundTotalPaise, onClose,
}: {
  receipt: {
    memberName: string; amountPaise: number; lateFeePaise: number;
    month: string; paidOn: string; method: string;
  };
  groupName: string;
  fundTotalPaise?: number;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const text = `🧾 *Receipt — ${groupName}*
*Name:* ${receipt.memberName}
*Month:* ${receipt.month}
*Paid:* ${formatPaise(receipt.amountPaise)} (${receipt.method.toUpperCase()})
${receipt.lateFeePaise > 0 ? `*Late fee:* ${formatPaise(receipt.lateFeePaise)}\n` : ''}*On:* ${fmtDate(receipt.paidOn)}
${fundTotalPaise !== undefined ? `*Total fund now:* ${formatPaise(fundTotalPaise)}\n` : ''}
_Recorded on SavingsClub_`;

  async function share() {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Receipt - ${receipt.memberName} (${receipt.month})`,
          text,
        });
        return;
      } catch {
        /* fallback to copy */
      }
    }
    copy();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard write error */
    }
  }

  return (
    <Sheet open title="Payment receipt" onClose={onClose}>
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ fontSize: '1.8rem', fontWeight: 700, fontFamily: 'var(--display)' }}>
          {formatPaise(receipt.amountPaise + receipt.lateFeePaise)}
        </div>
        <p className="dim" style={{ marginTop: 4 }}>
          {receipt.memberName} · {receipt.month}
        </p>
      </div>

      <Panel title="Details" flush>
        <List>
          <Row title="Payment date" note={fmtDate(receipt.paidOn)} />
          <Row title="Method" note={receipt.method.toUpperCase()} />
          <Row title="Amount paid" amount={formatPaise(receipt.amountPaise)} />
          {receipt.lateFeePaise > 0 && (
            <Row title="Late fee" amount={`+${formatPaise(receipt.lateFeePaise)}`} amountTone="coral" />
          )}
          {fundTotalPaise !== undefined && (
            <Row title="Group fund total" amount={formatPaise(fundTotalPaise)} amountTone="mint" />
          )}
        </List>
      </Panel>

      <div className="btn-row stack" style={{ marginTop: 20 }}>
        <button type="button" className="primary lg" onClick={() => void share()}>
          <IconShare width={16} height={16} style={{ marginRight: 8 }} />
          Share to WhatsApp
        </button>
        <button type="button" className="subtle" onClick={() => void copy()}>
          {copied ? 'Copied to clipboard!' : 'Copy text receipt'}
        </button>
      </div>
    </Sheet>
  );
}

function UnpaidActionSheet({
  member, period, isOfficer, onRecord, onRemind, onClose,
}: {
  member: Member;
  period: ContributionPeriod;
  isOfficer: boolean;
  onRecord: () => void;
  onRemind: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open title={member.full_name} onClose={onClose}>
      <p className="dim" style={{ marginTop: -4, marginBottom: 18 }}>
        {monthLabel(period.period_month)} · Due {fmtDate(period.due_date)}
      </p>
      <div className="btn-row stack">
        {isOfficer && !period.closed_at && (
          <button
            type="button"
            className="primary lg"
            onClick={() => {
              onClose();
              onRecord();
            }}
          >
            Record payment
          </button>
        )}
        <button
          type="button"
          className="subtle lg"
          onClick={() => {
            onClose();
            onRemind();
          }}
        >
          <IconShare width={16} height={16} style={{ marginRight: 8 }} />
          Send WhatsApp reminder
        </button>
      </div>
    </Sheet>
  );
}

function ReminderSheet({
  member, period, groupName, onClose,
}: {
  member: Member;
  period: ContributionPeriod;
  groupName: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const text = `📢 *${groupName}*
Hi ${member.full_name}, this is a reminder for ${monthLabel(period.period_month)}.

*To pay:* ${formatPaise(period.amount_paise)}
*By:* ${fmtDate(period.due_date)} (a late fee applies after ${fmtDate(period.grace_date)})

You can send it by UPI or bank transfer. Thank you!
_Sent from SavingsClub_`;

  async function share() {
    haptic(12);
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Reminder - ${member.full_name} (${monthLabel(period.period_month)})`,
          text,
        });
        return;
      } catch {
        /* fallback to wa.me */
      }
    }
    const cleanPhone = member.phone?.replace(/[^\d]/g, '');
    const url = cleanPhone
      ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  }

  async function copy() {
    haptic(10);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <Sheet open title="Send reminder" onClose={onClose}>
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ fontSize: '1.8rem', fontWeight: 700, fontFamily: 'var(--display)' }}>
          {formatPaise(period.amount_paise)}
        </div>
        <p className="dim" style={{ marginTop: 4 }}>
          {member.full_name} · {monthLabel(period.period_month)}
        </p>
      </div>

      <Panel title="Reminder message" flush>
        <div style={{ padding: 14, fontSize: '0.88rem', whiteSpace: 'pre-wrap', lineHeight: 1.5, background: 'var(--surface-2)', borderRadius: 'var(--r-sm)' }}>
          {text}
        </div>
      </Panel>

      <div className="btn-row stack" style={{ marginTop: 20 }}>
        <button type="button" className="primary lg" onClick={() => void share()}>
          <IconShare width={16} height={16} style={{ marginRight: 8 }} />
          Send via WhatsApp
        </button>
        <button type="button" className="subtle" onClick={() => void copy()}>
          {copied ? 'Copied to clipboard!' : 'Copy reminder text'}
        </button>
      </div>
    </Sheet>
  );
}

