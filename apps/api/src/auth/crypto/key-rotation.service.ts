import { Inject, Injectable } from '@nestjs/common';
import { sql } from '@crm/db';
import { DatabaseService } from '../../database/database.service.js';
import { KeyRing } from './key-ring.js';

/** What a pass over the stored secrets found and did. Counts and key ids only: never a secret. */
export interface RotationReport {
  readonly dryRun: boolean;
  /** Every authenticator secret and backup-code list stored. */
  readonly total: number;
  /** Already under the current key in the current format. Left alone. */
  readonly current: number;
  /** Re-encrypted under the current key (or, in a dry run, that would be). */
  readonly rotated: number;
  /** Could not be opened with any key held: the key that wrote them is not in AUTH_SECRET_PREVIOUS. */
  readonly unreadable: number;
  /** Changed by a request between being read and being written; a second pass picks them up. */
  readonly changedMeanwhile: number;
  /** How many values were under each key id (`legacy` for those written before key ids). */
  readonly keys: Readonly<Record<string, number>>;
}

const PAGE = 200;

/**
 * Re-encrypts stored authenticator secrets under the current `AUTH_SECRET` (ADR-0049).
 *
 * Run after a new `AUTH_SECRET` is deployed with the old one in `AUTH_SECRET_PREVIOUS`, until nothing is
 * left under an old key; only then is the old key removed. It is safe to run any number of times and
 * while the application is serving: a row is read, re-encrypted in memory, and written back **only if
 * it is still what was read**, so a user using a backup code at the same moment is never overwritten
 * with a stale list. `last_used_at` is not touched.
 *
 * Runs as the auth role, the only one that reads `mfa_factors`. Not injectable from outside this
 * module: it is reached by `pnpm auth:rotate-keys`, never by a request.
 */
@Injectable()
export class KeyRotationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(KeyRing) private readonly keys: KeyRing,
  ) {}

  /**
   * `userIds` limits the pass to those users' secrets. The command does not use it; it exists so a
   * test can rotate its own rows without touching rows other tests are using in the same database.
   */
  async rotate(options: { dryRun: boolean; userIds?: readonly string[] }): Promise<RotationReport> {
    const only = options.userIds === undefined ? null : [...options.userIds];
    // Zero users named is a pass over nothing, not over everyone.
    const scope =
      only === null
        ? sql``
        : only.length === 0
          ? sql`and false`
          : sql`and user_id in (${sql.join(
              only.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`;
    const seen = new Map<string, number>();
    let total = 0;
    let current = 0;
    let rotated = 0;
    let unreadable = 0;
    let changedMeanwhile = 0;

    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const page = await this.database.runAsAuth(async (tx) => {
        const result = await tx.execute(sql`
          select id, secret from mfa_factors
            where id > ${after}::uuid
              ${scope}
            order by id limit ${PAGE}
        `);
        return result.rows as unknown as { id: string; secret: string }[];
      });
      if (page.length === 0) break;

      await this.database.runAsAuth(async (tx) => {
        for (const row of page) {
          total += 1;
          const id = this.keys.idOf(row.secret);
          seen.set(id, (seen.get(id) ?? 0) + 1);

          if (!this.keys.needsRotation(row.secret)) {
            current += 1;
            continue;
          }

          let plaintext: string;
          try {
            plaintext = await this.keys.decrypt(row.secret);
          } catch {
            unreadable += 1;
            continue;
          }
          if (options.dryRun) {
            rotated += 1;
            continue;
          }

          const next = await this.keys.encrypt(plaintext);
          const updated = await tx.execute(sql`
            update mfa_factors set secret = ${next}
            where id = ${row.id}::uuid and secret = ${row.secret}
          `);
          if ((updated.rowCount ?? 0) === 1) rotated += 1;
          else changedMeanwhile += 1;
        }
      });

      after = (page[page.length - 1] as { id: string }).id;
      if (page.length < PAGE) break;
    }

    return {
      dryRun: options.dryRun,
      total,
      current,
      rotated,
      unreadable,
      changedMeanwhile,
      keys: Object.fromEntries([...seen].sort(([a], [b]) => a.localeCompare(b))),
    };
  }
}
