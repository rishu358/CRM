import {
  assertProductionConfig,
  productionConfigProblems,
  type ProductionConfigInput,
} from '@crm/core';
import { loadEnv, type EnvFor, type EnvSource } from '@crm/env';

/**
 * The worker's configuration (CLAUDE.md §5.8, ADR-0044).
 *
 * Declared once, in `@crm/env`'s registry: the worker connects as `crm_worker` (tenant-scoped, plus
 * cross-tenant outbox reads), optionally as `crm_erasure` (the narrow audit-redaction path, ADR-0032;
 * leaving it unset makes an erasure request fail loudly instead of erasing a record and leaving its
 * history intact), and reads no session secret, public API address or CORS list. Nothing here reads
 * `process.env`.
 */
export type WorkerEnv = EnvFor<'worker'>;

export function loadWorkerEnv(source?: EnvSource): WorkerEnv {
  const env = loadEnv('worker', source);
  // A production process with development settings does not start (ADR-0041).
  assertProductionConfig(productionInput(env));
  return env;
}

function productionInput(env: WorkerEnv): ProductionConfigInput {
  return {
    nodeEnv: env.NODE_ENV,
    scope: 'worker',
    emailProvider: env.EMAIL_PROVIDER,
    emailFrom: env.EMAIL_FROM,
    resendApiKey: env.RESEND_API_KEY,
    sesRegion: env.SES_REGION,
    sesAccessKeyId: env.SES_ACCESS_KEY_ID,
    sesSecretAccessKey: env.SES_SECRET_ACCESS_KEY,
    storageProvider: env.STORAGE_PROVIDER,
    s3AccessKeyId: env.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY,
    s3PublicEndpoint: env.S3_PUBLIC_ENDPOINT,
    webUrl: env.WEB_URL,
    databaseUrls: {
      DATABASE_URL: env.DATABASE_URL,
      DATABASE_WORKER_URL: env.DATABASE_WORKER_URL,
      DATABASE_ERASURE_URL: env.DATABASE_ERASURE_URL,
    },
  };
}

/** Things worth a log line at startup that are not reasons to refuse (production only). */
export function productionWarnings(env: WorkerEnv): readonly string[] {
  return productionConfigProblems(productionInput(env)).warnings;
}
