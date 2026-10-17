import { Injectable } from '@nestjs/common';
import {
  pipelineStages,
  pipelines,
  type Pipeline,
  type PipelineStage,
  type Tx,
  and,
  asc,
  eq,
} from '@crm/db';

/**
 * Data access for pipelines and their stages.
 *
 * Only the pipelines service calls this. Deals reach pipelines through
 * `PipelinesService`, never through this class or its tables (ADR-0001).
 *
 * Every query runs inside the caller's tenant-scoped transaction, so RLS adds
 * the tenant predicate; the explicit `tenant_id` comparisons are belt and
 * braces, not the actual isolation.
 */
@Injectable()
export class PipelinesRepository {
  async listActive(tx: Tx, tenantId: string): Promise<Pipeline[]> {
    return tx
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.tenantId, tenantId), eq(pipelines.isActive, true)))
      .orderBy(asc(pipelines.position), asc(pipelines.id));
  }

  async stagesOf(tx: Tx, tenantId: string, pipelineId: string): Promise<PipelineStage[]> {
    return tx
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.tenantId, tenantId), eq(pipelineStages.pipelineId, pipelineId)))
      .orderBy(asc(pipelineStages.position), asc(pipelineStages.id));
  }

  async allStages(tx: Tx, tenantId: string): Promise<PipelineStage[]> {
    return tx
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.tenantId, tenantId))
      .orderBy(asc(pipelineStages.position), asc(pipelineStages.id));
  }

  async findPipeline(tx: Tx, tenantId: string, id: string): Promise<Pipeline | null> {
    const rows = await tx
      .select()
      .from(pipelines)
      .where(
        and(eq(pipelines.tenantId, tenantId), eq(pipelines.id, id), eq(pipelines.isActive, true)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findDefault(tx: Tx, tenantId: string): Promise<Pipeline | null> {
    const rows = await tx
      .select()
      .from(pipelines)
      .where(
        and(
          eq(pipelines.tenantId, tenantId),
          eq(pipelines.isDefault, true),
          eq(pipelines.isActive, true),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findStage(tx: Tx, tenantId: string, id: string): Promise<PipelineStage | null> {
    const rows = await tx
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.tenantId, tenantId), eq(pipelineStages.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }
}
