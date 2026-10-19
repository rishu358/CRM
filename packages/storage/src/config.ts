import type { StorageProvider } from '@crm/core';
import { z } from 'zod';
import { MemoryStorageProvider } from './memory.js';
import { S3StorageProvider } from './s3.js';

/**
 * Storage configuration, shared by the API and the worker (CLAUDE.md §5.8).
 *
 * Both processes must agree on where files live, and the cheapest way to make
 * disagreement impossible is for both to spread this one shape into their own
 * env schema and call one factory. Neither reads `process.env` here; each app's
 * own `env.ts` remains the only place that does.
 *
 * `memory` exists for tests and cannot work across processes (the API and the
 * worker would each get their own empty store), so it is refused in production
 * and is not what `pnpm dev` uses: dev runs MinIO from docker-compose.
 */
export const storageEnvShape = {
  STORAGE_PROVIDER: z.enum(['s3', 'memory']).default('s3'),
  S3_BUCKET: z.string().min(1).default('crm-files'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  /** Internal address of an S3-compatible store. Omit for AWS S3 itself. */
  S3_ENDPOINT: z.string().optional(),
  /** The address a *browser* reaches the store at, when it differs from the above. */
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** MinIO needs this; S3 and R2 do not. */
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
};

export type StorageEnv = z.infer<z.ZodObject<typeof storageEnvShape>>;

export function createStorageProvider(env: StorageEnv, nodeEnv: string): StorageProvider {
  if (env.STORAGE_PROVIDER === 'memory') {
    if (nodeEnv === 'production') {
      throw new Error(
        'STORAGE_PROVIDER=memory cannot be used in production: the API and the worker ' +
          'would each hold their own empty store and no upload would ever be found.',
      );
    }
    return new MemoryStorageProvider();
  }

  if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    // Names the variables, never their values (CLAUDE.md §5.8).
    throw new Error('STORAGE_PROVIDER=s3 requires S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  }

  return new S3StorageProvider({
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}
