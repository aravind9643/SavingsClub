import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery, useMutation } from '../hooks/useQuery';
import { useSession, useIsOfficer } from '../context/SessionContext';
import { formatPaise, formatPaiseShort, rupeesToPaise, paiseToRupees } from '../lib/money';
import {
  List, Row, Panel, Empty, SkeletonList, Sheet, Field, AmountField, Busy,
  ErrorNote, Segments, initials, fmtDate, Notice,
} from '../components/ui';
import { IconContributions, IconCheck } from '../components/icons';
import type { Member, ContributionPeriod, Contribution } from '../lib/types';

export default function Contributions() {
  const nav = useNavigate();
  const { config, role } = useSession();
  const isOfficer = useIsOfficer();
  const [periodId, setPeriodId] = useState<string>('');
  const [paying, setPaying] = useState<{ period: ContributionPeriod; member: Member } | null>(null);

  const membersQ = useQuery<Member[]>('members', async () => {
    const { data, error } = await supabase.from('members').select('*').order('full_name');
    if (error) throw error;
    return (data ?? []) as Member[];
  });

  const periodsQ = useQuery<ContributionPeriod[]>('periods', async () => {
    const { data, error } = await supabase
      .from('contribution_periods').select('*').order('period_month', { ascending: false });
    if (error) throw error;
    return (data ?? []) as ContributionPeriod[];
  });

  const contribsQ = useQuery<Contribution[]>('contributions', async () => {
    const { data, error } = await supabase.from('contributions').select('*');
    if (error) throw error;
    return (data ?? []) as Contribution[];
  });

  const openPeriod = useMutation(
    async () => {
      const m = new Date(); m.setDate(1);
      const { error } = await supabase.rpc('open_period', {
        p_month: m.toISOString().slice(0, 10),
      });
      if (error) throw error;
    },
    { invalidates: ['periods', 'fund'] },
  );

  const periods = periodsQ.data ?? [];

  // Default to the newest month once periods arrive.
  useEffect(() => {
    if (!periodId && periods.length) setPeriodId(periods[0].id);
  }, [periods, periodId]);

  const period = periods.find((p) => p.id === periodId) ?? periods[0];
  const members = (membersQ.data ?? []).filter((m) => m.is_active);

  const paidMap = useMemo(() => {
    const map = new Map<string, Contribution>();
    for (const c of contribsQ.data ?? []) {
      if (c.period_id === period?.id) map.set(c.member_id, c);
    }
    return map;
  }, [contribsQ.data, period?.id]);

  const paidCount = members.filter((m) => paidMap.has(m.id)).length;
  const collected = members.reduce((sum, m) => {
    const c = paidMap.get(m.id);
    return sum + (c ? c.amount_paise + c.late_fee_paise : 0);
  }, 0);
  const expected = (period?.amount_paise ?? 0) * members.length;

  if (periodsQ.loading && !periodsQ.data) {
    return <Screen title="Chanda"><SkeletonList rows={5} /></Screen>;
  }

  if (periods.length === 0) {
    return (
      <Screen title="Chanda">
        <Empty icon={<IconContributions width={22} height={22} />}>
          No months opened yet.
          {isOfficer ? (
            <div className="btn-row stack" style={{ marginTop: 18 }}>
              <Busy className="primary lg" pending={openPeriod.pending}
                onClick={() => void openPeriod.run()}>
                Open this month
              </Busy>
            </div>
          ) : role === 'president' ? (
            <>
              <p className="dim" style={{ marginTop: 8, maxWidth: 360, marginInline: 'auto' }}>
                A cashier or accountant must be assigned before contributions can be opened and recorded.
              </p>
              <div className="btn-row stack" style={{ marginTop: 18, maxWidth: 320, marginInline: 'auto' }}>
                <button type="button" className="primary lg" onClick={() => nav('/members')}>
                  Assign roles in Members
                </button>
              </div>
            </>
          ) : (
            <p className="dim" style={{ marginTop: 8 }}>
              The group officers will open this month once contributions begin.
            </p>
          )}
        </Empty>
      </Screen>
    );
  }

  return (
    <>
      <Screen
        title="Chanda"
        sub={period ? monthLabel(period.period_month) : undefined}
      >
        <Segments
          value={period?.id ?? ''}
          onChange={setPeriodId}
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
              {paidCount} of {members.length} paid · {formatPaiseShort(expected)} expected
            </div>
            <div className="meter">
              <i style={{ width: `${expected ? (collected / expected) * 100 : 0}%` }} />
            </div>
          </div>
        )}

        {period?.closed_at && (
          <Notice tone="warn">This month is closed — entries can no longer be changed.</Notice>
        )}

        <Panel
          title="Members"
          action={
            isOfficer && !periods.some((p) => isThisMonth(p.period_month)) ? (
              <button className="sec-link" onClick={() => void openPeriod.run()}>
                Open this month
              </button>
            ) : undefined
          }
          flush
        >
          <List>
            {members.map((m) => {
              const c = paidMap.get(m.id);
              const overdue = !c && period && new Date(period.grace_date) < new Date();
              return (
                <Row
                  key={m.id}
                  icon={c ? <IconCheck width={17} height={17} /> : initials(m.full_name)}
                  iconTone={c ? 'mint' : overdue ? 'coral' : undefined}
                  title={m.full_name}
                  sub={
                    c
                      ? `Paid ${fmtDate(c.paid_on)}${c.late_fee_paise > 0 ? ' · late' : ''}`
                      : overdue
                        ? `Overdue since ${fmtDate(period?.grace_date)}`
                        : `Due ${fmtDate(period?.due_date)}`
                  }
                  amount={c ? formatPaiseShort(c.amount_paise) : '—'}
                  amountTone={c ? 'mint' : undefined}
                  note={c && c.late_fee_paise > 0 ? `+${formatPaiseShort(c.late_fee_paise)} fee` : undefined}
                  onClick={
                    isOfficer && !c && period && !period.closed_at
                      ? () => setPaying({ period, member: m })
                      : undefined
                  }
                  chevron={Boolean(isOfficer && !c && period && !period.closed_at)}
                />
              );
            })}
          </List>
        </Panel>
      </Screen>

      {paying && config && (
        <RecordSheet
          period={paying.period}
          member={paying.member}
          defaultPaise={config.monthly_contribution_paise}
          onClose={() => setPaying(null)}
        />
      )}
    </>
  );
}

function monthLabel(iso: string, short = false): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    month: short ? 'short' : 'long',
    year: short ? '2-digit' : 'numeric',
  });
}

function isThisMonth(iso: string): boolean {
  const d = new Date(iso); const n = new Date();
  return d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
}

function RecordSheet({
  period, member, defaultPaise, onClose,
}: {
  period: ContributionPeriod;
  member: Member;
  defaultPaise: number;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(String(paiseToRupees(defaultPaise)));
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<'bank' | 'cash'>('bank');

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
    { invalidates: ['contributions', 'positions', 'fund', 'cash', 'feed'], onSuccess: onClose },
  );

  const late = new Date(paidOn) > new Date(period.grace_date);

  return (
    <Sheet open title={member.full_name} onClose={onClose}>
      <p className="dim" style={{ marginTop: -4, marginBottom: 14 }}>
        {monthLabel(period.period_month)} · due {fmtDate(period.due_date)}
      </p>

      <ErrorNote error={save.error} />

      <AmountField value={amount} onChange={setAmount} autoFocus />

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
