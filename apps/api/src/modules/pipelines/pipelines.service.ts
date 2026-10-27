import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  ConflictError,
  defaultProbabilityFor,
  insertionIndex,
  newId,
  normalizeStageName,
  planReorder,
  probabilityFor,
  stageNameKey,
  stageNameProblem,
  stageSetProblems,
  ValidationError,
  VersionConflictError,
  type Actor,
  type StageKind,
  type StageOrderEntry,
} from '@crm/core';
import type { Pipeline as PipelineContract } from '@crm/contracts';
import type { Pipeline, PipelineStage, Tx } from '@crm/db';
import { DatabaseService } from '../../database/database.service.js';
import { PipelinesRepository } from './pipelines.repository.js';

/** What the deals module needs to know about a stage, and nothing more. */
export interface StageInfo {
  readonly id: string;
  readonly pipelineId: string;
  readonly name: string;
  readonly position: number;
  readonly probability: number;
  readonly stageType: StageKind;
  /** Retired by the pipeline editor: still a real row, but no deal may be placed in it. */
  readonly isRetired: boolean;
}

/** A stage as the pipeline editor handles it. */
export interface StageRecord extends StageInfo {
  readonly version: number;
  readonly archivedAt: Date | null;
}

/** A pipeline as the pipeline editor handles it. */
export interface PipelineRecord {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly isDefault: boolean;
  readonly version: number;
}

function toStageInfo(row: PipelineStage): StageInfo {
  return {
    id: row.id,
    pipelineId: row.pipelineId,
    name: row.name,
    position: row.position,
    probability: row.probability,
    stageType: row.stageType,
    isRetired: row.archivedAt !== null,
  };
}

function toStageRecord(row: PipelineStage): StageRecord {
  return { ...toStageInfo(row), version: row.version, archivedAt: row.archivedAt };
}

function toPipelineRecord(row: Pipeline): PipelineRecord {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    isDefault: row.isDefault,
    version: row.version,
  };
}

const entryOf = (stage: StageInfo): StageOrderEntry => ({
  id: stage.id,
  stageType: stage.stageType,
});

function problem(path: string, message: string): ValidationError {
  return new ValidationError([{ path, message }]);
}

/** Why a set of stages is not a usable pipeline, as the one 422 the caller can act on. */
function assertUsableSet(stages: readonly StageOrderEntry[]): void {
  const problems = stageSetProblems(stages);
  if (problems.length > 0) {
    throw new ValidationError(
      problems.map((entry) => ({ path: 'stages', message: entry.message })),
    );
  }
}

function article(stageType: StageKind): string {
  return stageType === 'open' ? 'an open' : `a ${stageType}`;
}

function probabilityMessage(stageType: StageKind): string {
  if (stageType === 'won') return 'A won stage is always at 100%';
  if (stageType === 'lost') return 'A lost stage is always at 0%';
  return 'Probability is a whole number from 0 to 100';
}

/**
 * Pipelines and stages (MVP_SPEC M5).
 *
 * Tenants get a seeded default pipeline, and a demo tenant gets a second one.
 * Reshaping the **stages** of a pipeline is the pipeline editor (ADR-0061): the
 * `pipeline` grant, checked by `PipelineEditorService`, which calls the editor
 * methods at the bottom of this class inside its own transaction. Creating and
 * renaming whole pipelines is not built yet; it needs a decision on plan limits
 * first.
 *
 * Authorization for reading is the deal grant: anybody who may read deals may
 * see the pipelines that deals sit in, because a board with no column names is
 * not a board. A caller with no deal read grant gets a plain 403.
 *
 * The public methods taking a `tx` are the way the deals module reaches this
 * one (CLAUDE.md §3): a service call inside the caller's own transaction, so a
 * deal write and the stage lookup it depends on see the same snapshot.
 *
 * A retired stage is not part of its pipeline any more: the board, the dashboard
 * and new deals see only the stages in use. History still finds a retired stage
 * by id (`findStage`), because an old event or a report may name it.
 */
