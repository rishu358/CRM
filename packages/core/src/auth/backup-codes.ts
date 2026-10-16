import { createHash, randomInt } from 'node:crypto';

/**
 * MFA backup codes (MVP_SPEC M1).
 *
 * The thing backup codes are actually for is the person whose phone is in a
 * river. That is a bad moment to be typing a case-sensitive string of
 * lookalike characters off a printout, so the alphabet drops the characters
 * that are read wrong — 0/O, 1/I/L — and the codes are compared
 * case-insensitively after separators are stripped.
 *
 * They are stored as SHA-256 digests, not in the clear: a backup code is a
 * password equivalent, and ten of them per user is ten more chances for a
 * database leak to become an account takeover. SHA-256 is enough here because
 * the code is 40 bits of CSPRNG output with no human-chosen structure.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const GROUP_LENGTH = 4;
const GROUPS = 2;

export const BACKUP_CODE_COUNT = 10;

/** `A2C4-E6G8`. Generated with `randomInt`, which is rejection-sampled. */
export function generateBackupCode(): string {
  const groups: string[] = [];
  for (let group = 0; group < GROUPS; group += 1) {
    let value = '';
    for (let index = 0; index < GROUP_LENGTH; index += 1) {
      value += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(value);
  }
  return groups.join('-');
}

export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  // A Set, because two identical codes in one batch would silently give the
  // user nine codes while telling them they have ten.
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateBackupCode());
  return [...codes];
}

/**
 * What goes in the database, and what a typed code is compared against.
 *
 * Normalising before hashing is what makes "a2c4 e6g8" work: the user is not
 * going to reproduce the dashes and the capitals, and refusing them teaches
 * nothing except that backup codes do not work.
 */
export function normaliseBackupCode(code: string): string {
  return code.replaceAll(/[^0-9A-Za-z]/g, '').toUpperCase();
}

export function hashBackupCode(code: string): string {
  return createHash('sha256').update(normaliseBackupCode(code), 'utf8').digest('hex');
}

export function hashBackupCodes(codes: readonly string[]): string[] {
  return codes.map(hashBackupCode);
}

/**
 * Find a matching unused code, or null.
 *
 * Returns the index so the caller can remove exactly that one: a backup code
 * is single-use, and "used" has to mean removed from the stored set, not
 * marked somewhere the verification path does not read.
 */
export function findBackupCode(hashes: readonly string[], candidate: string): number | null {
  const target = hashBackupCode(candidate);
  const index = hashes.indexOf(target);
  return index === -1 ? null : index;
}
