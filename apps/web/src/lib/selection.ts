'use client';

import { useMemo, useState } from 'react';

/**
 * Which rows of a list are ticked (MVP_SPEC M4, bulk actions).
 *
 * What a screen is told is always the ticked rows **that are on screen now**. Ticking, then
 * filtering the list so that a ticked row disappears, must not leave that row selected out of
 * sight and still acted on by "Delete 12 records": the count the person reads is the count that
 * is sent.
 *
 * "Every record this view matches" is a different thing (it can be more than is loaded, and it is
 * a filter and not a list of ids), so it is its own flag, and it ends the moment the ticks change.
 *
 * The rules are plain functions over a small state, so they are tested without a browser; the hook
 * below only holds the state.
 */
export interface SelectionState {
  readonly ticked: ReadonlySet<string>;
  readonly allMatching: boolean;
}

export const EMPTY_SELECTION: SelectionState = { ticked: new Set(), allMatching: false };

/** The ticked rows that are still on screen, in list order. */
export function tickedVisible(state: SelectionState, visibleIds: readonly string[]): string[] {
  return visibleIds.filter((id) => state.ticked.has(id));
}

export function toggleOne(state: SelectionState, id: string): SelectionState {
  const ticked = new Set(state.ticked);
  if (ticked.has(id)) ticked.delete(id);
  else ticked.add(id);
  return { ticked, allMatching: false };
}

export function toggleEveryVisible(
  state: SelectionState,
  visibleIds: readonly string[],
): SelectionState {
  const all =
    visibleIds.length > 0 && tickedVisible(state, visibleIds).length === visibleIds.length;
  return { ticked: all ? new Set() : new Set(visibleIds), allMatching: false };
}

export function tickEveryMatching(
  _state: SelectionState,
  visibleIds: readonly string[],
): SelectionState {
  return { ticked: new Set(visibleIds), allMatching: true };
}

/** "Every record this view matches" only means something while every loaded row is still ticked. */
export function isAllMatching(state: SelectionState, visibleIds: readonly string[]): boolean {
  return (
    state.allMatching &&
    visibleIds.length > 0 &&
    tickedVisible(state, visibleIds).length === visibleIds.length
  );
}

export interface Selection {
  /** Ticked rows on screen, in list order. */
  readonly ids: readonly string[];
  readonly count: number;
  readonly isSelected: (id: string) => boolean;
  readonly toggle: (id: string) => void;
  readonly allVisibleSelected: boolean;
  readonly someVisibleSelected: boolean;
  readonly toggleAllVisible: () => void;
  /** The person asked for every record the view matches, not only those loaded. */
  readonly allMatching: boolean;
  readonly selectAllMatching: () => void;
  readonly clear: () => void;
}

export function useSelection(visibleIds: readonly string[]): Selection {
  const [state, setState] = useState<SelectionState>(EMPTY_SELECTION);

  const ids = useMemo(() => tickedVisible(state, visibleIds), [state, visibleIds]);
  const allVisibleSelected = visibleIds.length > 0 && ids.length === visibleIds.length;

  return {
    ids,
    count: ids.length,
    isSelected: (id) => state.ticked.has(id),
    toggle: (id) => setState((current) => toggleOne(current, id)),
    allVisibleSelected,
    someVisibleSelected: ids.length > 0 && !allVisibleSelected,
    toggleAllVisible: () => setState((current) => toggleEveryVisible(current, visibleIds)),
    allMatching: isAllMatching(state, visibleIds),
    selectAllMatching: () => setState((current) => tickEveryMatching(current, visibleIds)),
    clear: () => setState(EMPTY_SELECTION),
  };
}
