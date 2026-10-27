import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  canMoveDealsBetween,
  ConflictError,
  MAX_DEALS_MOVED_PER_RETIREMENT,
  NotFoundError,
  type Actor,
} from '@crm/core';
import type {
  ManagedPipeline,
  ManagedStage,
  StageArchiveInput,
  StageArchiveResult,
  StageCreateInput,
  StageOrderInput,
  StageRestoreInput,
  StageUpdateInput,
} from '@crm/contracts';
import type { Tx } from '@crm/db';
import { isConstraintViolation } from '../../common/db-errors.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { IdempotencyService } from '../../platform/idempotency.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { DealsService } from '../deals/deals.service.js';
import {
  PipelinesService,
  type PipelineRecord,
  type StageRecord,
} from '../pipelines/pipelines.service.js';

type DealCounts = Map<string, { live: number; recycleBin: number }>;

const NO_DEALS = { live: 0, recycleBin: 0 };

function toManagedStage(stage: StageRecord, counts: DealCounts): ManagedStage {
  const held = counts.get(stage.id) ?? NO_DEALS;
  return {
    id: stage.id,
    name: stage.name,
    position: stage.position,
    probability: stage.probability,
    stageType: stage.stageType,
    version: stage.version,
    archivedAt: stage.archivedAt === null ? null : stage.archivedAt.toISOString(),
    dealCount: held.live,
    recycleBinDealCount: held.recycleBin,
  };
}

function toManagedPipeline(
  pipeline: PipelineRecord,
  stages: readonly StageRecord[],
  counts: DealCounts,
): ManagedPipeline {
  return {
    id: pipeline.id,
    name: pipeline.name,
    position: pipeline.position,
    isDefault: pipeline.isDefault,
    version: pipeline.version,
    stages: stages.map((stage) => toManagedStage(stage, counts)),
  };
}

/**
 * The pipeline and stage editor (MVP_SPEC M5, M9; ADR-0062).
 *
 * The same five steps every module follows, in the same order:
 *   1. authorize with `can()` against the `pipeline` object before anything else
 *   2. enforce the stage rules (in `PipelinesService`, beside the data)
 *   3. do the write, the audit entry and the outbox event in ONE transaction
 *   4. answer with the whole pipeline as the editor now sees it
 *
 * It is a module of its own because it needs both the pipelines (to edit them) and the deals (to
 * count what a stage holds and to move deals out of one being retired), and deals already depends
 * on pipelines: putting it in either would make the two modules depend on each other.
 *
 * Every write starts by locking the pipeline's row, so two edits to one pipeline run one after the
 * other. Someone holding a stale copy is told so with a 409 (a stage's `version` for a rename, the
 * pipeline's for a reorder), never silently overwritten.
 *
 * A pipeline that is not in the caller's company is a 404, exactly like a pipeline that does not
 * exist: RLS hides it, and nothing here distinguishes the two.
 */
