import { useState } from 'react';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useMutation, useQuery } from '../hooks/useQuery';
import { useSession } from '../context/SessionContext';
import { paiseToRupees, rupeesToPaise } from '../lib/money';
import { Panel, Field, Busy, ErrorNote, Notice, Loading } from '../components/ui';
import type { GroupInvite } from '../lib/types';

export default function Settings() {
  const { config, isOfficer, refresh } = useSession();
  const [saved, setSaved] = useState(false);

  const [form, setForm] = useState(() => config && ({
    group_name: config.name,
    monthly: String(paiseToRupees(config.monthly_contribution_paise)),
    due_day: String(config.due_day),
    grace_day: String(config.grace_day),
    late_fee: String(paiseToRupees(config.late_fee_paise)),
    loan_rate: String(config.loan_rate_bp / 100),
    overdue_rate: String(config.overdue_rate_bp / 100),
    max_months: String(config.max_loan_months),
    max_loan_pct: String(config.max_loan_pct_bp / 100),
    reserve_pct: String(config.reserve_pct_bp / 100),
    loan_approvals: String(config.loan_required_approvals),
    expense_approvals: String(config.expense_required_approvals),
    expense_pct: String(config.expense_annual_pct_bp / 100),
    float_limit: String(paiseToRupees(config.cash_float_limit_paise)),
    report_hours: String(config.cash_report_hours),
  }));

  const save = useMutation(
    async () => {
      if (!form) return;
      const { error } = await supabase.rpc('update_config', {
        p_group_name: form.group_name,
        p_monthly_contribution_paise: rupeesToPaise(form.monthly),
        p_due_day: Number(form.due_day),
        p_grace_day: Number(form.grace_day),
        p_late_fee_paise: rupeesToPaise(form.late_fee),
        p_loan_rate_bp: Math.round(Number(form.loan_rate) * 100),
        p_overdue_rate_bp: Math.round(Number(form.overdue_rate) * 100),
        p_max_loan_months: Number(form.max_months),
        p_max_loan_pct_bp: Math.round(Number(form.max_loan_pct) * 100),
        p_reserve_pct_bp: Math.round(Number(form.reserve_pct) * 100),
        p_loan_required_approvals: Number(form.loan_approvals),
        p_expense_required_approvals: Number(form.expense_approvals),
        p_expense_annual_pct_bp: Math.round(Number(form.expense_pct) * 100),
        p_cash_float_limit_paise: rupeesToPaise(form.float_limit),
        p_cash_report_hours: Number(form.report_hours),
        p_setup_complete: true,
      });
      if (error) throw error;
    },
    { invalidates: ['fund'], onSuccess: () => { setSaved(true); refresh(); } },
  );

  if (!config || !form) return <Screen title="Rules"><Loading /></Screen>;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm({ ...form, [k]: e.target.value });
    setSaved(false);
  };

  if (!isOfficer) {
    return (
      <Screen title="Rules">
        <Notice tone="warn">Only an office holder can change the group rules.</Notice>
        <Panel title="In force">
          <ReadOnly config={config} />
        </Panel>
      </Screen>
    );
  }

  return (
    <Screen title="Rules" sub="What the database enforces">
      <ErrorNote error={save.error} />
      {saved && <Notice tone="good">Saved.</Notice>}

      <Panel title="Group">
        <Field label="Group name">
          <input value={form.group_name} onChange={set('group_name')} />
        </Field>
      </Panel>

      <InvitePanel />

      <Panel title="Contributions">
        <div className="field-row">
          <Field label="Monthly amount (₹)">
            <input inputMode="decimal" value={form.monthly} onChange={set('monthly')} />
          </Field>
          <Field label="Late fee (₹)">
            <input inputMode="decimal" value={form.late_fee} onChange={set('late_fee')} />
          </Field>
        </div>
        <div className="field-row" style={{ marginTop: 14 }}>
          <Field label="Due day">
            <input inputMode="numeric" value={form.due_day} onChange={set('due_day')} />
          </Field>
          <Field label="Grace until">
            <input inputMode="numeric" value={form.grace_day} onChange={set('grace_day')} />
          </Field>
        </div>
      </Panel>

      <Panel title="Loans">
        <div className="field-row">
          <Field label="Interest % / month">
            <input inputMode="decimal" value={form.loan_rate} onChange={set('loan_rate')} />
          </Field>
          <Field label="Overdue % / month">
            <input inputMode="decimal" value={form.overdue_rate} onChange={set('overdue_rate')} />
          </Field>
        </div>
        <div className="field-row" style={{ marginTop: 14 }}>
          <Field label="Max term (months)">
            <input inputMode="numeric" value={form.max_months} onChange={set('max_months')} />
          </Field>
          <Field label="Approvals needed" >
            <input inputMode="numeric" value={form.loan_approvals} onChange={set('loan_approvals')} />
          </Field>
        </div>
        <div className="field-row" style={{ marginTop: 14 }}>
          <Field label="Max per member (%)">
            <input inputMode="decimal" value={form.max_loan_pct} onChange={set('max_loan_pct')} />
          </Field>
          <Field label="Reserve kept (%)" hint="Never lent out">
            <input inputMode="decimal" value={form.reserve_pct} onChange={set('reserve_pct')} />
          </Field>
        </div>
      </Panel>

      <Panel title="Expenses & cash">
        <div className="field-row">
          <Field label="Expense approvals">
            <input inputMode="numeric" value={form.expense_approvals} onChange={set('expense_approvals')} />
          </Field>
          <Field label="Yearly cap (%)">
            <input inputMode="decimal" value={form.expense_pct} onChange={set('expense_pct')} />
          </Field>
        </div>
        <div className="field-row" style={{ marginTop: 14 }}>
          <Field label="Cash float limit (₹)">
            <input inputMode="decimal" value={form.float_limit} onChange={set('float_limit')} />
          </Field>
          <Field label="Report within (hours)">
            <input inputMode="numeric" value={form.report_hours} onChange={set('report_hours')} />
          </Field>
        </div>
      </Panel>

      <Notice tone="warn">
        Change these and the signed agreement should change too — and everyone should
        be told.
      </Notice>

      <div className="btn-row stack" style={{ paddingBottom: 12 }}>
        <Busy className="primary lg" pending={save.pending} onClick={() => void save.run()}>
          Save rules
        </Busy>
      </div>
    </Screen>
  );
}

