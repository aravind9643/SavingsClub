import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { supabase } from '../lib/supabase';
import { useMutation, useQuery } from '../hooks/useQuery';
import { useSession } from '../context/SessionContext';
import { paiseToRupees, rupeesToPaise, formatPaise } from '../lib/money';
import { Panel, Field, Busy, ErrorNote, Notice, Loading, Sheet } from '../components/ui';
import { haptic } from '../lib/haptics';
import { today } from '../lib/dates';
import type { GroupInvite, Member } from '../lib/types';
import { IconShare } from '../components/icons';
import {
  type GroupExportData,
  exportContributionsCSV,
  exportLoansCSV,
  exportTreasuryCSV,
} from '../lib/export';
import { PrintableStatementModal } from '../components/PrintableStatement';

export default function Settings() {
  const nav = useNavigate();
  const { config, isOfficer, refresh } = useSession();
  const [saved, setSaved] = useState(false);

  const [openingSheet, setOpeningSheet] = useState(false);

  const [form, setForm] = useState(() => config && ({
    group_name: config.name,
    monthly: String(paiseToRupees(config.monthly_contribution_paise)),
    due_day: String(config.due_day),
    grace_day: String(config.grace_day),
    late_fee: String(paiseToRupees(config.late_fee_paise)),
    meeting_absent_fee: String(paiseToRupees(config.meeting_absent_fee_paise ?? 0)),
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

  useEffect(() => {
    if (!config) return;
    setForm({
      group_name: config.name,
      monthly: String(paiseToRupees(config.monthly_contribution_paise)),
      due_day: String(config.due_day),
      grace_day: String(config.grace_day),
      late_fee: String(paiseToRupees(config.late_fee_paise)),
      meeting_absent_fee: String(paiseToRupees(config.meeting_absent_fee_paise ?? 0)),
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
    });
  }, [config?.id, config?.meeting_absent_fee_paise]);

  const save = useMutation(
    async () => {
      if (!form) return;
      const due = Number(form.due_day);
      const grace = Number(form.grace_day);
      const monthly = rupeesToPaise(form.monthly);
      const lateFee = rupeesToPaise(form.late_fee);
      const absentFee = rupeesToPaise(form.meeting_absent_fee);
      const loanRate = Math.round(Number(form.loan_rate) * 100);
      const overdueRate = Math.round(Number(form.overdue_rate) * 100);
      const maxMonths = Number(form.max_months);
      const maxLoanPct = Math.round(Number(form.max_loan_pct) * 100);
      const reservePct = Math.round(Number(form.reserve_pct) * 100);
      const loanApprovals = Number(form.loan_approvals);
      const expenseApprovals = Number(form.expense_approvals);
      const expensePct = Math.round(Number(form.expense_pct) * 100);
      const floatLimit = rupeesToPaise(form.float_limit);
      const reportHours = Number(form.report_hours);

      if (monthly <= 0) throw new Error('The monthly amount must be more than zero');
      if (isNaN(due) || due < 1 || due > 28) throw new Error('Due day must be between 1 and 28');
      if (isNaN(grace) || grace < 1 || grace > 28) throw new Error('Grace day must be between 1 and 28');
      if (grace < due) throw new Error('Grace day cannot be earlier than due day');
      if (lateFee < 0) throw new Error('Late fee cannot be negative');
      if (absentFee < 0) throw new Error('Meeting absence fee cannot be negative');
      if (isNaN(loanRate) || loanRate < 0) throw new Error('Loan rate cannot be negative');
      if (isNaN(overdueRate) || overdueRate < 0) throw new Error('Overdue rate cannot be negative');
      if (isNaN(maxMonths) || maxMonths < 1) throw new Error('Max loan duration must be at least 1 month');
      if (isNaN(maxLoanPct) || maxLoanPct < 0 || maxLoanPct > 10000) throw new Error('Max loan % must be between 0 and 100%');
      if (isNaN(reservePct) || reservePct < 0 || reservePct > 10000) throw new Error('Reserve % must be between 0 and 100%');
      if (isNaN(loanApprovals) || loanApprovals < 0) throw new Error('Loan approvals cannot be negative');
      if (isNaN(expenseApprovals) || expenseApprovals < 0) throw new Error('Expense approvals cannot be negative');
      if (isNaN(expensePct) || expensePct < 0 || expensePct > 10000) throw new Error('Expense limit % must be between 0 and 100%');
      if (floatLimit < 0) throw new Error('Cash limit cannot be negative');
      if (isNaN(reportHours) || reportHours < 1) throw new Error('Cash reporting window must be at least 1 hour');

      const { error } = await supabase.rpc('update_config', {
        p_group_name: form.group_name.trim() || undefined,
        p_monthly_contribution_paise: monthly,
        p_due_day: due,
        p_grace_day: grace,
        p_late_fee_paise: lateFee,
        p_loan_rate_bp: loanRate,
        p_overdue_rate_bp: overdueRate,
        p_max_loan_months: maxMonths,
        p_max_loan_pct_bp: maxLoanPct,
        p_reserve_pct_bp: reservePct,
        p_loan_required_approvals: loanApprovals,
        p_expense_required_approvals: expenseApprovals,
        p_expense_annual_pct_bp: expensePct,
        p_cash_float_limit_paise: floatLimit,
        p_cash_report_hours: reportHours,
        p_setup_complete: true,
        p_meeting_absent_fee_paise: absentFee,
      });
      if (error) throw error;
    },
    { invalidates: ['fund', 'config', 'session'], onSuccess: () => { setSaved(true); refresh(); } },
  );

  if (!config || !form) return <Screen title="Group rules" onBack={() => nav('/community')}><Loading /></Screen>;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm({ ...form, [k]: e.target.value });
    setSaved(false);
  };

  if (!isOfficer) {
    return (
      <Screen title="Group rules" onBack={() => nav('/community')}>
        <Notice tone="warn">Only the cashier, accountant or admin can change these.</Notice>
        <Panel title="Rules right now">
          <ReadOnly config={config} />
        </Panel>
        <InstallAppPanel />
        <DataBackupPanel />
      </Screen>
    );
  }

  return (
    <>
    <Screen title="Group rules" sub="The app follows these, always" onBack={() => nav('/community')}>
      <ErrorNote error={save.error} />
      {saved && <Notice tone="good">Saved.</Notice>}

      <Panel title="Group">
        <Field label="Group name">
          <input value={form.group_name} onChange={set('group_name')} />
        </Field>
      </Panel>

      <InvitePanel />

      <Panel title="Monthly savings & meetings">
        <div className="field-row">
          <Field label="Amount each month (₹)">
            <input inputMode="decimal" value={form.monthly} onChange={set('monthly')} />
          </Field>
          <Field label="Late fee (₹)">
            <input inputMode="decimal" value={form.late_fee} onChange={set('late_fee')} />
          </Field>
        </div>
        <div className="field-row" style={{ marginTop: 14 }}>
          <Field label="Pay by day">
            <input inputMode="numeric" value={form.due_day} onChange={set('due_day')} />
          </Field>
          <Field label="Late after day">
            <input inputMode="numeric" value={form.grace_day} onChange={set('grace_day')} />
          </Field>
        </div>
        <div className="field-row" style={{ marginTop: 14 }}>
          <Field label="Meeting absence fine (₹)" hint="Charged per unexcused absence, 0 for none">
            <input inputMode="decimal" value={form.meeting_absent_fee} onChange={set('meeting_absent_fee')} />
          </Field>
        </div>
      </Panel>

      <Panel title="What the group already had">
        {config.opening_locked ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 600 }}>Opening balances finalized</div>
              <div className="dim" style={{ fontSize: '0.85rem', marginTop: 2 }}>
                Locked on {config.opened_on ? new Date(config.opened_on).toLocaleDateString() : 'setup'}. Baseline is immutable.
              </div>
            </div>
            <span className="tag mint">✓ Locked</span>
          </div>
        ) : (
          <div>
            <p className="dim" style={{ fontSize: '0.88rem', margin: 0, marginBottom: 12 }}>
              If your group ran on paper before SavingsClub, enter what each member had already saved so their shares and interest calculations start accurately.
            </p>
            <button
              type="button"
              className="sec-link"
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--hairline)',
                padding: '10px 14px',
                borderRadius: 'var(--r-sm)',
                fontWeight: 600,
                fontSize: '0.9rem',
                color: 'var(--text)',
              }}
              onClick={() => {
                haptic(10);
                setOpeningSheet(true);
              }}
            >
              Record Starting Balances
            </button>
          </div>
        )}
      </Panel>

      <Panel title="Loans">
        <div className="field-row">
          <Field label="Interest each month (%)">
            <input inputMode="decimal" value={form.loan_rate} onChange={set('loan_rate')} />
          </Field>
          <Field label="Extra if late (%)">
            <input inputMode="decimal" value={form.overdue_rate} onChange={set('overdue_rate')} />
          </Field>
        </div>
        <div className="field-row" style={{ marginTop: 14 }}>
          <Field label="Longest loan (months)">
            <input inputMode="numeric" value={form.max_months} onChange={set('max_months')} />
          </Field>
          <Field label="Yes votes needed" hint="Leave 0 and the app uses a simple majority">
            <input inputMode="numeric" value={form.loan_approvals} onChange={set('loan_approvals')} />
          </Field>
        </div>
        <div className="field-row" style={{ marginTop: 14 }}>
          <Field label="One member can borrow (%)">
            <input inputMode="decimal" value={form.max_loan_pct} onChange={set('max_loan_pct')} />
          </Field>
          <Field label="Always keep back (%)" hint="This much is never lent out">
            <input inputMode="decimal" value={form.reserve_pct} onChange={set('reserve_pct')} />
          </Field>
        </div>
      </Panel>

      <Panel title="Spending and cash">
        <div className="field-row">
          <Field label="Yes votes for spending" hint="Leave 0 and the app uses a two-thirds majority">
            <input inputMode="numeric" value={form.expense_approvals} onChange={set('expense_approvals')} />
          </Field>
          <Field label="Yearly spending limit (%)">
            <input inputMode="decimal" value={form.expense_pct} onChange={set('expense_pct')} />
          </Field>
        </div>
        <div className="field-row" style={{ marginTop: 14 }}>
          <Field label="Most cash in hand (₹)">
            <input inputMode="decimal" value={form.float_limit} onChange={set('float_limit')} />
          </Field>
          <Field label="Tell the group within (hours)">
            <input inputMode="numeric" value={form.report_hours} onChange={set('report_hours')} />
          </Field>
        </div>
      </Panel>

      <InstallAppPanel />

      <DataBackupPanel />

      <Notice tone="warn">
        Change these and the signed agreement should change too — and everyone should
        be told.
      </Notice>

      <div className="btn-row stack" style={{ marginTop: 12, paddingBottom: 36 }}>
        <Busy className="primary lg" pending={save.pending} onClick={() => void save.run()}>
          Save rules
        </Busy>
      </div>
    </Screen>
    {openingSheet && (
      <OpeningBalancesSheet onClose={() => setOpeningSheet(false)} />
    )}
    </>
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
  const { currentGroupId, group } = useSession();

  const inviteQ = useQuery<GroupInvite | null>('invite', async () => {
    // The group filter matters more here than elsewhere: this takes the FIRST
    // row of an ordered set, so without it the panel could display — and
    // "revoke" — whichever group's code happened to sort first.
    let q = supabase
      .from('group_invites').select('*')
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString());
    if (currentGroupId) q = q.eq('group_id', currentGroupId);

    const { data, error } = await q
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
            <button
              type="button"
              className="primary lg"
              style={{
                background: '#25D366',
                borderColor: '#25D366',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
              onClick={() => {
                haptic(10);
                const link = `${window.location.origin}/join?code=${invite.code}`;
                const text = `👋 Join our savings group *${group?.name || 'SavingsClub'}*!\n\n` +
                  `Use this invite link:\n${link}\n\n` +
                  `Or enter code in the app: *${invite.code}*\n` +
                  `(Code expires in 7 days)`;
                window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
              }}
            >
              <IconShare width={16} height={16} />
              Share invite on WhatsApp
            </button>
            <button
              type="button"
              className="subtle"
              onClick={() => {
                haptic(10);
                const link = `${window.location.origin}/join?code=${invite.code}`;
                void copy(link);
              }}
            >
              {copied ? 'Link copied to clipboard!' : 'Copy invite link'}
            </button>
            <div className="btn-row" style={{ marginTop: 6 }}>
              <Busy style={{ flex: 1 }} pending={create.pending} onClick={() => void create.run()}>
                New code
              </Busy>
              <Busy
                className="ghost"
                style={{ flex: 1 }}
                pending={revoke.pending}
                onClick={() => void revoke.run(invite.code)}
              >
                Cancel code
              </Busy>
            </div>
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
    ['Amount each month', `₹${paiseToRupees(config.monthly_contribution_paise)}`],
    ['Pay by', `${config.due_day}th, late after the ${config.grace_day}th`],
    ['Late fee', `₹${paiseToRupees(config.late_fee_paise)}`],
    ['Interest on loans', `${config.loan_rate_bp / 100}% per month`],
    ['Extra if late', `${config.overdue_rate_bp / 100}% per month`],
    ['Longest loan', `${config.max_loan_months} months`],
    ['One member can borrow', `${config.max_loan_pct_bp / 100}% of fund`],
    ['Always kept back', `${config.reserve_pct_bp / 100}% of fund`],
    ['Yes votes for a loan', config.loan_required_approvals > 0 ? `${config.loan_required_approvals} members` : 'A simple majority'],
    ['Yes votes for spending', config.expense_required_approvals > 0 ? `${config.expense_required_approvals} members` : 'Two out of every three'],
    ['Most cash in hand', `₹${paiseToRupees(config.cash_float_limit_paise)}`],
    ['Meeting absence fee', config.meeting_absent_fee_paise ? `₹${paiseToRupees(config.meeting_absent_fee_paise)}` : 'None'],
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

async function fetchExportData(): Promise<GroupExportData> {
  const { data, error } = await supabase.rpc('export_group_data');
  if (error) throw error;
  return data as GroupExportData;
}

function DataBackupPanel() {
  const { group } = useSession();
  const [downloading, setDownloading] = useState(false);
  const [statementData, setStatementData] = useState<GroupExportData | null>(null);

  const handleExportJSON = async () => {
    try {
      haptic(10);
      setDownloading(true);
      const data = await fetchExportData();
      const jsonStr = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(group?.name || 'SavingsClub').replace(/\s+/g, '_')}_backup_${today()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      haptic(20);
    } catch (e) {
      alert((e as Error).message || 'Failed to export group data');
    } finally {
      setDownloading(false);
    }
  };

  const handleExportCSV = async (type: 'contributions' | 'loans' | 'treasury') => {
    try {
      haptic(10);
      setDownloading(true);
      const data = await fetchExportData();
      const name = group?.name || 'SavingsClub';
      if (type === 'contributions') exportContributionsCSV(data, name);
      else if (type === 'loans') exportLoansCSV(data, name);
      else if (type === 'treasury') exportTreasuryCSV(data, name);
      haptic(20);
    } catch (e) {
      alert((e as Error).message || 'Failed to export CSV');
    } finally {
      setDownloading(false);
    }
  };

  const handleOpenStatement = async () => {
    try {
      haptic(10);
      setDownloading(true);
      const data = await fetchExportData();
      setStatementData(data);
    } catch (e) {
      alert((e as Error).message || 'Failed to generate statement');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <Panel title="Reports & Data Export">
        <p className="dim" style={{ fontSize: '0.88rem', margin: '0 0 12px' }}>
          Download clean Excel / CSV spreadsheets for accounting, or generate an annual printable statement.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 12 }}>
          <button
            type="button"
            className="sec-link"
            disabled={downloading}
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--hairline)',
              padding: '10px 12px',
              borderRadius: 'var(--r-sm)',
              fontWeight: 600,
              fontSize: '0.84rem',
              color: 'var(--text)',
              textAlign: 'center',
            }}
            onClick={() => void handleExportCSV('contributions')}
          >
            📊 Deposits (.csv)
          </button>

          <button
            type="button"
            className="sec-link"
            disabled={downloading}
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--hairline)',
              padding: '10px 12px',
              borderRadius: 'var(--r-sm)',
              fontWeight: 600,
              fontSize: '0.84rem',
              color: 'var(--text)',
              textAlign: 'center',
            }}
            onClick={() => void handleExportCSV('loans')}
          >
            💳 Loans (.csv)
          </button>

          <button
            type="button"
            className="sec-link"
            disabled={downloading}
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--hairline)',
              padding: '10px 12px',
              borderRadius: 'var(--r-sm)',
              fontWeight: 600,
              fontSize: '0.84rem',
              color: 'var(--text)',
              textAlign: 'center',
            }}
            onClick={() => void handleExportCSV('treasury')}
          >
            🪙 Cash Float (.csv)
          </button>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Busy
            type="button"
            className="sec-link"
            style={{
              flex: '1 1 180px',
              background: 'var(--mint-ghost)',
              border: '1px solid var(--mint)',
              padding: '10px 14px',
              borderRadius: 'var(--r-sm)',
              fontWeight: 600,
              fontSize: '0.88rem',
              color: 'var(--mint)',
              textAlign: 'center',
            }}
            pending={downloading}
            onClick={() => void handleOpenStatement()}
          >
            📑 Annual Statement (Print / PDF)
          </Busy>

          <Busy
            type="button"
            className="sec-link"
            style={{
              flex: '1 1 140px',
              background: 'var(--surface-3)',
              border: '1px solid var(--hairline)',
              padding: '10px 14px',
              borderRadius: 'var(--r-sm)',
              fontWeight: 600,
              fontSize: '0.84rem',
              color: 'var(--text-2)',
              textAlign: 'center',
            }}
            pending={downloading}
            onClick={() => void handleExportJSON()}
          >
            Full Backup (.json)
          </Busy>
        </div>
      </Panel>

      {statementData && (
        <PrintableStatementModal
          data={statementData}
          groupName={group?.name || 'SavingsClub'}
          onClose={() => setStatementData(null)}
        />
      )}
    </>
  );
}

