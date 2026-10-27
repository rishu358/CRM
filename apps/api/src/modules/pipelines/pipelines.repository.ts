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
  gte,
  isNotNull,
  isNull,
  sql,
} from '@crm/db';

/**
 * Where a stage waits, while it is being placed in the order, so it collides with nothing.
 *
 * Positions of the stages in use are unique (a partial unique index), and a reorder rewrites them
 * one row at a time. Parking a row here, and parking the others at negative numbers, means no
 * statement ever has to land on a position another row still holds. Only one stage is parked at a
 * time, because every editor write holds the pipeline row's lock.
 */
const PARKING_POSITION = -1_000_000_000;

/**
 * Data access for pipelines and their stages.
 *
 * Only the pipelines service calls this. Deals reach pipelines through
 * `PipelinesService`, never through this class or its tables (ADR-0001).
 *
 * Every query runs inside the caller's tenant-scoped transaction, so RLS adds
 * the tenant predicate; the explicit `tenant_id` comparisons are belt and
 * braces, not the actual isolation.
 *
 * A **retired** stage (`archived_at` set) is not part of a pipeline any more: the readers below
 * that feed the board, the dashboard and new deals leave it out. Only the `*Any*` and `*All*`
 * readers, which the editor and history lookups use, see it.
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

  /** The stages in use in one pipeline, in board order. */
  async stagesOf(tx: Tx, tenantId: string, pipelineId: string): Promise<PipelineStage[]> {
    return tx
      .select()
      .from(pipelineStages)
      .where(
        and(
          eq(pipelineStages.tenantId, tenantId),
          eq(pipelineStages.pipelineId, pipelineId),
          isNull(pipelineStages.archivedAt),
        ),
      )
      .orderBy(asc(pipelineStages.position), asc(pipelineStages.id));
  }

  /** The stages in use in every pipeline. */
  async allStages(tx: Tx, tenantId: string): Promise<PipelineStage[]> {
    return tx
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.tenantId, tenantId), isNull(pipelineStages.archivedAt)))
      .orderBy(asc(pipelineStages.position), asc(pipelineStages.id));
  }

  /**
   * Every stage there has ever been, retired ones included.
   *
   * What reports that count deals by the type of their stage need: a won deal is won whatever
   * became of its stage's row.
   */
  async allStagesAny(tx: Tx, tenantId: string): Promise<PipelineStage[]> {
    return tx
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.tenantId, tenantId))
      .orderBy(asc(pipelineStages.position), asc(pipelineStages.id));
  }

  /** The editor's view of one pipeline's stages: in use in board order, then retired, newest first. */
  async stagesForEditor(tx: Tx, tenantId: string): Promise<PipelineStage[]> {
    const rows = await this.allStagesAny(tx, tenantId);
    const inUse = rows.filter((row) => row.archivedAt === null);
    const retired = rows
      .filter((row) => row.archivedAt !== null)
      .sort((a, b) => (b.archivedAt?.getTime() ?? 0) - (a.archivedAt?.getTime() ?? 0));
    return [...inUse, ...retired];
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

  /**
   * Take the pipeline's row lock. Every editor write starts here, which is what makes two writes to
   * one pipeline happen one after the other: two reorders, a reorder and a retirement, two renames.
   */
  async lockPipeline(tx: Tx, tenantId: string, id: string): Promise<Pipeline | null> {
    const rows = await tx
      .select()
      .from(pipelines)
      .where(
        and(eq(pipelines.tenantId, tenantId), eq(pipelines.id, id), eq(pipelines.isActive, true)),
      )
      .limit(1)
      .for('update');
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

  /** A stage by id, in use or retired. Retired stages are still how history names a stage. */
  async findStage(tx: Tx, tenantId: string, id: string): Promise<PipelineStage | null> {
    const rows = await tx
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.tenantId, tenantId), eq(pipelineStages.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * A stage by id with a shared row lock, for a deal about to be placed in it.
   *
   * The retirement locks the same row exclusively before it moves the deals, so a deal being put
   * into a stage and a stage being retired cannot both succeed: one waits for the other, and the
   * placement that waits re-reads the row and sees the stage retired.
   */
  async findStageForPlacement(tx: Tx, tenantId: string, id: string): Promise<PipelineStage | null> {
    const rows = await tx
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.tenantId, tenantId), eq(pipelineStages.id, id)))
      .limit(1)
      .for('share');
    return rows[0] ?? null;
  }

  /** A stage by id with an exclusive row lock: the retirement's first step on the stage. */
  async lockStage(tx: Tx, tenantId: string, id: string): Promise<PipelineStage | null> {
    const rows = await tx
      .select()
      .from(pipelineStages)
      .where(and(eq(pipelineStages.tenantId, tenantId), eq(pipelineStages.id, id)))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /** Add a stage. It waits at the parking position until `writeOrder` places it. */
  async insertParkedStage(
    tx: Tx,
    values: Pick<
      typeof pipelineStages.$inferInsert,
      'id' | 'tenantId' | 'pipelineId' | 'name' | 'probability' | 'stageType' | 'createdBy'
    >,
  ): Promise<PipelineStage> {
    const rows = await tx
      .insert(pipelineStages)
      .values({ ...values, position: PARKING_POSITION, updatedBy: values.createdBy ?? null })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * Edit a stage's name, probability or type, guarded by the version the caller read.
   * Null means the version moved.
   */
  async updateStage(
    tx: Tx,
    tenantId: string,
    id: string,
    expectedVersion: number,
    patch: Partial<Pick<typeof pipelineStages.$inferInsert, 'name' | 'probability' | 'stageType'>>,
    actorId: string,
  ): Promise<PipelineStage | null> {
    const rows = await tx
      .update(pipelineStages)
      .set({ ...patch, updatedBy: actorId, updatedAt: new Date(), version: expectedVersion + 1 })
      .where(
        and(
          eq(pipelineStages.tenantId, tenantId),
          eq(pipelineStages.id, id),
          eq(pipelineStages.version, expectedVersion),
          isNull(pipelineStages.archivedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Retire a stage. The database refuses if it still holds a deal. Null means the version moved. */
  async archiveStage(
    tx: Tx,
    tenantId: string,
    id: string,
    expectedVersion: number,
    actorId: string,
  ): Promise<PipelineStage | null> {
    const now = new Date();
    const rows = await tx
      .update(pipelineStages)
      .set({
        archivedAt: now,
        archivedBy: actorId,
        updatedBy: actorId,
        updatedAt: now,
        version: expectedVersion + 1,
      })
      .where(
        and(
          eq(pipelineStages.tenantId, tenantId),
          eq(pipelineStages.id, id),
          eq(pipelineStages.version, expectedVersion),
          isNull(pipelineStages.archivedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Bring a retired stage back, parked until `writeOrder` places it. Null means the version moved. */
  async restoreParkedStage(
    tx: Tx,
    tenantId: string,
    id: string,
    expectedVersion: number,
    actorId: string,
  ): Promise<PipelineStage | null> {
    const rows = await tx
      .update(pipelineStages)
      .set({
        archivedAt: null,
        archivedBy: null,
        position: PARKING_POSITION,
        updatedBy: actorId,
        updatedAt: new Date(),
        version: expectedVersion + 1,
      })
      .where(
        and(
          eq(pipelineStages.tenantId, tenantId),
          eq(pipelineStages.id, id),
          eq(pipelineStages.version, expectedVersion),
          isNotNull(pipelineStages.archivedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Give the stages in use positions 0, 1, 2 ... in this order.
   *
   * Two steps in the caller's transaction, so no statement meets a position another row still
   * holds: the stages already placed move to negative numbers (a stage parked by
   * `insertParkedStage` or `restoreParkedStage` is already out of the way), then each gets its
   * final position. The unique index on the stages in use is the backstop, not the mechanism.
   */
  async writeOrder(
    tx: Tx,
    tenantId: string,
    pipelineId: string,
    orderedIds: readonly string[],
    actorId: string,
  ): Promise<void> {
    await tx
      .update(pipelineStages)
      .set({ position: sql`-1 - ${pipelineStages.position}` })
      .where(
        and(
          eq(pipelineStages.tenantId, tenantId),
          eq(pipelineStages.pipelineId, pipelineId),
          isNull(pipelineStages.archivedAt),
          gte(pipelineStages.position, 0),
        ),
      );

    const now = new Date();
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(pipelineStages)
        .set({ position: index, updatedBy: actorId, updatedAt: now })
        .where(
          and(
            eq(pipelineStages.tenantId, tenantId),
            eq(pipelineStages.pipelineId, pipelineId),
            eq(pipelineStages.id, id),
            isNull(pipelineStages.archivedAt),
          ),
        );
    }
  }

  /** The pipeline's version moves on whenever its set or order of stages does. */
  async bumpPipelineVersion(
    tx: Tx,
    tenantId: string,
    id: string,
    actorId: string,
  ): Promise<Pipeline> {
    const rows = await tx
      .update(pipelines)
      .set({ version: sql`${pipelines.version} + 1`, updatedBy: actorId, updatedAt: new Date() })
      .where(and(eq(pipelines.tenantId, tenantId), eq(pipelines.id, id)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('Pipeline vanished while locked');
    return row;
  }
}
