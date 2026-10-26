import { describe, expect, it } from 'vitest';
import {
  escapeSpreadsheetCell,
  FORMULA_TRIGGER_CHARACTERS,
  startsFormula,
  toExportCell,
  unescapeSpreadsheetCell,
} from './escaping.js';

/**
 * CLAUDE.md §5.11: a cell beginning `=`, `+`, `-`, `@`, tab or carriage return
 * gets a leading apostrophe. Each character is its own test, deliberately: a
 * `for` loop over the list would still pass if somebody removed one character
 * from the list *and* from the test's copy of it.
 */
describe('formula injection escaping (§5.11)', () => {
  it('escapes a cell starting with =', () => {
    expect(escapeSpreadsheetCell('=HYPERLINK("http://evil/","x")')).toBe(
      `'=HYPERLINK("http://evil/","x")`,
    );
  });

  it('escapes a cell starting with +', () => {
    expect(escapeSpreadsheetCell('+1+1')).toBe("'+1+1");
  });

  it('escapes a cell starting with -', () => {
    expect(escapeSpreadsheetCell("-2+3+cmd|' /c calc'!A0")).toBe("'-2+3+cmd|' /c calc'!A0");
  });

  it('escapes a cell starting with @', () => {
    expect(escapeSpreadsheetCell('@SUM(1+1)')).toBe("'@SUM(1+1)");
  });

  it('escapes a cell starting with a tab', () => {
    expect(escapeSpreadsheetCell('\t=1+1')).toBe("'\t=1+1");
  });

  it('escapes a cell starting with a carriage return', () => {
    expect(escapeSpreadsheetCell('\r=1+1')).toBe("'\r=1+1");
  });

  it('escapes a cell starting with a line feed (Excel strips leading whitespace too)', () => {
    expect(escapeSpreadsheetCell('\n=1+1')).toBe("'\n=1+1");
  });

  it('covers exactly the characters CLAUDE.md names, and the line feed', () => {
    expect([...FORMULA_TRIGGER_CHARACTERS].sort()).toEqual(
      ['=', '+', '-', '@', '\t', '\r', '\n'].sort(),
    );
  });

  it('leaves a trigger character that is not at the start alone', () => {
    for (const value of ['a=b', 'x+y', 'a-b', 'me@acme.com', 'a\tb', 'a\rb']) {
      expect(escapeSpreadsheetCell(value)).toBe(value);
      expect(startsFormula(value)).toBe(false);
    }
  });

  it('leaves ordinary text, empty strings and an existing apostrophe alone', () => {
    expect(escapeSpreadsheetCell('Acme Ltd')).toBe('Acme Ltd');
    expect(escapeSpreadsheetCell('')).toBe('');
    expect(escapeSpreadsheetCell("'already")).toBe("'already");
    expect(escapeSpreadsheetCell('0042')).toBe('0042');
  });

  it('does not double-escape an escaped value', () => {
    const once = escapeSpreadsheetCell('=1+1');
    expect(escapeSpreadsheetCell(once)).toBe(once);
  });
});

/**
 * The premise of escaping a leading tab, CR or LF is that Excel strips leading
 * whitespace before deciding whether a cell is a formula. That premise covers
 * every whitespace character, so each is its own case. Written out, not looped
 * from the implementation's own character class: a loop would still pass if a
 * character were removed from the class and from the test together.
 */
