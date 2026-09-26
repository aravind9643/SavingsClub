import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Screen } from '../App';
import { Panel, List, Row, Notice, Tag } from '../components/ui';
import {
  IconHelp, IconDeposits, IconLoans, IconTreasury, IconMembers,
  IconCheck, IconSettings, IconAudit, IconChevronDown,
  IconMeeting, IconChevron, IconShare,
} from '../components/icons';
import { haptic } from '../lib/haptics';

interface GuideSection {
  id: string;
  category: 'basics' | 'deposits' | 'loans' | 'treasury' | 'governance' | 'faq';
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  iconTone: 'mint' | 'violet' | 'coral' | 'amber';
  badge?: string;
  steps: {
    title: string;
    description: string;
    tip?: string;
  }[];
  rules?: string[];
  action?: {
    label: string;
    to: string;
  };
}

const CATEGORIES = [
  { id: 'all', label: 'All Topics' },
  { id: 'basics', label: 'Basics & Roles' },
  { id: 'deposits', label: 'Deposits' },
  { id: 'loans', label: 'Loans' },
  { id: 'treasury', label: 'Treasury' },
  { id: 'governance', label: 'Meetings & Rules' },
  { id: 'faq', label: 'Common FAQs' },
] as const;

const GUIDES: GuideSection[] = [
  {
    id: 'group-roles',
    category: 'basics',
    title: 'The 3 Offices & Duties',
    subtitle: 'Why Cashier and Accountant must always be different people',
    icon: <IconMembers width={18} height={18} />,
    iconTone: 'violet',
    badge: 'Core Concept',
    steps: [
      {
        title: 'Admin (Governance & Rules)',
        description:
          'The group creator starts as Admin. The Admin configures rules (monthly contribution, interest rate, reserve cap), invites members, and approves membership requests. Crucially, the Admin cannot handle money alone.',
        tip: 'The Admin keeps the peace, enforces group agreements, and assigns offices to members.',
      },
      {
        title: 'Cashier (Handles Cash in Hand)',
        description:
          'The Cashier holds the physical cash float, collects cash contributions, disburses loans in cash/bank, and records cash movements into the cash ledger.',
        tip: 'Cash held is strictly limited by the group cash safety limit to prevent holding excess money.',
      },
      {
        title: 'Accountant (Verifies the Bank)',
        description:
          'The Accountant reconciles bank account statements against the app books once a month, records contributions and repayments, and ensures expected bank balances match reality to the exact rupee.',
        tip: 'Dual control: The Cashier and Accountant MUST be two distinct individuals. A database constraint strictly prevents one person from holding both offices.',
      },
    ],
    rules: [
      'Cashier holds the cash; Accountant verifies the bank.',
      'Neither office can approve loans or propose distributions single-handedly.',
      'Admin cannot step down without handing over the office to another active member.',
    ],
    action: { label: 'View Member Offices', to: '/members' },
  },
  {
    id: 'joining-inviting',
    category: 'basics',
    title: 'Inviting & Joining Members',
    subtitle: 'How to bring friends in and why invite codes alone are not enough',
    icon: <IconShare width={18} height={18} />,
    iconTone: 'mint',
    steps: [
      {
        title: 'Generate an Invite Code',
        description:
          'An officer opens Settings or Community and taps "Share Invite". This generates a 12-letter secure code valid for 7 days.',
      },
      {
        title: 'Friend Signs In & Submits Code',
        description:
          'The friend taps the link or enters the code in the app. They enter their name, phone number, and optional nominee details.',
      },
      {
        title: 'Officer Approval Required',
        description:
          'A code alone does NOT reveal the group books! When someone enters a code, they enter "Pending" state. An officer must tap "Approve" in the Members tab. This prevents leaked WhatsApp links from exposing your financial ledger.',
        tip: 'Once approved, the new member can see group totals, start contributing, and vote on loans.',
      },
    ],
    rules: [
      'One active invite code per group at a time; generating a new one invalidates the old one.',
      'Only approved active members can see balances, vote, or borrow.',
    ],
    action: { label: 'Invite Members', to: '/settings' },
  },
  {
    id: 'monthly-deposits',
    category: 'deposits',
    title: 'Monthly Deposits (Chanda / Bachat)',
    subtitle: 'Opening the month, part-payments, late fees, and WhatsApp slips',
    icon: <IconDeposits width={18} height={18} />,
    iconTone: 'mint',
    badge: 'Monthly Routine',
    steps: [
      {
        title: '1. Start the Month',
        description:
          'At the beginning of each calendar month, an officer taps "Start this month" on the Deposits screen. This creates the collection period with the configured due date and grace date.',
      },
      {
        title: '2. Members Pay by Bank, UPI or Cash',
        description:
          'Members pay their monthly contribution. The Cashier or Accountant selects the member, enters the amount paid, chooses Bank or Cash, and enters the UPI reference / cheque number.',
        tip: 'Part-payments are fully supported! If a monthly fee is ₹1,000, a member can pay ₹500 today and ₹500 next week.',
      },
      {
        title: '3. Late Fee Protection',
        description:
          'If payment arrives after the grace date, the app adds the group late fee. Important: The late fee is charged exactly once per member per period, so paying the remainder in a second instalment will never charge an extra fee.',
      },
      {
        title: '4. Instant WhatsApp Receipts & Reminders',
        description:
          'After recording, tap "Send Receipt on WhatsApp" to generate a clean, formatted receipt slip with paid amount, date, reference, and current group fund total. For unpaid members, tap their name to send a friendly reminder.',
      },
    ],
    rules: [
      'Deposits can only be recorded by the Cashier or Accountant.',
      'Closed months are frozen and cannot receive backdated entries.',
    ],
    action: { label: 'Go to Deposits', to: '/deposits' },
  },
  {
    id: 'loans-and-voting',
    category: 'loans',
    title: 'Member Loans & Group Voting',
    subtitle: 'Democratic approvals, borrowing caps, reducing interest, and repayments',
    icon: <IconLoans width={18} height={18} />,
    iconTone: 'coral',
    badge: 'Popular',
    steps: [
      {
        title: '1. Request a Loan',
        description:
          'Any active member taps "Request Loan" on the Loans tab, enters the required amount, repayment term (in months), plan (monthly instalment or end of term), and purpose.',
        tip: 'The app checks the loan against the group borrow cap (e.g. max 50% of the lendable fund) and group reserve limits.',
      },
      {
        title: '2. Democratic Group Vote',
        description:
          'The request appears for all active members. Members vote "Approve" or "Reject". Neither the borrower nor their guarantor may vote on the request.',
        tip: 'A quorum of approvals is required (typically a simple majority) before the loan is approved.',
      },
      {
        title: '3. Disbursal by Cashier or Accountant',
        description:
          'Once approved, the Cashier or Accountant disburses the money. The money leaves the fund and moves to outstanding loan principal.',
      },
      {
        title: '4. Reducing Balance Interest & Repayments',
        description:
          'Interest is simple interest computed per-day on the reducing balance over a 30-day month. When repayments arrive, interest is cleared first, then overdue penalties, then principal. Paying early saves money!',
      },
    ],
    rules: [
      'Borrowers cannot vote on their own loan requests.',
      'Total loans cannot exceed the group reserve limit (e.g. 20% must stay in the bank/cash).',
      'Overdue rates apply only to days after the due date, never retroactively.',
    ],
    action: { label: 'View Loans', to: '/loans' },
  },
  {
    id: 'outside-borrowers',
    category: 'loans',
    title: 'Outside Borrower Loans',
    subtitle: 'Lending to trusted external contacts with a member guarantor',
    icon: <IconLoans width={18} height={18} />,
    iconTone: 'amber',
    steps: [
      {
        title: '1. Select "Outside Borrower"',
        description:
          'On the New Loan screen, toggle "Lending to someone outside the group". Enter the borrower’s full name, phone number, and address.',
      },
      {
        title: '2. Active Member Guarantor',
        description:
          'Every outside loan requires an active member to stand as Guarantor. The guarantor vouches for the borrower and agrees to assist in recovery if payment is delayed.',
        tip: 'The guarantor cannot vote on this loan request to maintain fairness and impartiality.',
      },
      {
        title: '3. Group Democratic Voting',
        description:
          'The group reviews the borrower details and guarantor endorsement before voting to approve the request.',
      },
    ],
    rules: [
      'Every outside loan must have an active group member as guarantor.',
      'The guarantor is clearly identified on all loan status cards and slips.',
    ],
    action: { label: 'New Loan Request', to: '/loans/new' },
  },
  {
    id: 'treasury-bank-cash',
    category: 'treasury',
    title: 'Treasury, Bank & Cash Float',
    subtitle: 'Balancing the books, petty cash safety, and bank reconciliation',
    icon: <IconTreasury width={18} height={18} />,
    iconTone: 'violet',
    badge: 'Financial Control',
    steps: [
      {
        title: '1. Two Fund Numbers That Differ',
        description:
          'Total Fund = all contributions received + interest received - expenses paid. Expected Bank Balance = Total Fund - outstanding loan principal - physical cash float in hand.',
        tip: 'This is what should actually be sitting in your group bank account right now.',
      },
      {
        title: '2. Monthly Bank Reconciliation',
        description:
          'Once a month, the Accountant checks the bank statement and records the actual balance in the Bank tab. The app immediately compares it against the ledger. A difference of ₹0 gives a green "Balanced" badge; any mismatch is highlighted.',
      },
      {
        title: '3. Cash Float Safety Limit',
        description:
          'The Cashier holds cash for day-to-day operations up to the configured limit (e.g. ₹5,000). When cash exceeds this limit, the app alerts the Cashier to deposit the excess into the bank.',
      },
    ],
    rules: [
      'Cash movements require a recorded purpose and counterparty note.',
      'Bank reconciliation must be recorded by the Accountant to preserve independence.',
    ],
    action: { label: 'Open Treasury Hub', to: '/treasury' },
  },
  {
    id: 'expenses-and-spending',
    category: 'treasury',
    title: 'Group Expenses & Spending',
    subtitle: 'Proposing group expenses, member voting, and officer limits',
    icon: <IconTreasury width={18} height={18} />,
    iconTone: 'coral',
    steps: [
      {
        title: '1. Propose an Expense',
        description:
          'Any member or officer can propose spending money for group trips, celebrations, snacks, or stationery from the Treasury -> Expenses tab.',
      },
      {
        title: '2. Voting on Expenses',
        description:
          'Regular expenses require democratic voting from group members before funds can be disbursed.',
        tip: 'Bank charges and minor admin expenses proposed by officers can be auto-approved, provided they fall within the annual discretionary spending cap.',
      },
      {
        title: '3. Payment & Accounting',
        description:
          'Once approved, the expense is paid via Bank or Cash. The amount is deducted from the fund and recorded in the immutable audit log.',
      },
    ],
    rules: [
      'Expenses cannot exceed the group yearly discretionary limit.',
      'The proposer cannot vote on their own expense proposal.',
    ],
    action: { label: 'View Expenses', to: '/expenses' },
  },
  {
    id: 'profit-dividends',
    category: 'treasury',
    title: 'Profit Sharing & Dividends',
    subtitle: 'Distributing interest earnings back to members fairly',
    icon: <IconDeposits width={18} height={18} />,
    iconTone: 'mint',
    steps: [
      {
        title: '1. Accumulated Interest Pool',
        description:
          'As borrowers repay loans, interest accumulates in the fund. The app automatically calculates the distributable profit (total interest minus group expenses and previous payouts).',
      },
      {
        title: '2. Officer Proposes Payout',
        description:
          'An officer opens Treasury -> Profit Share, selects "Yearly profit share (Bonus)" or "Final group share-out", and enters the amount to distribute.',
        tip: 'The app automatically divides the money pro-rata based on each member’s savings balance.',
      },
      {
        title: '3. Second Officer Confirmation (Two-Man Rule)',
        description:
          'A single leader CANNOT pay out money alone. Another officer (Cashier, Accountant, or Admin) must review the calculation and tap "Approve & Pay Out".',
      },
    ],
    rules: [
      'Distribution proposals require confirmation by a different officer.',
      'Distributed amounts are paid out and recorded in member passbooks.',
    ],
    action: { label: 'Profit Share Calculator', to: '/treasury' },
  },
  {
    id: 'meetings-attendance',
    category: 'governance',
    title: 'Monthly Meetings & Attendance',
    subtitle: 'Tracking attendance and managing absence fines automatically',
    icon: <IconMeeting width={18} height={18} />,
    iconTone: 'amber',
    steps: [
      {
        title: '1. Hold the Monthly Meeting',
        description:
          'During the group gathering, an officer opens Community -> Monthly Meetings and records attendance.',
      },
      {
        title: '2. Mark Present, Absent, or Excused',
        description:
          'Each member is marked Present, Absent (unexcused), or Excused (pre-notified leave).',
      },
      {
        title: '3. Automatic Fine Application',
        description:
          'If the group has a configured meeting absence fine (e.g. ₹50), members marked unexcused absent are automatically charged. Fines flow into the group fund.',
      },
    ],
    rules: [
      'Excused members are not charged absence fines.',
      'Meeting records are timestamped and preserved in the audit log.',
    ],
    action: { label: 'Go to Meetings', to: '/community' },
  },
  {
    id: 'audit-log-security',
    category: 'governance',
    title: 'Audit Log & Data Security',
    subtitle: 'Why numbers in SavingsClub can never be tampered with',
    icon: <IconAudit width={18} height={18} />,
    iconTone: 'violet',
    badge: 'Security',
    steps: [
      {
        title: 'Immutable Append-Only Audit',
        description:
          'Every financial action (deposit, loan, repayment, cash movement, role assignment) triggers a database audit entry recording exactly who did it, what changed, and the precise timestamp.',
      },
      {
        title: 'Cannot Be Deleted or Edited',
        description:
          'Even the database administrator cannot update or delete entries in the audit table. Database triggers prevent any UPDATE or DELETE operations.',
      },
      {
        title: 'Integer Paise Mathematics',
        description:
          'Money is never stored or computed as floating-point decimals. Every amount is calculated in integer paise (₹1 = 100 paise), eliminating rounding drift or hidden gaps.',
      },
    ],
    rules: [
      'The database enforces all rules via Row Level Security (RLS) and stored procedures.',
      'A user with direct API access can do nothing the app UI would not permit.',
    ],
    action: { label: 'View Audit Log', to: '/audit' },
  },
  {
    id: 'faq-security',
    category: 'faq',
    title: 'Can anyone run away with the money?',
    subtitle: 'How the app architecture prevents fraud and embezzlement',
    icon: <IconHelp width={18} height={18} />,
    iconTone: 'mint',
    steps: [
      {
        title: 'Two-Man Rule (Dual Officer Control)',
        description:
          'The Cashier holds physical cash, while the Accountant controls and reconciles the bank statements. A database constraint ensures the Cashier and Accountant can never be the same person.',
      },
      {
        title: 'Democratic Voting for Disbursements',
        description:
          'Neither the Admin, Cashier, nor Accountant can issue a loan or pay a discretionary expense on their own. Members must vote to approve loans and expenses.',
      },
      {
        title: 'No Backdating or Erasing Entries',
        description:
          'Closed months cannot receive late entries, and the append-only audit log records every single modification permanently.',
      },
    ],
  },
  {
    id: 'faq-interest',
    category: 'faq',
    title: 'How is loan interest calculated?',
    subtitle: 'Simple reducing-balance interest explained',
    icon: <IconHelp width={18} height={18} />,
    iconTone: 'amber',
    steps: [
      {
        title: 'Reducing Balance',
        description:
          'Interest is charged ONLY on the remaining outstanding principal, not the original borrowed amount. As you repay principal, your monthly interest decreases.',
      },
      {
        title: 'Per-Day Simple Interest',
        description:
          'Interest is calculated per day over a standard 30-day month based on your group monthly rate (e.g. 2% per month = 24% annual).',
      },
      {
        title: 'Overdue Penalty Only on Late Days',
        description:
          'If a loan passes its due date, the higher overdue interest rate applies ONLY to the days after the due date — never retroactively to the whole loan term.',
      },
    ],
  },
  {
    id: 'faq-exit',
    category: 'faq',
    title: 'What happens when a member leaves?',
    subtitle: 'Member exit payouts and share settlements',
    icon: <IconHelp width={18} height={18} />,
    iconTone: 'coral',
    steps: [
      {
        title: '1. Settle Outstanding Loans First',
        description:
          'A member with an outstanding debt cannot leave the group until their loan principal and accrued interest are settled in full.',
      },
      {
        title: '2. Pro-Rata Share Calculation',
        description:
          'The app calculates the member’s net entitlement: their total contributions + accumulated interest share - any previous payouts received.',
      },
      {
        title: '3. Handing Over Offices',
        description:
          'If the leaving member is the Admin, Cashier, or Accountant, they must hand over their office to another member before leaving.',
      },
    ],
  },
];

