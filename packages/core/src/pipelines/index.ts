/**
 * The rules for editing a pipeline's stages (MVP_SPEC M5, M9; ADR-0062).
 *
 * Pure, like `deals/stage-rules.ts`: no database, no clock, so every rule here
 * is a unit test, and the API and anything that comes after it (an import, a
 * template) ask the same functions instead of re-deriving them. The database
 * restates the ones whose violation would leave a permanently wrong row (a
 * unique active position, a unique active name, no deal in a retired stage);
 * these functions produce the sentence a person can act on.
 *
 * A stage is "active" until it is retired. Retired stages keep their row, so a
 * deal's history and a past event's stage name stay true, and they take no part
 * in ordering, in the name check or in the counts below.
 */

import type { StageKind } from '../deals/stage-rules.js';

/** The longest a stage name may be, after trimming. */
export const STAGE_NAME_MAX_LENGTH = 60;

/**
 * The most active stages a pipeline holds.
 *
 * A board with more columns than this stops being a board, and the cap keeps a
 * mistaken script from creating thousands of them. It is a constant rather than
 * a plan limit: nothing about it is commercial.
 */
export const MAX_STAGES_PER_PIPELINE = 20;

/**
 * The most deals one retirement moves in its own transaction.
 *
 * Each deal gets an audit row and an outbox event, so the transaction grows
 * with the count. Above this the request is refused with the number, and the
 * deals are moved out first (the board, one at a time, or a smaller stage at a
 * time) rather than holding locks for a long while.
 */
export const MAX_DEALS_MOVED_PER_RETIREMENT = 2000;

/** What a stage needs to be ordered and checked. */
export interface StageOrderEntry {
  readonly id: string;
  readonly stageType: StageKind;
}

/** What went wrong with a proposed set of stages, as a stable code plus a sentence. */
export interface StageSetProblem {
  readonly code:
    'no_open_stage' | 'no_won_stage' | 'no_lost_stage' | 'open_after_closed' | 'too_many_stages';
  readonly message: string;
}

/** The stage name as it is stored: surrounding space removed. */
export function normalizeStageName(raw: string): string {
  return raw.trim();
}

/**
 * The key a name is unique under: case and surrounding space do not make two
 * stages different. Mirrors the `lower(name)` unique index.
 */
export function stageNameKey(name: string): string {
  return normalizeStageName(name).toLowerCase();
}

/** Why a name is not acceptable, or null. */
export function stageNameProblem(raw: string): string | null {
  const name = normalizeStageName(raw);
  if (name.length === 0) return 'A stage needs a name';
  if (name.length > STAGE_NAME_MAX_LENGTH) {
    return `A stage name is at most ${STAGE_NAME_MAX_LENGTH} characters`;
  }
  return null;
}

/**
 * The probability a stage of this type carries.
 *
 * A won stage is 100 and a lost stage 0 (a database CHECK says the same), so
 * asking for another number on a closed stage is the caller's mistake rather
 * than something to fix quietly; an open stage takes the number it is given.
 * Returns null for "that number is not allowed for this type".
 */
export function probabilityFor(stageType: StageKind, requested: number): number | null {
  if (!Number.isInteger(requested) || requested < 0 || requested > 100) return null;
  if (stageType === 'won') return requested === 100 ? 100 : null;
  if (stageType === 'lost') return requested === 0 ? 0 : null;
  return requested;
}

/** The probability a stage takes when it becomes this type and none was asked for. */
export function defaultProbabilityFor(stageType: StageKind, current: number): number {
  if (stageType === 'won') return 100;
  if (stageType === 'lost') return 0;
  return current;
}

/**
 * Whether the active stages, in board order, make a usable pipeline.
 *
 *   - at least one open stage (a deal needs somewhere to start)
 *   - at least one won stage and one lost stage (a deal needs somewhere to end,
 *     and "lost" is where the mandatory reason is collected)
 *   - every open stage before every won or lost stage, so the board reads left
 *     to right as "in progress, then finished" and the open pipeline total is a
 *     prefix of it
 *   - no more than `MAX_STAGES_PER_PIPELINE`
 */
