# ADR-0035: A record attachment is an untrusted file with somebody else's name on it

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

MVP_SPEC §6.1 names an `attachments` table and §M4 puts files on the record
page. ADR-0030 built the file-safety path for import and export and closed by
saying what was left: _"Record attachments (the other thing §5.12 was written
for) are not built. When they are, they reuse `StorageProvider`,
`newStorageKey`, `detectUploadFormat` (with its signature list extended) and
the same presigned flow."_ `docs/SECURITY_REVIEW.md` row 12 says the same in
terms. This is that work.

An attachment is not simply another record that happens to hold bytes. Three
of its properties are chosen by one user and acted on by another, and each one
lands somewhere that does something with it:

- the **filename** reaches a `Content-Disposition` header and a save dialog, so
  it can carry header syntax, path separators, or a right-to-left override that
  makes `invoice‮gnp.exe` render to a reader as `invoice exe.png`;
- the **content type** decides whether a browser renders the bytes or saves
  them, and an SVG or an HTML file rendered from an origin that holds this
  app's session is stored XSS;
- the **bytes** are whatever the uploader liked, whatever the name claims.

And it hangs off a polymorphic `(object_type, record_id)` pair, which ADR-0005
was explicit has **no foreign key** — so neither integrity on write nor cleanup
on delete comes from the database.

## Decision

### 1. Permission is the record's, not the attachment's

