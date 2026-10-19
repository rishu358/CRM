import { Injectable } from '@nestjs/common';
import { exportJobs, type ExportJob, type NewExportJob, type Tx, and, eq } from '@crm/db';

/**
 * Data access for export jobs. By creator as well as id, like imports: an
 * export's file is a slice of the customer list, and only the person who asked
 * for it has any claim to it.
 */
@Injectable()
export class ExportsRepository {
  /** Null when the idempotency key already names a job. */
  async insert(tx: Tx, values: NewExportJob): Promise<ExportJob | null> {
    const rows = await tx.insert(exportJobs).values(values).onConflictDoNothing().returning();
    return rows[0] ?? null;
  }

  async findOwn(tx: Tx, tenantId: string, userId: string, id: string): Promise<ExportJob | null> {
    const rows = await tx
      .select()
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.tenantId, tenantId),
          eq(exportJobs.createdBy, userId),
          eq(exportJobs.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findByIdempotencyKey(
    tx: Tx,
    tenantId: string,
    userId: string,
    key: string,
  ): Promise<ExportJob | null> {
    const rows = await tx
      .select()
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.tenantId, tenantId),
          eq(exportJobs.createdBy, userId),
          eq(exportJobs.idempotencyKey, key),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}
