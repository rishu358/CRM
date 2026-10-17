import { z } from 'zod';

/**
 * What counts as an acceptable password (MVP_SPEC M1).
 *
 * Length first, composition second. NIST SP 800-63B is explicit that
 * composition rules ("one uppercase, one symbol") buy far less than length and
 * push people towards `Password1!`, so the floor is 12 characters and the
 * composition requirement is deliberately mild: not all one kind of character.
 *
 * The cap exists because the input is hashed with scrypt, and an unbounded
 * password is an unbounded amount of work for anyone who can POST to sign-in.
 *
 * Lives in core so the API and the web form reject exactly the same strings. A
 * form that accepts what the API refuses is a user typing a password twice and
 * being told nothing useful.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

/** Rejected outright regardless of length. Short, and about this product. */
const FORBIDDEN = new Set([
  'password',
  'passw0rd',
  'password123',
  'letmein12345',
  'qwertyuiop12',
  '123456789012',
  'administrator',
  'crmcrmcrmcrm',
]);

export function passwordProblems(password: string): string[] {
  const problems: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Use at least ${String(PASSWORD_MIN_LENGTH)} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`Use at most ${String(PASSWORD_MAX_LENGTH)} characters`);
  }
  if (FORBIDDEN.has(password.toLowerCase())) {
    problems.push('This password is too common');
  }

  // "More than one kind of character" rather than a checklist of required
  // classes: it rules out `aaaaaaaaaaaa` and `123456789012` without pushing
  // everyone to the same predictable shape.
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;
  if (password.length < 20 && classes < 2) {
    problems.push('Mix letters with numbers or symbols, or use a longer passphrase');
  }

  return problems;
}

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH)
  .superRefine((value, ctx) => {
    for (const message of passwordProblems(value)) {
      ctx.addIssue({ code: 'custom', message });
    }
  });

/**
 * Email as we store it: trimmed and lowercased.
 *
 * The column is `citext`, so comparison is case-insensitive either way, but
 * normalising on the way in means the address shown back to someone is the one
 * they will see in every other place too.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(320, 'Email address is too long');
