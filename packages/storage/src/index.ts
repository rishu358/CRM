import { randomBytes } from 'node:crypto';

export * from './s3.js';
export * from './memory.js';
export * from './config.js';

/**
 * A storage key nobody can guess or influence (CLAUDE.md §5.12).
 *
 * 256 bits from the OS CSPRNG, URL-safe. The **filename is never part of it**:
 * a name the user typed in a key is a path-traversal and enumeration
 * surface, and the original name is kept in the database for display only.
 * The tenant prefix is for operators (lifecycle rules, per-tenant erasure); it
 * is not a security boundary and nothing relies on it being one — the
 * boundary is that keys are only ever handed out for rows RLS let the caller
 * see.
 */
export function newStorageKey(tenantId: string, area: 'imports' | 'exports', suffix = ''): string {
  return `tenants/${tenantId}/${area}/${randomBytes(32).toString('base64url')}${suffix}`;
}

/** Derived, not random: the error file for an import is found from the job. */
export function importErrorFileKey(storageKey: string): string {
  return `${storageKey}.errors.csv`;
}
