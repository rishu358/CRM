import { createHash } from 'node:crypto';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';

/**
 * The keys a stored secret may be under, and which one new ones are written with (ADR-0049).
 *
 * What is encrypted at rest with `AUTH_SECRET` is the authenticator (MFA) secrets and backup codes. A
 * single key with nothing recording which key wrote a value makes rotating it all or nothing: change it
 * and every enrolled authenticator is unreadable. So each stored value says which key it is under:
 *
 *     k1.<key id>.<ciphertext>
 *
 * The key id is a short hash of the key (never the key), derived rather than configured, so there is
 * nothing to keep in step. Writing always uses the current key. Reading finds the key by its id among
 * the current key and `AUTH_SECRET_PREVIOUS`. A value written before this format existed has no id and
 * is tried against each key in turn: the cipher is authenticated, so a wrong key fails rather than
 * returning noise.
 *
 * Rotation is then: add the old key as a previous one, deploy the new one, re-encrypt what is stored
 * (`pnpm auth:rotate-keys`), and only then drop the old key.
 */
const FORMAT = 'k1';

/** The id of a key: 8 hex characters of a domain-separated hash. It identifies; it does not reveal. */
export function keyId(secret: string): string {
  return createHash('sha256').update(`crm.key-id.v1\0${secret}`, 'utf8').digest('hex').slice(0, 8);
}

/** A stored value names a key this process does not hold. Says which id, never a key. */
export class UnknownKeyError extends Error {
  constructor(readonly id: string) {
    super(
      `A stored secret is encrypted with key ${id}, which is not AUTH_SECRET or in AUTH_SECRET_PREVIOUS. ` +
        'Add the key it was written with to AUTH_SECRET_PREVIOUS.',
    );
    this.name = 'UnknownKeyError';
  }
}

/** A stored value could not be opened with any key held, and does not say which was used. */
export class UndecryptableError extends Error {
  constructor() {
    super(
      'A stored secret could not be decrypted with AUTH_SECRET or any key in AUTH_SECRET_PREVIOUS. ' +
        'It was written with a key that is no longer held.',
    );
    this.name = 'UndecryptableError';
  }
}

const SEPARATOR = /\./;

export class KeyRing {
  private readonly current: { readonly id: string; readonly secret: string };
  private readonly all: readonly { readonly id: string; readonly secret: string }[];

  /**
   * `previous` is newest first. Each key must be distinct: two keys with one id could not be told
   * apart, and a previous key equal to the current one is a mistake worth stopping on.
   */
  constructor(current: string, previous: readonly string[] = []) {
    const keys = [current, ...previous].map((secret) => ({ id: keyId(secret), secret }));
    if (new Set(keys.map((key) => key.id)).size !== keys.length) {
      throw new Error('AUTH_SECRET and AUTH_SECRET_PREVIOUS must all be different keys');
    }
    this.current = keys[0] as { id: string; secret: string };
    this.all = keys;
  }

  /** The id new values are written under: safe to log and to show an operator. */
  get currentId(): string {
    return this.current.id;
  }

  /** Every key held, as the secrets a signer may verify against. Current first. */
  secrets(): string[] {
    return this.all.map((key) => key.secret);
  }

  async encrypt(plaintext: string): Promise<string> {
    const ciphertext = await symmetricEncrypt({ key: this.current.secret, data: plaintext });
    return `${FORMAT}.${this.current.id}.${ciphertext}`;
  }

  async decrypt(stored: string): Promise<string> {
    const parsed = parse(stored);
    if (parsed === null) {
      // Written before key ids existed: no way to know which key, so try them, current first.
      for (const key of this.all) {
        try {
          return await symmetricDecrypt({ key: key.secret, data: stored });
        } catch {
          // Not this key.
        }
      }
      throw new UndecryptableError();
    }

    const key = this.all.find((candidate) => candidate.id === parsed.id);
    if (key === undefined) throw new UnknownKeyError(parsed.id);
    try {
      return await symmetricDecrypt({ key: key.secret, data: parsed.ciphertext });
    } catch {
      throw new UndecryptableError();
    }
  }

  /** Whether this value is anything other than the current format under the current key. */
  needsRotation(stored: string): boolean {
    const parsed = parse(stored);
    return parsed === null || parsed.id !== this.current.id;
  }

  /** The key a stored value is under, or `legacy` for one written before key ids. For reports. */
  idOf(stored: string): string {
    return parse(stored)?.id ?? 'legacy';
  }
}

function parse(stored: string): { id: string; ciphertext: string } | null {
  const parts = stored.split(SEPARATOR);
  if (parts.length !== 3 || parts[0] !== FORMAT) return null;
  const [, id, ciphertext] = parts as [string, string, string];
  return /^[0-9a-f]{8}$/.test(id) && ciphertext !== '' ? { id, ciphertext } : null;
}
