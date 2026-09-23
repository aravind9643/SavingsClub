import { useState } from 'react';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useQuery, useMutation } from '../hooks/useQuery';
import { useIsOfficer, useSession } from '../context/SessionContext';
import { useFund } from '../context/FundContext';
import { formatPaise, formatPaiseShort, rupeesToPaise } from '../lib/money';
import {
  Hero, Chip, Panel, List, Row, Empty, Sheet, Field, AmountField, Busy,
  ErrorNote, Notice, Stat, fmtDate,
} from '../components/ui';
import { IconPlus, IconBank, IconCheck } from '../components/icons';
import type { BankStatement } from '../lib/types';

export default function Bank() {
  const isOfficer = useIsOfficer();
  const { currentGroupId } = useSession();
  const { fund } = useFund();
  const [sheet, setSheet] = useState(false);

  const q = useQuery<BankStatement[]>('bank', async () => {
    let query = supabase
      .from('bank_statements').select('*').order('as_of', { ascending: false });
    if (currentGroupId) query = query.eq('group_id', currentGroupId);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as BankStatement[];
  });

  const latest = (q.data ?? [])[0];

  return (
    <>
      <Screen title="Bank" sub="Reconciliation">
        {fund && (
          <Hero
            label="Should be in the bank"
            paise={fund.expected_bank_balance_paise}
            meta={
              <>
                <Chip>Fund <b>{formatPaiseShort(fund.total_fund_paise)}</b></Chip>
                <Chip tone="violet">− On loan <b>{formatPaiseShort(fund.outstanding_paise)}</b></Chip>
                <Chip tone="amber">− Cash <b>{formatPaiseShort(fund.cash_float_paise)}</b></Chip>
              </>
            }
          />
        )}

        {latest && (
          <Notice tone={latest.difference_paise === 0 ? 'good' : 'danger'}>
            {latest.difference_paise === 0
              ? `Balanced as of ${fmtDate(latest.as_of)}.`
              : `Off by ${formatPaise(Math.abs(latest.difference_paise))} as of ${fmtDate(latest.as_of)} — find out why.`}
          </Notice>
        )}

        {latest && (
          <Panel title="Last statement">
            <div className="stats three">
              <Stat k="Bank says" v={formatPaiseShort(latest.closing_balance_paise)} />
              <Stat k="Books say" v={formatPaiseShort(latest.expected_balance_paise)} />
              <Stat
                k="Difference"
                v={formatPaiseShort(latest.difference_paise)}
                tone={latest.difference_paise === 0 ? 'mint' : 'coral'}
                s={latest.difference_paise === 0 ? 'balanced' : 'check'}
              />
            </div>
          </Panel>
        )}

        <Panel title="History" flush>
          {(q.data ?? []).length === 0 ? (
            <Empty icon={<IconBank width={22} height={22} />}>
              No statements yet. Record one each month — the difference is the check
              that catches almost every problem early.
            </Empty>
          ) : (
            <List>
              {(q.data ?? []).map((s) => (
                <Row
                  key={s.id}
                  icon={<IconCheck width={17} height={17} />}
                  iconTone={s.difference_paise === 0 ? 'mint' : 'coral'}
                  title={fmtDate(s.as_of)}
                  sub={s.note || `Books said ${formatPaiseShort(s.expected_balance_paise)}`}
                  amount={formatPaiseShort(s.closing_balance_paise)}
                  note={
                    s.difference_paise === 0
                      ? 'balanced'
                      : `off ${formatPaiseShort(Math.abs(s.difference_paise))}`
                  }
                  amountTone={s.difference_paise === 0 ? 'mint' : 'coral'}
                />
              ))}
            </List>
          )}
        </Panel>
      </Screen>

      {isOfficer && (
        <button className="fab" onClick={() => setSheet(true)}>
          <IconPlus width={18} height={18} />
          Statement
        </button>
      )}

      {sheet && (
        <StatementSheet
          expected={fund?.expected_bank_balance_paise ?? 0}
          onClose={() => setSheet(false)}
        />
      )}
    </>
  );
}

function StatementSheet({ expected, onClose }: { expected: number; onClose: () => void }) {
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [balance, setBalance] = useState('');
  const [note, setNote] = useState('');

  const save = useMutation(
    async () => {
      const { error } = await supabase.rpc('record_bank_statement', {
        p_as_of: asOf,
        p_closing_balance_paise: rupeesToPaise(balance),
        p_note: note || null,
      });
      if (error) throw error;
    },
    { invalidates: ['bank', 'bank:last', 'fund'], onSuccess: onClose },
  );

  const typed = balance ? rupeesToPaise(balance) : null;
  const diff = typed === null ? null : typed - expected;

  return (
    <Sheet open title="Bank statement" onClose={onClose}>
      <p className="dim" style={{ marginTop: -4, marginBottom: 14 }}>
        The books say {formatPaise(expected)} should be there.
      </p>

      <ErrorNote error={save.error} />

      <label>Closing balance the bank shows</label>
      <AmountField value={balance} onChange={setBalance} autoFocus />

      <div className="field-row" style={{ marginTop: 14 }}>
        <Field label="Statement date">
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
        <Field label="Note (optional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>

      {diff !== null && (
        <div style={{ marginTop: 16 }}>
          <Notice tone={diff === 0 ? 'good' : 'danger'}>
            {diff === 0
              ? 'Matches the books exactly.'
              : `Off by ${formatPaise(Math.abs(diff))} — find out why before saving.`}
          </Notice>
        </div>
      )}

      <div className="btn-row stack">
        <Busy className="primary lg" pending={save.pending} disabled={!balance}
          onClick={() => void save.run()}>
          Save statement
        </Busy>
      </div>
    </Sheet>
  );
}
