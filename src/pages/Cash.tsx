import { useState } from 'react';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery, useMutation } from '../hooks/useQuery';
import { useSession } from '../context/SessionContext';
import { useFund } from '../context/FundContext';
import { formatPaiseShort, rupeesToPaise } from '../lib/money';
import {
  Hero, Chip, Panel, List, Row, Empty, SkeletonList, Sheet, Field, AmountField,
  Busy, ErrorNote, Notice, fmtDateTime, ago,
} from '../components/ui';
import {
  IconPlus, IconWallet, IconArrowUp, IconArrowDown,
} from '../components/icons';
import type { CashEntry, CashAlert } from '../lib/types';

export default function Cash() {
  const { role, config } = useSession();
  const { fund } = useFund();
  const isCashier = role === 'cashier';
  const [sheet, setSheet] = useState(false);

  const entriesQ = useQuery<CashEntry[]>('cash', async () => {
    const { data, error } = await supabase
      .from('cash_ledger').select('*').order('occurred_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as CashEntry[];
  });

  const alertsQ = useQuery<CashAlert[]>('cash:alerts', async () => {
    const { data, error } = await supabase
      .from('v_cash_alerts').select('*').eq('unreported', true);
    if (error) throw error;
    return (data ?? []) as CashAlert[];
  });

  const report = useMutation(
    async (id: string) => {
      const { error } = await supabase.rpc('report_cash_movement', { p_id: id });
      if (error) throw error;
    },
    { invalidates: ['cash', 'fund'] },
  );

  const balance = fund?.cash_float_paise ?? 0;
  const limit = fund?.cash_float_limit_paise ?? 0;

  return (
    <>
      <Screen title="Cash" sub="Emergency float">
        <Hero
          label="With the cashier"
          paise={balance}
          meta={
            <>
              <Chip tone={balance > limit ? 'coral' : 'mint'}>
                Limit <b>{formatPaiseShort(limit)}</b>
              </Chip>
              <Chip>Report within <b>{config?.cash_report_hours ?? 24}h</b></Chip>
            </>
          }
          meter={{ value: balance, limit: Math.max(1, limit) }}
        />

        {balance > limit && (
          <Notice tone="danger">
            Over the limit — deposit the excess into the bank.
          </Notice>
        )}

        {(alertsQ.data ?? []).length > 0 && (
          <Panel title="Not yet told to the group" flush>
            <List>
              {(alertsQ.data ?? []).map((a) => (
                <Row
                  key={a.id}
                  icon={<IconArrowUp width={17} height={17} />}
                  iconTone={a.reporting_breached ? 'coral' : 'amber'}
                  title={a.purpose}
                  sub={`${ago(a.occurred_at)}${a.reporting_breached ? ' · overdue' : ''}`}
                  amount={formatPaiseShort(a.amount_paise)}
                  amountTone="coral"
                  note={
                    <button
                      className="seg"
                      style={{ padding: '3px 9px', fontSize: '0.7rem' }}
                      disabled={report.pending}
                      onClick={() => void report.run(a.id)}
                    >
                      Mark told
                    </button>
                  }
                />
              ))}
            </List>
            <ErrorNote error={report.error} />
          </Panel>
        )}

        <Panel title="Register" flush>
          {entriesQ.loading && !entriesQ.data ? (
            <SkeletonList rows={4} />
          ) : (entriesQ.data ?? []).length === 0 ? (
            <Empty icon={<IconWallet width={22} height={22} />}>
              No cash has moved yet.
            </Empty>
          ) : (
            <List>
              {(entriesQ.data ?? []).map((e) => (
                <Row
                  key={e.id}
                  icon={e.direction === 'in'
                    ? <IconArrowDown width={17} height={17} />
                    : <IconArrowUp width={17} height={17} />}
                  iconTone={e.direction === 'in' ? 'mint' : 'amber'}
                  title={e.purpose}
                  sub={`${fmtDateTime(e.occurred_at)}${e.counterparty ? ` · ${e.counterparty}` : ''}`}
                  amount={`${e.direction === 'in' ? '+' : '−'}${formatPaiseShort(e.amount_paise)}`}
                  amountTone={e.direction === 'in' ? 'mint' : undefined}
                  note={
                    e.direction === 'out'
                      ? (e.reported_at ? 'told' : 'not told')
                      : undefined
                  }
                />
              ))}
            </List>
          )}
        </Panel>
      </Screen>

      {isCashier && (
        <button className="fab" onClick={() => setSheet(true)}>
          <IconPlus width={18} height={18} />
          Cash
        </button>
      )}

      {sheet && <CashSheet onClose={() => setSheet(false)} />}
    </>
  );
}

function CashSheet({ onClose }: { onClose: () => void }) {
  const [direction, setDirection] = useState<'in' | 'out'>('out');
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [reportNow, setReportNow] = useState(true);

  const save = useMutation(
    async () => {
      const { error } = await supabase.rpc('record_cash_movement', {
        p_direction: direction,
        p_amount_paise: rupeesToPaise(amount),
        p_purpose: purpose,
        p_counterparty: counterparty || null,
        p_report_now: reportNow,
      });
      if (error) throw error;
    },
    { invalidates: ['cash', 'fund', 'feed'], onSuccess: onClose },
  );

  return (
    <Sheet open title="Record cash" onClose={onClose}>
      <ErrorNote error={save.error} />

      <div className="seg-row" style={{ marginBottom: 14 }}>
        <button className={`seg${direction === 'out' ? ' on' : ''}`} onClick={() => setDirection('out')}>
          Paid out
        </button>
        <button className={`seg${direction === 'in' ? ' on' : ''}`} onClick={() => setDirection('in')}>
          Taken in
        </button>
      </div>

      <AmountField value={amount} onChange={setAmount} autoFocus />

      <div style={{ marginTop: 14 }}>
        <Field label="What for">
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder={direction === 'out' ? 'Emergency help' : 'Withdrawn from the bank'}
          />
        </Field>
        <Field label="Who (optional)">
          <input value={counterparty} onChange={(e) => setCounterparty(e.target.value)} />
        </Field>
      </div>

      <label style={{
        display: 'flex', gap: 10, alignItems: 'center', marginTop: 16,
        padding: '12px 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-2)',
      }}>
        <input
          type="checkbox"
          checked={reportNow}
          onChange={(e) => setReportNow(e.target.checked)}
        />
        <span style={{ color: 'var(--text)', fontWeight: 500 }}>
          I have told the group about this
        </span>
      </label>

      <div className="btn-row stack">
        <Busy
          className="primary lg"
          pending={save.pending}
          disabled={!amount || !purpose}
          onClick={() => void save.run()}
        >
          Save
        </Busy>
      </div>
    </Sheet>
  );
}