@Injectable()
export class PipelineEditorService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PipelinesService) private readonly pipelines: PipelinesService,
    @Inject(DealsService) private readonly deals: DealsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  async list(actor: Actor): Promise<ManagedPipeline[]> {
    assertCan(actor, 'read', { objectType: 'pipeline' });

    return this.inTenant(actor, async (tx) => {
      const [view, counts] = await Promise.all([
        this.pipelines.editorView(tx, actor.tenantId),
        this.deals.countsByStage(tx, actor.tenantId),
      ]);
      return view.map((entry) => toManagedPipeline(entry.pipeline, entry.stages, counts));
    });
  }

  async createStage(
    actor: Actor,
    pipelineId: string,
    input: StageCreateInput,
    idempotencyKey?: string,
  ): Promise<ManagedPipeline> {
    assertCan(actor, 'create', { objectType: 'pipeline' });

    return this.inTenant(actor, (tx) =>
      this.idempotency.once(
        tx,
        actor,
        idempotencyKey,
        { objectType: 'pipeline_stage', action: 'create' },
        { pipelineId, ...input },
        async () => {
          await this.lockOrNotFound(tx, actor, pipelineId);
          const stage = await this.pipelines.addStage(
            tx,
            actor.tenantId,
            pipelineId,
            input,
            actor.userId,
          );

          await this.audit.record(tx, actor, {
            action: 'create',
            objectType: 'pipeline_stage',
            recordId: stage.id,
            changes: {
              name: { new: stage.name },
              stageType: { new: stage.stageType },
              probability: { new: stage.probability },
            },
          });
          await this.outbox.publish(tx, actor, {
            eventType: 'pipeline_stage.created.v1',
            objectType: 'pipeline_stage',
            recordId: stage.id,
            payload: {
              pipelineId,
              name: stage.name,
              stageType: stage.stageType,
              probability: stage.probability,
            },
          });

          return {
            answer: await this.managed(tx, actor, pipelineId),
            reference: { recordId: stage.id, pipelineId },
          };
        },
        (reference) => this.managed(tx, actor, String(reference['pipelineId'] ?? pipelineId)),
      ),
    );
  }

  async updateStage(
    actor: Actor,
    pipelineId: string,
    stageId: string,
    input: StageUpdateInput,
  ): Promise<ManagedPipeline> {
    assertCan(actor, 'update', { objectType: 'pipeline' });

    return this.inTenant(actor, async (tx) => {
      await this.lockOrNotFound(tx, actor, pipelineId);
      const stage = await this.pipelines.findStageIn(tx, actor.tenantId, pipelineId, stageId);
      if (stage === null) throw new NotFoundError('Stage');

      const held = (await this.deals.countsByStage(tx, actor.tenantId)).get(stage.id);
      const holdsDeals = held !== undefined && held.live + held.recycleBin > 0;

      const updated = await this.translateRetire(() =>
        this.pipelines.editStage(
          tx,
          actor.tenantId,
          pipelineId,
          stage,
          input,
          holdsDeals,
          actor.userId,
        ),
      );

      const changes: Record<string, { old?: unknown; new?: unknown }> = {};
      if (updated.name !== stage.name) changes['name'] = { old: stage.name, new: updated.name };
      if (updated.probability !== stage.probability) {
        changes['probability'] = { old: stage.probability, new: updated.probability };
      }
      if (updated.stageType !== stage.stageType) {
        changes['stageType'] = { old: stage.stageType, new: updated.stageType };
      }

      if (Object.keys(changes).length > 0) {
        await this.audit.record(tx, actor, {
          action: 'update',
          objectType: 'pipeline_stage',
          recordId: stage.id,
          changes,
        });
        await this.outbox.publish(tx, actor, {
          eventType: 'pipeline_stage.updated.v1',
          objectType: 'pipeline_stage',
          recordId: stage.id,
          payload: { pipelineId, changedFields: Object.keys(changes) },
        });
      }

      return this.managed(tx, actor, pipelineId);
    });
  }

  async orderStages(
    actor: Actor,
    pipelineId: string,
    input: StageOrderInput,
  ): Promise<ManagedPipeline> {
    assertCan(actor, 'update', { objectType: 'pipeline' });

    return this.inTenant(actor, async (tx) => {
      const pipeline = await this.lockOrNotFound(tx, actor, pipelineId);
      const result = await this.pipelines.reorderStages(
        tx,
        actor.tenantId,
        pipeline,
        input.version,
        input.stageIds,
        actor.userId,
      );

      if (result.changed) {
        await this.audit.record(tx, actor, {
          action: 'update',
          objectType: 'pipeline',
          recordId: pipelineId,
          changes: {
            stageOrder: {
              old: result.before.map((stage) => stage.name),
              new: result.after.map((stage) => stage.name),
            },
          },
        });
        await this.outbox.publish(tx, actor, {
          eventType: 'pipeline.stages_reordered.v1',
          objectType: 'pipeline',
          recordId: pipelineId,
          payload: { stageIds: result.after.map((stage) => stage.id) },
        });
      }

      return this.managed(tx, actor, pipelineId);
    });
  }

  /**
   * Retire a stage: move its deals, then retire it, in one transaction.
   *
   * The order matters. The stage row is locked first, so a deal being placed in it either finishes
   * first (and is moved with the rest) or waits and then finds it retired. The deals move through
   * `DealsService.moveOutOfStage`, the same stage rules a drag uses; only then is the stage marked
   * retired, which the database allows only once nothing is left in it.
   */
  async archiveStage(
    actor: Actor,
    pipelineId: string,
    stageId: string,
    input: StageArchiveInput,
  ): Promise<StageArchiveResult> {
    assertCan(actor, 'delete', { objectType: 'pipeline' });

    return this.inTenant(actor, async (tx) => {
      await this.lockOrNotFound(tx, actor, pipelineId);
      const stage = await this.pipelines.lockStageIn(tx, actor.tenantId, pipelineId, stageId);
      if (stage === null) throw new NotFoundError('Stage');

      const held = (await this.deals.countsByStage(tx, actor.tenantId)).get(stage.id) ?? NO_DEALS;
      const target = await this.pipelines.planRetirement(
        tx,
        actor.tenantId,
        pipelineId,
        stage,
        input,
        held.live + held.recycleBin,
        MAX_DEALS_MOVED_PER_RETIREMENT,
        canMoveDealsBetween,
      );

      const moved =
        target === null
          ? NO_DEALS
          : await this.deals.moveOutOfStage(
              actor,
              tx,
              stage,
              target,
              MAX_DEALS_MOVED_PER_RETIREMENT,
            );

      await this.translateRetire(() =>
        this.pipelines.retireStage(
          tx,
          actor.tenantId,
          pipelineId,
          stage,
          input.version,
          actor.userId,
        ),
      );

      await this.audit.record(tx, actor, {
        action: 'delete',
        objectType: 'pipeline_stage',
        recordId: stage.id,
        changes: {
          name: { old: stage.name },
          movedDealsTo: { new: target?.name ?? null },
          movedDeals: { new: moved.live },
          movedRecycleBinDeals: { new: moved.recycleBin },
        },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'pipeline_stage.archived.v1',
        objectType: 'pipeline_stage',
        recordId: stage.id,
        payload: {
          pipelineId,
          name: stage.name,
          movedToStageId: target?.id ?? null,
          movedDeals: moved.live,
          movedRecycleBinDeals: moved.recycleBin,
        },
      });

      return {
        pipeline: await this.managed(tx, actor, pipelineId),
        movedDeals: moved.live,
        movedRecycleBinDeals: moved.recycleBin,
      };
    });
  }

  async restoreStage(
    actor: Actor,
    pipelineId: string,
    stageId: string,
    input: StageRestoreInput,
  ): Promise<ManagedPipeline> {
    assertCan(actor, 'update', { objectType: 'pipeline' });

    return this.inTenant(actor, async (tx) => {
      await this.lockOrNotFound(tx, actor, pipelineId);
      const stage = await this.pipelines.findStageIn(tx, actor.tenantId, pipelineId, stageId);
      if (stage === null) throw new NotFoundError('Stage');

      await this.pipelines.restoreStage(
        tx,
        actor.tenantId,
        pipelineId,
        stage,
        input.version,
        actor.userId,
      );

      await this.audit.record(tx, actor, {
        action: 'restore',
        objectType: 'pipeline_stage',
        recordId: stage.id,
        changes: { name: { new: stage.name } },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'pipeline_stage.restored.v1',
        objectType: 'pipeline_stage',
        recordId: stage.id,
        payload: { pipelineId, name: stage.name },
      });

      return this.managed(tx, actor, pipelineId);
    });
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }

  private async lockOrNotFound(tx: Tx, actor: Actor, pipelineId: string): Promise<PipelineRecord> {
    const pipeline = await this.pipelines.lockPipeline(tx, actor.tenantId, pipelineId);
    if (pipeline === null) throw new NotFoundError('Pipeline');
    return pipeline;
  }

  /** The pipeline as the editor sees it now, read inside the same transaction as the write. */
  private async managed(tx: Tx, actor: Actor, pipelineId: string): Promise<ManagedPipeline> {
    const [view, counts] = await Promise.all([
      this.pipelines.editorViewOf(tx, actor.tenantId, pipelineId),
      this.deals.countsByStage(tx, actor.tenantId),
    ]);
    if (view === null) throw new NotFoundError('Pipeline');
    return toManagedPipeline(view.pipeline, view.stages, counts);
  }

  /**
   * The database's own refusals, said in the module's words.
   *
   * The service checks everything first, so these are the cases it cannot see from where it stands:
   * a deal that reached a stage between the check and the write (a retirement the trigger refused),
   * or two stages claiming one name or position (the unique indexes). Either is a "try again" for
   * the person holding a stale screen, not a 500.
   */
  private async translateRetire<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isConstraintViolation(error, 'pipeline_stages_empty_before_retire')) {
        throw new ConflictError('A deal was added to this stage just now. Reload and try again.');
      }
      if (isConstraintViolation(error, 'pipeline_stages_type_stable')) {
        throw new ConflictError('Deals are in this stage, so its type cannot change');
      }
      if (
        isConstraintViolation(error, 'pipeline_stages_active_name_key') ||
        isConstraintViolation(error, 'pipeline_stages_active_position_key')
      ) {
        throw new ConflictError('The pipeline was changed by someone else. Reload and try again.');
      }
      throw error;
    }
  }
}
