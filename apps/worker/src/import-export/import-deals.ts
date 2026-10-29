import { resolveStageState, StageRuleViolation, type DealStageState } from '@crm/core';
import { sql, type Tx } from '@crm/db';

/**
 * What is specific to a deal in an import (ADR-0070): which pipeline and stage a row means, and what
 * the stage rules then make of its probability, closed date and lost reason.
 *
 * A row names its pipeline and stage **by name**. The match is exact but ignores case; a stage is
 * looked for inside the pipeline the row names (or the default pipeline when it names none, or the
 * deal's own pipeline when an existing deal is being updated), so two pipelines may share a stage
 * name without any ambiguity. A blank pipeline is the default pipeline and a blank stage is the
 * first open stage, as for a deal made in a form. Nothing is guessed: a name that is not there is a
 * row error that says which.
 *
 * The stage rules are `resolveStageState`, the very function the deals API uses (ADR-0020), so an
 * import cannot produce a deal the API would refuse: a won deal is at 100%, a lost one at 0% and
 * needs a reason, an open one has no closed date. The only addition is the closed date: with the
 * right to import original dates, a row may say when a won or lost deal really closed, and that is
 * passed to the rules in place of "now".
 */

export interface StageFacts {
  readonly id: string;
  readonly pipelineId: string;
  readonly name: string;
  readonly stageType: 'open' | 'won' | 'lost';
  readonly probability: number;
}

export interface PipelineFacts {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
}

export interface Placement {
  readonly pipelines: readonly PipelineFacts[];
  /** Stages in use, in board order, by pipeline. */
  readonly stages: ReadonlyMap<string, readonly StageFacts[]>;
}

/** Every active pipeline and the stages in use, once per chunk: a workspace has a handful. */
export async function loadPlacement(tx: Tx, tenantId: string): Promise<Placement> {
  const pipelines = (
    await tx.execute(sql`
      select id, name, is_default
      from pipelines
      where tenant_id = ${tenantId} and is_active
      order by position, id
    `)
  ).rows as unknown as { id: string; name: string; is_default: boolean }[];

  const stageRows = (
    await tx.execute(sql`
      select id, pipeline_id, name, stage_type, probability
      from pipeline_stages
      where tenant_id = ${tenantId} and archived_at is null
      order by position, id
    `)
  ).rows as unknown as {
    id: string;
    pipeline_id: string;
    name: string;
    stage_type: 'open' | 'won' | 'lost';
    probability: number;
  }[];

  const stages = new Map<string, StageFacts[]>();
  for (const row of stageRows) {
    const list = stages.get(row.pipeline_id) ?? [];
    list.push({
      id: row.id,
      pipelineId: row.pipeline_id,
      name: row.name,
      stageType: row.stage_type,
      probability: row.probability,
    });
    stages.set(row.pipeline_id, list);
  }
  return {
    pipelines: pipelines.map((row) => ({ id: row.id, name: row.name, isDefault: row.is_default })),
    stages,
  };
}

export interface RowProblem {
  readonly field: string;
  readonly message: string;
}

type Found<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: RowProblem };

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export function pipelineNamed(placement: Placement, name: string): Found<PipelineFacts> {
  const found = placement.pipelines.find((pipeline) => same(pipeline.name, name));
  return found === undefined
    ? {
        ok: false,
        problem: { field: 'pipeline_id', message: `Pipeline: no pipeline is named "${name}"` },
      }
    : { ok: true, value: found };
}

export function stageNamed(
  placement: Placement,
  pipeline: PipelineFacts | { id: string; name: string },
  name: string,
): Found<StageFacts> {
  const found = (placement.stages.get(pipeline.id) ?? []).find((stage) => same(stage.name, name));
  return found === undefined
    ? {
        ok: false,
        problem: {
          field: 'stage_id',
          message: `Stage: the pipeline "${pipeline.name}" has no stage named "${name}"`,
        },
      }
    : { ok: true, value: found };
}