export default function Help() {
  const nav = useNavigate();
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>('group-roles');

  const filteredGuides = useMemo(() => {
    let list = GUIDES;
    if (selectedCategory !== 'all') {
      list = list.filter((g) => g.category === selectedCategory);
    }
    const q = search.trim().toLowerCase();
    if (!q) return list;

    return list.filter((g) => {
      const matchTitle = g.title.toLowerCase().includes(q);
      const matchSubtitle = g.subtitle.toLowerCase().includes(q);
      const matchSteps = g.steps.some(
        (s) => s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
      );
      const matchRules = g.rules?.some((r) => r.toLowerCase().includes(q));
      return matchTitle || matchSubtitle || matchSteps || matchRules;
    });
  }, [selectedCategory, search]);

  const toggleExpand = (id: string) => {
    haptic(10);
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <Screen
      title="User Guide & Tutorials"
      sub="Everything you need to know about running your group"
      onBack={() => nav('/community')}
    >
      {/* Search Input */}
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search features (e.g. late fees, UPI, outside loan, cashier)..."
          style={{
            paddingLeft: 38,
            paddingRight: search ? 36 : 14,
            minHeight: 44,
            fontSize: '0.9rem',
            borderRadius: 'var(--r-sm)',
            border: '1px solid var(--hairline)',
            background: 'var(--surface)',
          }}
        />
        <span
          style={{
            position: 'absolute',
            left: 14,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--text-3)',
            pointerEvents: 'none',
            fontSize: '0.9rem',
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
              padding: '6px 10px',
              color: 'var(--text-3)',
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Category Pills */}
      <div
        className="scroller"
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 16,
          paddingBottom: 4,
          overflowX: 'auto',
          scrollbarWidth: 'none',
        }}
      >
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`seg${selectedCategory === cat.id ? ' on' : ''}`}
            onClick={() => {
              haptic(10);
              setSelectedCategory(cat.id);
            }}
            style={{
              padding: '7px 14px',
              whiteSpace: 'nowrap',
              fontSize: '0.82rem',
              fontWeight: selectedCategory === cat.id ? 700 : 500,
              borderRadius: 'var(--r-full)',
            }}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Overview Quick Banner */}
      {!search && selectedCategory === 'all' && (
        <div
          className="panel"
          style={{
            background: 'linear-gradient(145deg, var(--surface), var(--surface-2))',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--r)',
            padding: '16px 18px',
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span className="row-ico mint" style={{ width: 34, height: 34, borderRadius: 10 }}>
              <IconCheck width={16} height={16} />
            </span>
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.98rem' }}>How SavingsClub Works</div>
              <div className="dim" style={{ fontSize: '0.82rem' }}>4 simple steps for trusted savings</div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10, marginTop: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ background: 'var(--mint)', color: '#000', borderRadius: '50%', width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 800, flexShrink: 0, marginTop: 2 }}>1</span>
              <div style={{ fontSize: '0.85rem', lineHeight: 1.4 }}>
                <strong>Save Monthly:</strong> All members pay their regular chanda before the due date via UPI or Cash.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ background: 'var(--violet)', color: '#fff', borderRadius: '50%', width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 800, flexShrink: 0, marginTop: 2 }}>2</span>
              <div style={{ fontSize: '0.85rem', lineHeight: 1.4 }}>
                <strong>Borrow with Approval:</strong> Members borrow when they need funds. The group votes democrati­cally to approve.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ background: 'var(--coral)', color: '#fff', borderRadius: '50%', width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 800, flexShrink: 0, marginTop: 2 }}>3</span>
              <div style={{ fontSize: '0.85rem', lineHeight: 1.4 }}>
                <strong>Grow Interest Pool:</strong> Simple reducing-balance interest on loans is paid back into the group treasury.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ background: 'var(--amber)', color: '#000', borderRadius: '50%', width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 800, flexShrink: 0, marginTop: 2 }}>4</span>
              <div style={{ fontSize: '0.85rem', lineHeight: 1.4 }}>
                <strong>Share Profit Dividends:</strong> Accumulated interest is returned to members annually or upon group closure pro-rata.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Guide List */}
      <Panel
        title={
          selectedCategory === 'all'
            ? 'Feature Tutorials & Guides'
            : CATEGORIES.find((c) => c.id === selectedCategory)?.label
        }
        flush
      >
        {filteredGuides.length === 0 ? (
          <div style={{ padding: '30px 20px', textAlign: 'center' }}>
            <span style={{ fontSize: '2rem' }}>🔍</span>
            <p className="dim" style={{ marginTop: 8 }}>
              No guides match &quot;{search}&quot;. Try searching for &quot;deposit&quot;, &quot;loan&quot;, &quot;cashier&quot;, or &quot;interest&quot;.
            </p>
          </div>
        ) : (
          <List>
            {filteredGuides.map((guide) => {
              const isExpanded = expandedId === guide.id;
              return (
                <div
                  key={guide.id}
                  style={{
                    borderBottom: '1px solid var(--hairline)',
                    transition: 'background 0.15s ease',
                  }}
                >
                  <Row
                    icon={guide.icon}
                    iconTone={guide.iconTone}
                    title={
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>{guide.title}</span>
                        {guide.badge && <Tag tone={guide.iconTone}>{guide.badge}</Tag>}
                      </div>
                    }
                    sub={guide.subtitle}
                    onClick={() => toggleExpand(guide.id)}
                    note={
                      <span
                        style={{
                          transform: isExpanded ? 'rotate(180deg)' : 'none',
                          transition: 'transform 0.2s ease',
                          display: 'flex',
                          alignItems: 'center',
                          color: 'var(--text-3)',
                        }}
                      >
                        <IconChevronDown width={14} height={14} />
                      </span>
                    }
                  />

                  {isExpanded && (
                    <div
                      style={{
                        padding: '4px 16px 18px 52px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 14,
                        animation: 'fadeIn 0.2s ease',
                      }}
                    >
                      {/* Step by Step Breakdown */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {guide.steps.map((step, idx) => (
                          <div
                            key={idx}
                            style={{
                              background: 'var(--surface-2)',
                              padding: '12px 14px',
                              borderRadius: 'var(--r-sm)',
                              border: '1px solid var(--hairline)',
                            }}
                          >
                            <div style={{ fontWeight: 650, fontSize: '0.88rem', marginBottom: 4 }}>
                              {step.title}
                            </div>
                            <div
                              style={{
                                fontSize: '0.84rem',
                                color: 'var(--text-2)',
                                lineHeight: 1.5,
                              }}
                            >
                              {step.description}
                            </div>
                            {step.tip && (
                              <div
                                style={{
                                  marginTop: 8,
                                  fontSize: '0.8rem',
                                  color: 'var(--mint)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                }}
                              >
                                <span>💡</span>
                                <span>{step.tip}</span>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Golden Rules */}
                      {guide.rules && guide.rules.length > 0 && (
                        <div
                          style={{
                            background: 'var(--surface-sunken)',
                            padding: '10px 14px',
                            borderRadius: 'var(--r-sm)',
                            borderLeft: '3px solid var(--violet)',
                          }}
                        >
                          <div
                            style={{
                              fontSize: '0.78rem',
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                              color: 'var(--violet)',
                              marginBottom: 6,
                            }}
                          >
                            Important Rules
                          </div>
                          <ul
                            style={{
                              margin: 0,
                              paddingLeft: 18,
                              fontSize: '0.82rem',
                              color: 'var(--text-2)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 4,
                            }}
                          >
                            {guide.rules.map((rule, rIdx) => (
                              <li key={rIdx}>{rule}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Action Button */}
                      {guide.action && (
                        <div style={{ marginTop: 2 }}>
                          <button
                            type="button"
                            className="sec-link"
                            style={{
                              background: 'var(--surface)',
                              border: '1px solid var(--hairline)',
                              padding: '8px 14px',
                              borderRadius: 'var(--r-sm)',
                              fontWeight: 600,
                              fontSize: '0.84rem',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                            }}
                            onClick={() => {
                              haptic(10);
                              nav(guide.action!.to);
                            }}
                          >
                            <span>{guide.action.label}</span>
                            <IconChevron width={13} height={13} />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </List>
        )}
      </Panel>

      {/* Quick Navigation Footer */}
      <div style={{ marginTop: 20, marginBottom: 16 }}>
        <Notice>
          Need more help? Ask your group Admin or review the immutable record anytime in the Activity History.
        </Notice>
      </div>

      <div className="btn-row stack" style={{ marginBottom: 24 }}>
        <button
          type="button"
          className="subtle lg"
          onClick={() => {
            haptic(10);
            nav('/settings');
          }}
        >
          <IconSettings width={16} height={16} style={{ marginRight: 8 }} />
          Group Rules & Configuration
        </button>
      </div>
    </Screen>
  );
}