/**
 * The group's invite code.
 *
 * Only one code is live at a time -- create_invite() retires the previous one --
 * so "new code" doubles as "stop the old one working", which is what someone
 * reaches for when a code has spread further than they meant.
 */
function InvitePanel() {
  const inviteQ = useQuery<GroupInvite | null>('invite', async () => {
    const { data, error } = await supabase
      .from('group_invites').select('*')
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle();
    if (error) throw error;
    return (data as GroupInvite) ?? null;
  });

  const create = useMutation(
    async () => {
      const { error } = await supabase.rpc('create_invite', { p_days_valid: 7 });
      if (error) throw error;
    },
    { invalidates: ['invite'] },
  );

  const revoke = useMutation(
    async (code: string) => {
      const { error } = await supabase.rpc('revoke_invite', { p_code: code });
      if (error) throw error;
    },
    { invalidates: ['invite'] },
  );

  const invite = inviteQ.data;
  const [copied, setCopied] = useState(false);

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // No clipboard permission (or an insecure origin). The code is on screen
      // to be read out either way, so this is not worth an error message.
    }
  }

  return (
    <Panel title="Invite people">
      <ErrorNote error={create.error ?? revoke.error ?? inviteQ.error} />

      {invite ? (
        <>
          <button
            type="button"
            onClick={() => void copy(invite.code)}
            style={{
              width: '100%', textAlign: 'center', padding: '16px 12px',
              fontFamily: 'var(--mono, ui-monospace, monospace)',
              fontSize: '1.3rem', letterSpacing: '0.14em', fontWeight: 600,
              borderRadius: 14, border: '1px dashed var(--hairline)',
              background: 'var(--violet-ghost)', color: 'var(--text)',
            }}
          >
            {invite.code}
          </button>
          <p className="dim" style={{ marginTop: 8, textAlign: 'center' }}>
            {copied
              ? 'Copied'
              : `Expires ${new Date(invite.expires_at).toLocaleDateString()} · used ${invite.use_count} time${invite.use_count === 1 ? '' : 's'}`}
          </p>

          <Notice tone="warn">
            Anyone with this code can ask to join, so approve each request against a
            name you know. Approving is what shows them the money.
          </Notice>

          <div className="btn-row stack">
            <Busy pending={create.pending} onClick={() => void create.run()}>
              New code
            </Busy>
            <Busy
              className="ghost"
              pending={revoke.pending}
              onClick={() => void revoke.run(invite.code)}
            >
              Cancel this code
            </Busy>
          </div>
        </>
      ) : (
        <>
          <p className="dim" style={{ marginBottom: 12 }}>
            No code is active. Create one to let people ask to join, then approve them
            on the Members page.
          </p>
          <Busy className="primary" pending={create.pending} onClick={() => void create.run()}>
            Create an invite code
          </Busy>
        </>
      )}
    </Panel>
  );
}

function ReadOnly({ config }: { config: NonNullable<ReturnType<typeof useSession>['config']> }) {
  const rows: [string, string][] = [
    ['Monthly contribution', `₹${paiseToRupees(config.monthly_contribution_paise)}`],
    ['Due by', `${config.due_day}th, grace to ${config.grace_day}th`],
    ['Late fee', `₹${paiseToRupees(config.late_fee_paise)}`],
    ['Loan interest', `${config.loan_rate_bp / 100}% per month`],
    ['Overdue interest', `${config.overdue_rate_bp / 100}% per month`],
    ['Max term', `${config.max_loan_months} months`],
    ['Max per member', `${config.max_loan_pct_bp / 100}% of fund`],
    ['Reserve', `${config.reserve_pct_bp / 100}% of fund`],
    ['Loan approvals', `${config.loan_required_approvals} members`],
    ['Expense approvals', `${config.expense_required_approvals} members`],
    ['Cash float limit', `₹${paiseToRupees(config.cash_float_limit_paise)}`],
  ];
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 10, fontSize: '0.88rem' }}>
          <span className="dim" style={{ flex: 1 }}>{k}</span>
          <strong>{v}</strong>
        </div>
      ))}
    </div>
  );
}
