# ADR-0059: A plain E.164 phone number is not escaped in exports

- **Status:** Accepted
- **Date:** 2026-10-26

## Context

CLAUDE.md §5.11 and ADR-0030 §8 neutralise spreadsheet formulas by giving any cell that starts with
`=`, `+`, `-`, `@`, tab or carriage return a leading apostrophe. Phone numbers are stored in E.164
(`+919876543210`), so every phone cell in every export began with an apostrophe (pilot finding F5: 198 of
198). In a spreadsheet the apostrophe shows, and a file exported and imported again carried it in.

## Decision

A cell whose whole value matches `^\+[1-9][0-9]{1,14}$` (the pattern every phone field is validated against)
is written as it is. Everything else follows the old rule.

Why this does not open formula injection: after the plus there are only ASCII digits. A formula needs a
function name, a cell reference, an operator or a separator; a DDE command needs `|` and `!`. A value of
`+` and digits can be read as a number and as nothing else. The match is anchored at both ends, uses
`[0-9]` (no other script's digits), has no multiline flag (a trailing line break fails it), and allows at
most 15 digits. `+91+cmd|' /c calc'!A0`, `+919876543210+1`, `+91 98765 43210`, `+91=HYPERLINK(...)`,
`+A1`, a phone with a leading or trailing space, `++91...` and `+0...` are not matched and are escaped. The
exemption is by value, in the one shared writer, not by column, so there is still no list of "columns to
escape".

Our importer still undoes the apostrophe that earlier exports put in front of a phone number.

## Consequences

- The `.xlsx` export stores a phone as text and shows `+919876543210` as written. A CSV opened in Excel may
  be read by Excel as a number (the plus can be dropped), which is Excel's own behaviour and is not
  something a CSV can prevent without a formula (`="+91..."`), which this project will not write. Use the
  `.xlsx` export for people who open files in Excel. **Not checked in Excel itself**: no copy on this machine.
- A phone number written with spaces or dashes is not E.164 and is still escaped; the API does not store
  such values.
