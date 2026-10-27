/**
 * Stage-transition rules for deals (MVP_SPEC M5, ADR-0020).
 *
 * The one place that decides what a deal's `closed_at`, `probability` and
 * `lost_reason` must be, given the stage it is in. Pure: no clock of its own,
 * no database, so every rule below is a unit test rather than an integration
 * test, and the API, an import and a future automation all call the same
 * function instead of re-deriving it.
 *
 * The rules, by stage type:
 *
 *   won   closed now · probability 100 · no lost reason
 *   lost  closed now · probability 0   · a lost reason is **required**
 *   open  not closed · no lost reason  · probability is the caller's, or the
 *         stage's default when the deal has just arrived in the stage
 *
 * "Closed now" means the instant of the move that closed it. Editing a won
 * deal's name does not re-close it, so `closed_at` survives edits that leave
 * the stage alone.
 *
 * The database restates the same rule as a trigger (`deals_stage_state`). That
 * is the guarantee; this is the part that produces a sentence a person can act
 * on rather than a constraint name.
 */

export type StageKind = 'open' | 'won' | 'lost';

/** The facts about a stage that the rules read. */
export interface StageFacts {
  readonly id: string;
  readonly stageType: StageKind;
  /** The stage's default probability, a whole percent. */
  readonly probability: number;
}

/** What a deal currently is, for a deal that already exists. */
export interface DealStageSnapshot {
  readonly stageId: string;
  readonly probability: number;
  readonly closedAt: Date | null;
  readonly lostReason: string | null;
}

export interface StageRuleInput {
  /** The stage the deal is, or is about to be, in. */
  readonly stage: StageFacts;
  /** What the deal is now. Absent when it is being created. */
  readonly previous?: DealStageSnapshot | undefined;
  /** What the caller sent. `undefined` means "not mentioned". */
  readonly probability?: number | undefined;
  readonly lostReason?: string | null | undefined;
  /** Injected so the rules stay deterministic. */
  readonly now: Date;
  /**
   * The deal is being moved from one stage to another stage of the same kind
   * because its stage was retired, not because anybody closed it again. A won
   * or lost deal then keeps the moment it closed and its reason, so tidying a
   * pipeline does not move "won this month" (ADR-0061). Ignored for open
   * stages and when the deal was not already closed.
   */
  readonly keepClosedState?: boolean | undefined;
}

export interface DealStageState {
  readonly probability: number;
  readonly closedAt: Date | null;
  readonly lostReason: string | null;
}

/** A refusal, addressed to the field the caller should fix. */
export class StageRuleViolation extends Error {
  constructor(
    readonly path: 'probability' | 'lostReason',
    message: string,
  ) {
    super(message);
    this.name = 'StageRuleViolation';
  }
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function resolveStageState(input: StageRuleInput): DealStageState {
  const { stage, previous, now } = input;
  const unchangedStage = previous !== undefined && previous.stageId === stage.id;
  const keepClosed = unchangedStage || input.keepClosedState === true;
  const suppliedReason = trimmedOrNull(input.lostReason);

  switch (stage.stageType) {
    case 'won': {
      if (suppliedReason !== null) {
        throw new StageRuleViolation('lostReason', 'A won deal cannot have a lost reason');
      }
      if (input.probability !== undefined && input.probability !== 100) {
        throw new StageRuleViolation('probability', 'A won deal is always at 100%');
      }
      return {
        probability: 100,
        closedAt: keepClosed && previous?.closedAt != null ? previous.closedAt : now,
        lostReason: null,
      };
    }

    case 'lost': {
      if (input.probability !== undefined && input.probability !== 0) {
        throw new StageRuleViolation('probability', 'A lost deal is always at 0%');
      }
      // A reason already on file stays valid while the deal stays lost; one
      // that is being sent replaces it. Moving *into* lost has nothing on file.
      const reason =
        suppliedReason ??
        (keepClosed && previous !== undefined ? trimmedOrNull(previous.lostReason) : null);
      if (reason === null) {
        throw new StageRuleViolation(
          'lostReason',
          'A lost reason is required when a deal is marked lost',
        );
      }
      return {
        probability: 0,
        closedAt: keepClosed && previous?.closedAt != null ? previous.closedAt : now,
        lostReason: reason,
      };
    }

    case 'open': {
      if (suppliedReason !== null) {
        throw new StageRuleViolation(
          'lostReason',
          'A lost reason can only be given for a deal in a lost stage',
        );
      }
      // Re-opening a closed deal forgets that it was closed: it is open again,
      // and its history lives in the audit log and the timeline, not here.
      const probability =
        input.probability ?? (unchangedStage ? previous.probability : stage.probability);
      return { probability, closedAt: null, lostReason: null };
    }
  }
}