There is no `attachment` object type in the permissions model and no
`role_permissions` backfill in the migration. Reading a record's files requires
`read` on that record; adding or removing one requires `update` on it. Both are
judged by `can()` through the module that **owns** the record
(`AttachmentTargetsService` → each module's `allowsRecordAction`), with the
constraint for _that action_ applied in SQL — so a role with `read: all` and
`update: own` can list the files on a colleague's contact and not touch them.

This is a decision, not a shortcut. A separate attachment grant would let an
administrator grant "may attach" over records the grantee cannot see, which is
a sentence that cannot be made to mean anything safe. It also means every
tenant that already exists has exactly the right permissions the moment this
ships, with nothing copied and nothing to go stale.

A record the actor cannot reach is a **404, never a 403** (CLAUDE.md §5.5), and
the check happens before the attachment is looked up, so an attachment id from
another tenant and one on a colleague's record produce the same response as an
id that was never issued. A test asserts the three are byte-identical. This is
the specific way a polymorphic link becomes a way around record scope, and it
is the case the activities module already tests; attachments follow it.

### 2. The allow-list is closed, and the server decides the type

`ALLOWED_ATTACHMENT_TYPES` (`@crm/core/files`) maps an extension to **our**
canonical MIME type and to the byte format that must back it: `pdf`, `png`,
`jpg`/`jpeg`, `gif`, `webp`, `txt`, `csv`, `zip`, `docx`, `xlsx`, `pptx`.
Everything else is refused by extension before a byte is uploaded, which is the
cheapest place to refuse anything.

`image/svg+xml`, `text/html` and `application/xml` are **absent on purpose**.
Each is a document that can carry script. We serve every download as
`attachment`, which should be enough on its own — and "should be enough on its
own" is exactly the sentence that precedes an incident. The allow-list is the
control; the disposition header is the second one. Adding any of the three back
is a decision for an ADR, not for a configuration file.

The contract carries **no `mime` field**. A client-supplied content type is the
string §5.12 says not to believe, and it is the string that decides whether a
browser renders. The server reads the extension, looks up the canonical type,
binds that into the presigned PUT, stores it, and serves the download as it —
never the client's string, and never a sniffed string echoed back.

The claim is the **last** extension, which is the one the operating system
obeys: `report.pdf.exe` claims `exe` and is refused.

### 3. The filename is refused, not repaired — and sanitised anyway

`attachmentFileNameProblem` rejects, with a reason naming the rule: path
separators, `..`, control characters, the bidirectional overrides
(U+202A–U+202E, U+2066–U+2069, U+200E, U+200F), a name over 255 characters, and
any extension not on the list. Rejecting rather than quietly rewriting matters
twice: a name we silently repaired is a name the uploader cannot find in the
list afterwards, and "we fixed it" is how a hostile name survives into the one
caller that forgot to ask.

Then it is sanitised again. `safeDownloadName` moved out of the S3 adapter into
`packages/storage/src/download-name.ts` and is now applied by **both**
providers, so the in-memory fake used by the test suite proves the real
control rather than its own idea of it. It is an allow-list —
`[A-Za-z0-9._-]`, no `..`, 120 characters — so quotes, newlines, NULs, overrides
and separators are gone without any of them having to be anticipated, and the
quoted header cannot be broken out of.

The length limit counts **characters, not UTF-16 code units**: 250 emoji are
500 code units, and a limit written with `.length` would reject a perfectly
ordinary name.

### 4. The bytes are checked, by the worker, against the claim

The API never reads a file's bytes (ADR-0030 §1, CLAUDE.md §5.12). An upload is
a presigned PUT bound to the exact declared size and our content type; the
browser uploads straight to the store; `POST /attachments/{id}/uploaded` makes
the API `head()` the object — metadata only — and publish
`attachment.uploaded.v1`. The **worker** reads the first 8 KB, runs
`detectAttachmentFormat`, compares it with what the name claimed, and either
marks the attachment `ready` or `rejected` with a sentence for the user and
deletes the object. Until it passes, the attachment is not listed and no
download link is issued.

Because that check runs **after** the confirmation has returned, a refusal cannot
be in the confirmation's response, and the list shows only files that passed.
Without a third place to look, a file the worker refused would simply never
appear and nobody would be told why — the first version of the panel did exactly
that, found by the end-to-end test. `GET /attachments/{id}` returns one
attachment in any state, with `failureReason`; the panel polls it until the file
is `ready` (then refreshes the list) or `rejected` (then says why). It is gated
like every read — `read` on the record, 404 otherwise — and never returns the
storage key.

The worker re-checks `head()` as well, because the presigned URL outlives the
confirmation and an object can be swapped between the two — the same point
ADR-0029 §7 makes about imports. A test swaps a valid PDF for a PE executable.

This is also the seam for malware scanning (MVP_SPEC §8, P1), which is still
not built.

### 5. One signature table, two allow-lists

ADR-0030 said to extend `detectUploadFormat`'s signature list. What actually
happened is better: the evidence moved to `@crm/core/files/signatures.ts` and
both callers now read it. Import asks "is this a CSV or a workbook, and does
that match the name?"; an attachment asks "is this one of the types we accept,
and does that match the name?". The allow-lists differ — an import refuses a
PDF by name, an attachment welcomes one — but a signature added for either is
now known to both. `magic-bytes.ts` keeps its own answer and lost only its copy
of the table and of the "plausibly text" test. Its existing tests passed
unchanged, which is what made the move safe to do.

**Two-byte printable signatures are a trap**, and the table says so. `MZ` is a
Windows executable and also the first two characters of a CSV whose first cell
is `MZ…`; `BM` is a bitmap and also `BMW`. The executable predates this and
earns its false positives; nothing else short and printable is being added.

For `zip`, `docx`, `xlsx` and `pptx` the byte check establishes **"a zip
archive" and nothing more** — that is the honest limit of a signature check on
OOXML. We never open an attachment archive, so a bomb inside one costs storage
and nothing else, unlike an import, which must inflate it. `inspectXlsxArchive`
is therefore not in this path.

### 6. Limits

| Limit                  | Value          | Answers                                          |
| ---------------------- | -------------- | ------------------------------------------------ |
| Upload size            | 25 MB          | signed into the URL; re-checked by `head`, twice |
| Files per record       | 50             | one record as an unbounded bucket                |
| Filename               | 255 characters | a header-length problem wearing a filename       |
| Upload URL             | 10 minutes     | a signed URL handed to somebody else             |
| Download URL           | 5 minutes      | the same                                         |
| Retention after delete | 30 days        | matches the Recycle Bin                          |

The size ceiling is the same 25 MB an import gets. One number is easier to
defend than two, and nothing about an attachment argues for more; a plan may
one day buy a higher one, and it will still be a constant rather than a tenant
setting.

### 7. Deletion: the row is soft, the bytes are not forever

Delete is a soft delete, and the stored object **stays**. An undelete that
cannot bring the file back is not an undelete, and the file is the whole value
of an attachment.

The delete publishes `attachment.purge_due.v1` dated 30 days out. ADR-0025 made
the outbox a scheduler by dating reminders to the future; this is its second
user, and it costs no cron, no cross-tenant sweep and nothing held in a
process's memory. When it fires, the worker checks the row is **still**
deleted — a restored attachment makes the pending event a no-op — then deletes
the object and the row, in that order. The other order could leave an object
nothing points at: unreachable, attributable to nobody, and paid for forever.
This order can only leave a row whose bytes are gone, which the next delivery
tidies up.

### 8. Orphans: the price of ADR-0005, paid in bytes as well as rows

There is no foreign key to the target, so deleting a contact does not delete
its files. `pruneAttachments` reacts to `account|contact|lead|deal|activity
.deleted.v1`, looks for the record, and **does nothing while it is still
there** — a delete in this product is a soft delete, and the files on a contact
in the Recycle Bin must survive it being restored. Which means that today, with
no hard delete anywhere in the product, this handler almost always does
nothing. That is correct rather than disappointing: it is already right for the
day a Recycle Bin purge or a DPDP erasure request (MVP_SPEC M11) arrives, and
it needs no change then.

When the record really has gone, it removes the stored objects **and** the
rows. This is the one place attachments differ from `pruneActivityLinks`, and
it is the reason: an orphaned link row is untidy, an orphaned private file that
nobody can reach and everybody pays to store is worse.

### 9. Immutable, so no `version`

There is no PATCH. A new revision of a document is a new attachment, which also
keeps the audit trail honest about who uploaded what. With nothing editable
there is nothing for optimistic locking to protect, so the table has no
`version` column and DELETE carries no version — a column nobody can move is a
column that only misleads.

## Consequences

- No new dependencies. The flow is `StorageProvider` (ADR-0009),
  `newStorageKey` (now with an `attachments` area), the presigned pattern from
  ADR-0030 and the outbox from ADR-0006.
- `safeDownloadName` moved to its own module in `packages/storage` and is
  applied by the memory provider as well as S3. `MemoryStorageProvider` gained
  `headersFor(url)`, so a test can assert the actual `Content-Disposition` and
  `Content-Type` a download would carry.
- Five services gained `allowsRecordAction(tx, actor, action, id)`. It is
  generic — it names no feature — so the next polymorphic module (tags, notes)
  uses it rather than adding a sixth method.
- `AttachmentTargetsService` is a near-twin of the activities module's
  `RecordLinksService`: action-aware and over five types rather than read-only
  over four. The duplication is deliberate for now, because the two differ in
  both axes and a shared abstraction over two callers would be guessing.
  **When a third polymorphic feature lands, consolidate them.**
- `ATTACHMENT_TARGET_TYPES` is a third closed set beside `LINK_TARGET_TYPES`
  and `BUSINESS_OBJECT_TYPES`. It differs by one — an activity can carry a file
  but nothing links to an activity — so neither is the other's superset by
  accident, and P2's custom objects widen them in the same place.
- The attachment panel is thin on purpose: the accepted extensions and the size
  are checked again by the API, the file never passes through the web app, and
  a download is a link the API decides to issue.
- **Still not built:** malware scanning (P1), inline preview of images, and
  restoring a deleted attachment — the row and the bytes survive the retention
  window so that restore is possible, but no endpoint offers it yet. An
  attachment on a record that is itself restored from the Recycle Bin comes
  back with it, because nothing removed it.

## Alternatives considered

- **An `attachment` object type with its own grants.** Rejected in §1: it
  invents a permission that can disagree with the record's, and it needs a
  backfill for every tenant that exists.
- **Sniff the type and serve what we found.** Rejected: that is the attacker's
  bytes choosing the header. The allow-list decides the type; the bytes only
  get to agree or be refused.
- **Allow SVG because users will ask.** Rejected in §2. If it is ever allowed,
  it is served from a separate origin with its own ADR, not by widening a list.
- **Delete the object immediately and keep the row for the audit trail.**
  Rejected in §7: a soft delete you cannot restore from is a lie, and the audit
  log already records the delete independently of the row.
- **A nightly sweep for expired attachments.** Rejected in §7: the outbox
  already schedules, per row, with no extra machinery and no cross-tenant
  query.
- **Cascade from the target with a foreign key.** Not available — ADR-0005 gave
  that up on purpose, and this is the cost it said would have to be paid.
