import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../context/SessionContext';
import {
  superAdmin, SuperAdminError, hasSuperAdminSession, superAdminSignIn, superAdminSignOut,
} from '../lib/superAdmin';
import { formatPaise, rupeesToPaise } from '../lib/money';
import { today, toDateString } from '../lib/dates';
import { haptic } from '../lib/haptics';
import {
  Panel, Stat, List, Row, Tag, Sheet, Field, Notice, SkeletonList,
  Segments, initials, roleLabel, fmtDate, fmtDateTime, ago,
} from '../components/ui';
import {
  IconShield, IconTrash, IconEdit, IconLock,
  IconDownload, IconWrench, IconBank, IconAudit, IconExpenses,
} from '../components/icons';
import type { Role, AuditRow } from '../lib/types';
import { RowEditor } from './admin/RowEditor';
import { TableBrowser } from './admin/TableBrowser';

interface DbGroup {
  id: string;
  name: string;
  created_at: string;
  setup_complete: boolean;
  monthly_contribution_paise: number;
}

interface DbMember {
  id: string;
  group_id: string;
  auth_user_id: string | null;
  full_name: string;
  phone: string | null;
  status: 'pending' | 'active' | 'left';
  joined_on: string;
  nominee_name: string | null;
  nominee_phone: string | null;
}

interface DbRoleAssignment {
  id: string;
  group_id: string;
  member_id: string;
  role: Role;
  start_date: string;
  end_date: string | null;
}

interface DbLoan {
  id: string;
  group_id: string;
  borrower_id: string | null;
  is_outside_borrower?: boolean;
  outside_borrower_name?: string | null;
  principal_paise: number;
  status: string;
  purpose: string | null;
  requested_at: string;
}

interface DbRepayment {
  id: string;
  loan_id: string;
  principal_paise: number;
}

interface DbContribution {
  id: string;
  group_id: string;
  member_id: string;
  period_id: string;
  amount_paise: number;
  paid_on: string;
  method: string;
}

interface DbBankStatement {
  id: string;
  group_id: string;
  as_of: string;
  closing_balance_paise: number;
  expected_balance_paise: number;
  difference_paise: number;
  note: string | null;
  uploaded_by: string;
}

interface DbExpense {
  id: string;
  group_id: string;
  category: string;
  description: string;
  amount_paise: number;
  incurred_on: string;
  method: string;
  status: string;
  created_by: string;
}

type DbAudit = AuditRow & { group_id?: string | null };

interface LoadResult {
  groups: DbGroup[];
  members: DbMember[];
  role_assignments: DbRoleAssignment[];
  loans: DbLoan[];
  loan_repayments: DbRepayment[];
  contributions: DbContribution[];
  bank_statements: DbBankStatement[];
  expenses: DbExpense[];
  audit_log: DbAudit[];
}

const EMPTY: LoadResult = {
  groups: [], members: [], role_assignments: [], loans: [], loan_repayments: [],
  contributions: [], bank_statements: [], expenses: [], audit_log: [],
};

interface IntegrityIssue {
  severity: 'danger' | 'warn' | 'good';
  title: string;
  desc: string;
  tenant?: string;
}

type Tab = 'groups' | 'members' | 'loans' | 'contributions' | 'bank' | 'expenses' | 'audit' | 'health' | 'tables' | 'backup';
type Section = 'tenants' | 'money' | 'audit' | 'data' | 'tools';
/** Any table in the server's registry (supabase/functions/superadmin). */
type Table = string;

// Nine tabs in one sideways-scrolling row put half of them off-screen on a
// phone. Four sections, each with at most four tabs, fit.
const SECTIONS: { value: Section; label: string; tabs: Tab[] }[] = [
  { value: 'tenants', label: 'Tenants', tabs: ['groups', 'members'] },
  { value: 'money', label: 'Money', tabs: ['loans', 'contributions', 'bank', 'expenses'] },
  { value: 'audit', label: 'Audit', tabs: ['audit', 'health'] },
  { value: 'data', label: 'Tables', tabs: ['tables'] },
  { value: 'tools', label: 'Backup', tabs: ['backup'] },
];

const TAB_TABLE: Partial<Record<Tab, { table: Table; label: string }>> = {
  groups: { table: 'groups', label: 'group' },
  members: { table: 'members', label: 'member' },
  loans: { table: 'loans', label: 'loan' },
  contributions: { table: 'contributions', label: 'deposit' },
  bank: { table: 'bank_statements', label: 'bank statement' },
  expenses: { table: 'expenses', label: 'expense' },
  audit: { table: 'audit_log', label: 'audit entry' },
};

// What a delete does to the books, said before it happens. These rows are
// history: nothing else in the app removes them, and every share, fund total
// and reconciliation is computed from them.
const GENERIC_CONSEQUENCE =
  'Removes the row permanently. Anything computed from it — balances, shares, votes, schedules — is restated, and rows that point at it may block the delete or be removed with it.';

const CONSEQUENCE: Record<Table, string> = {
  groups: 'Deletes the group and everything recorded in it. The database may refuse if records still point at it.',
  members: 'Removes the member row. The database refuses this if any money is recorded against them — mark them as left in the app instead.',
  loans: 'Removes the loan from the books. Outstanding totals, lending capacity and the fund all change, and every figure computed from it is restated.',
  contributions: 'Removes the deposit. The member’s savings, their share of the fund and the group total all drop by this amount. There is no reversal entry — the deposit disappears from history.',
  bank_statements: 'Removes this reconciliation point. The group will no longer have a record of what the bank said on that date.',
  expenses: 'Removes the expense. The fund goes up by this amount and the year’s spending cap is recalculated.',
  audit_log: 'Removes the audit entries permanently. The audit log is meant to be append-only — only do this for test data.',
};

// Rows whose removal restates the group's money: type to confirm, not just OK.
const TYPE_TO_CONFIRM = new Set<Table>(['groups', 'loans', 'contributions', 'bank_statements', 'expenses']);

interface PendingDelete {
  table: Table;
  ids: string[];
  label: string;
  what: string;
  /** Text the operator must type to enable the button, or null for none. */
  confirmText: string | null;
}

function shell(sub: string, body: React.ReactNode) {
  return (
    <div className="superadmin-shell">
      <header className="appbar">
        <div className="appbar-inner" style={{ maxWidth: 1120 }}>
          <span className="row-ico coral" style={{ width: 34, height: 34, borderRadius: 10, flex: 'none' }}>
            <IconShield width={16} height={16} />
          </span>
          <span className="appbar-title">
            <span className="appbar-name">Developer Super Admin</span>
            <span className="appbar-sub">{sub}</span>
          </span>
        </div>
      </header>
      <div className="superadmin-container">{body}</div>
    </div>
  );
}