function InstallAppPanel() {
  const [isStandalone, setIsStandalone] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(display-mode: standalone)').matches || (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  });
  const [promptEvent, setPromptEvent] = useState<any>(null);
  const [showIosGuide, setShowIosGuide] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setPromptEvent(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);

  const handleInstall = async () => {
    if (promptEvent) {
      promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice.outcome === 'accepted') {
        setIsStandalone(true);
        setPromptEvent(null);
      }
    } else if (isIOS) {
      setShowIosGuide(true);
    } else {
      alert('To install SavingsClub: open your browser menu (⋮) and tap "Add to Home screen" or "Install App".');
    }
  };

  if (isStandalone) {
    return (
      <Panel title="Mobile App">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
          <span style={{ fontSize: '1.2rem' }}>📱</span>
          <div>
            <div style={{ fontWeight: 650, color: 'var(--mint)', fontSize: '0.9rem' }}>
              Installed on this device
            </div>
            <div className="dim" style={{ fontSize: '0.8rem', marginTop: 1 }}>
              SavingsClub is running in standalone full-screen mode.
            </div>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <>
      <Panel title="Install as Mobile App">
        <p className="dim" style={{ fontSize: '0.88rem', margin: '0 0 12px' }}>
          Add SavingsClub to your phone's home screen for fast 1-tap access, full-screen view, and offline support.
        </p>

        <button
          type="button"
          className="sec-link"
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--accent)',
            padding: '10px 14px',
            borderRadius: 'var(--r-sm)',
            fontWeight: 700,
            fontSize: '0.88rem',
            color: 'var(--text)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
          onClick={handleInstall}
        >
          📲 Add to Home Screen / Install
        </button>
      </Panel>

      {showIosGuide && (
        <Sheet open title="Install on iPhone / iPad" onClose={() => setShowIosGuide(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 0', fontSize: '0.9rem' }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flex: 'none' }}>1</span>
              <div>Tap the <strong>Share</strong> button at the bottom of Safari (the square with an arrow pointing up).</div>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flex: 'none' }}>2</span>
              <div>Scroll down and select <strong>&ldquo;Add to Home Screen&rdquo;</strong>.</div>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flex: 'none' }}>3</span>
              <div>Tap <strong>Add</strong> in the top right. SavingsClub will now launch full-screen!</div>
            </div>
          </div>
          <div className="btn-row stack" style={{ marginTop: 20 }}>
            <button type="button" className="primary lg" onClick={() => setShowIosGuide(false)}>
              Got it
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

function OpeningBalancesSheet({ onClose }: { onClose: () => void }) {
  const { config, currentGroupId, refresh } = useSession();
  const [openedOn, setOpenedOn] = useState(config?.opened_on || today());
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [lockConfirm, setLockConfirm] = useState(false);

  const membersQ = useQuery<Member[]>('members:active', async () => {
    let q = supabase
      .from('members')
      .select('*')
      .eq('status', 'active')
      .order('full_name');
    if (currentGroupId) q = q.eq('group_id', currentGroupId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Member[];
  });

  const members = membersQ.data ?? [];

  // Initialize from member opening_balance_paise when loaded
  useEffect(() => {
    if (members.length > 0 && Object.keys(balances).length === 0) {
      const init: Record<string, string> = {};
      for (const m of members) {
        init[m.id] = m.opening_balance_paise ? String(paiseToRupees(m.opening_balance_paise)) : '0';
      }
      setBalances(init);
    }
  }, [members]);

  // Calculate total starting fund in paise
  const totalStartingPaise = members.reduce((sum, m) => {
    const val = balances[m.id];
    return sum + (val ? rupeesToPaise(val) : 0);
  }, 0);

  const saveOpening = useMutation(
    async () => {
      const payload: Record<string, number> = {};
      for (const m of members) {
        const val = balances[m.id];
        const paise = val ? rupeesToPaise(val) : 0;
        if (paise < 0) throw new Error('Starting balances cannot be negative');
        payload[m.id] = paise;
      }
      const { error } = await supabase.rpc('set_opening_position', {
        p_opened_on: openedOn,
        p_balances: payload,
      });
      if (error) throw error;
    },
    {
      invalidates: ['fund', 'members', 'session'],
      onSuccess: () => {
        haptic(20);
        refresh();
      },
    },
  );

  const lockOpening = useMutation(
    async () => {
      const { error } = await supabase.rpc('lock_opening_position');
      if (error) throw error;
    },
    {
      invalidates: ['fund', 'members', 'session'],
      onSuccess: () => {
        haptic(20);
        refresh();
        onClose();
      },
    },
  );

  return (
    <Sheet open title="Starting Balances (Past Records)" onClose={onClose}>
      <p className="dim" style={{ fontSize: '0.85rem', marginBottom: 12 }}>
        Enter how much each member already saved before using this app. This will be counted as their starting savings.
      </p>

      <Field label="Group start date">
        <input
          type="date"
          value={openedOn}
          max={today()}
          onChange={(e) => setOpenedOn(e.target.value)}
        />
      </Field>

      <div style={{ marginBlock: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontWeight: 650, fontSize: '0.88rem' }} className="dim">Member savings</span>
          <span style={{ fontWeight: 700, color: 'var(--mint)', fontSize: '0.95rem' }}>
            Total: {formatPaise(totalStartingPaise)}
          </span>
        </div>

        <div style={{ maxHeight: 260, overflowY: 'auto', paddingRight: 4 }}>
          {members.map((m) => (
            <div
              key={m.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 0',
                borderBottom: '1px solid var(--hairline)',
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0, flex: 1, fontWeight: 600, fontSize: '0.92rem' }}>
                {m.full_name}
              </div>
              <div style={{ width: 130 }}>
                <input
                  inputMode="decimal"
                  placeholder="0"
                  value={balances[m.id] ?? '0'}
                  onChange={(e) => {
                    const v = e.target.value;
                    setBalances((prev) => ({ ...prev, [m.id]: v }));
                  }}
                  style={{ textAlign: 'right', padding: '6px 10px', fontSize: '0.92rem' }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <Notice>
        Starting balances can only be changed before monthly deposits or loans are recorded.
      </Notice>

      <ErrorNote error={saveOpening.error || lockOpening.error} />

      <div className="btn-row stack" style={{ marginTop: 14 }}>
        <Busy className="primary lg" pending={saveOpening.pending} onClick={() => void saveOpening.run()}>
          Save Starting Balances
        </Busy>

        {!lockConfirm ? (
          <button
            type="button"
            className="lg"
            style={{ color: 'var(--amber)' }}
            onClick={() => setLockConfirm(true)}
          >
            Lock Starting Balances
          </button>
        ) : (
          <div style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 'var(--r-sm)' }}>
            <p style={{ margin: 0, fontSize: '0.85rem', marginBottom: 8, color: 'var(--text)' }}>
              Are you sure? Once locked, these starting amounts cannot be changed because all future savings and payouts are calculated from them.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Busy
                className="coral sm"
                pending={lockOpening.pending}
                onClick={() => void lockOpening.run()}
              >
                Yes, Lock Starting Balances
              </Busy>
              <button
                type="button"
                className="sm"
                onClick={() => setLockConfirm(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
