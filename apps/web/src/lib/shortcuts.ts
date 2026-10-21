'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { TranslationKey } from './i18n';

/**
 * Keyboard shortcuts (MVP_SPEC §10: "keyboard-first").
 *
 * Three families, all single keys so they work with one hand and never collide
 * with a browser chord:
 *
 *   C            create a record of whatever the current screen lists
 *   G then X     go to a screen (G D = deals, G C = contacts, ...)
 *   ?            show this list
 *
 * plus `Ctrl`/`Cmd` + `K` and `/` for the command palette, which owns those.
 *
 * Every one of them is ignored while the caret is in a field, while any modal
 * is open, and when a modifier is held — a shortcut that fires while someone is
 * typing a name containing a "c" is not a shortcut, it is a bug.
 *
 * Nothing here decides what a shortcut is *allowed* to do. `G D` is a link
 * click; `C` calls the same handler the "New" button calls. Both land on
 * screens and endpoints that make their own authorization decisions.
 */

/** The `G` then letter destinations, in the order the help list shows them. */
export const GO_TO: readonly { key: string; href: string; label: TranslationKey }[] = [
  { key: 'h', href: '/dashboard', label: 'nav.dashboard' },
  { key: 'm', href: '/my-day', label: 'nav.myDay' },
  { key: 'l', href: '/leads', label: 'nav.leads' },
  { key: 'c', href: '/contacts', label: 'nav.contacts' },
  { key: 'a', href: '/accounts', label: 'nav.accounts' },
  { key: 'd', href: '/deals', label: 'nav.deals' },
  { key: 'i', href: '/import', label: 'nav.import' },
  { key: 't', href: '/settings/team', label: 'nav.team' },
  { key: 's', href: '/settings/security', label: 'nav.settings' },
];

/** The key that follows `G` for a path, so the sidebar can show the hint. */
export function goToKeyFor(href: string): string | undefined {
  return GO_TO.find((entry) => entry.href === href)?.key;
}

/** How long after `G` the next key still counts as part of the sequence. */
export const SEQUENCE_WINDOW_MS = 1500;

/** Whether a key event came from somewhere the user is already typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Whether a modal (a `<dialog>` or an `aria-modal` overlay) is on screen. */
export function isModalOpen(): boolean {
  return document.querySelector('dialog[open], [aria-modal="true"]') !== null;
}

// --- the switch (WCAG 2.1.4) --------------------------------------------------

/**
 * Single-key shortcuts can be turned off.
 *
 * WCAG 2.1.4 (Character Key Shortcuts, level A): a shortcut made of a single
 * letter, number, punctuation or symbol must be able to be turned off, remapped,
 * or only be active while its control has focus. The reason is practical —
 * somebody using speech input says "go to deals" and an `s` or a `c` in the
 * recognised words fires commands they did not mean, and a person with a
 * tremor strikes keys they did not intend.
 *
 * So they are on by default (this is a keyboard-first product) and one switch,
 * in the shortcuts dialog, turns off every one of them: `C`, `G` then a
 * letter, `?` and the palette's `/`. `Ctrl`/`Cmd` + `K` is a chord, not a
 * character key, and is unaffected.
 *
 * Per person, per browser, in `localStorage`; storage that is blocked just
 * means they stay on.
 */
const SINGLE_KEY = 'crm.shortcuts.singleKey';
const singleKeyListeners = new Set<() => void>();

export function singleKeyShortcutsEnabled(): boolean {
  try {
    return window.localStorage.getItem(SINGLE_KEY) !== '0';
  } catch {
    return true;
  }
}

function subscribeSingleKey(listener: () => void): () => void {
  singleKeyListeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    singleKeyListeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function useSingleKeyShortcuts(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribeSingleKey, singleKeyShortcutsEnabled, () => true);
  const set = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(SINGLE_KEY, next ? '1' : '0');
    } catch {
      // A convenience; failing to remember it is not an error.
    }
    for (const listener of singleKeyListeners) listener();
  }, []);
  return [enabled, set];
}

// --- "C" creates ------------------------------------------------------------

let createHandler: (() => void) | null = null;

/**
 * A screen says "this is what C does here". One at a time: whichever list is
 * on display owns the key, and unregistering on unmount means a stale handler
 * from the previous screen can never fire.
 */
export function registerCreateShortcut(handler: () => void): () => void {
  createHandler = handler;
  return () => {
    if (createHandler === handler) createHandler = null;
  };
}

/** Run the current screen's create action. Returns whether there was one. */
export function runCreateShortcut(): boolean {
  if (createHandler === null) return false;
  createHandler();
  return true;
}

/** Register the screen's "new" action as the target of the `C` key. */
export function useCreateShortcut(handler: () => void, enabled = true): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return undefined;
    return registerCreateShortcut(() => latest.current());
  }, [enabled]);
}

// --- Display ---------------------------------------------------------------

/** Nothing to subscribe to: the platform does not change while the page is open. */
const noSubscription = () => () => undefined;

function modifierLabel(): string {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  return /mac|iphone|ipad/i.test(platform) ? '⌘' : 'Ctrl';
}

/**
 * The label for the "command" modifier on this platform.
 *
 * `useSyncExternalStore` is the sanctioned way to read something only the
 * browser knows: the server snapshot (`Ctrl`) is used for the server render and
 * for hydration, so the two agree, and React then switches to the real value.
 */
export function useModifierLabel(): string {
  return useSyncExternalStore(noSubscription, modifierLabel, () => 'Ctrl');
}
