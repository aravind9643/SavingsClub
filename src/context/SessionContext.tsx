import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, friendlyError } from '../lib/supabase';
import { setQueryGroup } from '../hooks/useQuery';
import type { Member, Role, AppConfig, MyGroup } from '../lib/types';
import { today } from '../lib/dates';

interface SessionValue {
  session: Session | null;
  /** Every group this login belongs to, including ones awaiting approval. */
  groups: MyGroup[];
  currentGroupId: string | null;
  group: MyGroup | null;
  member: Member | null;
  role: Role;
  config: AppConfig | null;
  loading: boolean;
  /** Signed in but in no group at all -- offer create or join. */
  noGroups: boolean;
  /** Joined with a code and waiting for an officer to approve. */
  awaitingApproval: boolean;
  isOfficer: boolean;
  networkError: string | null;
  retry: () => void;
  switchGroup: (groupId: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => void;
}

const Ctx = createContext<SessionValue | null>(null);

/**
 * Remembering the open group locally is a convenience, not an authority. The
 * server re-derives it from profiles.last_group_id and validates it against
 * members on every single query, so a tampered value here buys nothing.
 */
const LAST_GROUP = 'sanchay-group';

function readLastGroup(): string | null {
  try {
    return localStorage.getItem(LAST_GROUP);
  } catch {
    return null;
  }
}

function readInitialSession(): Session | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.access_token && parsed.user) {
            return parsed as Session;
          }
        }
      }
    }
  } catch {
    // fallback if private window or parse error
  }
  return null;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(readInitialSession);
  const [authReady, setAuthReady] = useState(() => Boolean(readInitialSession()));
  const [groupsFetchedFor, setGroupsFetchedFor] = useState<string | null>(null);
  const [groups, setGroups] = useState<MyGroup[]>([]);
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(readLastGroup);
  const [member, setMember] = useState<Member | null>(null);
  const [role, setRole] = useState<Role>('member');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_OUT' || !s) {
        setSession(null);
        setGroupsFetchedFor(null);
        setAuthReady(true);
        return;
      }
      setSession((prev) => {
        if (prev?.user?.id === s.user.id && prev.access_token === s.access_token) {
          return prev;
        }
        return s;
      });
      setAuthReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Multi-tab synchronization: keep active group in sync across browser tabs
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LAST_GROUP && e.newValue && e.newValue !== currentGroupId) {
        setCurrentGroupId(e.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [currentGroupId]);

  // The cache is namespaced by group. This must run before any child query
  // renders under a new group, so it is a layout-time concern, not an effect
  // that competes with the fetches it is meant to govern.
  setQueryGroup(currentGroupId);

  const userId = session?.user?.id;

  useEffect(() => {
    let cancelled = false;

    if (!authReady) {
      return;
    }

    if (!session) {
      setGroups([]);
      setGroupsFetchedFor(null);
      setMember(null);
      setRole('member');
      setConfig(null);
      setLoading(false);
      setNetworkError(null);
      return;
    }

    // Only set full-screen loading on initial load when there is no data.
    // Background session updates must never tear down the UI.
    if (!member && groups.length === 0) {
      setLoading(true);
    }
    (async () => {
      const { data: gs, error: gsError } = await supabase
        .from('v_my_groups').select('*').order('name');
      if (cancelled) return;

      if (gsError) {
        // Transient network or server error -- preserve existing group state
        // and do not redirect to onboarding!
        setNetworkError(friendlyError(gsError));
        setLoading(false);
        return;
      }
      setNetworkError(null);

      const list = (gs ?? []) as MyGroup[];
      setGroups(list);

      if (list.length === 0) {
        setCurrentGroupId(null);
        setGroupsFetchedFor(session.user.id);
        setMember(null);
        setRole('member');
        setConfig(null);
        setLoading(false);
        return;
      }

      // Prefer what the server says is current -- it reflects the JWT claim the
      // policies will actually enforce. Fall back to the remembered choice, and
      // only then to whatever group is first.
      //
      // The `status === 'active'` guards matter: join_group_with_code() makes
      // the group you just asked to join the active one, so without them
      // someone who already had a working group would be dropped onto a
      // "waiting for approval" screen and cut off from the books they were
      // using. A group you cannot see yet never displaces one you can.
      const claimed = list.find((g) => g.is_current);
      const remembered = list.find((g) => g.id === currentGroupId);
      const active =
        (claimed?.status === 'active' ? claimed : undefined)
        ?? (remembered?.status === 'active' ? remembered : undefined)
        ?? list.find((g) => g.status === 'active')
        ?? claimed
        ?? remembered
        ?? list[0];

      if (active.id !== currentGroupId) {
        setCurrentGroupId(active.id);
        try { localStorage.setItem(LAST_GROUP, active.id); } catch { /* private window */ }
      }

      if (claimed && active.id !== claimed.id && active.status === 'active') {
        await supabase.rpc('set_active_group', { p_group_id: active.id });
      }

      // A pending member can see nothing by design, so there is no point
      // asking for the config or the role -- both would come back empty.
      if (active.status !== 'active') {
        setGroupsFetchedFor(session.user.id);
        setMember(null);
        setRole('member');
        setConfig(null);
        setLoading(false);
        return;
      }

      const [{ data: me }, { data: r }, { data: c }] = await Promise.all([
        supabase.from('members').select('*')
          .eq('group_id', active.id)
          .eq('id', active.member_id).maybeSingle(),
        supabase.rpc('current_role_of'),
        supabase.from('groups').select('*').eq('id', active.id).maybeSingle(),
      ]);
      if (cancelled) return;

      const memberObj = (me as Member) ?? (active ? {
        id: active.member_id,
        group_id: active.id,
        auth_user_id: session.user.id,
        full_name: session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'Member',
        email: session.user.email ?? null,
        phone: null,
        nominee_name: null,
        nominee_phone: null,
        joined_on: today(),
        status: active.status,
        is_active: active.status === 'active',
        left_on: null,
        created_at: new Date().toISOString(),
      } as Member : null);

      setGroupsFetchedFor(session.user.id);
      setMember(memberObj);
      setRole((r as Role) ?? active.role ?? 'member');
      setConfig((c as AppConfig) ?? null);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [userId, currentGroupId, tick, authReady]);

  const switchGroup = useCallback(async (groupId: string) => {
    if (groupId === currentGroupId) return;

    // Record the choice server-side first. set_active_group() refuses a group
    // you are not in, so a failure here means the switch must not happen at
    // all -- showing the group locally while the server denies it would render
    // an empty screen and look like data loss.
    const { error } = await supabase.rpc('set_active_group', { p_group_id: groupId });
    if (error) throw error;

    // Refresh the token so the group_id claim matches the new group. Without
    // this the claim lags until expiry and current_group_id() would fall back
    // to profiles -- correct, but a round trip slower on every policy check.
    await supabase.auth.refreshSession();

    try { localStorage.setItem(LAST_GROUP, groupId); } catch { /* private window */ }
    setCurrentGroupId(groupId);
  }, [currentGroupId]);

  const group = groups.find((g) => g.id === currentGroupId) ?? groups[0] ?? null;

  const isGroupsLoadedForCurrentSession = session
    ? groupsFetchedFor === session.user.id
    : true;

  const isOverallLoading = !authReady || loading || !isGroupsLoadedForCurrentSession;

  const value = useMemo<SessionValue>(() => ({
    session,
    groups,
    currentGroupId,
    group,
    member,
    role,
    config,
    loading: isOverallLoading,
    noGroups: Boolean(session) && isGroupsLoadedForCurrentSession && !loading && groups.length === 0,
    awaitingApproval:
      Boolean(session) && isGroupsLoadedForCurrentSession && !loading && groups.length > 0 && (group?.status === 'pending' || groups.every((g) => g.status === 'pending')),
    isOfficer: role === 'cashier' || role === 'accountant' || role === 'admin',
    networkError,
    retry: () => setTick((n) => n + 1),
    switchGroup,
    signOut: async () => {
      try { localStorage.removeItem(LAST_GROUP); } catch { /* private window */ }
      await supabase.auth.signOut();
    },
    refresh: () => setTick((n) => n + 1),
  }), [session, groups, currentGroupId, group, member, role, config, isOverallLoading, isGroupsLoadedForCurrentSession, loading, networkError, switchGroup]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}

/** Cashier and accountant are the two money-handling offices. */
export function useIsOfficer(): boolean {
  const { role } = useSession();
  return role === 'cashier' || role === 'accountant';
}
