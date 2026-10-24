import {
  assertProductionConfig,
  productionConfigProblems,
  type ProductionConfigInput,
} from '@crm/core';
import { loadEnv, type EnvFor, type EnvSource } from '@crm/env';

/**
 * The API's configuration (CLAUDE.md §5.8, ADR-0044).
 *
 * The variables, their types, defaults and documentation are declared once, in `@crm/env`'s
 * registry; this module asks it for the API's scope and then applies the production rules
 * (`@crm/core`), which need the whole picture rather than one variable at a time. Nothing here, or
 * anywhere else in the application, reads `process.env`.
 *
 * Validated once at boot so a missing secret stops the process immediately rather than surfacing as
 * a confusing 500 on the first request that needs it. Errors name the variable, never its value.
 */
export type ApiEnv = EnvFor<'api'>;

export function loadApiEnv(source?: EnvSource): ApiEnv {
  const env = loadEnv('api', source);
  // A production process with development settings does not start (ADR-0041).
  assertProductionConfig(productionInput(env));
  return env;
}

function productionInput(env: ApiEnv): ProductionConfigInput {
  return {
    nodeEnv: env.NODE_ENV,
    scope: 'api',
    authSecret: env.AUTH_SECRET,
    emailProvider: env.EMAIL_PROVIDER,
    emailFrom: env.EMAIL_FROM,
    resendApiKey: env.RESEND_API_KEY,
    storageProvider: env.STORAGE_PROVIDER,
    s3AccessKeyId: env.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY,
    s3PublicEndpoint: env.S3_PUBLIC_ENDPOINT,
    webUrl: env.WEB_URL,
    apiUrl: env.API_URL,
    corsOrigins: env.CORS_ORIGINS,
    databaseUrls: { DATABASE_URL: env.DATABASE_URL, DATABASE_AUTH_URL: env.DATABASE_AUTH_URL },
    redisUrl: env.REDIS_URL,
  };
}

/** Things worth a log line at startup that are not reasons to refuse (production only). */
export function productionWarnings(env: ApiEnv): readonly string[] {
  return productionConfigProblems(productionInput(env)).warnings;
}

export function corsOrigins(env: ApiEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** DI token for the validated environment. */
export const API_ENV_TOKEN = 'API_ENV';

/** Whether Google sign-in is configured. Both halves, or neither. */
export function googleConfigured(
  env: ApiEnv,
): env is ApiEnv & { GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string } {
  return (
    typeof env.GOOGLE_CLIENT_ID === 'string' &&
    env.GOOGLE_CLIENT_ID.length > 0 &&
    typeof env.GOOGLE_CLIENT_SECRET === 'string' &&
    env.GOOGLE_CLIENT_SECRET.length > 0
  );
}