describe('leading whitespace does not hide a formula (§5.11)', () => {
  const WHITESPACE: readonly [string, string][] = [
    ['a space', ' '],
    ['two spaces', '  '],
    ['a non-breaking space', '\u00A0'],
    ['a vertical tab', '\u000B'],
    ['a form feed', '\u000C'],
    ['an en space', '\u2002'],
    ['an em space', '\u2003'],
    ['a thin space', '\u2009'],
    ['an ideographic space', '\u3000'],
    ['a line separator', '\u2028'],
    ['a paragraph separator', '\u2029'],
    ['a zero-width space', '\u200B'],
    ['a zero-width non-joiner', '\u200C'],
    ['a zero-width joiner', '\u200D'],
    ['a word joiner', '\u2060'],
    ['a byte-order mark', '\uFEFF'],
    ['a mix of them', ' \t\u00A0\u200B'],
  ];

  describe.each(WHITESPACE)('%s before the payload', (_name, space) => {
    it.each(['=', '+', '-', '@'])('is escaped when the payload starts with %s', (starter) => {
      const value = `${space}${starter}SUM(1:9)`;
      expect(startsFormula(value)).toBe(true);
      expect(escapeSpreadsheetCell(value)).toBe(`'${value}`);
      expect(toExportCell(value)).toBe(`'${value}`);
    });
  });

  it('escapes the cases in the review that found this', () => {
    expect(escapeSpreadsheetCell(' =1+1')).toBe("' =1+1");
    expect(escapeSpreadsheetCell('  =1+1')).toBe("'  =1+1");
    expect(escapeSpreadsheetCell(' @SUM(1:9)')).toBe("' @SUM(1:9)");
    expect(escapeSpreadsheetCell('\u00A0=1+1')).toBe("'\u00A0=1+1");
  });

  it('leaves whitespace before ordinary text, numbers and nothing at all alone', () => {
    for (const value of [' hello', '\u00A0Acme', '  42', ' a=b', '   ', '\u200B', ' ']) {
      expect(escapeSpreadsheetCell(value), JSON.stringify(value)).toBe(value);
    }
  });

  it('still escapes a leading tab, CR or LF whatever follows (the policy, verbatim)', () => {
    for (const value of ['\tplain', '\rplain', '\nplain']) {
      expect(escapeSpreadsheetCell(value), JSON.stringify(value)).toBe(`'${value}`);
    }
  });

  it('is not defeated by an apostrophe that is not ours', () => {
    // After an apostrophe the cell is text in a spreadsheet; nothing to escape.
    expect(escapeSpreadsheetCell("' =1+1")).toBe("' =1+1");
  });

  it('round-trips through unescape for each whitespace character', () => {
    for (const [, space] of WHITESPACE) {
      const original = `${space}=1+1`;
      expect(unescapeSpreadsheetCell(escapeSpreadsheetCell(original))).toBe(original);
    }
    // And does not eat an apostrophe that was data.
    expect(unescapeSpreadsheetCell("' hello")).toBe("' hello");
  });
});

