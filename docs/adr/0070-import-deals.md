# ADR-0070: Deals can be imported

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

F7, the fourth of five import changes. ADR-0029 left deals out on purpose: "a deal row must name a pipeline and
a stage, and MVP_SPEC does not say how a spreadsheet identifies one". The owner decided (2026-10-28): by
**name**; a row with no id is skipped when a deal with the same name already exists on the same account, and the
downloadable result says so; an optional id column of the person's own makes a re-run exact; the owner column
follows the rule of ADR-0067; original dates are for those who hold the right of ADR-0069.

## Decision

**Placement by name** (`import-deals.ts`). The pipeline cell names a pipeline and the stage cell a stage, each
matched exactly but ignoring case. A stage is looked for inside the pipeline the row names, so two pipelines
may share a stage name without ambiguity. A blank pipeline is the default pipeline; a blank stage is the first
open stage in use, as for a deal made in a form. A name that is not there fails the row and names it. An
existing deal is updated within the pipeline it is in: a file does not move deals between pipelines (that is a
larger edit than the API makes by accident either).

**The stage rules are the API's own.** The probability, the closed date and the lost reason come from
`resolveStageState` (ADR-0020), the function the deals API calls, so an import cannot make a deal the API
would refuse: a won deal is at 100% and closed, a lost one at 0% and needs a reason, an open one has neither a
closed date nor a lost reason. On an update the deal's current state is the "previous" the rules read, so a
deal already closed keeps the moment it closed.

**Money.** An amount is `1500.75 USD`, or a plain number meaning the workspace's currency. It is read to the
exact minor unit; a currency with fewer decimals than the cell has is refused, not rounded.

**Links.** Account (name, domain or id), primary contact (e-mail address) and owner (e-mail address) resolve
once per chunk, inside the importer's own reach, exactly as ADR-0067 does for contacts: a contact the importer
may not read answers like one that does not exist, two contacts with one address is an error, and an owner
needs the same right as a reassignment.

**Original dates.** `created_at` and `closed_at` need `import_history:create` (ADR-0069). A closed date needs a
won or lost stage and a created date beside it, and cannot come before it: without the stage rules deciding
that, the dashboard's "won this month" would believe whatever a file said. A deal closed on a date from the
file was last touched then, so its last-updated time is that date. Without the right, the columns are not
offered and are refused.

**Duplicates are never silent.** A deal has no natural key, so the file chooses what "the same deal" means:

- `ID` (`external_id`): the person's own id, kept on the deal (a new nullable column, unique among a company's
  live deals). Importing the same file again with "update" changes the deals instead of doubling them, and a
  row that would change nothing is skipped without bumping the version.
- `Name`: the same name **on the same account** (a deal with no account matches a deal with none). The same
  name on two accounts is two deals.

A deal skipped as a duplicate, including a second row for it earlier in the same file, is counted as skipped
and **listed in the downloadable file** with `Skipped: a deal named "X" already exists on this account` (or
`with the ID "x"`). That file used to exist only when a row failed; it now also exists when a deal was skipped as
a duplicate. Contacts, accounts and leads are unchanged. In `create` mode nothing is matched, as for the others.

**Written like a deal made in a form.** One audit entry per deal (with the import job id), and `deal.created.v1`
carrying the pipeline, the stage and its name, which the consumers of that event already read. The check
(ADR-0068) runs the same code and writes nothing.

## What it does not do

- Deal contacts beyond the primary one (the `contacts[]` people on a deal) are not imported.
- Moving an existing deal to another pipeline is refused.
- Keeping imported rows from firing automations and notifications is F7-5, and applies to deals too.
- A deal's `external_id` is not shown or exported yet; it exists to make a re-run exact.

## Consequences

- Migration `0031_import_deals.sql`: the import-job type check allows `deal`, and `deals.external_id` with its
  unique index. Both are catalogue-only on a large table (nullable, no default; the index starts empty).
- `import` on deals becomes grantable in the role editor; the seed already gave it to Owner, Admin and
  Manager, who could not use it until now. Anyone who holds it can now import deals at their scope.
- The mapping screen offers Deals, and for deals offers the pipeline, stage, links, ID and (with the right) the
  dates. Existing screens for the other objects are unchanged.
