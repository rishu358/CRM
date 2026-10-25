import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { verifyPassword as verifyLegacyScrypt } from 'better-auth/crypto';
import { API_ENV_TOKEN, type ApiEnv } from '../../config/env.js';

const argon2Async = promisify(argon2);

/**
 * Password hashing (ADR-0017, ADR-0050).
 *
 * New passwords are hashed with **Argon2id**, by Node's own `crypto.argon2` (Node 24.7+): no dependency
 * and no native add-on of ours. The stored form is the standard PHC string
 *
 *     $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>
 *
 * so the cost it was made with travels with it, and raising the settings later does not strand anyone: a
 * password hashed at an older setting still verifies, and `needsRehash` says it should be moved to the
 * current one the next time its owner proves they know it.
 *
 * Passwords hashed before this (Better Auth's scrypt, `salt:hash`) still verify, through Better Auth's own
 * verifier, and are upgraded the same way. That keeps every existing account working with no reset.
 *
 * Behind an interface (ADR-0009): nothing outside `crypto/` imports a Better Auth symbol.
 *
 * ## What is chosen here and what is not
 *
 * The algorithm, the salt (16 random bytes from the CSPRNG, one per hash), the tag length (32) and the
 * constant-time comparison are fixed here. The cost (memory, passes, lanes) is configuration, with
 * floors, so a deployment can make hashing slower and cannot make it weaker than the OWASP minimum.
 *
 * ## Verifying a password that does not exist
 *
 * `verifyDummy` is called when the address matched no user, against a dummy hash made at the current
 * settings. A sign-in that returns instantly for unknown addresses and after ~100ms for known ones is a
 * user-enumeration oracle that no amount of careful wording in the response body fixes.
 */
export const PASSWORD_HASHER = 'PASSWORD_HASHER';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  /**
   * Whether a hash that has just verified should be replaced: it is in an older format, or was made
   * with weaker settings than are configured now. Never true for a hash that is already current.
   */
  needsRehash(hash: string): boolean;
  /** Burn comparable time when there is no hash to check against. */
  verifyDummy(password: string): Promise<void>;
}

export interface Argon2Settings {
  /** Memory in KiB. */
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
}

const SALT_BYTES = 16;
const TAG_BYTES = 32;
const VERSION = 19;

/**
 * Ceilings on what a stored hash may ask a verification to spend. The hash comes from our own database,
 * so this is not defence against an attacker so much as against corruption and a bad restore: a mangled
 * `m=` must not become a request for gigabytes. Above the ceiling a hash is unparseable, and a failed
 * sign-in, not an outage.
 */
const MAX_MEMORY_KIB = 1_048_576;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 8;

interface Parsed {
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly salt: Buffer;
  readonly tag: Buffer;
}

const PHC =
  /^\$argon2id\$v=19\$m=(\d{1,8}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]{11,})\$([A-Za-z0-9+/]{6,})$/;

function parse(stored: string): Parsed | null {
  const match = PHC.exec(stored);
  if (match === null) return null;
  const [, m, t, p, salt, tag] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const memory = Number(m);
  const passes = Number(t);
  const parallelism = Number(p);
  if (
    memory < 8 * parallelism ||
    memory > MAX_MEMORY_KIB ||
    passes < 1 ||
    passes > MAX_PASSES ||
    parallelism < 1 ||
    parallelism > MAX_PARALLELISM
  ) {
    return null;
  }
  const saltBytes = Buffer.from(salt, 'base64');
  const tagBytes = Buffer.from(tag, 'base64');
  if (saltBytes.length < 8 || tagBytes.length < 16) return null;
  return { memory, passes, parallelism, salt: saltBytes, tag: tagBytes };
}

/** PHC strings carry unpadded base64. */
const b64 = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');

async function derive(
  password: string,
  salt: Buffer,
  settings: Argon2Settings,
  tagLength: number,
): Promise<Buffer> {
  return argon2Async('argon2id', {
    message: password,
    nonce: salt,
    parallelism: settings.parallelism,
    tagLength,
    memory: settings.memory,
    passes: settings.passes,
  });
}

@Injectable()
export class Argon2idPasswordHasher implements PasswordHasher {
  private readonly settings: Argon2Settings;
  private dummy: Promise<string> | null = null;

  constructor(@Inject(API_ENV_TOKEN) env: ApiEnv) {
    this.settings = {
      memory: env.PASSWORD_HASH_MEMORY_KIB,
      passes: env.PASSWORD_HASH_PASSES,
      parallelism: env.PASSWORD_HASH_PARALLELISM,
    };
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const tag = await derive(password, salt, this.settings, TAG_BYTES);
    const { memory, passes, parallelism } = this.settings;
    return `$argon2id$v=${String(VERSION)}$m=${String(memory)},t=${String(passes)},p=${String(parallelism)}$${b64(salt)}$${b64(tag)}`;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    // Anything that is not one of ours is a hash from before Argon2id (Better Auth's `salt:key`).
    // It is Better Auth's to verify; a string it cannot parse is a failed sign-in, not a 500: throwing
    // would turn "this row is odd" into an outage for one user and a stack trace in the logs.
    if (!hash.startsWith('$argon2')) return this.verifyLegacy(hash, password);

    const parsed = parse(hash);
    if (parsed === null) return false;
    try {
      const candidate = await derive(password, parsed.salt, parsed, parsed.tag.length);
      return candidate.length === parsed.tag.length && timingSafeEqual(candidate, parsed.tag);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    const parsed = hash.startsWith('$argon2') ? parse(hash) : null;
    // Not ours (the old scrypt format) or unreadable: replace it, since it has just verified.
    if (parsed === null) return true;
    return (
      parsed.memory < this.settings.memory ||
      parsed.passes < this.settings.passes ||
      parsed.parallelism < this.settings.parallelism ||
      parsed.salt.length < SALT_BYTES ||
      parsed.tag.length < TAG_BYTES
    );
  }

  async verifyDummy(password: string): Promise<void> {
    // A real hash of a value nobody knows, made once at the current settings. Generated rather than
    // hard-coded: a constant in the source would be the same on every deployment.
    this.dummy ??= this.hash(
      `no-such-user-${randomBytes(12).toString('hex')}${String(Date.now())}`,
    );
    await this.verify(await this.dummy, password);
  }

  private async verifyLegacy(hash: string, password: string): Promise<boolean> {
    try {
      return await verifyLegacyScrypt({ hash, password });
    } catch {
      return false;
    }
  }
}
