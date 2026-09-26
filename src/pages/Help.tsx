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
    title: 'The three jobs',
    subtitle: 'Why the cashier and the accountant are never the same person',
    icon: <IconMembers width={18} height={18} />,
    iconTone: 'violet',
    badge: 'Core Concept',
    steps: [
      {
        title: 'Admin — keeps the rules',
        description:
          'The group creator starts as Admin. The Admin configures rules (monthly contribution, interest rate, reserve cap), invites members, and approves membership requests. Crucially, the Admin cannot handle money alone.',
        tip: 'The admin settles disagreements and decides who does which job.',
      },
      {
        title: 'Cashier — holds the cash',
        description:
          'The cashier holds the group’s cash, takes payments in, pays loans out, and writes down every rupee that moves.',
        tip: 'The group sets a limit on how much cash one person may hold. Anything over it goes to the bank.',
      },
      {
        title: 'Accountant — checks the bank',
        description:
          'Once a month the accountant compares the bank’s figure with the app’s. They must agree to the rupee. The accountant also records payments and loan repayments.',
        tip: 'One person must never both take the money in and keep the record of it. The app refuses to give both jobs to the same person.',
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
    title: 'Bringing people in',
    subtitle: 'Invite codes, and why a code alone is not enough',
    icon: <IconShare width={18} height={18} />,
    iconTone: 'mint',
    steps: [
      {
        title: 'Make an invite code',
        description:
          'An officer opens Settings or Community and taps "Share Invite". This generates a 12-letter secure code valid for 7 days.',
      },
      {
        title: 'They sign in and enter it',
        description:
          'The friend taps the link or enters the code in the app. They enter their name, phone number, and optional nominee details.',
      },
      {
        title: 'Someone lets them in',
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
    title: 'Paying in each month',
    subtitle: 'Starting the month, paying in parts, late fees, and receipts',
    icon: <IconDeposits width={18} height={18} />,
    iconTone: 'mint',
    badge: 'Monthly Routine',
    steps: [
      {
        title: 'Open the month',
        description:
          'At the beginning of each calendar month, an officer taps "Start this month" on the Deposits screen. This creates the collection period with the configured due date and grace date.',
      },
      {
        title: 'People pay',
        description:
          'Members pay their monthly contribution. The Cashier or Accountant selects the member, enters the amount paid, chooses Bank or Cash, and enters the UPI reference / cheque number.',
        tip: 'Part-payments are fully supported! If a monthly fee is ₹1,000, a member can pay ₹500 today and ₹500 next week.',
      },
      {
        title: 'Paying late',
        description:
          'If payment arrives after the grace date, the app adds the group late fee. Important: The late fee is charged exactly once per member per period, so paying the remainder in a second instalment will never charge an extra fee.',
      },
      {
        title: 'Receipts and reminders',
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
    title: 'Borrowing from the group',
    subtitle: 'Asking, voting, limits, interest and paying back',
    icon: <IconLoans width={18} height={18} />,
    iconTone: 'coral',
    badge: 'Popular',
    steps: [
      {
        title: 'Ask for a loan',
        description:
          'Any active member taps "Request Loan" on the Loans tab, enters the required amount, repayment term (in months), plan (monthly instalment or end of term), and purpose.',
        tip: 'One member can borrow only so much — 30% of the fund to start with, though your group can change it in Settings.',
      },
      {
        title: 'The group votes',
        description:
          'The request appears for all active members. Members vote "Approve" or "Reject". Neither the borrower nor their guarantor may vote on the request.',
        tip: 'More than half the members must say yes. The app counts the votes for you.',
      },
      {
        title: 'The money is paid out',
        description:
          'Once the group agrees, the cashier or accountant pays the money out. It is still the group’s money — it is just out on loan now.',
      },
      {
        title: 'Interest and paying back',
        description:
          'Interest is charged each day on what is still owed — so as the loan comes down, so does the interest. When someone repays, the cashier enters how much of it is the loan and how much is interest. Paying early genuinely costs less.',
      },
    ],
    rules: [
      'You cannot vote on your own loan, and neither can the person who vouched for you.',
      'Some of the fund always stays put — 25% to start with — so the group is never lent out completely.',
      'Overdue rates apply only to days after the due date, never retroactively.',
    ],
    action: { label: 'View Loans', to: '/loans' },
  },
  {
    id: 'outside-borrowers',
    category: 'loans',
    title: 'Lending to someone outside the group',
    subtitle: 'When a member vouches for someone who is not in the group',
    icon: <IconLoans width={18} height={18} />,
    iconTone: 'amber',
    steps: [
      {
        title: 'Choose someone outside the group',
        description:
          'On the New Loan screen, toggle "Lending to someone outside the group". Enter the borrower’s full name, phone number, and address.',
      },
      {
        title: 'A member vouches for them',
        description:
          'Every outside loan requires an active member to stand as Guarantor. The guarantor vouches for the borrower and agrees to assist in recovery if payment is delayed.',
        tip: 'The guarantor cannot vote on this loan request to maintain fairness and impartiality.',
      },
      {
        title: 'The group votes',
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
    title: 'The group’s money',
    subtitle: 'Where the money sits, and how the group checks it is all there',
    icon: <IconTreasury width={18} height={18} />,
    iconTone: 'violet',
    badge: 'Financial Control',
    steps: [
      {
        title: 'Two totals that are not the same',
        description:
          'What the group is worth = everything paid in, plus interest earned, minus what was spent. What should be in the bank = that, minus what is out on loan, minus the cash someone is holding.',
        tip: 'This is what should actually be sitting in your group bank account right now.',
      },
      {
        title: 'Checking the bank each month',
        description:
          'Once a month, the Accountant checks the bank statement and records the actual balance in the Bank tab. The app immediately compares it against the ledger. A difference of ₹0 gives a green "Balanced" badge; any mismatch is highlighted.',
      },
      {
        title: 'A limit on cash in hand',
        description:
          'The Cashier holds cash for day-to-day operations up to the configured limit (e.g. ₹5,000). When cash exceeds this limit, the app alerts the Cashier to deposit the excess into the bank.',
      },
    ],
    rules: [
      'Cash movements require a recorded purpose and counterparty note.',
      'The accountant records the bank check — not the cashier, so nobody checks their own work.',
    ],
    action: { label: 'Open Treasury Hub', to: '/treasury' },
  },
  {
    id: 'expenses-and-spending',
    category: 'treasury',
    title: 'Spending the group’s money',
    subtitle: 'Asking to spend, voting on it, and what officers may do alone',
    icon: <IconTreasury width={18} height={18} />,
    iconTone: 'coral',
    steps: [
      {
        title: 'Ask to spend',
        description:
          'Any member or officer can propose spending money for group trips, celebrations, snacks, or stationery from the Treasury -> Expenses tab.',
      },
      {
        title: 'The group votes',
        description:
          'Ordinary spending needs the group’s agreement before the money goes out.',
        tip: 'Bank charges and minor admin expenses proposed by officers can be auto-approved, provided they fall within the annual discretionary spending cap.',
      },
      {
        title: 'Paying and recording it',
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
    title: 'Sharing out the profit',
    subtitle: 'How the interest the group earned gets divided up',
    icon: <IconDeposits width={18} height={18} />,
    iconTone: 'mint',
    steps: [
      {
        title: 'The interest the group earned',
        description:
          'As borrowers repay loans, interest accumulates in the fund. The app automatically calculates the distributable profit (total interest minus group expenses and previous payouts).',
      },
      {
        title: 'Someone proposes the split',
        description:
          'An officer opens Treasury -> Profit Share, selects "Yearly profit share (Bonus)" or "Final group share-out", and enters the amount to distribute.',
        tip: 'The app splits it by how much each person has saved — save more, get more.',
      },
      {
        title: 'A second person agrees it',
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
    title: 'Meetings and who came',
    subtitle: 'Recording who was there, and fines for missing it',
    icon: <IconMeeting width={18} height={18} />,
    iconTone: 'amber',
    steps: [
      {
        title: 'Hold the meeting',
        description:
          'During the group gathering, an officer opens Community -> Monthly Meetings and records attendance.',
      },
      {
        title: 'Mark who came',
        description:
          'Each member is marked Present, Absent (unexcused), or Excused (pre-notified leave).',
      },
      {
        title: 'Fines for missing it',
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
    title: 'The record nobody can change',
    subtitle: 'Why a figure in this app cannot be quietly altered',
    icon: <IconAudit width={18} height={18} />,
    iconTone: 'violet',
    badge: 'Security',
    steps: [
      {
        title: 'Every change is written down',
        description:
          'Every financial action (deposit, loan, repayment, cash movement, role assignment) triggers a database audit entry recording exactly who did it, what changed, and the precise timestamp.',
      },
      {
        title: 'Nothing can be erased',
        description:
          'Even the database administrator cannot update or delete entries in the audit table. Database triggers prevent any UPDATE or DELETE operations.',
      },
      {
        title: 'Counted in whole paise',
        description:
          'Every amount is counted in whole paise, never in decimals. That is why the totals always add up exactly instead of drifting by a rupee here and there.',
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
    subtitle: 'What stops one person taking the group’s money',
    icon: <IconHelp width={18} height={18} />,
    iconTone: 'mint',
    steps: [
      {
        title: 'Two people, never one',
        description:
          'The cashier holds the cash; the accountant checks the bank. The app will not let one person do both.',
      },
      {
        title: 'The group votes before money goes out',
        description:
          'Neither the Admin, Cashier, nor Accountant can issue a loan or pay a discretionary expense on their own. Members must vote to approve loans and expenses.',
      },
      {
        title: 'No back-dating, no rubbing out',
        description:
          'Closed months cannot receive late entries, and the append-only audit log records every single modification permanently.',
      },
    ],
  },
  {
    id: 'faq-interest',
    category: 'faq',
    title: 'How is loan interest calculated?',
    subtitle: 'Why it gets cheaper as you pay back',
    icon: <IconHelp width={18} height={18} />,
    iconTone: 'amber',
    steps: [
      {
        title: 'Interest falls as you repay',
        description:
          'Interest is charged only on what you still owe, not on what you originally borrowed. Pay some back and next month’s interest is smaller.',
      },
      {
        title: 'Charged by the day',
        description:
          'Interest is calculated per day over a standard 30-day month based on your group monthly rate (e.g. 2% per month = 24% annual).',
      },
      {
        title: 'Extra charge only for late days',
        description:
          'If a loan passes its due date, the higher overdue interest rate applies ONLY to the days after the due date — never retroactively to the whole loan term.',
      },
    ],
  },
  {
    id: 'faq-exit',
    category: 'faq',
    title: 'What happens when a member leaves?',
    subtitle: 'Getting your savings back when you go',
    icon: <IconHelp width={18} height={18} />,
    iconTone: 'coral',
    steps: [
      {
        title: 'Clear any loan first',
        description:
          'Nobody can leave while they still owe the group money — the loan and its interest have to be cleared first.',
      },
      {
        title: 'Working out your share',
        description:
          'The app calculates the member’s net entitlement: their total contributions + accumulated interest share - any previous payouts received.',
      },
      {
        title: 'Passing on your job',
        description:
          'If the leaving member is the Admin, Cashier, or Accountant, they must hand over their office to another member before leaving.',
      },
    ],
  },
];

// The four banner steps were fourteen lines of identical inline CSS apiece,
// differing only in colour, number and words.
function HowStep({
  n, tone, title, children,
}: {
  n: number;
  tone: 'mint' | 'violet' | 'coral' | 'amber';
  title: string;
  children: React.ReactNode;
}) {
  // mint and amber are light, so they take dark text; violet and coral dark.
  const fg = tone === 'mint' || tone === 'amber' ? '#000' : '#fff';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span
        aria-hidden="true"
        style={{
          background: `var(--${tone})`,
          color: fg,
          borderRadius: '50%',
          width: 20,
          height: 20,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.75rem',
          fontWeight: 800,
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        {n}
      </span>
      <div style={{ fontSize: '0.85rem', lineHeight: 1.4 }}>
        <strong>{title}:</strong> {children}
      </div>
    </div>
  );
}

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

  // With exactly one match, open it. Searching "late fee" and being handed a
  // single collapsed row you still have to tap is a step that earns nothing.
  const openId = filteredGuides.length === 1 && search.trim()
    ? filteredGuides[0].id
    : expandedId;

  const toggleExpand = (id: string) => {
    haptic(10);
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <Screen
      title="How this works"
      sub="How the group works, step by step"
      onBack={() => nav('/community')}
    >
      {/* Search Input */}
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search — late fee, loan, cashier…"
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
            aria-label="Clear search"
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
            aria-pressed={selectedCategory === cat.id}
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
              <div className="dim" style={{ fontSize: '0.82rem' }}>The whole idea in four steps</div>
            </div>
          </div>
          <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
            <HowStep n={1} tone="mint" title="Everyone pays in">
              the same amount each month, by UPI, bank or cash.
            </HowStep>
            <HowStep n={2} tone="violet" title="Members borrow">
              anyone can ask for a loan, and the group votes on it.
            </HowStep>
            <HowStep n={3} tone="coral" title="The pot grows">
              borrowers pay interest, and that interest belongs to everyone.
            </HowStep>
            <HowStep n={4} tone="amber" title="Everyone shares it">
              the profit is split by how much each person saved.
            </HowStep>
          </div>
        </div>
      )}

      {/* Guide List */}
      <Panel
        title={
          selectedCategory === 'all'
            ? 'Pick a topic'
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
              const isExpanded = openId === guide.id;
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
                    expanded={isExpanded}
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
                        padding: '2px 14px 16px',
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
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'baseline',
                                gap: 8,
                                marginBottom: 4,
                              }}
                            >
                              <span
                                aria-hidden="true"
                                style={{
                                  color: 'var(--text-3)',
                                  fontWeight: 700,
                                  fontSize: '0.78rem',
                                  fontVariantNumeric: 'tabular-nums',
                                  flexShrink: 0,
                                }}
                              >
                                {idx + 1}
                              </span>
                              <span style={{ fontWeight: 650, fontSize: '0.88rem' }}>
                                {step.title}
                              </span>
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
