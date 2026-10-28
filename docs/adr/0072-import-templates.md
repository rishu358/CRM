# ADR-0072: Import templates: a mapping suggested from where the file came from

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

F7, the last of the import changes. The owner's decision (2026-10-28): start with two templates, a **Zoho CRM
export** and a **generic Excel or CSV file**, mapped by column name. Mapping twenty columns by hand on the first
day is the part people give up on, and the people moving in are mostly coming from Zoho or from a spreadsheet
somebody built.

## Decision

A template is a table from a column heading to this product's import target, per object (contact, account, lead,
deal), in `packages/core/src/import-export/templates.ts`. It does one thing: **suggest** a mapping.

- **A suggestion, never a decision.** The mapping screen still shows every column and every choice; the person
  changes any of them; nothing is imported until they press Start; and the server validates the mapping like any
  other, so a template cannot make an import do what the person could not. Choosing a different source on the
  screen re-suggests the mapping, and the choice stays visible.
- **Detected, and overridable.** Two or more headings that only a Zoho export has (`Contact Owner`, `Deal Name`,
  `Closing Date`, ...) is taken as Zoho; anything else as a spreadsheet. The screen says which and lets the
  person change it.
- **What the screen always did comes first.** A heading that is a target's own label or key maps as before, in
  every template, so a file that mapped yesterday maps the same way today. A template only adds suggestions.
- **Never a target the person is not offered.** A suggestion is dropped if the target is not on offer: the owner
  column for someone who may not assign, the date columns without the right to import original dates.
- **A target is suggested once,** for the first column that claims it.
- **A blank template file** can be downloaded from the screen: the headings of the generic template for what the
  person is offered, made in the browser (nothing is uploaded or stored).

### Where the names come from

**Zoho's names are taken only from Zoho's own public help pages** ("Standard fields" for Accounts, Contacts,
Leads and Deals, read on 2026-10-28). Those pages give each module's field labels, which is also what an export's
heading row uses for standard fields. Nothing is reverse-engineered from an export file. Three headings are
**unverified** because the standard-fields pages do not list them: the system columns an export adds, `Record Id`
(mapped to a deal's own ID, which makes importing the same export twice exact), `Created Time` and `Closed Time`.
They are marked in the code (`UNVERIFIED_ZOHO_HEADINGS`) and, if a real export words them differently, they are
simply not recognised and the person picks the column by hand. Because the pages describe the standard fields
only, a workspace's custom Zoho fields are never suggested.

### What a template deliberately does not suggest

- **Zoho's `Contact Name` on a deal.** It is a name, and this importer wants an e-mail address; suggesting it
  would fail every row.
- **A free-text `Company` on a contact as the account link.** Usually a company that is not an account yet; a
  heading that says `Account` is taken to mean it. (Zoho's own `Account Name` is, because Zoho's import has the
  same rule: the account must already exist, so the screen says to import accounts first.)
- **Values.** A Zoho stage, lead status or lead source this workspace does not have is refused row by row with
  its name, as a hand-made file would be. Translating them is a business decision for another day.

## Consequences

- No migration, no new permission, no server change: the templates are pure code in `@crm/core` and the
  mapping screen reads them.
- The screen gains a "Where did this file come from?" choice and a template download. The existing flow, buttons
  and the suggestions for headings it already understood are unchanged.
- Tests: the mapping suggestions are unit tests (a Zoho contact and deal export, a tidy spreadsheet, detection,
  precedence, dropped targets, unverified headings listed); one browser test uploads a Zoho-style file and
  checks the suggestion, the override and the change of source.
- More sources (HubSpot, Salesforce, Google Contacts) are a table each, on request, with the same rule about
  where the names come from.
