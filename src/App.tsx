import {
  createContext, useContext, useEffect, useState, lazy, Suspense, type ReactNode,
} from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from './context/SessionContext';
import { FundProvider, useFund } from './context/FundContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Contributions from './pages/Contributions';
import Loans from './pages/Loans';
import Onboard, { AwaitingApproval } from './pages/Onboard';
import GroupSwitcher from './components/GroupSwitcher';
import { Loading, initials, resetScrollLock } from './components/ui';
import {
  IconHome, IconContributions, IconLoans, IconWallet, IconMore, IconChevronDown,
} from './components/icons';

const LoanDetail = lazy(() => import('./pages/LoanDetail'));
const NewLoan = lazy(() => import('./pages/NewLoan'));
const Expenses = lazy(() => import('./pages/Expenses'));
const Cash = lazy(() => import('./pages/Cash'));
const Bank = lazy(() => import('./pages/Bank'));
const Members = lazy(() => import('./pages/Members'));
const Audit = lazy(() => import('./pages/Audit'));
const Settings = lazy(() => import('./pages/Settings'));
const More = lazy(() => import('./pages/More'));

/** Five destinations, the most anyone can hit accurately on a phone. */
const TABS = [
  { to: '/', label: 'Home', Icon: IconHome, end: true },
  { to: '/contributions', label: 'Chanda', Icon: IconContributions },
  { to: '/loans', label: 'Loans', Icon: IconLoans },
  { to: '/cash', label: 'Cash', Icon: IconWallet },
  { to: '/more', label: 'More', Icon: IconMore },
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
  const blipFor = (to: string) =>
    alerts.some((a) => a.severity === 'danger' && a.to === to);

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
          <Route path="/contributions" element={<Contributions />} />
          <Route path="/loans" element={<Loans />} />
          <Route path="/loans/new" element={<NewLoan />} />
          <Route path="/loans/:id" element={<LoanDetail />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/cash" element={<Cash />} />
          <Route path="/bank" element={<Bank />} />
          <Route path="/members" element={<Members />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/more" element={<More />} />
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

/** Shared page frame: sticky translucent app bar over a stacked screen. */
export function Screen({
  title, sub, action, children,
}: { title: string; sub?: ReactNode; action?: ReactNode; children: ReactNode }) {
  const openSwitcher = useContext(SwitcherCtx);
  const { group, groups } = useSession();

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
      <header className="appbar">
        <div className="appbar-inner">
          <span className="appbar-title">
            {title}
            {sub ? <span className="appbar-sub">{sub}</span> : null}
          </span>
          {chip}
          {action}
        </div>
      </header>
      <div className="screen stagger">{children}</div>
    </>
  );
}