/** Where a new deal goes. */
export function placeNewDeal(
  placement: Placement,
  named: { pipeline?: string | undefined; stage?: string | undefined },
): Found<{ pipeline: { id: string; name: string }; stage: StageFacts }> {
  let pipeline: PipelineFacts | undefined;
  if (named.pipeline !== undefined) {
    const found = pipelineNamed(placement, named.pipeline);
    if (!found.ok) return found;
    pipeline = found.value;
  } else {
    pipeline = placement.pipelines.find((candidate) => candidate.isDefault);
    if (pipeline === undefined) {
      return {
        ok: false,
        problem: {
          field: 'pipeline_id',
          message: 'No default pipeline is configured for this workspace',
        },
      };
    }
  }

  if (named.stage !== undefined) {
    const found = stageNamed(placement, pipeline, named.stage);
    return found.ok ? { ok: true, value: { pipeline, stage: found.value } } : found;
  }
  const first = (placement.stages.get(pipeline.id) ?? []).find(
    (stage) => stage.stageType === 'open',
  );
  if (first === undefined) {
    return {
      ok: false,
      problem: {
        field: 'stage_id',
        message: `Stage: the pipeline "${pipeline.name}" has no open stage to start a deal in`,
      },
    };
  }
  return { ok: true, value: { pipeline, stage: first } };
}

function violation(error: unknown): RowProblem | null {
  if (!(error instanceof StageRuleViolation)) return null;
  return {
    field: error.path === 'lostReason' ? 'lost_reason' : 'probability',
    message: error.message,
  };
}

/**
 * What the stage rules make of a deal: its probability, when it closed and why it was lost.
 *
 * `closedAt` and `createdAt` come from the file and exist only for someone holding the right to
 * import original dates. A closed date needs a won or lost stage, and cannot come before the
 * created date.
 */
export function stageStateFor(input: {
  stage: StageFacts;
  previous?:
    | { stageId: string; probability: number; closedAt: Date | null; lostReason: string | null }
    | undefined;
  probability?: number | undefined;
  lostReason?: string | null | undefined;
  closedAt?: Date | undefined;
  createdAt?: Date | undefined;
  now: Date;
}): Found<DealStageState> {
  const { stage } = input;
  if (input.closedAt !== undefined) {
    if (stage.stageType === 'open') {
      return {
        ok: false,
        problem: {
          field: 'closed_at',
          message: 'Closed date: only a deal in a won or lost stage can have one',
        },
      };
    }
    if (input.createdAt !== undefined && input.closedAt.getTime() < input.createdAt.getTime()) {
      return {
        ok: false,
        problem: { field: 'closed_at', message: 'Closed date: cannot be before the created date' },
      };
    }
  }

  try {
    return {
      ok: true,
      value: resolveStageState({
        stage,
        previous: input.previous,
        probability: input.probability,
        lostReason: input.lostReason,
        // The closed date of the file stands in for "now": that is when the deal closed.
        now: input.closedAt ?? input.now,
      }),
    };
  } catch (error) {
    const problem = violation(error);
    if (problem === null) throw error;
    return { ok: false, problem };
  }
}

/** A plain amount (`1500.75`) is in the workspace's currency; `1500.75 USD` says its own. */
export function withDefaultCurrency(cell: string, currency: string | undefined): string {
  const text = cell.trim();
  if (currency !== undefined && /^-?[\d,]+(?:\.\d+)?$/.test(text)) return `${text} ${currency}`;
  return cell;
}

/** What a parsed amount cell holds, as the deals contract spells it. */
export function toMoneyInput(value: unknown): { amountMinor: string; currency: string } {
  const money = value as { amount_minor: string; currency: string };
  return { amountMinor: money.amount_minor, currency: money.currency };
}

export const SKIPPED_NOTE_PREFIX = 'Skipped: ';
