import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { setQueryGroup } from '../hooks/useQuery';
import type { Member, Role, AppConfig, MyGroup } from '../lib/types';

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

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [groups, setGroups] = useState<MyGroup[]>([]);
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(readLastGroup);
  const [member, setMember] = useState<Member | null>(null);
  const [role, setRole] = useState<Role>('member');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // The cache is namespaced by group. This must run before any child query
  // renders under a new group, so it is a layout-time concern, not an effect
  // that competes with the fetches it is meant to govern.
  setQueryGroup(currentGroupId);

  useEffect(() => {
    let cancelled = false;

    if (!session) {
      setGroups([]);
      setMember(null);
      setRole('member');
      setConfig(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    (async () => {
      const { data: gs } = await supabase
        .from('v_my_groups').select('*').order('name');
      if (cancelled) return;

      const list = (gs ?? []) as MyGroup[];
      setGroups(list);

      if (list.length === 0) {
        setCurrentGroupId(null);
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
      const remembered = list.find((g) => g.id === currentGroupId);
      const claimed = list.find((g) => g.is_current);
      const active =
        (remembered?.status === 'active' ? remembered : undefined)
        ?? (claimed?.status === 'active' ? claimed : undefined)
        ?? list.find((g) => g.status === 'active')
        ?? remembered
        ?? claimed
        ?? list[0];

      if (active.id !== currentGroupId) {
        setCurrentGroupId(active.id);
        try { localStorage.setItem(LAST_GROUP, active.id); } catch { /* private window */ }
      }

      // A pending member can see nothing by design, so there is no point
      // asking for the config or the role -- both would come back empty.
      if (active.status !== 'active') {
        setMember(null);
        setRole('member');
        setConfig(null);
        setLoading(false);
        return;
      }

      const [{ data: me }, { data: r }, { data: c }] = await Promise.all([
        supabase.from('members').select('*')
          .eq('id', active.member_id).maybeSingle(),
        supabase.rpc('current_role_of'),
        supabase.from('groups').select('*').eq('id', active.id).maybeSingle(),
      ]);
      if (cancelled) return;

      setMember((me as Member) ?? null);
      setRole((r as Role) ?? 'member');
      setConfig((c as AppConfig) ?? null);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [session, currentGroupId, tick]);

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

  const group = groups.find((g) => g.id === currentGroupId) ?? null;

  const value = useMemo<SessionValue>(() => ({
    session,
    groups,
    currentGroupId,
    group,
    member,
    role,
    config,
    loading,
    noGroups: Boolean(session) && !loading && groups.length === 0,
    awaitingApproval:
      Boolean(session) && !loading && groups.length > 0 && group?.status === 'pending',
    isOfficer: role === 'cashier' || role === 'accountant' || role === 'president',
    switchGroup,
    signOut: async () => {
      try { localStorage.removeItem(LAST_GROUP); } catch { /* private window */ }
      await supabase.auth.signOut();
    },
    refresh: () => setTick((n) => n + 1),
  }), [session, groups, currentGroupId, group, member, role, config, loading, switchGroup]);

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
