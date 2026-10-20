'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether the sidebar is collapsed to an icon rail.
 *
 * A per-person, per-browser convenience, so it lives in `localStorage` and
 * nowhere else — it is not data, nothing server-side ever needs it, and it must
 * never be the reason a page fails: every access is wrapped, and storage that
 * is blocked or full just means the sidebar starts open each time.
 *
 * `useSyncExternalStore` rather than state-plus-effect: the server and the first
 * client render both say "open" (so hydration agrees), and React then moves to
 * the stored value without a cascading render.
 */
const KEY = 'crm.sidebar.collapsed';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function useSidebarCollapsed(): [boolean, () => void] {
  const collapsed = useSyncExternalStore(subscribe, read, () => false);
  const toggle = useCallback(() => {
    try {
      window.localStorage.setItem(KEY, read() ? '0' : '1');
    } catch {
      // Storage is a convenience; failing to remember is not an error.
    }
    for (const listener of listeners) listener();
  }, []);
  return [collapsed, toggle];
}