export function stageSetProblems(stages: readonly StageOrderEntry[]): StageSetProblem[] {
  const problems: StageSetProblem[] = [];

  if (!stages.some((stage) => stage.stageType === 'open')) {
    problems.push({
      code: 'no_open_stage',
      message: 'A pipeline needs at least one open stage for deals to start in',
    });
  }
  if (!stages.some((stage) => stage.stageType === 'won')) {
    problems.push({ code: 'no_won_stage', message: 'A pipeline needs at least one won stage' });
  }
  if (!stages.some((stage) => stage.stageType === 'lost')) {
    problems.push({ code: 'no_lost_stage', message: 'A pipeline needs at least one lost stage' });
  }

  const firstClosed = stages.findIndex((stage) => stage.stageType !== 'open');
  if (firstClosed !== -1 && stages.slice(firstClosed).some((stage) => stage.stageType === 'open')) {
    problems.push({
      code: 'open_after_closed',
      message: 'Open stages come first; won and lost stages go after them',
    });
  }

  if (stages.length > MAX_STAGES_PER_PIPELINE) {
    problems.push({
      code: 'too_many_stages',
      message: `A pipeline has at most ${MAX_STAGES_PER_PIPELINE} stages`,
    });
  }

  return problems;
}

export type ReorderPlan =
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly reason: 'duplicate' | 'unknown' | 'missing' };

/**
 * Check a requested order against the stages that exist.
 *
 * A reorder names every active stage, once, in the new order. Anything else is
 * a stale or mistaken request: an id that is not an active stage of this
 * pipeline (another company's, a retired one, a typo) is `unknown`; an id left
 * out is `missing`, which is how a stage added by a colleague since the editor
 * loaded shows up; an id twice is `duplicate`. Never "fix up" a partial list,
 * because that is where a duplicated position would come from.
 */
export function planReorder(
  existing: readonly StageOrderEntry[],
  requestedIds: readonly string[],
): ReorderPlan {
  const known = new Set(existing.map((stage) => stage.id));
  const seen = new Set<string>();
  for (const id of requestedIds) {
    if (seen.has(id)) return { ok: false, reason: 'duplicate' };
    seen.add(id);
    if (!known.has(id)) return { ok: false, reason: 'unknown' };
  }
  if (seen.size !== known.size) return { ok: false, reason: 'missing' };
  return { ok: true, ids: [...requestedIds] };
}

/** Positions for an ordered list: 0, 1, 2 ... with no gaps and no repeats. */
export function densePositions(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

/**
 * Where a new stage goes in the active order, as an index.
 *
 * A new open stage goes after the last open stage (so before Won and Lost); a
 * new won or lost stage goes at the end. The editor can then move it.
 */
export function insertionIndex(stages: readonly StageOrderEntry[], stageType: StageKind): number {
  if (stageType !== 'open') return stages.length;
  let lastOpen = -1;
  stages.forEach((stage, index) => {
    if (stage.stageType === 'open') lastOpen = index;
  });
  return lastOpen + 1;
}

/**
 * Where a restored stage goes: the same rule as a new one of its type, so a
 * restored "Proposal" comes back among the open stages rather than after Lost.
 */
export const restoreIndex = insertionIndex;

/**
 * Whether retiring a stage may move its deals into a target stage.
 *
 * Only into a stage of the same type. Moving open deals into a won stage would
 * close every one of them as won in one click; into a lost stage it would need
 * a reason per deal. Moving won deals into another won stage, and lost into
 * lost, is a tidy-up that leaves every deal's state meaning what it meant. To
 * win or lose deals, move them on the board, where it is one deal at a time.
 */
export function canMoveDealsBetween(from: StageKind, to: StageKind): boolean {
  return from === to;
}
