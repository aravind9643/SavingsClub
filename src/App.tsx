import {
  createContext, useContext, useEffect, useRef, useState, lazy, Suspense,
  type ReactNode,
} from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { SessionProvider, useSession } from './context/SessionContext';
import { FundProvider, useFund } from './context/FundContext';
import Dashboard from './pages/Dashboard';
import GroupSwitcher from './components/GroupSwitcher';
import ProfileSheet from './components/ProfileSheet';
import { Loading, initials, resetScrollLock } from './components/ui';
import {
  IconHome, IconDeposits, IconLoans, IconTreasury, IconMembers, IconChevronDown,
  IconArrowLeft,
} from './components/icons';
import { haptic } from './lib/haptics';
import { useT, type MsgKey } from './lib/i18n';

// Only Home ships in the first bundle: it is the first screen a signed-in
// member sees. Login and Onboard are needed only before that, by people who
// are not yet in a group, and Deposits and Loans only once opened -- all five
// used to load on every visit.
const Login = lazy(() => import('./pages/Login'));
const Onboard = lazy(() => import('./pages/Onboard'));
const AwaitingApproval = lazy(() => import('./pages/Onboard').then((m) => ({ default: m.AwaitingApproval })));
const Deposits = lazy(() => import('./pages/Deposits'));
const Loans = lazy(() => import('./pages/Loans'));
const LoanDetail = lazy(() => import('./pages/LoanDetail'));
const NewLoan = lazy(() => import('./pages/NewLoan'));
const Members = lazy(() => import('./pages/Members'));
const Audit = lazy(() => import('./pages/Audit'));
const Settings = lazy(() => import('./pages/Settings'));
const MoneyHub = lazy(() => import('./pages/MoneyHub'));
const Community = lazy(() => import('./pages/Community'));
const Help = lazy(() => import('./pages/Help'));
const Admin = lazy(() => import('./pages/Admin'));

/** Five intuitive destinations for community savings groups */
const TABS: { to: string; label: MsgKey; Icon: typeof IconHome; end?: boolean }[] = [
  { to: '/', label: 'tab.home', Icon: IconHome, end: true },
  { to: '/deposits', label: 'tab.deposits', Icon: IconDeposits },
  { to: '/loans', label: 'tab.loans', Icon: IconLoans },
  { to: '/treasury', label: 'tab.treasury', Icon: IconTreasury },
  { to: '/community', label: 'tab.community', Icon: IconMembers },
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
  const t = useT();

  // A dot on the tab that owns the most urgent thing needing attention.
  // Compared on the path alone: an alert may carry "?pay=1" or "?deposit=1"
  // to open the fix directly, and that must not hide which tab owns it.
  const blipFor = (to: string) => {
    const paths = alerts.filter((a) => a.severity === 'danger').map((a) => a.to.split('?')[0]);
    if (to === '/treasury') return paths.some((p) => p === '/cash' || p === '/bank' || p === '/treasury');
    if (to === '/community') return paths.some((p) => p === '/members' || p === '/community');
    return paths.some((p) => p === to || p.startsWith(`${to}/`));
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
          {group?.name ?? 'SavingsClub'}
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
          <span>{t(label)}</span>
          {blipFor(to) ? <i className="blip" /> : null}
        </NavLink>
      ))}
    </nav>
  );
}

function Shell() {
  const [switcher, setSwitcher] = useState(false);
  const { networkError, retry } = useSession();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    resetScrollLock();
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [location.pathname]);

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
          <Route path="/help" element={<Help />} />
          <Route path="/guide" element={<Navigate to="/help" replace />} />
          <Route path="/more" element={<Community />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <TabBar onSwitchGroup={() => setSwitcher(true)} />
      <GroupSwitcher
        open={switcher}
        onClose={() => setSwitcher(false)}
        onAddGroup={() => {
          setSwitcher(false);
          navigate('/onboard');
        }}
      />
    </div>
    </SwitcherCtx.Provider>
  );
}

function Gate() {
  const {
    session, member, loading, noGroups, awaitingApproval, currentGroupId, groups, refresh,
  } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  useTheme();

  // The Developer Super Admin Portal is completely independent from the app's
  // group membership, onboarding state, or member profile gates.
  if (location.pathname === '/admin') {
    return (
      <Suspense fallback={<div className="auth" style={{ minHeight: '60vh' }}><Loading what="Opening Developer Portal" /></div>}>
        <Admin />
      </Suspense>
    );
  }

  // Unauthenticated: a single <Login> instance handles /login, /signup, /join.
  // Using one Route avoids remounting (which replayed the pop-in animation and
  // reset form state — the "glitch" when toggling sign-in / create-account).
  if (!session) {
    if (loading) return <div className="auth"><Loading what="Signing in" /></div>;
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  // Signed in, but no groups yet: dedicated /onboard and /join routes
  if (noGroups) {
    return (
      <Routes>
        <Route path="/join" element={<Onboard initialMode="join" onDone={() => refresh()} />} />
        <Route path="/onboard" element={<Onboard onDone={() => refresh()} />} />
        <Route path="/awaiting-approval" element={<div className="auth"><Loading what="Joining group" /></div>} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/signup" element={<Navigate to="/" replace />} />
        <Route path="/" element={<Onboard onDone={() => refresh()} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  // Signed in with pending membership awaiting officer approval
  if (awaitingApproval || (groups.length > 0 && groups.every((g) => g.status === 'pending'))) {
    return (
      <Routes>
        <Route path="/onboard" element={<Onboard onDone={() => refresh()} />} />
        <Route path="/join" element={<Onboard initialMode="join" onDone={() => refresh()} />} />
        <Route path="/awaiting-approval" element={<AwaitingApproval />} />
        <Route path="*" element={<AwaitingApproval />} />
      </Routes>
    );
  }

  // Signed in, in an active group, but member row hasn't arrived
  if (loading || !member) return <div className="auth"><Loading what="Opening your group" /></div>;

  // Signed in, active group member
  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/signup" element={<Navigate to="/" replace />} />
      <Route path="/onboard" element={<Onboard onDone={() => navigate('/')} />} />
      <Route path="/join" element={<Onboard initialMode="join" onDone={() => navigate('/')} />} />
      <Route
        path="/*"
        element={
          <FundProvider key={currentGroupId ?? 'none'}>
            <Shell />
          </FundProvider>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        {/* For the lazy sign-in and onboarding screens, which Gate renders
            outside Shell's own boundary. */}
        <Suspense fallback={<div className="auth"><Loading /></div>}>
          <Gate />
        </Suspense>
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
  title, sub, action, onBack, children,
}: {
  title: string;
  sub?: ReactNode;
  action?: ReactNode;
  onBack?: () => void;
  children: ReactNode;
}) {
  const { member } = useSession();
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

  return (
    <>
      <header className={`appbar${condensed ? ' condensed' : ''}`}>
        <div className="appbar-inner">
          {onBack && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                haptic(10);
                onBack();
              }}
              aria-label="Back"
            >
              <IconArrowLeft width={16} height={16} />
            </button>
          )}
          <span className="appbar-title">
            <span className="appbar-name">{title}</span>
            {sub ? <span className="appbar-sub">{sub}</span> : null}
          </span>
          <div className="appbar-actions">
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
