import type { ImportJob as ImportJobContract } from '@crm/contracts';
import type { ImportTarget } from '@crm/core';
import type { ImportJob } from '@crm/db';

/**
 * An import job as the API returns it.
 *
 * Nothing here is field-permission filtered, because nothing here is a record:
 * the preview rows are the user's own file, read back to them, and the counts
 * are counts. What *is* permission-shaped is `targets`, which the service
 * computes per caller from field metadata and their write permissions.
 *
 * `storageKey` and `errorFileKey` are deliberately absent. They are the
 * capability to read a file; a client that held one would hold a way to
 * ask for it without going through the audited link endpoint.
 */
export function serializeImportJob(
  job: ImportJob,
  extra: { targets?: ImportTarget[]; matchFields?: readonly string[] } = {},
): ImportJobContract {
  return {
    id: job.id,
    objectType: job.objectType,
    status: job.status,
    fileName: job.fileName,
    claimedFormat: job.claimedFormat,
    detectedFormat: job.detectedFormat ?? null,
    sizeBytes: job.sizeBytes ?? null,
    columns: job.columns ?? null,
    preview: job.preview ?? null,
    mapping: job.mapping === null ? null : job.mapping.map((entry) => ({ ...entry })),
    duplicateMode: job.duplicateMode ?? null,
    matchField: job.matchField ?? null,
    totalRows: job.totalRows ?? null,
    processedRows: job.processedRows,
    createdCount: job.createdCount,
    updatedCount: job.updatedCount,
    skippedCount: job.skippedCount,
    failedCount: job.failedCount,
    hasErrorFile: job.errorFileKey !== null,
    dryRun: job.dryRun,
    failureReason: job.failureReason ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    ...(extra.targets === undefined
      ? {}
      : {
          targets: extra.targets.map((target) => ({
            key: target.key,
            label: target.label,
            type: target.type,
            required: target.required,
            isSystem: target.isSystem,
            ...(target.options === undefined ? {} : { options: [...target.options] }),
          })),
        }),
    ...(extra.matchFields === undefined ? {} : { matchFields: [...extra.matchFields] }),
  };
}
