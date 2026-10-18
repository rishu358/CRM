# ADR-0030: Files are untrusted bytes in a private store; spreadsheets are untrusted both ways

- **Status:** Accepted
- **Date:** 2026-10-18

## Context

CLAUDE.md §5.11 and §5.12 were recorded as "not built" until something needed
them. Import and export are that something. They are two rules, and they are the
same rule seen from two ends: **a file is data the user controls, and a
spreadsheet is a program for whoever opens it.**

- §5.12: _validate type by magic bytes and size, store with random keys, serve via
  short-lived presigned URLs, never from the API process._
- §5.11: _escape CSV formula injection; exports are permission-checked and
  audited._

## Decision

### 1. The API never touches a file

There is no endpoint that accepts a file. `POST /imports` returns a presigned PUT
URL; the browser uploads straight to object storage. A download is a presigned GET
the browser follows. The API signs URLs and reads **metadata** (`head`); it has no
code path that reads or writes a file's bytes. The in-memory test provider counts
reads and writes and the API tests assert both stay at zero through a whole flow.

`StorageProvider` (`@crm/core`, ADR-0009) is deliberately missing `upload(file)` and
`serve(key)` — the two methods one would reach for first, and the two that would put
a request handler on the file path. The worker, which must parse bytes, gets
`openRead` (a stream it can abandon) and `readPrefix`.

### 2. Keys are random and mean nothing

`newStorageKey` is 256 bits from the CSPRNG under `tenants/<tenant>/<area>/`. The
filename is **never** part of a key (a user-typed name in a key is a traversal and
enumeration surface); it is stored for display only and sanitised again at
download (`safeDownloadName`: header-safe alphabet, no `..`, bounded). The tenant
prefix is for operators (lifecycle, erasure), not a security boundary: the boundary
is that keys are only handed out for rows RLS let the caller see, and that job
lookups are by creator as well as id. Neither the storage key nor the error-file key
is ever returned by the API.

### 3. Presigned URLs bind what they can

An upload URL is signed for an **exact size** and a **type chosen by the server from
the claimed format** — a presigned PUT cannot express a ceiling, only an exact size,
and "exactly what you said you would send" is the stronger rule. A body of another
length, another type, or a PUT to another key is refused by the store; a test
against a real S3-compatible server (MinIO, pinned by digest) proves each. Upload
URLs live 10 minutes, download URLs 5. A download is offered as an `attachment`,
never rendered.

`Content-Length` is not among the headers returned to the client: a browser cannot
set it (forbidden header name), it follows from the body, and the signature binds it
regardless.

### 4. Type is decided by bytes, and the claim must match

`detectUploadFormat` reads the first 8 KB:

- `PK\x03\x04` → a workbook _candidate_ (a zip is also a jar, a docx and a bomb);
- known binary signatures (PDF, PE, ELF, Mach-O, images, OLE2/legacy `.xls`, gzip,
  7z, rar, `#!`) → refused by name;
- otherwise it must look like text: no NUL, no stray control characters, valid UTF-8
  (BOM allowed; UTF-16 refused with a clear message);

and the result is **compared with what the filename claimed**. A `.csv` whose bytes
are a zip, and an `.xlsx` that is plain text, are both rejected: the mismatch is the
signal. It is ~100 lines with no dependency, on purpose — a security control that is
a library call changes behaviour when someone bumps a version.

### 5. A workbook is a zip bomb until proven otherwise

`inspectXlsxArchive` runs before any parser and **measures rather than believes**:
it reads the central directory (entry count, encryption, zip64, unsafe names, the
required `[Content_Types].xml` and `xl/workbook.xml`), then inflates every entry
through a counter that aborts the moment the running total passes 200 MB —
counting real output, not the declared size — and refuses a header that lies about
an entry's size or an entry whose real ratio is bomb-shaped. A 220 MB bomb in a
~1 MB file is rejected in a few seconds without being inflated in full.

Then, because ExcelJS's streaming reader assumes `workbook.xml` precedes the sheets
and writers disagree (ExcelJS's own order varies between runs — found by a test
that read the same workbook forty times), the validated archive is **re-ordered by
copying raw compressed bytes** (`reorderArchive`, no recompression) so legitimate
files from Excel, LibreOffice, Sheets and ExcelJS all parse.

### 6. Every dimension has a ceiling, before it costs anything

| Limit         | Value               | Answers                                                     |
| ------------- | ------------------- | ----------------------------------------------------------- |
| Upload size   | 25 MB               | signed into the URL; re-checked by `head` and while reading |
| Inflated size | 200 MB, **counted** | zip bomb                                                    |
| Inflate ratio | 100:1 above 1 MB    | zip bomb that stays under the total                         |
| Zip entries   | 100                 | entry-count bomb (a real workbook has ~12)                  |
| Rows          | 100,000             | above the 50,000 the spec asks for                          |
| Columns       | 200                 | "a sheet with a million columns" (XLSX allows 16,384)       |
| One cell      | 32,000 characters   | matches the `long_text` ceiling                             |
| Parse time    | 120 s               | a pathological file                                         |

