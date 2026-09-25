import {
  createContext, useContext, useEffect, useRef, useState, lazy, Suspense,
  type ReactNode,
} from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from './context/SessionContext';
import { FundProvider, useFund } from './context/FundContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Deposits from './pages/Deposits';
import Loans from './pages/Loans';
import Onboard, { AwaitingApproval } from './pages/Onboard';
import GroupSwitcher from './components/GroupSwitcher';
import ProfileSheet from './components/ProfileSheet';
import { Loading, initials, resetScrollLock } from './components/ui';
import {
  IconHome, IconDeposits, IconLoans, IconWallet, IconMembers, IconChevronDown,
} from './components/icons';
import { haptic } from './lib/haptics';

const LoanDetail = lazy(() => import('./pages/LoanDetail'));
const NewLoan = lazy(() => import('./pages/NewLoan'));
const Members = lazy(() => import('./pages/Members'));
const Audit = lazy(() => import('./pages/Audit'));
const Settings = lazy(() => import('./pages/Settings'));
const MoneyHub = lazy(() => import('./pages/MoneyHub'));
const Community = lazy(() => import('./pages/Community'));

/** Five intuitive destinations for community savings groups */
const TABS = [
  { to: '/', label: 'Home', Icon: IconHome, end: true },
  { to: '/deposits', label: 'Deposits', Icon: IconDeposits },
  { to: '/loans', label: 'Loans', Icon: IconLoans },
  { to: '/treasury', label: 'Treasury', Icon: IconWallet },
  { to: '/community', label: 'Community', Icon: IconMembers },
];

type Theme = 'dark' | 'light';

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('sanchay-theme') as Theme) || 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('sanchay-theme', theme); } catch { /* private window */ }
  }, [theme]);
  return { theme, setTheme };
}

export function useAppTheme() {
  return useTheme();
}

/**
 * Opens the group switcher. On a phone the rail brand is hidden, so the chip in
 * each screen's app bar is the only way in -- and Screen is shared by every
 * page, which is why this is a context rather than a prop threaded through all
 * fourteen of them.
 */
const SwitcherCtx = createContext<(() => void) | null>(null);

export function useGroupSwitcher() {
  return useContext(SwitcherCtx);
}

function TabBar({ onSwitchGroup }: { onSwitchGroup: () => void }) {
  const { alerts } = useFund();
  const { group } = useSession();

  // A dot on the tab that owns the most urgent thing needing attention.
  const blipFor = (to: string) => {
    if (to === '/treasury') {
      return alerts.some((a) => a.severity === 'danger' && (a.to === '/cash' || a.to === '/bank' || a.to === '/treasury'));
    }
    if (to === '/community') {
      return alerts.some((a) => a.severity === 'danger' && (a.to === '/members' || a.to === '/community'));
    }
    return alerts.some((a) => a.severity === 'danger' && a.to === to);
  };

  const location = useLocation();

  return (
    <nav className="tabbar" aria-label="Main">
      <button
        type="button"
        className="rail-brand"
        onClick={onSwitchGroup}
        aria-label="Switch or create group"
      >
        <span
          className="row-ico violet"
          style={{ width: 34, height: 34, borderRadius: 11 }}
        >
          {initials(group?.name)}
        </span>
        <strong style={{ fontFamily: 'var(--display)', fontSize: '0.98rem' }}>
          {group?.name ?? 'Sanchay'}
        </strong>
        <IconChevronDown width={12} height={12} className="brand-caret" />
      </button>

      {TABS.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
          onClick={() => {
            if (location.pathname === to) {
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }
          }}
        >
          <Icon />
          <span>{label}</span>
          {blipFor(to) ? <i className="blip" /> : null}
        </NavLink>
      ))}
    </nav>
  );
}

