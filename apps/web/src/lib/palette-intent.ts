'use client';

/**
 * "Do this when you get there" (MVP_SPEC M7).
 *
 * The command palette's quick actions are mostly navigation, but one of them —
 * "New deal" — is a thing that happens *on* a screen rather than a screen to
 * go to. The palette cannot open the deals board's dialog directly, because
 * the dialog belongs to a component that may not be mounted yet.
 *
 * So the palette leaves an intent, then navigates. The screen picks it up
 * either when it mounts (the user was somewhere else) or immediately (they
 * were already there). An intent is consumed once; a stale one cannot pop a
 * dialog open on a later visit.
 *
 * Deliberately not a URL parameter: `/deals?new=1` would make the deals route
 * dynamic, survive a bookmark, and leave `?new=1` in the address bar after the
 * dialog closed. Deliberately not a store either — this is a single value and
 * a listener list, and a state library for it would be the tail wagging the
 * dog.
 */
export type PaletteIntent = 'new-deal';

let pending: PaletteIntent | null = null;
const listeners = new Set<(intent: PaletteIntent) => void>();

/** Record an intent and tell anybody already listening. */
export function requestIntent(intent: PaletteIntent): void {
  pending = intent;
  for (const listener of listeners) listener(intent);
}

/**
 * Take the pending intent if it is this one.
 *
 * Returns false the second time, so a remount does not reopen the dialog.
 */
export function consumeIntent(intent: PaletteIntent): boolean {
  if (pending !== intent) return false;
  pending = null;
  return true;
}

/** Listen for intents raised while this screen is already on display. */
export function onIntent(listener: (intent: PaletteIntent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
