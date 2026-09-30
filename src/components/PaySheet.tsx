import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../context/SessionContext';
import { useQuery, useMutation } from '../hooks/useQuery';
import { supabase } from '../lib/supabase';
import { formatPaise } from '../lib/money';
import { today } from '../lib/dates';
import { useT, useLang, monthIn } from '../lib/i18n';
import { upiLink, looksLikeUpiRef } from '../lib/upi';
import { haptic } from '../lib/haptics';
import { Sheet, Field, Busy, ErrorNote, Notice } from './ui';
import type { UnpaidRow, PaymentClaim } from '../lib/types';

type Quote = { due: number; fee: number; pending: number; toPay: number };

/**
 * Paying a month, for the member who owes it.
 *
 * Step one sends the money -- a UPI link that opens the member's own payment
 * app, or a QR for paying from another phone. Step two says so: a claim the
 * cashier checks against the bank and confirms. The app never moves money
 * and never marks anything paid on the member's word; claim_payment() and
 * confirm_payment_claim() (0046) keep it that way on the server.
 */
export default function PaySheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [lang] = useLang();
  const { member, config, group, currentGroupId } = useSession();

  const unpaidQ = useQuery<UnpaidRow[]>(member ? 'fund:unpaid:pay' : null, async () => {
    const { data, error } = await supabase.from('v_unpaid_contributions').select('*')
      .eq('group_id', currentGroupId!).eq('member_id', member!.id)
      .order('period_month', { ascending: true });
    if (error) throw error;
    return (data ?? []) as UnpaidRow[];
  });
  const claimsQ = useQuery<PaymentClaim[]>(member ? 'fund:claims:mine' : null, async () => {
    const { data, error } = await supabase.from('payment_claims').select('*')
      .eq('group_id', currentGroupId!).eq('member_id', member!.id).eq('status', 'pending');
    if (error) throw error;
    return (data ?? []) as PaymentClaim[];
  });

  // The oldest month still owed: that is the one a payment is for.
  const period = unpaidQ.data?.[0];
  const pending = (claimsQ.data ?? [])
    .filter((c) => c.period_id === period?.period_id)
    .reduce((s, c) => s + c.amount_paise, 0);

  // What to send today, late fee included, from the same function that caps
  // the claim (payment_quote, 0049). Asking for the deposit alone let a late
  // payment be confirmed as deposit + fee -- Rs.50 the bank never received.
  const quoteQ = useQuery<Quote | null>(
    period ? `fund:quote:${period.period_id}:${today()}` : null,
    async () => {
      const { data, error } = await supabase.rpc('payment_quote', { p_period_id: period!.period_id });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, number | string> | undefined;
      if (!row) return null;
      return {
        due: Number(row.due_paise), fee: Number(row.late_fee_paise),
        pending: Number(row.pending_paise), toPay: Number(row.to_pay_paise),
      };
    },
  );
  const quote = quoteQ.data ?? null;
  const owed = quote ? quote.toPay : 0;
  // The fee is shown only while it is still part of what to send.
  const fee = quote && quote.toPay > 0 ? quote.fee : 0;

  const vpa = config?.upi_id ?? null;
  const payee = config?.upi_payee_name || group?.name || 'SavingsClub';
  const month = period ? monthIn('en', period.period_month) : '';
  const note = `${group?.name ?? 'Savings'} ${month} ${member?.full_name ?? ''}`.trim();
  const link = vpa && owed > 0 ? upiLink(vpa, payee, owed, note) : null;

  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    if (!link) { setQr(null); return; }
    let live = true;
    // Loaded here only: most visits never open this sheet.
    void import('qrcode').then((m) => m.toDataURL(link, { margin: 1, width: 232 }))
      .then((url) => { if (live) setQr(url); })
      .catch(() => { if (live) setQr(null); });
    return () => { live = false; };
  }, [link]);

  const [copied, setCopied] = useState(false);
  const [method, setMethod] = useState<'upi' | 'bank'>(vpa ? 'upi' : 'bank');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const [sent, setSent] = useState(false);

  // Prefill with what is owed, once it is known, without fighting the user.
  const owedRupees = useMemo(() => {
    const r = Math.floor(owed / 100);
    const c = owed % 100;
    return c ? `${r}.${String(c).padStart(2, '0')}` : String(r);
  }, [owed]);
  useEffect(() => { if (!amount && owed > 0) setAmount(owedRupees); }, [owedRupees, owed, amount]);

  const submit = useMutation(
    async () => {
      const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim().replace(/,/g, ''));
      if (!m) throw new Error(t('pay.amount'));
      const paise = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
      if (method === 'upi' && !looksLikeUpiRef(reference)) throw new Error(t('pay.ref.hint'));
      const { error } = await supabase.rpc('claim_payment', {
        p_period_id: period!.period_id,
        p_amount_paise: paise,
        p_paid_on: paidOn,
        p_method: method,
        p_reference: reference.trim() || null,
      });
      if (error) throw error;
    },
    { invalidates: ['fund', 'claims'], onSuccess: () => { haptic(20); setSent(true); } },
  );

  const withdraw = useMutation(
    async (id: string) => {
      const { error } = await supabase.rpc('withdraw_payment_claim', { p_claim_id: id });
      if (error) throw error;
    },
    { invalidates: ['fund', 'claims'] },
  );

  const title = period ? t('pay.title', { month: monthIn(lang, period.period_month) }) : t('home.q.deposit');

  return (
    <Sheet open title={title} onClose={onClose}>
      {!period || (quote && owed === 0 && pending === 0) ? (
        <Notice tone="good">{t('pay.nothing')}</Notice>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ textAlign: 'center' }}>
            <div className="dim" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 650 }}>
              {t('pay.owed')}
            </div>
            <div style={{ fontFamily: 'var(--display)', fontSize: '2.2rem', fontWeight: 800 }}>
              {quote ? formatPaise(owed) : '…'}
            </div>
            {fee > 0 && (
              <div className="dim" style={{ marginTop: 2 }}>
                {t('pay.fee', { deposit: formatPaise(owed - fee), fee: formatPaise(fee) })}
              </div>
            )}
          </div>
          <ErrorNote error={quoteQ.error} />

          {(claimsQ.data ?? []).map((c) => (
            <Notice key={c.id} tone="info">
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 160 }}>
                  {t('pay.waiting', { amount: formatPaise(c.amount_paise) })}
                  {c.reference ? <span className="dim"> · {c.reference}</span> : null}
                </span>
                <Busy className="sec-link" pending={withdraw.pending} onClick={() => void withdraw.run(c.id)}>
                  {t('pay.withdraw')}
                </Busy>
              </span>
            </Notice>
          ))}
          <ErrorNote error={withdraw.error} />

          {owed > 0 && !sent && (
            link ? (
              <>
                <a
                  href={link}
                  className="btn-link primary lg"
                  onClick={() => haptic(15)}
                  style={{ textAlign: 'center' }}
                >
                  {t('pay.upi')} · {formatPaise(owed)}
                </a>
                <p className="dim" style={{ margin: 0, textAlign: 'center' }}>{t('pay.upi.hint')}</p>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                  <span className="dim">{t('pay.qr')}</span>
                  {qr ? (
                    <img src={qr} alt={`UPI QR for ${formatPaise(owed)} to ${vpa}`} width={232} height={232}
                      style={{ borderRadius: 12, background: '#fff', padding: 6 }} />
                  ) : <div className="skeleton" style={{ width: 232, height: 232, borderRadius: 12 }} />}
                  <span className="dim" style={{ overflowWrap: 'anywhere', textAlign: 'center' }}>
                    {t('pay.to', { name: payee, vpa: vpa! })}
                  </span>
                  <button
                    type="button"
                    className="subtle"
                    onClick={() => {
                      void navigator.clipboard?.writeText(vpa!).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1800);
                      });
                    }}
                  >
                    {copied ? t('pay.copied') : t('pay.copy')}
                  </button>
                </div>
              </>
            ) : (
              <Notice tone="warn">{t('pay.noupi')}</Notice>
            )
          )}

          {sent ? (
            <Notice tone="good">{t('pay.sent')}</Notice>
          ) : owed > 0 && (
            <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <strong>{t('pay.done')}</strong>
                <p className="dim" style={{ margin: '4px 0 0' }}>{t('pay.done.hint')}</p>
              </div>
              <div className="seg-row">
                {(['upi', 'bank'] as const).map((mth) => (
                  <button key={mth} type="button" className={`seg${method === mth ? ' on' : ''}`}
                    onClick={() => setMethod(mth)}>
                    {t(mth === 'upi' ? 'pay.method.upi' : 'pay.method.bank')}
                  </button>
                ))}
              </div>
              <Field label={t('pay.amount')}>
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
              <Field label={t(method === 'upi' ? 'pay.ref' : 'pay.ref.bank')} hint={method === 'upi' ? t('pay.ref.hint') : undefined}>
                <input value={reference} onChange={(e) => setReference(e.target.value)}
                  autoComplete="off" spellCheck={false} placeholder={method === 'upi' ? '426811234567' : ''} />
              </Field>
              <Field label={t('pay.date')}>
                <input type="date" value={paidOn} max={today()} min={period.period_month.slice(0, 10)}
                  onChange={(e) => setPaidOn(e.target.value)} />
              </Field>
              <ErrorNote error={submit.error} />
              <Busy
                className="primary lg"
                pending={submit.pending}
                disabled={!amount.trim() || (method === 'upi' && !reference.trim())}
                onClick={() => void submit.run()}
              >
                {t('pay.submit')}
              </Busy>
              <p className="dim" style={{ margin: 0, textAlign: 'center' }}>{t('pay.cash')}</p>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
