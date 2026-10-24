import type { StorageProvider } from '@crm/core';
import { MemoryStorageProvider } from './memory.js';
import { S3StorageProvider } from './s3.js';

/**
 * The storage settings a process needs, as its environment provides them (CLAUDE.md §5.8).
 *
 * The variables themselves, their defaults and their documentation are declared once, in
 * `@crm/env`'s registry (ADR-0044), where the API and the worker both read them, so the two
 * processes cannot disagree about where files live. This is only the shape `createStorageProvider`
 * needs: both apps' loaded environments satisfy it as they are, and this package depends on no
 * configuration package. Nothing here reads `process.env`.
 *
 * `memory` exists for tests and cannot work across processes (the API and the worker would each get
 * their own empty store), so it is refused in production and is not what `pnpm dev` uses: dev runs
 * MinIO from docker-compose.
 */
export interface StorageEnv {
  readonly STORAGE_PROVIDER: 's3' | 'memory';
  readonly S3_BUCKET: string;
  readonly S3_REGION: string;
  /** Internal address of an S3-compatible store. Omit for AWS S3 itself. */
  readonly S3_ENDPOINT?: string | undefined;
  /** The address a *browser* reaches the store at, when it differs from the above. */
  readonly S3_PUBLIC_ENDPOINT?: string | undefined;
  readonly S3_ACCESS_KEY_ID?: string | undefined;
  readonly S3_SECRET_ACCESS_KEY?: string | undefined;
  /** MinIO needs this; S3 and R2 do not. */
  readonly S3_FORCE_PATH_STYLE: boolean;
}

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
