"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

/**
 * A tiny fetch hook. `invalidate(prefix)` re-runs every mounted query whose key starts with the
 * prefix, which is how mutations refresh the lists and counters that depend on them.
 */
const listeners = new Set<(key: string) => void>();

/** Views built from tasks: changing a task refreshes these too. */
const TASK_DEPENDENTS = ["/api/calendar", "/api/reminders", "/api/dashboard"];

export function invalidate(prefix = "") {
  listeners.forEach((l) => l(prefix));
  if (prefix.startsWith("/api/tasks")) {
    for (const dependent of TASK_DEPENDENTS) listeners.forEach((l) => l(dependent));
  }
}

type State<T> = { key: string | null; data?: T; error: ApiError | null };

export function useQuery<T>(key: string | null, fetcher?: () => Promise<T>) {
  const [state, setState] = useState<State<T>>({ key: null, error: null });
  const fetcherRef = useRef(fetcher);
  const latest = useRef(0);

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const load = useCallback(async () => {
    if (key === null) return;
    const mine = ++latest.current;
    try {
      const result = await (fetcherRef.current ? fetcherRef.current() : api<T>(key));
      if (mine === latest.current) setState({ key, data: result, error: null });
    } catch (e) {
      if (mine !== latest.current) return;
      const error = e instanceof ApiError ? e : new ApiError(0, "error", "Something went wrong");
      // Keep showing the last good data for this key if a background refresh fails.
      setState((s) => ({ key, data: s.key === key ? s.data : undefined, error }));
    }
  }, [key]);

  useEffect(() => {
    if (key === null) return;
    void load();
    const onInvalidate = (prefix: string) => {
      if (key.startsWith(prefix)) void load();
    };
    const onFocus = () => void load();
    listeners.add(onInvalidate);
    window.addEventListener("focus", onFocus);
    return () => {
      listeners.delete(onInvalidate);
      window.removeEventListener("focus", onFocus);
    };
  }, [key, load]);

  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : null,
    /** True until the first response for this key arrives. */
    loading: key !== null && !current,
    reload: () => {
      setState({ key: null, error: null });
      return load();
    },
  };
}
