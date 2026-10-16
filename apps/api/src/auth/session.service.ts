import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { API_ENV_TOKEN } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import type { ApiEnv } from '../config/env.js';

/**
 * Session verification (ADR-0014).
 *
 * Runs as `crm_auth`, which has no grant on any business table, so this layer
 * cannot reach customer data even if it is wrong.
 *
 * What the database stores is the SHA-256 of the token, never the token, so a
 * stolen backup yields nothing usable. SHA-256 (rather than a slow password
 * hash) is correct here: the token is 32 random bytes, so there is no low
 * entropy to protect against brute force, and session lookup is on the hot path
 * of every request.
 */
export interface VerifiedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly activeTenantId: string | null;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 32 bytes of CSPRNG output, base64url encoded. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

interface SessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly active_tenant_id: string | null;
  readonly token_hash: string;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  /**
   * Resolve a bearer token into a session, or null.
   *
   * Every disqualifying condition is checked in SQL so there is no path where
   * an expired or revoked session is loaded and then forgotten about:
   *   - not revoked
   *   - not expired
   *   - issued at or after the user's `sessions_valid_from`, which a password
   *     change bumps so every other device is signed out in one write
   *   - the user is not soft-deleted
   */
  async verify(token: string): Promise<VerifiedSession | null> {
    if (token.length < 16 || token.length > 512) return null;
    const tokenHash = hashSessionToken(token);

    const rows = await this.database.runAsAuth(async (tx) => {
      const result = await tx.execute(sql`
        select s.id, s.user_id, s.active_tenant_id, s.token_hash
        from sessions s
        join users u on u.id = s.user_id
        where s.token_hash = ${tokenHash}
          and s.revoked_at is null
          and s.expires_at > now()
          and s.created_at >= u.sessions_valid_from
          and u.deleted_at is null
        limit 1
      `);
      return result.rows as unknown as SessionRow[];
    });

    const row = rows[0];
    if (row === undefined) return null;

    // The lookup above already matched on the hash, so this is belt-and-braces
    // against a future change that widens the query; constant-time either way.
    if (!constantTimeEquals(row.token_hash, tokenHash)) return null;

    return {
      sessionId: row.id,
      userId: row.user_id,
      activeTenantId: row.active_tenant_id,
    };
  }

  /**
   * Create a session for a user. Returns the raw token, which is the only time
   * it exists outside the client.
   *
   * Credential verification is **not** done here — that belongs to the sign-in
   * flow. Nothing may call this without having authenticated the user first.
   */
  async issue(
    userId: string,
    options: {
      tenantId?: string | null;
      ipAddress?: string | null;
      userAgent?: string | null;
    } = {},
  ): Promise<{ token: string; sessionId: string }> {
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + this.env.SESSION_TTL_DAYS * 24 * 3600 * 1000);

    const rows = await this.database.runAsAuth(async (tx) => {
      const result = await tx.execute(sql`
        insert into sessions (id, user_id, token_hash, expires_at, active_tenant_id, ip_address, user_agent)
        values (
          gen_random_uuid(), ${userId}, ${tokenHash}, ${expiresAt.toISOString()},
          ${options.tenantId ?? null}, ${options.ipAddress ?? null}, ${options.userAgent ?? null}
        )
        returning id
      `);
      return result.rows as unknown as { id: string }[];
    });

    const sessionId = rows[0]?.id;
    if (sessionId === undefined) throw new Error('Failed to create session');
    return { token, sessionId };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.database.runAsAuth((tx) =>
      tx.execute(sql`update sessions set revoked_at = now() where id = ${sessionId}`),
    );
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