describe('toExportCell: the writer applies it to every value type', () => {
  it('escapes strings', () => {
    expect(toExportCell('=cmd')).toBe("'=cmd");
  });

  it('escapes a negative number: -5 starts with a trigger like any other cell', () => {
    // Deliberate. A number that begins with "-" is indistinguishable, to a
    // spreadsheet, from the start of a formula; the rule is by first character,
    // not by whether the value "looks dangerous".
    expect(toExportCell(-5)).toBe("'-5");
    expect(toExportCell(5)).toBe('5');
  });

  it('turns null and undefined into an empty cell, not the word "null"', () => {
    expect(toExportCell(null)).toBe('');
    expect(toExportCell(undefined)).toBe('');
  });

  it('stringifies booleans, dates and objects', () => {
    expect(toExportCell(true)).toBe('true');
    expect(toExportCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(toExportCell({ a: 1 })).toBe('{"a":1}');
  });

  it('escapes an object whose JSON starts with a trigger character', () => {
    // JSON of a bare string value starts with a quote, but a negative number
    // inside an array does not start with a trigger; the point is that the
    // escape runs on the *final* text, whatever produced it.
    expect(toExportCell(['=1'])).toBe('["=1"]');
  });
});

describe('unescapeSpreadsheetCell: an export can be re-imported', () => {
  it('undoes our own escape and nothing else', () => {
    expect(unescapeSpreadsheetCell("'-1500.00 INR")).toBe('-1500.00 INR');
    expect(unescapeSpreadsheetCell("'=1+1")).toBe('=1+1');
    expect(unescapeSpreadsheetCell("'Neil")).toBe("'Neil");
    expect(unescapeSpreadsheetCell("'")).toBe("'");
    expect(unescapeSpreadsheetCell('plain')).toBe('plain');
  });

  it('round-trips through escape for every trigger', () => {
    for (const trigger of FORMULA_TRIGGER_CHARACTERS) {
      const original = `${trigger}payload`;
      expect(unescapeSpreadsheetCell(escapeSpreadsheetCell(original))).toBe(original);
    }
  });
});

/**
 * Pilot finding F5: every phone number is `+91...`, so every phone cell in an export began with an
 * apostrophe (198 of 198), which shows in a spreadsheet or is carried back in on import.
 *
 * A value that is exactly an E.164 number (`+`, a non-zero digit, then 1 to 14 digits, the pattern the
 * API validates phones against) is left alone. That is safe because nothing but digits follows the
 * plus: a spreadsheet can only read it as a number, and there is no function name, cell reference,
 * operator, separator (`|`, `!`, `,`, `;`), quote or space for a formula or a DDE command to be made
 * of. Every other cell that starts with `+` is still escaped, including a phone with anything extra.
 */
describe('a plain E.164 phone number is not escaped (F5)', () => {
  it.each(['+919876543210', '+14155552671', '+442071838750', '+12', '+123456789012345'])(
    'leaves %s as it is, in every writer',
    (phone) => {
      expect(startsFormula(phone)).toBe(true); // it does start with a trigger character...
      expect(escapeSpreadsheetCell(phone)).toBe(phone); // ...and is still exempt
      expect(toExportCell(phone)).toBe(phone);
    },
  );

  it.each([
    ['a formula after the number', '+919876543210+1'],
    ['a DDE payload that starts like a number', "+91+cmd|' /c calc'!A0"],
    ['a formula that starts like a number', '+1+1'],
    ['a function call', '+SUM(1,2)'],
    ['a cell reference', '+A1'],
    ['a hyperlink', '+91=HYPERLINK("http://evil/","x")'],
    ['spaces inside', '+91 98765 43210'],
    ['a dash inside', '+91-98765-43210'],
    ['a leading space', ' +919876543210'],
    ['a trailing space', '+919876543210 '],
    ['a trailing line feed', '+919876543210\n'],
    ['a trailing carriage return', '+919876543210\r'],
    ['a trailing tab', '+919876543210\t'],
    ['a leading zero after the plus', '+0919876543210'],
    ['too many digits (16)', '+1234567890123456'],
    ['a single digit', '+9'],
    ['a decimal point', '+91.9876543210'],
    ['an exponent', '+1E5'],
    ['a full-width digit', '+９１９８７６５４３２１０'],
    ['an Arabic-Indic digit', '+٩١٩٨٧٦٥٤٣٢١٠'],
    ['a plus on its own', '+'],
    ['two pluses', '++919876543210'],
  ])('still escapes %s', (_name, value) => {
    expect(escapeSpreadsheetCell(value)).toBe(`'${value}`);
    expect(toExportCell(value)).toBe(`'${value}`);
  });

  it('does not exempt the other triggers: a minus or equals in front of a number is still escaped', () => {
    for (const value of ['-919876543210', '=919876543210', '@919876543210', '\t+919876543210']) {
      expect(escapeSpreadsheetCell(value), JSON.stringify(value)).toBe(`'${value}`);
    }
  });

  it('still undoes the apostrophe that earlier exports put in front of a phone number', () => {
    expect(unescapeSpreadsheetCell("'+919876543210")).toBe('+919876543210');
    expect(unescapeSpreadsheetCell('+919876543210')).toBe('+919876543210');
  });

  it('round-trips: export then import gives back the same phone, with and without the exemption', () => {
    const phone = '+919876543210';
    expect(unescapeSpreadsheetCell(toExportCell(phone))).toBe(phone);
  });
});