All fail with a sentence for the user (never a stack trace, never file content) and
the worker survives.

### 7. Both parses validate, because the URL outlives the analysis

See ADR-0029 §7: analysis and staging each run the whole of `openUpload`, so an
object swapped between them is refused. A test swaps a valid CSV for a PDF of the
same size.

### 8. Formula injection: escape every cell, in the writer, with no list

A cell starting with `=`, `+`, `-`, `@`, tab or carriage return is executed by Excel
and Sheets when the file is opened — an exported customer name runs code on the
machine of whoever opens it, and the attacker never touches our servers. The fix is
one character: a leading apostrophe.

`toExportCell` is the only way a value reaches an output file. It is applied to
**every cell of every column**, in the CSV and XLSX writers, to the header row
(custom field labels are admin-written), and to the **import error file**, which
echoes the uploader's own cells and is therefore the one export whose contents an
attacker controls directly. There is no list of "columns to escape", because such a
list is out of date the next time someone adds a field. Line feed is escaped as well
as the policy's six: Excel strips leading whitespace before deciding, so a leading
newline is the same hole.

Tests cover each trigger character as its own case, on a system column, a custom
field, a header, and data that arrived through an import (the route by which an
attacker gets a string of their choosing into a tenant), and then assert that **no
cell in the whole file** starts with a trigger.

Two judgement calls:

- **A negative number in a CSV is escaped** (`'-5`). The rule is by first character,
  not by whether a value looks dangerous; an exception for "pure numbers" is an
  exception someone will extend. In XLSX a typed number is written as a number (a
  numeric cell cannot be a formula, and text-typed numbers would make the sheet's own
  columns unsummable); every string is escaped, whatever its content.
- **XLSX strings are escaped too**, though a string cell in the file format is not a
  formula, because a re-save, a CSV conversion or a paste into another tool turns
  that string into a cell that is.

An exported file round-trips: the importer undoes exactly our own escape
(`unescapeSpreadsheetCell`: an apostrophe before a trigger character) and nothing
else, and the next export escapes it again, so undoing it opens nothing.

Exports carry a UTF-8 byte-order mark: Excel opens a BOM-less UTF-8 CSV as the
system code page.

## Consequences

- A new `@crm/storage` package holds the S3 adapter (AWS SDK v3, the only place it
  is imported), an in-memory provider for tests, and the configuration both apps
  share. `docker compose` runs MinIO (digest-pinned); `pnpm infra:up` creates the
  bucket, blocks public access, sets a 2-day lifecycle rule and a CORS rule for the
  web origin. Production needs the same CORS rule on its bucket, or the browser's
  upload is refused.
- New dependencies, beyond the CLAUDE.md §2 table: `exceljs` (streaming XLSX),
  `csv-parse`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`,
  `@aws-sdk/lib-storage` (streamed multipart writes), and `testcontainers` as a dev
  dependency of the storage package. `exceljs` pulls in several deprecated
  transitive packages (`fstream`, `glob@7`, `rimraf@2`, `uuid@8`); it is the one to
  watch in `pnpm audit`, and the parser is isolated in one file (`parse.ts`) so
  replacing it is bounded.
- MIME sniffing is a **negative** test for CSV (there is no CSV signature): "plausibly
  text and not recognisably anything else". It stops an executable or an image named
  `.csv`; it cannot stop a text file that is not really a customer list, and does not
  try to.
- Malware scanning is P1 (MVP_SPEC §8) and not built. The seam is `openUpload`.
- Record **attachments** (the other thing §5.12 was written for) are not built. When
  they are, they reuse `StorageProvider`, `newStorageKey`, `detectUploadFormat` (with
  its signature list extended) and the same presigned flow; nothing here is specific
  to spreadsheets except `inspectXlsxArchive` and the limits table.

## Alternatives considered

- **Upload through the API.** Rejected by §5.12, and it would put a 25 MB body on the
  request path of every other user.
- **A MIME-sniffing library.** Rejected for the reason in §4; the signature list is
  short, explicit, and reviewable.
- **Trust the zip headers.** The classic bomb. Rejected: counted, not declared.
- **Read the workbook non-streaming.** Rejected: a DOM of a 200 MB sheet is gigabytes
  and would not "fail cleanly rather than exhaust the worker".
- **CSV library with an `escape_formulas` option.** Rejected: an option can be left
  off. The writer is ten lines in which there is nothing to leave off.
