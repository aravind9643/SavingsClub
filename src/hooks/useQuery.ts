import { useCallback, useEffect, useRef, useState } from 'react';
import { friendlyError } from '../lib/supabase';

/**
 * The whole data-fetching layer, kept deliberately small.
 *
 * A cache keyed by string, a version counter per key, and an `invalidate` that
 * mutations call. That is the part of a query library this app actually needs.
 * If this file ever grows past ~150 lines, that is the signal to adopt TanStack
 * Query rather than to keep extending it.
 */

type Listener = () => void;

interface CacheEntry<T = unknown> {
  data: T;
  timestamp: number;
}

const STALE_TIME_MS = 60_000;

const versions = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();
const cache = new Map<string, CacheEntry>();

/**
 * Tenancy, enforced in one place.
 *
 * Every key a caller passes is a bare noun -- 'fund', 'members', 'loans'. Under
 * one group that was fine. Under several it is a correctness bug: switch group
 * and 'fund' still holds the previous group's money, so the new group's name
 * would sit above the old group's balance until each query happened to refetch.
 *
 * The fix could have been "add currentGroupId to all thirty call sites", but a
 * single missed one is a silent wrong-money bug that no type check would catch.
 * So the namespace is applied HERE, to every key, on the way in. Call sites keep
 * their bare keys and cannot get this wrong.
 */
let activeGroup = '_';

function scoped(key: string | null): string | null {
  if (key === null) return null;
  if (key.startsWith(`${activeGroup}/`)) return key;
  return `${activeGroup}/${key}`;
}

/**
 * Called by SessionContext when the open group changes. Drops the outgoing
 * group's cached rows rather than leaving them addressable -- a stale balance
 * that is merely unreachable is one refactor away from being reachable again.
 */
export function setQueryGroup(groupId: string | null): void {
  const next = groupId ?? '_';
  if (next === activeGroup) return;

  const previous = activeGroup;
  activeGroup = next;

  // Collected before deleting: mutating a Map while iterating its own keys is
  // the kind of thing that works until it quietly does not.
  const stale: string[] = [];
  for (const key of cache.keys()) {
    if (key.startsWith(`${previous}/`)) stale.push(key);
  }
  for (const key of stale) cache.delete(key);
  // Wake every live query. Each one now resolves to a key under the new group,
  // so they refetch instead of rendering the group they were mounted under.
  for (const set of listeners.values()) set.forEach((fn) => fn());
}

function subscribe(key: string, fn: Listener): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);
  return () => set!.delete(fn);
}

/**
 * Re-run every live query whose key starts with one of these prefixes.
 * Prefixes are bare nouns from the call site, so they are scoped the same way
 * the keys were: invalidating 'fund' never disturbs another group's cache.
 */
export function invalidate(...prefixes: string[]): void {
  const scopedPrefixes = prefixes.map((p) =>
    p.startsWith(`${activeGroup}/`) ? p : `${activeGroup}/${p}`,
  );
  // `cache` is scanned as well as `listeners` and `versions`. A key that was
  // fetched but is not currently mounted appears in neither of those, so
  // leaving it out let a stale row survive its own invalidation and be served
  // from cache the next time that screen opened -- a pre-mutation balance
  // shown after the mutation succeeded.
  const keys = new Set([...listeners.keys(), ...versions.keys(), ...cache.keys()]);
  for (const key of keys) {
    if (scopedPrefixes.some((p) => key === p || key.startsWith(`${p}:`))) {
      versions.set(key, (versions.get(key) ?? 0) + 1);
      cache.delete(key);
      listeners.get(key)?.forEach((fn) => fn());
    }
  }
}

export interface QueryState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

export function useQuery<T>(
  rawKey: string | null,
  fetcher: () => Promise<T>,
): QueryState<T> {
  // Resolved during render, not captured in an effect: after a group switch
  // this must produce the NEW group's key on the very first render, so the
  // cache read below cannot hand back the outgoing group's rows.
  const key = scoped(rawKey);

  const initialEntry = key ? (cache.get(key) as CacheEntry<T> | undefined) : undefined;
  const [data, setData] = useState<T | undefined>(initialEntry?.data);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(key) && initialEntry === undefined);
  const [, bump] = useState(0);

  // The key changing means the group changed (or the caller's own key did).
  // Either way the previous result belongs to a different question: show the
  // cached value for the new key, or nothing, but never the old answer.
  const shownFor = useRef(key);
  if (shownFor.current !== key) {
    shownFor.current = key;
    const hitEntry = key ? (cache.get(key) as CacheEntry<T> | undefined) : undefined;
    setData(hitEntry?.data);
    setError(null);
    setLoading(Boolean(key) && hitEntry === undefined);
  }

  // Keep the latest fetcher without making it a dependency: callers pass an
  // inline arrow, which would otherwise re-run the effect on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!key) {
      setLoading(false);
      return;
    }
    return subscribe(key, () => bump((n) => n + 1));
  }, [key]);

  // Revalidate on tab focus if data has become stale
  useEffect(() => {
    if (!key) return;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        const currentEntry = cache.get(key) as CacheEntry<T> | undefined;
        if (!currentEntry || Date.now() - currentEntry.timestamp >= STALE_TIME_MS) {
          bump((n) => n + 1);
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [key]);

  const version = key ? (versions.get(key) ?? 0) : 0;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;

    const currentEntry = cache.get(key) as CacheEntry<T> | undefined;
    const isFresh =
      currentEntry !== undefined && Date.now() - currentEntry.timestamp < STALE_TIME_MS;

    // Fresh cached data does not need refetching on mount
    if (isFresh) {
      setLoading(false);
      return;
    }

    if (!currentEntry) {
      setLoading(true);
    }

    fetcherRef
      .current()
      .then((result) => {
        if (cancelled) return;
        cache.set(key, { data: result, timestamp: Date.now() });
        setData(result);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(friendlyError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [key, version]);

  const refetch = useCallback(() => {
    if (rawKey) invalidate(rawKey);
  }, [rawKey]);

  return { data, error, loading, refetch };
}

export interface MutationState<A extends unknown[], R> {
  run: (...args: A) => Promise<R | undefined>;
  pending: boolean;
  error: string | null;
  reset: () => void;
}

export function useMutation<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: { invalidates?: string[]; onSuccess?: (result: R) => void } = {},
): MutationState<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      const result = await fnRef.current(...args);
      const { invalidates, onSuccess } = optsRef.current;
      if (invalidates?.length) invalidate(...invalidates);
      onSuccess?.(result);
      return result;
    } catch (e) {
      setError(friendlyError(e));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { run, pending, error, reset };
}
