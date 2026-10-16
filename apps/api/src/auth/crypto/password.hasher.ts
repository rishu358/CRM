import { Injectable } from '@nestjs/common';
import { hashPassword, verifyPassword } from 'better-auth/crypto';

/**
 * Password hashing (ADR-0017).
 *
 * The implementation is Better Auth's: scrypt, with a random salt and the
 * parameters encoded into the stored string. We do not choose the parameters,
 * pick the salt, or write the comparison — those are precisely the three
 * places hand-rolled password handling goes wrong, and ADR-0014 exists to keep
 * us out of them.
 *
 * Behind an interface (ADR-0009) so that moving to Argon2id, or to a newer
 * parameter set, is one file and a rehash-on-login, not a search across the
 * codebase.
 *
 * ## Verifying a password that does not exist
 *
 * `verify` is also called when the address matched no user, against a dummy
 * hash. A sign-in that returns instantly for unknown addresses and after
 * ~100ms for known ones is a user-enumeration oracle that no amount of careful
 * wording in the response body fixes.
 */
export const PASSWORD_HASHER = 'PASSWORD_HASHER';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  /** Burn comparable time when there is no hash to check against. */
  verifyDummy(password: string): Promise<void>;
}

/**
 * A real hash of a value nobody knows, computed once at startup.
 *
 * Generated rather than hard-coded: a constant in the source would be the same
 * on every deployment, which is a small thing, but a free one to avoid.
 */
let dummyHash: Promise<string> | null = null;

@Injectable()
export class BetterAuthPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return hashPassword(password);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await verifyPassword({ hash, password });
    } catch {
      // A stored hash we cannot parse — from a future format, or corruption —
      // is a failed sign-in, not a 500. Throwing here would turn "this row is
      // odd" into an outage for one user and a stack trace in the logs.
      return false;
    }
  }

  async verifyDummy(password: string): Promise<void> {
    dummyHash ??= hashPassword(
      `no-such-user-${Math.random().toString(36).slice(2)}${String(Date.now())}`,
    );
    await this.verify(await dummyHash, password);
  }
}