function Shell() {
  const [switcher, setSwitcher] = useState(false);
  const [adding, setAdding] = useState(false);
  const { networkError, retry } = useSession();
  const location = useLocation();

  useEffect(() => {
    resetScrollLock();
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [location.pathname]);

  // Adding a group takes over the screen: create/join both end in a session
  // refresh, and a half-visible ledger behind them would be the old group's.
  if (adding) return <Onboard onDone={() => setAdding(false)} />;

  return (
    <SwitcherCtx.Provider value={() => setSwitcher(true)}>
    <div className="app">
      {networkError && (
        <div style={{
          background: 'var(--coral-ghost)',
          borderBottom: '1px solid var(--coral-dim)',
          color: 'var(--coral)',
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '0.86rem',
          fontWeight: 500,
          position: 'sticky',
          top: 0,
          zIndex: 50,
        }}>
          <span>Connection issue: {networkError}</span>
          <button
            type="button"
            onClick={retry}
            style={{
              background: 'var(--coral)',
              color: '#fff',
              border: 0,
              borderRadius: 6,
              padding: '4px 10px',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}
      <Suspense fallback={<div className="auth" style={{ minHeight: '40vh' }}><Loading /></div>}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/deposits" element={<Deposits />} />
          <Route path="/contributions" element={<Navigate to="/deposits" replace />} />
          <Route path="/loans" element={<Loans />} />
          <Route path="/loans/new" element={<NewLoan />} />
          <Route path="/loans/:id" element={<LoanDetail />} />
          <Route path="/treasury" element={<MoneyHub />} />
          <Route path="/community" element={<Community />} />
          <Route path="/expenses" element={<MoneyHub defaultTab="expenses" />} />
          <Route path="/cash" element={<MoneyHub defaultTab="cash" />} />
          <Route path="/bank" element={<MoneyHub defaultTab="bank" />} />
          <Route path="/members" element={<Members />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/more" element={<Community />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <TabBar onSwitchGroup={() => setSwitcher(true)} />
      <GroupSwitcher
        open={switcher}
        onClose={() => setSwitcher(false)}
        onAddGroup={() => setAdding(true)}
      />
    </div>
    </SwitcherCtx.Provider>
  );
}

function Gate() {
  const {
    session, member, loading, noGroups, awaitingApproval, currentGroupId, groups,
  } = useSession();
  useTheme();

  if (loading) return <div className="auth"><Loading what="Signing in" /></div>;
  if (!session) return <Login />;
  if (noGroups) return <Onboard />;
  if (awaitingApproval || (groups.length > 0 && groups.every((g) => g.status === 'pending'))) {
    return <AwaitingApproval />;
  }
  // Signed in, in an active group, but the member row has not arrived. A brief
  // window during a switch rather than a state anyone can get stuck in.
  if (!member) return <div className="auth"><Loading what="Opening your group" /></div>;

  // Remounting the whole shell on a group change throws away every page's local
  // state -- open sheets, half-typed amounts, scroll position -- which would
  // otherwise carry over from one group's screen to another's.
  return (
    <FundProvider key={currentGroupId ?? 'none'}>
      <Shell />
    </FundProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Gate />
      </SessionProvider>
    </BrowserRouter>
  );
}

/**
 * Shared page frame: a scroll-aware app bar over a stacked screen.
 *
 * The bar starts large and flush with the page, then condenses once anything
 * scrolls under it — the subtitle folds away, the title shrinks to fit one
 * line beside the controls, and a hairline appears to separate the layers.
 * That collapse is what makes a header read as native rather than as a div
 * pinned to the top.
 *
 * Detection is an IntersectionObserver on a zero-height sentinel rather than a
 * scroll listener: it fires twice (crossing in, crossing out) instead of on
 * every frame, and it needs no scroll maths that would have to know which
 * element is actually scrolling.
 */
export function Screen({
  title, sub, action, children,
}: { title: string; sub?: ReactNode; action?: ReactNode; children: ReactNode }) {
  const openSwitcher = useContext(SwitcherCtx);
  const { group, groups, member } = useSession();
  const sentinel = useRef<HTMLDivElement | null>(null);
  const [condensed, setCondensed] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => setCondensed(!entry.isIntersecting),
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The chip carries the group name and, when there is more than one group,
  // doubles as the switcher. With a single group there is nothing to switch
  // to, so it stays a label rather than pretending to be a control.
  const canSwitch = groups.length > 1;
  const chip = openSwitcher && group ? (
    <button
      type="button"
      className={`group-chip${canSwitch ? '' : ' static'}`}
      onClick={openSwitcher}
      aria-label={canSwitch
        ? `Current group ${group.name}. Switch or add group`
        : `Group ${group.name}. Add another group`}
    >
      <span className="group-chip-ico">{initials(group.name)}</span>
      <span className="nm">{group.name}</span>
      <IconChevronDown width={10} height={10} className="chip-caret" />
    </button>
  ) : null;

  return (
    <>
      <header className={`appbar${condensed ? ' condensed' : ''}`}>
        <div className="appbar-inner">
          <span className="appbar-title">
            <span className="appbar-name">{title}</span>
            {sub ? <span className="appbar-sub">{sub}</span> : null}
          </span>
          <div className="appbar-actions">
            {chip}
            {action}
            <button
              type="button"
              className="icon-btn avatar"
              onClick={() => {
                haptic(10);
                setProfileOpen(true);
              }}
              aria-label={`Profile for ${member?.full_name ?? 'User'}`}
              title={member?.full_name ?? 'Your Profile'}
            >
              {initials(member?.full_name)}
            </button>
          </div>
        </div>
      </header>
      {/* Zero-height marker: once it leaves the viewport the bar condenses. */}
      <div ref={sentinel} aria-hidden className="appbar-sentinel" />
      <div className="screen stagger">{children}</div>

      {profileOpen && (
        <ProfileSheet open={profileOpen} onClose={() => setProfileOpen(false)} />
      )}
    </>
  );
}
