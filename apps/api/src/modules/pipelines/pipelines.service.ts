import { Inject, Injectable } from '@nestjs/common';
import { assertCan, ValidationError, type Actor, type StageKind } from '@crm/core';
import type { Pipeline as PipelineContract } from '@crm/contracts';
import type { PipelineStage, Tx } from '@crm/db';
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
}

function toStageInfo(row: PipelineStage): StageInfo {
  return {
    id: row.id,
    pipelineId: row.pipelineId,
    name: row.name,
    position: row.position,
    probability: row.probability,
    stageType: row.stageType,
  };
}

/**
 * Pipelines and stages (MVP_SPEC M5).
 *
 * Read-only in this module: tenants get a seeded default pipeline, and a demo
 * tenant gets a second one. Creating and reshaping pipelines is an admin
 * feature (MVP_SPEC M9) that needs its own permission object — pipelines are
 * configuration, not records — and that is a decision to take with M3, not to
 * sneak in here as a side door through `deal` permissions.
 *
 * Authorization is the deal grant: anybody who may read deals may see the
 * pipelines that deals sit in, because a board with no column names is not a
 * board. A caller with no deal read grant gets a plain 403.
 *
 * The public methods taking a `tx` are the way the deals module reaches this
 * one (CLAUDE.md §3): a service call inside the caller's own transaction, so a
 * deal write and the stage lookup it depends on see the same snapshot.
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

  /** The stages of a pipeline in board order, or null when it is not usable. */
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
    const stages = await this.repository.allStages(tx, tenantId);
    return stages.filter((stage) => stage.stageType === kind).map((stage) => stage.id);
  }

  async pipelineIsUsable(tx: Tx, tenantId: string, pipelineId: string): Promise<boolean> {
    return (await this.repository.findPipeline(tx, tenantId, pipelineId)) !== null;
  }

  async findStage(tx: Tx, tenantId: string, stageId: string): Promise<StageInfo | null> {
    const row = await this.repository.findStage(tx, tenantId, stageId);
    return row === null ? null : toStageInfo(row);
  }

  /** Where a deal with no stage of its own starts: the pipeline's first open stage. */
  async firstOpenStage(tx: Tx, tenantId: string, pipelineId: string): Promise<StageInfo | null> {
    const stages = await this.repository.stagesOf(tx, tenantId, pipelineId);
    const first = stages.find((stage) => stage.stageType === 'open');
    return first === undefined ? null : toStageInfo(first);
  }
}