@Injectable()
export class PipelinesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PipelinesRepository) private readonly repository: PipelinesRepository,
  ) {}

  async list(actor: Actor): Promise<PipelineContract[]> {
    assertCan(actor, 'read', { objectType: 'deal' });

    return this.database.runInTenant(
      { tenantId: actor.tenantId, userId: actor.userId },
      async (tx) => {
        const [pipelines, stages] = await Promise.all([
          this.repository.listActive(tx, actor.tenantId),
          this.repository.allStages(tx, actor.tenantId),
        ]);

        return pipelines.map((pipeline) => ({
          id: pipeline.id,
          name: pipeline.name,
          position: pipeline.position,
          isDefault: pipeline.isDefault,
          stages: stages
            .filter((stage) => stage.pipelineId === pipeline.id)
            .map((stage) => ({
              id: stage.id,
              name: stage.name,
              position: stage.position,
              probability: stage.probability,
              stageType: stage.stageType,
            })),
        }));
      },
    );
  }

  /** The stages in use in a pipeline, in board order, or null when it is not usable. */
  async stagesOf(tx: Tx, tenantId: string, pipelineId: string): Promise<StageInfo[] | null> {
    const pipeline = await this.repository.findPipeline(tx, tenantId, pipelineId);
    if (pipeline === null) return null;
    return (await this.repository.stagesOf(tx, tenantId, pipelineId)).map(toStageInfo);
  }

  /** The tenant's default pipeline, or a 422 explaining there is none. */
  async defaultPipelineId(tx: Tx, tenantId: string): Promise<string> {
    const pipeline = await this.repository.findDefault(tx, tenantId);
    if (pipeline === null) {
      throw new ValidationError([
        { path: 'pipelineId', message: 'No default pipeline is configured for this workspace' },
      ]);
    }
    return pipeline.id;
  }

  /**
   * Every stage of one kind across all pipelines, for reports that ask "which deals are
   * won". The deals module cannot join to stages (ADR-0001), so it is told which they are.
   */
  async stageIdsOfKind(tx: Tx, tenantId: string, kind: StageKind): Promise<string[]> {
    // Retired stages count: a deal is won because of its stage's type, whatever became of the row.
    const stages = await this.repository.allStagesAny(tx, tenantId);
    return stages.filter((stage) => stage.stageType === kind).map((stage) => stage.id);
  }

  async pipelineIsUsable(tx: Tx, tenantId: string, pipelineId: string): Promise<boolean> {
    return (await this.repository.findPipeline(tx, tenantId, pipelineId)) !== null;
  }

  /** A stage by id, retired or not: history still names stages that have since been retired. */
  async findStage(tx: Tx, tenantId: string, stageId: string): Promise<StageInfo | null> {
    const row = await this.repository.findStage(tx, tenantId, stageId);
    return row === null ? null : toStageInfo(row);
  }

  /**
   * A stage a deal is about to be placed in, with a shared lock on its row for the rest of the
   * transaction. Callers refuse a retired stage (`isRetired`); the lock is what stops a stage
   * being retired between that check and the deal being written.
   */
  async findStageForPlacement(
    tx: Tx,
    tenantId: string,
    stageId: string,
  ): Promise<StageInfo | null> {
    const row = await this.repository.findStageForPlacement(tx, tenantId, stageId);
    return row === null ? null : toStageInfo(row);
  }

  /** Where a deal with no stage of its own starts: the pipeline's first open stage in use. */
  async firstOpenStage(tx: Tx, tenantId: string, pipelineId: string): Promise<StageInfo | null> {
    const stages = await this.repository.stagesOf(tx, tenantId, pipelineId);
    const first = stages.find((stage) => stage.stageType === 'open');
    return first === undefined ? null : toStageInfo(first);
  }

  // ---------------------------------------------------------------------------------------------
  // The pipeline editor's operations (ADR-0061).
  //
  // Each runs inside the caller's transaction and assumes the caller has already authorized the
  // request. Every write starts from `lockPipeline`, which is what serializes writes to one
  // pipeline. They enforce the stage rules and raise 404, 409 and 422; the audit entry and the
  // outbox event are the caller's, because they are written in the same transaction as the deals
  // that move.
  // ---------------------------------------------------------------------------------------------

  /** Lock a pipeline for editing, or null when it is not there (or belongs to another company). */
  async lockPipeline(tx: Tx, tenantId: string, pipelineId: string): Promise<PipelineRecord | null> {
    const row = await this.repository.lockPipeline(tx, tenantId, pipelineId);
    return row === null ? null : toPipelineRecord(row);
  }

  /** Every active pipeline with all its stages, retired ones last, for the editor. */
  async editorView(
    tx: Tx,
    tenantId: string,
  ): Promise<{ pipeline: PipelineRecord; stages: StageRecord[] }[]> {
    const [rows, stages] = await Promise.all([
      this.repository.listActive(tx, tenantId),
      this.repository.stagesForEditor(tx, tenantId),
    ]);
    return rows.map((row) => ({
      pipeline: toPipelineRecord(row),
      stages: stages.filter((stage) => stage.pipelineId === row.id).map(toStageRecord),
    }));
  }

  /** One pipeline's editor view, or null. */
  async editorViewOf(
    tx: Tx,
    tenantId: string,
    pipelineId: string,
  ): Promise<{ pipeline: PipelineRecord; stages: StageRecord[] } | null> {
    const all = await this.editorView(tx, tenantId);
    return all.find((entry) => entry.pipeline.id === pipelineId) ?? null;
  }

  private async inUse(tx: Tx, tenantId: string, pipelineId: string): Promise<StageRecord[]> {
    return (await this.repository.stagesOf(tx, tenantId, pipelineId)).map(toStageRecord);
  }

  /** A stage of this pipeline, retired or not, or null. */
  async findStageIn(
    tx: Tx,
    tenantId: string,
    pipelineId: string,
    stageId: string,
  ): Promise<StageRecord | null> {
    const row = await this.repository.findStage(tx, tenantId, stageId);
    return row !== null && row.pipelineId === pipelineId ? toStageRecord(row) : null;
  }

  /** Take the stage's row lock before moving its deals. Null when the stage is not in the pipeline. */
  async lockStageIn(
    tx: Tx,
    tenantId: string,
    pipelineId: string,
    stageId: string,
  ): Promise<StageRecord | null> {
    const row = await this.repository.lockStage(tx, tenantId, stageId);
    return row !== null && row.pipelineId === pipelineId ? toStageRecord(row) : null;
  }

  private assertNameFree(stages: readonly StageRecord[], name: string, exceptId?: string): void {
    const key = stageNameKey(name);
    if (stages.some((stage) => stage.id !== exceptId && stageNameKey(stage.name) === key)) {
      throw new ConflictError('A stage with that name already exists in this pipeline', [
        { path: 'name', message: 'A stage with that name already exists in this pipeline' },
      ]);
    }
  }

  private async finishStructuralChange(
    tx: Tx,
    tenantId: string,
    pipelineId: string,
    orderedIds: readonly string[],
    actorId: string,
  ): Promise<void> {
    await this.repository.writeOrder(tx, tenantId, pipelineId, orderedIds, actorId);
    await this.repository.bumpPipelineVersion(tx, tenantId, pipelineId, actorId);
  }

  /** Add a stage: after the last open stage if it is open, last otherwise. */
  async addStage(
    tx: Tx,
    tenantId: string,
    pipelineId: string,
    input: { name: string; stageType: StageKind; probability?: number | undefined },
    actorId: string,
  ): Promise<StageRecord> {
    const name = normalizeStageName(input.name);
    const nameProblem = stageNameProblem(name);
    if (nameProblem !== null) throw problem('name', nameProblem);

    const stages = await this.inUse(tx, tenantId, pipelineId);
    this.assertNameFree(stages, name);

    const requested =
      input.probability ??
      (input.stageType === 'open' ? 50 : defaultProbabilityFor(input.stageType, 0));
    const probability = probabilityFor(input.stageType, requested);
    if (probability === null) throw problem('probability', probabilityMessage(input.stageType));

    const id = newId();
    const order: StageOrderEntry[] = stages.map(entryOf);
    order.splice(insertionIndex(order, input.stageType), 0, { id, stageType: input.stageType });
    assertUsableSet(order);

    await this.repository.insertParkedStage(tx, {
      id,
      tenantId,
      pipelineId,
      name,
      probability,
      stageType: input.stageType,
      createdBy: actorId,
    });
    await this.finishStructuralChange(
      tx,
      tenantId,
      pipelineId,
      order.map((entry) => entry.id),
      actorId,
    );
    const created = await this.findStageIn(tx, tenantId, pipelineId, id);
    if (created === null) throw new Error('Stage vanished while the pipeline was locked');
    return created;
  }

  /**
   * Rename, re-weight or retype a stage.
   *
   * A retype is only legal for a stage no deal has ever been in (`holdsDeals` says whether one is,
   * live or in the Recycle Bin) and must leave the pipeline usable; the database refuses it too,
   * which is what an import or a script would meet.
   */
  async editStage(
    tx: Tx,
    tenantId: string,
    pipelineId: string,
    stage: StageRecord,
    input: {
      version: number;
      name?: string | undefined;
      probability?: number | undefined;
      stageType?: StageKind | undefined;
    },
    holdsDeals: boolean,
    actorId: string,
  ): Promise<StageRecord> {
    if (stage.isRetired) {
      throw new ConflictError('This stage is retired. Restore it before changing it.');
    }
    if (stage.version !== input.version) throw new VersionConflictError('stage');

    const stages = await this.inUse(tx, tenantId, pipelineId);
    const patch: { name?: string; probability?: number; stageType?: StageKind } = {};

    if (input.name !== undefined) {
      const name = normalizeStageName(input.name);
      const nameProblem = stageNameProblem(name);
      if (nameProblem !== null) throw problem('name', nameProblem);
      this.assertNameFree(stages, name, stage.id);
      if (name !== stage.name) patch.name = name;
    }

    const stageType = input.stageType ?? stage.stageType;
    const retyped = stageType !== stage.stageType;
    if (retyped) {
      if (holdsDeals) {
        throw problem(
          'stageType',
          'Deals are in this stage, so its type cannot change. Move them out and retire it, then add a new stage of the type you want.',
        );
      }
      patch.stageType = stageType;
      assertUsableSet(
        stages.map((entry) =>
          entry.id === stage.id ? { ...entryOf(entry), stageType } : entryOf(entry),
        ),
      );
    }

    if (input.probability !== undefined || retyped) {
      const requested = input.probability ?? defaultProbabilityFor(stageType, stage.probability);
      const probability = probabilityFor(stageType, requested);
      if (probability === null) throw problem('probability', probabilityMessage(stageType));
      if (probability !== stage.probability) patch.probability = probability;
    }

    const updated = await this.repository.updateStage(
      tx,
      tenantId,
      stage.id,
      input.version,
      patch,
      actorId,
    );
    if (updated === null) throw new VersionConflictError('stage');
    if (retyped) await this.repository.bumpPipelineVersion(tx, tenantId, pipelineId, actorId);
    return toStageRecord(updated);
  }

  /** Set the order of the stages in use. */
  async reorderStages(
    tx: Tx,
    tenantId: string,
    pipeline: PipelineRecord,
    version: number,
    stageIds: readonly string[],
    actorId: string,
  ): Promise<{ changed: boolean; before: StageRecord[]; after: StageRecord[] }> {
    if (pipeline.version !== version) throw new VersionConflictError('pipeline');

    const before = await this.inUse(tx, tenantId, pipeline.id);
    const plan = planReorder(before.map(entryOf), stageIds);
    if (!plan.ok) {
      throw problem(
        'stageIds',
        plan.reason === 'duplicate'
          ? 'A stage is listed twice'
          : plan.reason === 'unknown'
            ? 'That list names a stage that is not in use in this pipeline'
            : 'That list leaves out a stage that is in use. Reload and try again.',
      );
    }

    const byId = new Map(before.map((stage) => [stage.id, stage]));
    const after = plan.ids.map((id) => byId.get(id) as StageRecord);
    assertUsableSet(after.map(entryOf));

    const unchanged = after.every((stage, index) => before[index]?.id === stage.id);
    if (unchanged) return { changed: false, before, after: before };

    await this.finishStructuralChange(tx, tenantId, pipeline.id, plan.ids, actorId);
    return { changed: true, before, after };
  }

  /**
   * Check that a stage may be retired and that its deals may go where the caller asked, and find
   * the stage the deals will move to. Throws the 422 the caller can act on; returns the target (or
   * null when the stage holds no deals and none was named).
   */
  async planRetirement(
    tx: Tx,
    tenantId: string,
    pipelineId: string,
    stage: StageRecord,
    input: { version: number; moveDealsToStageId?: string | undefined },
    dealCount: number,
    maxDeals: number,
    canMove: (from: StageKind, to: StageKind) => boolean,
  ): Promise<StageRecord | null> {
    if (stage.isRetired) throw new ConflictError('This stage is already retired');
    if (stage.version !== input.version) throw new VersionConflictError('stage');

    const stages = await this.inUse(tx, tenantId, pipelineId);
    const remaining = stages.filter((entry) => entry.id !== stage.id);
    assertUsableSet(remaining.map(entryOf));

    if (input.moveDealsToStageId === undefined) {
      if (dealCount > 0) {
        const noun = dealCount === 1 ? 'deal' : 'deals';
        throw problem(
          'moveDealsToStageId',
          `This stage holds ${dealCount} ${noun}. Choose a stage to move ${
            dealCount === 1 ? 'it' : 'them'
          } to.`,
        );
      }
      return null;
    }

    const target = remaining.find((entry) => entry.id === input.moveDealsToStageId);
    if (target === undefined) {
      throw problem('moveDealsToStageId', 'Choose another stage that is in use in this pipeline');
    }
    if (!canMove(stage.stageType, target.stageType)) {
      throw problem(
        'moveDealsToStageId',
        `Deals in ${article(stage.stageType)} stage can only move to another ${stage.stageType} stage. To win or lose deals, move them on the board.`,
      );
    }
    if (dealCount > maxDeals) {
      throw problem(
        'moveDealsToStageId',
        `This stage holds ${dealCount} deals, more than the ${maxDeals} that can be moved at once. Move some on the board first.`,
      );
    }
    return target;
  }

  /** Retire a stage whose deals have already moved, and close the gap in the order. */
  async retireStage(
    tx: Tx,
    tenantId: string,
    pipelineId: string,
    stage: StageRecord,
    version: number,
    actorId: string,
  ): Promise<StageRecord> {
    const retired = await this.repository.archiveStage(tx, tenantId, stage.id, version, actorId);
    if (retired === null) throw new VersionConflictError('stage');
    const remaining = await this.inUse(tx, tenantId, pipelineId);
    await this.finishStructuralChange(
      tx,
      tenantId,
      pipelineId,
      remaining.map((entry) => entry.id),
      actorId,
    );
    return toStageRecord(retired);
  }

  /** Bring a retired stage back, placed like a new stage of its type. */
  async restoreStage(
    tx: Tx,
    tenantId: string,
    pipelineId: string,
    stage: StageRecord,
    version: number,
    actorId: string,
  ): Promise<StageRecord> {
    if (!stage.isRetired) throw new ConflictError('This stage is not retired');
    if (stage.version !== version) throw new VersionConflictError('stage');

    const stages = await this.inUse(tx, tenantId, pipelineId);
    this.assertNameFree(stages, stage.name);

    const order: StageOrderEntry[] = stages.map(entryOf);
    order.splice(insertionIndex(order, stage.stageType), 0, entryOf(stage));
    assertUsableSet(order);

    const restored = await this.repository.restoreParkedStage(
      tx,
      tenantId,
      stage.id,
      version,
      actorId,
    );
    if (restored === null) throw new VersionConflictError('stage');
    await this.finishStructuralChange(
      tx,
      tenantId,
      pipelineId,
      order.map((entry) => entry.id),
      actorId,
    );
    const back = await this.findStageIn(tx, tenantId, pipelineId, stage.id);
    return back ?? toStageRecord(restored);
  }
}