function gate(title: string, text: React.ReactNode, action?: React.ReactNode) {
  return (
    <div style={{ maxWidth: 460, width: '100%', margin: '8vh auto 0' }}>
      <div className="panel" style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 14 }}>
        <span className="row-ico coral" style={{ width: 52, height: 52, borderRadius: 18 }}>
          <IconLock width={24} height={24} />
        </span>
        <h2 style={{ fontSize: '1.2rem' }}>{title}</h2>
        <div style={{ fontSize: '0.86rem', color: 'var(--text-3)', lineHeight: 1.5, width: '100%' }}>{text}</div>
        {action}
      </div>
    </div>
  );
}

function trash(onClick: () => void, label: string) {
  return (
    <button
      type="button"
      className="icon-btn"
      title={`Delete ${label}`}
      aria-label={`Delete ${label}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{ width: 30, height: 30, color: 'var(--coral)' }}
    >
      <IconTrash width={12} height={12} />
    </button>
  );
}

type Access =
  | { state: 'checking' }
  | { state: 'locked'; error: string | null }
  | { state: 'unreachable'; message: string }
  | { state: 'ok'; email: string | null };

export default function Admin() {
  const nav = useNavigate();
  // The console has its own sign-in, separate from the app's (see
  // lib/superAdmin.ts). If the developer also happens to be signed in to the
  // app as a member, "Open group" can use that; otherwise it says why not.
  const { switchGroup, groups: userGroups } = useSession();

  // ---------------------------------------------------------------- access
  // Decided by the server on every call; this is only what to render.
  const [access, setAccess] = useState<Access>({ state: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const [login, setLogin] = useState({ email: '', password: '' });
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!(await hasSuperAdminSession())) {
        if (!cancelled) setAccess((a) => (a.state === 'locked' ? a : { state: 'locked', error: null }));
        return;
      }
      setAccess({ state: 'checking' });
      try {
        const r = await superAdmin<{ email: string | null }>('whoami');
        if (!cancelled) setAccess({ state: 'ok', email: r.email });
      } catch (e) {
        if (cancelled) return;
        const status = e instanceof SuperAdminError ? e.status : 0;
        // 401/403 is the server's verdict on this login: sign it out of the
        // console so the form comes back. Anything else means no verdict was
        // reached, so keep the session and offer a retry.
        if (status === 401 || status === 403) {
          await superAdminSignOut();
          setAccess({ state: 'locked', error: (e as Error).message });
        } else {
          setAccess({ state: 'unreachable', message: (e as Error).message });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [attempt]);

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!login.email.trim() || !login.password) return;
    haptic(10);
    setSigningIn(true);
    try {
      await superAdminSignIn(login.email, login.password);
      setLogin({ email: login.email, password: '' });
      setAttempt((n) => n + 1);
    } catch (err) {
      setAccess({ state: 'locked', error: (err as Error).message });
    } finally {
      setSigningIn(false);
    }
  };

  const lock = async () => {
    await superAdminSignOut();
    setData(EMPTY);
    setLoaded(false);
    setAccess({ state: 'locked', error: null });
  };

  // ------------------------------------------------------------------ data
  const [data, setData] = useState<LoadResult>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setActionError(null);
    try {
      const r = await superAdmin<LoadResult>('load');
      setData({ ...EMPTY, ...r });
      setLoaded(true);
    } catch (e) {
      setActionError((e as Error).message || 'Could not load the database.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (access.state === 'ok') void refreshAll();
  }, [access.state, refreshAll]);

  // A success message that never leaves stops being read. Errors stay until
  // dismissed: they may need copying.
  useEffect(() => {
    if (!actionSuccess) return;
    const t = setTimeout(() => setActionSuccess(null), 5000);
    return () => clearTimeout(t);
  }, [actionSuccess]);

  const { groups, members, role_assignments: roles, loans, loan_repayments: repayments,
    contributions, bank_statements: bankStatements, expenses, audit_log: auditRows } = data;

  // ------------------------------------------------------------ navigation
  const [section, setSection] = useState<Section>('tenants');
  const [tab, setTab] = useState<Tab>('groups');
  const [search, setSearch] = useState('');
  const [filterGroupId, setFilterGroupId] = useState<string>('all');

  // ------------------------------------------------------------- sheets
  const [editGroup, setEditGroup] = useState<DbGroup | null>(null);
  const [editMember, setEditMember] = useState<DbMember | null>(null);
  const [isNewGroup, setIsNewGroup] = useState(false);
  const [isNewMember, setIsNewMember] = useState(false);
  const [roleMember, setRoleMember] = useState<DbMember | null>(null);
  const [selectedRole, setSelectedRole] = useState<Role>('member');
  const [selectedAudit, setSelectedAudit] = useState<DbAudit | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [typed, setTyped] = useState('');
  // One editor for every table: the row as the database holds it, all of its
  // columns, rather than the five fields a bespoke form happened to include.
  const [editing, setEditing] = useState<{ table: string; pk: string; edit: boolean; row: Record<string, unknown> } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [groupForm, setGroupForm] = useState({ name: '', monthly_rupees: '1000' });
  const [memberForm, setMemberForm] = useState({
    group_id: '', full_name: '', phone: '', nominee_name: '', nominee_phone: '',
  });

  // ---------------------------------------------------------- lookups
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, m.full_name])), [members]);
  const memberCountByGroup = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of members) if (m.status === 'active') map.set(m.group_id, (map.get(m.group_id) ?? 0) + 1);
    return map;
  }, [members]);
  const activeRolesMap = useMemo(() => {
    const map = new Map<string, Role>();
    roles.forEach((r) => map.set(`${r.group_id}:${r.member_id}`, r.role));
    return map;
  }, [roles]);
  const myGroupIds = useMemo(() => new Set(userGroups.map((g) => g.id)), [userGroups]);

  // Turns an id column into the name it points at, for the editor and the
  // Tables browser. An id alone says nothing to the person fixing the row.
  const describe = useCallback((col: string, value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    if (col === 'group_id' || col === 'last_group_id') return groupMap.get(value);
    if (/(^|_)(member|borrower|guarantor|voter|recorded_by|created_by|proposed_by|uploaded_by|confirmed_by)(_id)?$/.test(col)) {
      return memberMap.get(value);
    }
    if (col === 'loan_id') {
      const l = loans.find((x) => x.id === value);
      return l ? `loan to ${(l.borrower_id && memberMap.get(l.borrower_id)) || l.outside_borrower_name || 'someone'}` : undefined;
    }
    return undefined;
  }, [groupMap, memberMap, loans]);

  const openEditor = (table: string, row: object, edit = true) => {
    haptic(10);
    setEditing({ table, pk: table === 'group_invites' ? 'code' : 'id', edit, row: row as Record<string, unknown> });
  };

  // Edit and delete, side by side, at the end of a list row.
  const rowActions = (table: string, row: { id: string }, label: string, onDelete: () => void) => (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      <button
        type="button"
        className="icon-btn"
        title={`Edit ${label}`}
        aria-label={`Edit ${label}`}
        onClick={(e) => { e.stopPropagation(); openEditor(table, row); }}
        style={{ width: 30, height: 30 }}
      >
        <IconEdit width={12} height={12} />
      </button>
      {trash(onDelete, label)}
    </span>
  );

  const borrowerName = useCallback(
    (l: DbLoan) => (l.borrower_id ? memberMap.get(l.borrower_id) : null)
      ?? l.outside_borrower_name ?? 'Unknown borrower',
    [memberMap],
  );

  // What is still owed on each loan, from the repayments actually recorded.
  // The principal lent is not what is out: a half-repaid loan is half out.
  const repaidByLoan = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of repayments) map.set(r.loan_id, (map.get(r.loan_id) ?? 0) + (r.principal_paise || 0));
    return map;
  }, [repayments]);
  const runningLoans = useMemo(() => loans.filter((l) => l.status === 'disbursed'), [loans]);
  const outstandingPaise = useMemo(
    () => runningLoans.reduce((s, l) => s + Math.max(0, l.principal_paise - (repaidByLoan.get(l.id) ?? 0)), 0),
    [runningLoans, repaidByLoan],
  );
  const totalContributionsPaise = useMemo(
    () => contributions.reduce((acc, c) => acc + (c.amount_paise || 0), 0),
    [contributions],
  );

  // ------------------------------------------------------------- filtering
  const q = search.trim().toLowerCase();
  const inGroup = useCallback(
    (groupId: string | null | undefined) => filterGroupId === 'all' || groupId === filterGroupId,
    [filterGroupId],
  );
  const has = useCallback(
    (...fields: (string | null | undefined)[]) => !q || fields.some((f) => f && f.toLowerCase().includes(q)),
    [q],
  );

  const filteredGroups = useMemo(
    () => groups.filter((g) => inGroup(g.id) && has(g.name, g.id)),
    [groups, inGroup, has],
  );
  const filteredMembers = useMemo(
    () => members.filter((m) => inGroup(m.group_id)
      && has(m.full_name, m.phone, m.id, groupMap.get(m.group_id), m.status)),
    [members, inGroup, has, groupMap],
  );
  const filteredLoans = useMemo(
    () => loans.filter((l) => inGroup(l.group_id)
      && has(borrowerName(l), l.purpose, l.status, groupMap.get(l.group_id), l.id)),
    [loans, inGroup, has, borrowerName, groupMap],
  );
  const filteredContributions = useMemo(
    () => contributions.filter((c) => inGroup(c.group_id)
      && has(memberMap.get(c.member_id), c.method, groupMap.get(c.group_id), c.id)),
    [contributions, inGroup, has, memberMap, groupMap],
  );
  const filteredBankStatements = useMemo(
    () => bankStatements.filter((b) => inGroup(b.group_id) && has(groupMap.get(b.group_id), b.note, b.as_of)),
    [bankStatements, inGroup, has, groupMap],
  );
  const filteredExpenses = useMemo(
    () => expenses.filter((e) => inGroup(e.group_id)
      && has(e.description, e.category, e.status, groupMap.get(e.group_id))),
    [expenses, inGroup, has, groupMap],
  );
  const filteredAuditRows = useMemo(
    () => auditRows.filter((a) => inGroup(a.group_id) && has(a.table_name, a.action, String(a.row_id))),
    [auditRows, inGroup, has],
  );

  const visibleIds = useMemo(() => {
    const pick: Record<Tab, { id: string | number }[]> = {
      groups: filteredGroups, members: filteredMembers, loans: filteredLoans,
      contributions: filteredContributions, bank: filteredBankStatements,
      expenses: filteredExpenses, audit: filteredAuditRows, health: [], tables: [], backup: [],
    };
    return pick[tab].map((x) => String(x.id));
  }, [tab, filteredGroups, filteredMembers, filteredLoans, filteredContributions,
    filteredBankStatements, filteredExpenses, filteredAuditRows]);

  // ------------------------------------------------------------- selection
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Anything that changes what is on screen clears the selection. Keeping it
  // across a search meant "Delete (4)" could remove three rows that were no
  // longer visible.
  useEffect(() => {
    setSelectedIds([]);
  }, [tab, filterGroupId, search]);

  // And bulk delete only ever acts on rows that are both selected AND shown.
  const selectedVisible = useMemo(
    () => selectedIds.filter((id) => visibleIds.includes(id)),
    [selectedIds, visibleIds],
  );

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const toggleSelectAll = () => setSelectedIds(allSelected ? [] : visibleIds);

  // ---------------------------------------------------------------- deletes
  const askDelete = (table: Table, ids: string[], label: string, what: string, confirmName?: string) => {
    haptic(15);
    setTyped('');
    // Tables without a written consequence are the ones this screen knows
    // least about: type to confirm, the safe default.
    const needsTyping = TYPE_TO_CONFIRM.has(table) || !(table in CONSEQUENCE) || ids.length > 1;
    setPendingDelete({
      table, ids, label, what,
      confirmText: needsTyping ? (table === 'groups' && confirmName ? confirmName : 'DELETE') : null,
    });
  };

  const runDelete = async () => {
    if (!pendingDelete) return;
    const { table, ids, label } = pendingDelete;
    haptic(30);
    setBusy(true);
    setActionError(null);
    try {
      const r = await superAdmin<{ deleted: number }>('delete', { table, ids });
      // Report what the database did, not what was asked for.
      setActionSuccess(
        r.deleted === ids.length
          ? `Deleted ${r.deleted} ${label}${r.deleted === 1 ? '' : 's'}.`
          : `Deleted ${r.deleted} of ${ids.length} ${label}s — the rest were already gone.`,
      );
      setSelectedIds([]);
      setPendingDelete(null);
      setEditing(null);
      setReloadKey((n) => n + 1);
      await refreshAll();
    } catch (e) {
      setActionError((e as Error).message || `Could not delete the ${label}.`);
      setPendingDelete(null);
    } finally {
      setBusy(false);
    }
  };

  // ------------------------------------------------------------ other writes
  const handleSaveGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    haptic(10);
    setBusy(true);
    setActionError(null);
    try {
      await superAdmin('save_group', {
        id: isNewGroup ? undefined : editGroup?.id,
        name: groupForm.name,
        monthly_contribution_paise: rupeesToPaise(groupForm.monthly_rupees),
      });
      setActionSuccess(`Group "${groupForm.name.trim()}" ${isNewGroup ? 'created' : 'updated'}.`);
      setEditGroup(null);
      setIsNewGroup(false);
      await refreshAll();
    } catch (err) {
      setActionError((err as Error).message || 'Could not save the group.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveMember = async (e: React.FormEvent) => {
    e.preventDefault();
    haptic(10);
    setBusy(true);
    setActionError(null);
    try {
      await superAdmin('save_member', {
        id: isNewMember ? undefined : editMember?.id,
        ...memberForm,
      });
      setActionSuccess(`Member "${memberForm.full_name.trim()}" ${isNewMember ? 'created' : 'updated'}.`);
      setEditMember(null);
      setIsNewMember(false);
      await refreshAll();
    } catch (err) {
      setActionError((err as Error).message || 'Could not save the member.');
    } finally {
      setBusy(false);
    }
  };

  // One RPC, one transaction (0043). The date is the operator's LOCAL day:
  // toISOString() would record yesterday between 00:00 and 05:29 IST.
  const handleAssignRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roleMember) return;
    haptic(10);
    setBusy(true);
    setActionError(null);
    try {
      await superAdmin('assign_role', {
        group_id: roleMember.group_id,
        member_id: roleMember.id,
        role: selectedRole,
        on: today(),
      });
      setActionSuccess(`${roleMember.full_name} is now ${roleLabel(selectedRole)}.`);
      setRoleMember(null);
      await refreshAll();
    } catch (err) {
      setActionError((err as Error).message || 'Could not change the role.');
    } finally {
      setBusy(false);
    }
  };

  const handleSwitchToGroup = async (groupId: string) => {
    haptic(10);
    setActionError(null);
    try {
      await switchGroup(groupId);
      nav('/');
    } catch (err) {
      setActionError((err as Error).message || 'Could not open the group.');
    }
  };

  const handleExportBackup = async () => {
    haptic(10);
    setBusy(true);
    setActionError(null);
    try {
      const dump = await superAdmin<{ exported_at: string; tables: Record<string, unknown[]> }>('backup');
      const rows = Object.values(dump.tables).reduce((s, t) => s + t.length, 0);
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `savingsclub-backup-${toDateString()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setActionSuccess(`Backup downloaded: ${Object.keys(dump.tables).length} tables, ${rows} rows.`);
    } catch (err) {
      setActionError((err as Error).message || 'Could not build the backup.');
    } finally {
      setBusy(false);
    }
  };

  // ------------------------------------------------------------ health audit
  // Derived from the data, not stored: it used to run once and then describe
  // a database that had since changed.
  const healthIssues = useMemo<IntegrityIssue[]>(() => {
    const issues: IntegrityIssue[] = [];
    const memberIds = new Set(members.map((m) => m.id));

    for (const g of groups) {
      const gRoles = roles.filter((r) => r.group_id === g.id);
      const cashier = gRoles.find((r) => r.role === 'cashier');
      const accountant = gRoles.find((r) => r.role === 'accountant');
      if (!gRoles.some((r) => r.role === 'admin')) {
        issues.push({ severity: 'danger', title: 'No admin', tenant: g.name,
          desc: 'Nobody holds the admin office. Assign one under Members.' });
      }
      if (!cashier) {
        issues.push({ severity: 'warn', title: 'No cashier', tenant: g.name,
          desc: 'Contributions, repayments and loans cannot be recorded until one is assigned.' });
      }
      if (!accountant) {
        issues.push({ severity: 'warn', title: 'No accountant', tenant: g.name,
          desc: 'Bank reconciliation cannot be recorded until one is assigned.' });
      }
      if (cashier && accountant && cashier.member_id === accountant.member_id) {
        issues.push({ severity: 'danger', title: 'Cashier and accountant are the same person', tenant: g.name,
          desc: `${memberMap.get(cashier.member_id) ?? 'One member'} holds both offices.` });
      }
      const latestBank = bankStatements
        .filter((b) => b.group_id === g.id)
        .reduce<DbBankStatement | undefined>((latest, b) => (!latest || b.as_of > latest.as_of ? b : latest), undefined);
      if (latestBank && latestBank.difference_paise !== 0) {
        issues.push({ severity: 'warn', title: 'Bank does not match the books', tenant: g.name,
          desc: `Statement of ${fmtDate(latestBank.as_of)} is off by ${formatPaise(latestBank.difference_paise)}.` });
      }
      const waiting = members.filter((m) => m.group_id === g.id && m.status === 'pending').length;
      if (waiting) {
        issues.push({ severity: 'warn', title: `${waiting} waiting for approval`, tenant: g.name,
          desc: 'Joined with an invite code and cannot see anything until an officer approves them.' });
      }
    }

    const orphan = (what: string, n: number) => {
      if (n) issues.push({ severity: 'danger', title: `${n} orphan ${what}`,
        desc: `${what[0].toUpperCase()}${what.slice(1)} that point at a group or member that no longer exists.` });
    };
    orphan('members', members.filter((m) => !groupMap.has(m.group_id)).length);
    orphan('loans', loans.filter((l) => !groupMap.has(l.group_id)
      || (l.borrower_id !== null && !memberIds.has(l.borrower_id))).length);
    orphan('deposits', contributions.filter((c) => !groupMap.has(c.group_id) || !memberIds.has(c.member_id)).length);

    if (issues.length === 0) {
      issues.push({ severity: 'good', title: 'Everything checks out',
        desc: 'Every group has its offices filled, the latest bank statements balance, and no record is orphaned.' });
    }
    return issues;
  }, [groups, members, roles, loans, contributions, bankStatements, groupMap, memberMap]);

  // ================================================================ render
  if (access.state !== 'ok') {
    if (access.state === 'checking') {
      return shell('Checking access', <SkeletonList rows={3} />);
    }
    if (access.state === 'unreachable') {
      return shell('Console unavailable', gate(
        'Cannot reach the console',
        <>
          <p style={{ margin: 0 }}>{access.message}</p>
          <p style={{ margin: '10px 0 0' }}>
            This says nothing about whether your login has access — that is checked once the
            function answers.
          </p>
        </>,
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
          <button type="button" className="primary lg" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
          <button type="button" onClick={() => void lock()}>Sign out</button>
        </div>,
      ));
    }
    return shell('Sign in', gate(
      'Super admin sign-in',
      <>
        <p style={{ margin: 0 }}>
          A developer login, separate from the app — it does not sign you in to any group. Checked on the
          server on every request, and forgotten when this tab closes.
        </p>
        {access.error && (
          <div style={{ marginTop: 12, textAlign: 'left' }}><Notice tone="danger">{access.error}</Notice></div>
        )}
      </>,
      <form onSubmit={(e) => void signIn(e)} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          type="email"
          placeholder="Email"
          aria-label="Email"
          value={login.email}
          onChange={(e) => setLogin({ ...login, email: e.target.value })}
          autoFocus
          autoComplete="username"
          required
        />
        <input
          type="password"
          placeholder="Password"
          aria-label="Password"
          value={login.password}
          onChange={(e) => setLogin({ ...login, password: e.target.value })}
          autoComplete="current-password"
          required
        />
        <button type="submit" className="primary lg" disabled={signingIn || !login.email.trim() || !login.password}>
          {signingIn ? 'Signing in…' : 'Sign in'}
        </button>
      </form>,
    ));
  }

  const sectionTabs = SECTIONS.find((s) => s.value === section)!.tabs;
  const tabCounts: Record<Tab, number | undefined> = {
    groups: filteredGroups.length, members: filteredMembers.length, loans: filteredLoans.length,
    contributions: filteredContributions.length, bank: filteredBankStatements.length,
    expenses: filteredExpenses.length, audit: filteredAuditRows.length,
    health: healthIssues.filter((i) => i.severity !== 'good').length || undefined, tables: undefined, backup: undefined,
  };
  const tabLabels: Record<Tab, string> = {
    groups: 'Groups', members: 'Members', loans: 'Loans', contributions: 'Deposits',
    bank: 'Bank', expenses: 'Expenses', audit: 'Audit log', health: 'Health', tables: 'All tables', backup: 'JSON backup',
  };
  const tableInfo = TAB_TABLE[tab];
  const showList = loaded;

  const checkbox = (id: string, label: string) => (
    <input
      type="checkbox"
      className="superadmin-checkbox"
      checked={selectedIds.includes(id)}
      onChange={() => toggleSelect(id)}
      onClick={(e) => e.stopPropagation()}
      aria-label={`Select ${label}`}
    />
  );
  const empty = (icon: React.ReactNode, title: string) => (
    <div className="empty" style={{ padding: '32px 16px' }}>
      <div className="empty-ico" style={{ width: 44, height: 44 }}>{icon}</div>
      <div style={{ fontWeight: 600, color: 'var(--text-2)' }}>{title}</div>
      <div style={{ fontSize: '0.82rem', color: 'var(--text-3)', marginTop: 4 }}>
        {q || filterGroupId !== 'all' ? 'Nothing matches the current search or group filter.' : 'Nothing recorded yet.'}
      </div>
    </div>
  );

  return shell(access.email ? `Signed in as ${access.email}` : 'Unrestricted multi-tenant console', (
    <>
      {/* STATUS */}
      <div
        className="panel"
        style={{
          background: 'linear-gradient(135deg, color-mix(in srgb, var(--coral) 15%, var(--surface)), var(--surface))',
          border: '1px solid color-mix(in srgb, var(--coral) 30%, var(--hairline))',
          padding: 16, display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <Tag tone="mint">Server-checked access</Tag>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-3)' }}>RLS bypassed</span>
          </div>
          <button type="button" className="sec-link" onClick={() => void lock()} style={{ fontSize: '0.78rem', color: 'var(--coral)' }}>
            <IconLock width={12} height={12} style={{ marginRight: 4 }} />
            Sign out
          </button>
        </div>

        <div className="stats four">
          <Stat k="Groups" v={groups.length} s="all tenants" tone="mint" />
          <Stat k="Members" v={members.filter((m) => m.status === 'active').length}
            s={`active · ${members.length} total`} tone="mint" />
          <Stat k="Loans running" v={runningLoans.length} s={`${formatPaise(outstandingPaise)} still owed`} tone="amber" />
          <Stat k="Total deposited" v={formatPaise(totalContributionsPaise)} s={`${contributions.length} deposits`} tone="mint" />
        </div>
      </div>

      {actionError && (
        <Notice tone="danger" onClick={() => setActionError(null)}>
          {actionError} <span className="dim">· tap to dismiss</span>
        </Notice>
      )}
      {actionSuccess && <Notice tone="good">{actionSuccess}</Notice>}

      {/* TABS & CONTROLS */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Segments
          value={section}
          options={SECTIONS.map((s) => ({ value: s.value, label: s.label }))}
          onChange={(s) => {
            haptic(10);
            setSection(s);
            setTab(SECTIONS.find((x) => x.value === s)!.tabs[0]);
          }}
        />
        {sectionTabs.length > 1 && (
          <Segments
            value={tab}
            options={sectionTabs.map((t) => ({ value: t, label: tabLabels[t], count: tabCounts[t] }))}
            onChange={(t) => { haptic(10); setTab(t); }}
          />
        )}

        {tab !== 'health' && tab !== 'backup' && (
          <div
            className="superadmin-controls"
            style={{
              display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
              background: 'var(--surface)', padding: 10, borderRadius: 'var(--r)', border: '1px solid var(--hairline)',
            }}
          >
            <select
              value={filterGroupId}
              onChange={(e) => setFilterGroupId(e.target.value)}
              aria-label="Filter by group"
              style={{ minWidth: 160, width: 'auto', flex: 'none', border: '1px solid var(--hairline)' }}
            >
              <option value="all">All groups ({groups.length})</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <input
              type="search"
              className="sa-search"
              placeholder="Search"
              aria-label="Search records"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: 160, border: '1px solid var(--hairline)' }}
            />
            <button type="button" className="sa-refresh" onClick={() => void refreshAll()} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        )}

        {tableInfo && showList && visibleIds.length > 0 && (
          <div className={`sa-bulkbar${selectedVisible.length > 0 ? ' active' : ''}`}>
            <label>
              <input
                type="checkbox"
                className="superadmin-checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                aria-label={allSelected ? 'Deselect all' : 'Select all'}
              />
              <span>
                {selectedVisible.length > 0
                  ? `${selectedVisible.length} of ${visibleIds.length} selected`
                  : `Select all (${visibleIds.length})`}
              </span>
            </label>
            {selectedVisible.length > 0 && (
              <div className="sa-bulk-actions">
                <button type="button" className="sec-link" onClick={() => setSelectedIds([])}>Clear</button>
                <button
                  type="button"
                  className="btn-danger-outline"
                  disabled={busy}
                  onClick={() => askDelete(
                    tableInfo.table, selectedVisible, tableInfo.label,
                    `${selectedVisible.length} ${tableInfo.label}${selectedVisible.length === 1 ? '' : 's'}`,
                  )}
                >
                  <IconTrash width={13} height={13} style={{ marginRight: 6 }} />
                  Delete ({selectedVisible.length})
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* The first load shows a skeleton, not empty lists: "no deposits"
          and "not loaded yet" must not look the same. */}
      {!showList && tab !== 'backup' && <SkeletonList rows={4} />}

      {/* GROUPS */}
      {showList && tab === 'groups' && (
        <Panel
          title={`Groups (${filteredGroups.length})`}
          action={
            <button
              type="button"
              className="primary"
              onClick={() => {
                setGroupForm({ name: '', monthly_rupees: '1000' });
                setIsNewGroup(true);
                setEditGroup({} as DbGroup);
              }}
              style={{ fontSize: '0.78rem', padding: '5px 12px' }}
            >
              + Create Group
            </button>
          }
        >
          {filteredGroups.length === 0 ? empty(<IconShield width={20} height={20} />, 'No groups') : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filteredGroups.map((g) => {
                const isChecked = selectedIds.includes(g.id);
                const canEnter = myGroupIds.has(g.id);
                return (
                  <div
                    key={g.id}
                    className="superadmin-group-card"
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14,
                      padding: '12px 14px', borderRadius: 'var(--r-sm)',
                      background: isChecked ? 'color-mix(in srgb, var(--coral) 8%, var(--surface))' : 'var(--surface)',
                      border: isChecked ? '1px solid color-mix(in srgb, var(--coral) 40%, transparent)' : '1px solid var(--hairline)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none', marginTop: 2 }}>
                        {checkbox(g.id, g.name)}
                        <span className="row-ico violet" style={{ flex: 'none' }}>{initials(g.name)}</span>
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: '0.96rem', color: 'var(--text)' }}>{g.name}</strong>
                          <Tag tone={g.setup_complete ? 'mint' : 'amber'}>{g.setup_complete ? 'Set up' : 'Setup pending'}</Tag>
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-3)', marginTop: 3, overflowWrap: 'anywhere' }}>
                          {memberCountByGroup.get(g.id) ?? 0} active members · {formatPaise(g.monthly_contribution_paise || 0)}/month · <code>{g.id.slice(0, 8)}</code>
                        </div>
                      </div>
                    </div>

                    <div className="group-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
                      {/* Opening a group's dashboard needs a membership of
                          your own; say so up front instead of after a tap. */}
                      <button
                        type="button"
                        className="sec-link"
                        disabled={!canEnter}
                        title={canEnter ? 'Open this group in the app' : 'Your account is not a member of this group'}
                        onClick={() => void handleSwitchToGroup(g.id)}
                        style={{ fontSize: '0.78rem', color: canEnter ? 'var(--mint)' : 'var(--text-3)', whiteSpace: 'nowrap' }}
                      >
                        {canEnter ? 'Open group →' : 'Not your group'}
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Edit group"
                        aria-label={`Edit ${g.name}`}
                        onClick={() => openEditor('groups', g)}
                        style={{ width: 32, height: 32 }}
                      >
                        <IconEdit width={13} height={13} />
                      </button>
                      {trash(() => askDelete('groups', [g.id], 'group', `the group "${g.name}"`, g.name), g.name)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      )}

      {/* MEMBERS */}
      {showList && tab === 'members' && (
        <Panel
          title={`Members (${filteredMembers.length})`}
          action={
            <button
              type="button"
              className="primary"
              disabled={groups.length === 0}
              onClick={() => {
                setMemberForm({
                  group_id: filterGroupId !== 'all' ? filterGroupId : groups[0]?.id || '',
                  full_name: '', phone: '', nominee_name: '', nominee_phone: '',
                });
                setIsNewMember(true);
                setEditMember({} as DbMember);
              }}
              style={{ fontSize: '0.78rem', padding: '5px 12px' }}
            >
              + Create Member
            </button>
          }
        >
          {filteredMembers.length === 0 ? empty(<IconShield width={20} height={20} />, 'No members') : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filteredMembers.map((m) => {
                const currentRole = activeRolesMap.get(`${m.group_id}:${m.id}`) || 'member';
                const isChecked = selectedIds.includes(m.id);
                return (
                  <div
                    key={m.id}
                    className="superadmin-group-card"
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14,
                      padding: '12px 14px', borderRadius: 'var(--r-sm)',
                      background: isChecked ? 'color-mix(in srgb, var(--coral) 8%, var(--surface))' : 'var(--surface)',
                      border: isChecked ? '1px solid color-mix(in srgb, var(--coral) 40%, transparent)' : '1px solid var(--hairline)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none', marginTop: 2 }}>
                        {checkbox(m.id, m.full_name)}
                        <span className="row-ico mint" style={{ flex: 'none' }}>{initials(m.full_name)}</span>
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: '0.96rem', color: 'var(--text)' }}>{m.full_name}</strong>
                          <Tag tone={currentRole === 'member' ? undefined : 'mint'}>{roleLabel(currentRole)}</Tag>
                          {m.status !== 'active' && (
                            <Tag tone={m.status === 'pending' ? 'amber' : 'coral'}>{m.status === 'pending' ? 'Pending' : 'Left'}</Tag>
                          )}
                          <Tag tone="violet">{groupMap.get(m.group_id) || 'Unknown group'}</Tag>
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-3)', marginTop: 4, overflowWrap: 'anywhere' }}>
                          {m.phone || 'No phone'} · joined {fmtDate(m.joined_on)} · <code>{m.id.slice(0, 8)}</code>
                        </div>
                      </div>
                    </div>

                    <div className="group-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
                      <button
                        type="button"
                        className="sec-link"
                        disabled={m.status !== 'active'}
                        title={m.status === 'active' ? 'Change office' : 'Only active members can hold an office'}
                        onClick={() => { setRoleMember(m); setSelectedRole(currentRole); }}
                        style={{ fontSize: '0.78rem', color: m.status === 'active' ? 'var(--violet)' : 'var(--text-3)', whiteSpace: 'nowrap' }}
                      >
                        Assign role
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Edit member"
                        aria-label={`Edit ${m.full_name}`}
                        onClick={() => openEditor('members', m)}
                        style={{ width: 32, height: 32 }}
                      >
                        <IconEdit width={13} height={13} />
                      </button>
                      {trash(() => askDelete('members', [m.id], 'member', `the member "${m.full_name}"`), m.full_name)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      )}

      {/* LOANS */}
      {showList && tab === 'loans' && (
        <Panel title={`Loans (${filteredLoans.length})`} flush>
          {filteredLoans.length === 0 ? empty(<IconShield width={20} height={20} />, 'No loans') : (
            <List>
              {filteredLoans.map((l) => {
                const who = borrowerName(l);
                const left = l.status === 'disbursed'
                  ? Math.max(0, l.principal_paise - (repaidByLoan.get(l.id) ?? 0)) : null;
                return (
                  <Row
                    key={l.id}
                    icon={checkbox(l.id, `loan to ${who}`)}
                    title={
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 650 }}>{who}</span>
                        <Tag tone={l.status === 'disbursed' ? 'amber' : l.status === 'closed' ? 'mint'
                          : l.status === 'rejected' || l.status === 'written_off' ? 'coral' : 'violet'}>
                          {l.status.replace('_', ' ')}
                        </Tag>
                        {l.is_outside_borrower && <Tag>outside</Tag>}
                      </span>
                    }
                    sub={[groupMap.get(l.group_id) || 'Unknown group', l.purpose, fmtDate(l.requested_at.slice(0, 10)),
                      left !== null ? `${formatPaise(left)} still owed` : null].filter(Boolean).join(' · ')}
                    amount={formatPaise(l.principal_paise)}
                    amountTone="coral"
                    note={rowActions('loans', l, `loan to ${who}`, () => askDelete('loans', [l.id], 'loan',
                      `the ${formatPaise(l.principal_paise)} loan to ${who}`))}
                  />
                );
              })}
            </List>
          )}
        </Panel>
      )}

      {/* DEPOSITS */}
      {showList && tab === 'contributions' && (
        <Panel title={`Deposits (${filteredContributions.length})`} flush>
          {filteredContributions.length === 0 ? empty(<IconBank width={20} height={20} />, 'No deposits') : (
            <List>
              {filteredContributions.map((c) => {
                const who = memberMap.get(c.member_id) || 'Unknown member';
                return (
                  <Row
                    key={c.id}
                    icon={checkbox(c.id, `deposit by ${who}`)}
                    title={
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 650 }}>{who}</span>
                        <Tag tone="mint">{c.method}</Tag>
                      </span>
                    }
                    sub={`${groupMap.get(c.group_id) || 'Unknown group'} · ${fmtDate(c.paid_on)}`}
                    amount={formatPaise(c.amount_paise)}
                    amountTone="mint"
                    note={rowActions('contributions', c, `deposit by ${who}`, () => askDelete('contributions', [c.id], 'deposit',
                      `${who}'s ${formatPaise(c.amount_paise)} deposit of ${fmtDate(c.paid_on)}`))}
                  />
                );
              })}
            </List>
          )}
        </Panel>
      )}

      {/* BANK */}
      {showList && tab === 'bank' && (
        <Panel title={`Bank statements (${filteredBankStatements.length})`} flush>
          {filteredBankStatements.length === 0 ? empty(<IconBank width={20} height={20} />, 'No bank statements') : (
            <List>
              {filteredBankStatements.map((b) => (
                <Row
                  key={b.id}
                  icon={checkbox(b.id, `statement of ${b.as_of}`)}
                  title={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 650 }}>{groupMap.get(b.group_id) || 'Unknown group'}</span>
                      <Tag tone={b.difference_paise === 0 ? 'mint' : 'coral'}>
                        {b.difference_paise === 0 ? 'Balanced' : `Off by ${formatPaise(b.difference_paise)}`}
                      </Tag>
                    </span>
                  }
                  sub={[fmtDate(b.as_of), `Bank ${formatPaise(b.closing_balance_paise)}`,
                    `Books ${formatPaise(b.expected_balance_paise)}`, b.note].filter(Boolean).join(' · ')}
                  note={rowActions('bank_statements', b, `statement of ${b.as_of}`, () => askDelete('bank_statements', [b.id], 'bank statement',
                    `the bank statement of ${fmtDate(b.as_of)}`))}
                />
              ))}
            </List>
          )}
        </Panel>
      )}

      {/* EXPENSES */}
      {showList && tab === 'expenses' && (
        <Panel title={`Expenses (${filteredExpenses.length})`} flush>
          {filteredExpenses.length === 0 ? empty(<IconExpenses width={20} height={20} />, 'No expenses') : (
            <List>
              {filteredExpenses.map((exp) => (
                <Row
                  key={exp.id}
                  icon={checkbox(exp.id, exp.description)}
                  title={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 650 }}>{exp.description}</span>
                      <Tag tone={exp.status === 'approved' || exp.status === 'paid' ? 'mint' : exp.status === 'rejected' ? 'coral' : 'amber'}>
                        {exp.status}
                      </Tag>
                      <Tag tone="violet">{exp.category.replace('_', ' ')}</Tag>
                    </span>
                  }
                  sub={`${groupMap.get(exp.group_id) || 'Unknown group'} · ${exp.method} · ${fmtDate(exp.incurred_on)}`}
                  amount={formatPaise(exp.amount_paise)}
                  amountTone="coral"
                  note={rowActions('expenses', exp, exp.description, () => askDelete('expenses', [exp.id], 'expense',
                    `the ${formatPaise(exp.amount_paise)} expense "${exp.description}"`))}
                />
              ))}
            </List>
          )}
        </Panel>
      )}

      {/* AUDIT */}
      {showList && tab === 'audit' && (
        <Panel title={`Audit log (latest ${filteredAuditRows.length})`} flush>
          {filteredAuditRows.length === 0 ? empty(<IconAudit width={20} height={20} />, 'No audit entries') : (
            <List>
              {filteredAuditRows.map((a) => (
                <Row
                  key={a.id}
                  icon={checkbox(String(a.id), `audit entry ${a.id}`)}
                  title={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Tag tone={a.action === 'INSERT' ? 'mint' : a.action === 'DELETE' ? 'coral' : 'amber'}>{a.action}</Tag>
                      <strong style={{ fontSize: '0.92rem' }}>{a.table_name}</strong>
                      <span className="dim" style={{ fontSize: '0.78rem' }}>#{a.id}</span>
                    </span>
                  }
                  sub={[a.group_id ? groupMap.get(a.group_id) : null, fmtDateTime(a.occurred_at), ago(a.occurred_at)]
                    .filter(Boolean).join(' · ')}
                  note={
                    <button type="button" className="sec-link" onClick={() => setSelectedAudit(a)}
                      style={{ fontSize: '0.76rem', color: 'var(--mint)' }}>
                      Inspect
                    </button>
                  }
                />
              ))}
            </List>
          )}
        </Panel>
      )}

      {/* HEALTH */}
      {showList && tab === 'health' && (
        <Panel
          title="Integrity check"
          action={
            <button type="button" className="sec-link" onClick={() => void refreshAll()} disabled={loading}>
              <IconWrench width={13} height={13} style={{ marginRight: 4 }} />
              {loading ? 'Checking…' : 'Reload and re-check'}
            </button>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {healthIssues.map((issue, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12, padding: 14,
                  borderRadius: 'var(--r-sm)', border: '1px solid var(--hairline)',
                  background: `color-mix(in srgb, var(--${issue.severity === 'danger' ? 'coral' : issue.severity === 'warn' ? 'amber' : 'mint'}) 12%, var(--surface))`,
                }}
              >
                <Tag tone={issue.severity === 'good' ? 'mint' : issue.severity === 'warn' ? 'amber' : 'coral'}>
                  {issue.severity === 'good' ? 'OK' : issue.severity === 'warn' ? 'Check' : 'Fix'}
                </Tag>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, color: 'var(--text)', fontSize: '0.92rem' }}>
                    {issue.title} {issue.tenant && <span className="dim">· {issue.tenant}</span>}
                  </div>
                  <div style={{ color: 'var(--text-2)', fontSize: '0.82rem', marginTop: 3 }}>{issue.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* BACKUP */}
      {tab === 'backup' && (
        <Panel title="Full database backup">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ color: 'var(--text-2)', fontSize: '0.88rem', margin: 0 }}>
              Every table a restore would need — groups, profiles, members, roles, invites, months, deposits,
              loans with their votes, schedules and repayments, expenses and votes, cash, bank statements,
              payouts, share-outs, meetings and the full audit log — as one JSON file. Nothing is capped at
              1,000 rows.
            </p>
            <button type="button" className="primary lg" onClick={() => void handleExportBackup()} disabled={busy}>
              <IconDownload width={16} height={16} style={{ marginRight: 8 }} />
              {busy ? 'Building backup…' : 'Download JSON backup'}
            </button>
          </div>
        </Panel>
      )}

      {/* EVERY TABLE */}
      {tab === 'tables' && (
        <TableBrowser
          groupFilter={filterGroupId}
          search={search}
          reloadKey={reloadKey}
          describe={describe}
          onOpen={(t, row) => openEditor(t.name, row, t.edit)}
        />
      )}

      {/* ROW EDITOR */}
      {editing && (
        <RowEditor
          key={`${editing.table}:${String(editing.row[editing.pk])}`}
          table={editing.table}
          pk={editing.pk}
          row={editing.row}
          editable={editing.edit}
          describe={describe}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setActionSuccess(msg);
            setEditing(null);
            setReloadKey((n) => n + 1);
            void refreshAll();
          }}
          onDelete={() => askDelete(
            editing.table, [String(editing.row[editing.pk])], `${editing.table} row`,
            `this ${editing.table} row`,
            editing.table === 'groups' ? String(editing.row.name ?? '') : undefined,
          )}
        />
      )}

      {/* CONFIRM DELETE */}
      {pendingDelete && (
        <Sheet open title="Delete permanently?" onClose={() => { if (!busy) setPendingDelete(null); }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={{ margin: 0, fontSize: '0.95rem' }}>
              You are about to delete <strong>{pendingDelete.what}</strong>.
            </p>
            <Notice tone="danger">{CONSEQUENCE[pendingDelete.table] ?? GENERIC_CONSEQUENCE}</Notice>
            {pendingDelete.confirmText && (
              <Field label={`Type ${pendingDelete.confirmText} to confirm`}>
                <input
                  type="text"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            )}
            <div className="btn-row stack" style={{ marginTop: 0 }}>
              <button
                type="button"
                className="danger"
                disabled={busy || (pendingDelete.confirmText !== null && typed.trim() !== pendingDelete.confirmText)}
                onClick={() => void runDelete()}
              >
                {busy ? 'Deleting…' : `Delete ${pendingDelete.ids.length === 1 ? pendingDelete.label : `${pendingDelete.ids.length} ${pendingDelete.label}s`}`}
              </button>
              <button type="button" onClick={() => setPendingDelete(null)} disabled={busy}>Cancel</button>
            </div>
          </div>
        </Sheet>
      )}

      {/* EDIT / CREATE GROUP */}
      {editGroup && (
        <Sheet open title={isNewGroup ? 'Create group' : `Edit ${editGroup.name}`} onClose={() => setEditGroup(null)}>
          <form onSubmit={handleSaveGroup} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Group name">
              <input type="text" required value={groupForm.name}
                onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                placeholder="e.g. Friends Savings Sangam" />
            </Field>
            <Field label="Monthly contribution (₹)">
              <input type="number" required min={0} step={1} inputMode="numeric" value={groupForm.monthly_rupees}
                onChange={(e) => setGroupForm({ ...groupForm, monthly_rupees: e.target.value })} />
            </Field>
            <button type="submit" className="primary lg" disabled={busy}>
              {busy ? 'Saving…' : isNewGroup ? 'Create group' : 'Save changes'}
            </button>
          </form>
        </Sheet>
      )}

      {/* EDIT / CREATE MEMBER */}
      {editMember && (
        <Sheet open title={isNewMember ? 'Create member' : `Edit ${editMember.full_name}`} onClose={() => setEditMember(null)}>
          <form onSubmit={handleSaveMember} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Group">
              <select value={memberForm.group_id} required
                onChange={(e) => setMemberForm({ ...memberForm, group_id: e.target.value })}>
                <option value="">Select a group</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </Field>
            <Field label="Full name">
              <input type="text" required value={memberForm.full_name}
                onChange={(e) => setMemberForm({ ...memberForm, full_name: e.target.value })} />
            </Field>
            <Field label="Phone">
              <input type="tel" value={memberForm.phone} placeholder="e.g. 9876543210"
                onChange={(e) => setMemberForm({ ...memberForm, phone: e.target.value })} />
            </Field>
            <Field label="Nominee name">
              <input type="text" value={memberForm.nominee_name}
                onChange={(e) => setMemberForm({ ...memberForm, nominee_name: e.target.value })} />
            </Field>
            <Field label="Nominee phone">
              <input type="tel" value={memberForm.nominee_phone}
                onChange={(e) => setMemberForm({ ...memberForm, nominee_phone: e.target.value })} />
            </Field>
            <button type="submit" className="primary lg" disabled={busy}>
              {busy ? 'Saving…' : isNewMember ? 'Create member' : 'Save changes'}
            </button>
          </form>
        </Sheet>
      )}

      {/* ROLE */}
      {roleMember && (
        <Sheet open title={`Office for ${roleMember.full_name}`} onClose={() => setRoleMember(null)}>
          <form onSubmit={handleAssignRole} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Notice tone="good">
              Group: <strong>{groupMap.get(roleMember.group_id)}</strong>. Whoever holds the chosen office now
              hands it over today, in the same step. The admin office cannot be left empty.
            </Notice>
            <Field label="Office">
              <select value={selectedRole} onChange={(e) => setSelectedRole(e.target.value as Role)}>
                <option value="member">Member (no office)</option>
                <option value="admin">Admin</option>
                <option value="cashier">Cashier</option>
                <option value="accountant">Accountant</option>
              </select>
            </Field>
            <button type="submit" className="primary lg" disabled={busy}>
              {busy ? 'Saving…' : 'Save office'}
            </button>
          </form>
        </Sheet>
      )}

      {/* AUDIT INSPECTOR */}
      {selectedAudit && (
        <Sheet open title={`Audit #${selectedAudit.id} · ${selectedAudit.action} ${selectedAudit.table_name}`}
          onClose={() => setSelectedAudit(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Tag tone={selectedAudit.action === 'INSERT' ? 'mint' : selectedAudit.action === 'DELETE' ? 'coral' : 'amber'}>
                {selectedAudit.action}
              </Tag>
              <span style={{ fontSize: '0.82rem', color: 'var(--text-3)' }}>
                {fmtDateTime(selectedAudit.occurred_at)} · {ago(selectedAudit.occurred_at)}
              </span>
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-2)', overflowWrap: 'anywhere' }}>
              <strong>Row:</strong> <code>{selectedAudit.row_id}</code>
            </div>
            {selectedAudit.changed_keys && selectedAudit.changed_keys.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {selectedAudit.changed_keys.map((k) => <Tag key={k} tone="violet">{k}</Tag>)}
              </div>
            )}
            {(['new_data', 'old_data'] as const).map((k) => selectedAudit[k] && (
              <div key={k}>
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-3)', marginBottom: 4 }}>
                  {k === 'new_data' ? 'After' : 'Before'}
                </div>
                <pre style={{
                  background: 'var(--surface-2)', padding: 12, borderRadius: 'var(--r-sm)',
                  border: '1px solid var(--hairline)', fontSize: '0.76rem', maxHeight: 220,
                  overflow: 'auto', margin: 0, color: k === 'new_data' ? 'var(--text)' : 'var(--text-3)',
                }}>
                  {JSON.stringify(selectedAudit[k], null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </Sheet>
      )}
    </>
  ));
}
