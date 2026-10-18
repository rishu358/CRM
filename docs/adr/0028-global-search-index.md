# ADR-0028: Global search is a per-field index behind a provider interface

- **Status:** Accepted
- **Date:** 2026-10-18

## Context

MVP_SPEC M7 asks for one box — `Ctrl`/`Cmd` + `K` — that searches every object
the signed-in person may read, over name, email, phone and company, in under
300 ms for a tenant holding a million records. CLAUDE.md §2 names the
implementation (Postgres full-text plus `pg_trgm`) and, in the same line, says
it sits behind a `SearchProvider` so Meilisearch can replace it later.
ADR-0009 is the general form of that promise.

Search is unlike every read path built so far. Each of the others answers a
question about a record the caller has already named: "show me contact X",
"list the deals in pipeline Y". Search answers a question about records the
caller has **not** named, across five tables at once, from a string they typed.
That makes it the easiest place in the product to leak from, and the four
things it has to respect are exactly the four the rest of the product has spent
seven modules getting right:

1. the tenant (CLAUDE.md §5.1);
2. the actor's `own`/`team`/`all` record scope, **per object type** — a rep may
   hold `all` on accounts and `own` on deals (§5.3);
3. field-level permissions — a hidden field must not be searchable (§5.4);
4. soft deletes — a record in the Recycle Bin must not be findable.

All four have to be applied **while rows are selected**, not to rows already
fetched. Filtering afterwards is a leak waiting for the next refactor, and it
also quietly breaks the result count: ask for ten, discard six, show four.

## Decision

### 1. One row per `(record, field)`, not per record

`search_documents` holds one row for each searchable field of each record:
`(tenant_id, object_type, record_id, field_key, owner_id, value, weight)`, plus
a **generated** `tsvector` derived from `value`.

This shape is the whole security design, and it exists because of rule 3.

With one row per record carrying a single vector built from every field, a
match tells you nothing about **which** field matched. A hidden field would
therefore still be searchable: type a colleague's concealed phone number, get
the record back, and the field permission has been walked around without the
column ever being read. Splitting by field makes "do not search what you may
not read" a `field_key = ANY(…)` predicate the planner applies while selecting
rows.

It also settles the subtler half of the same problem. A search result wants to
quote the text it matched, and the usual way — `ts_headline` over the whole
record — puts a hidden field's contents into the excerpt while the field itself
is dutifully stripped from the payload. Here the snippet **is** the matched
row's own `value`, and the match could only ever have been on a readable field,
so the leak has nowhere to happen. `search.security.spec.ts` tests it anyway,
because "structural" is a claim.

The cost is row count: roughly four index rows per record rather than one.
`ownerId` is denormalised onto each row so rule 2 is a predicate rather than a
join back to five tables — the join would be the thing that made search slow,
and an engine in another process could not do it at all.

### 2. The index is a projection, never a source of truth

Rows are written by the **outbox relay** (ADR-0006), not inline by the
services. A service that called an indexer directly is a service somebody
eventually forgets to call, and the record would be saved while the index
silently disagreed. Here, anything that writes a record writes an event, and
anything that writes an event gets indexed — so a record created, edited or
soft-deleted becomes findable, or stops being findable, without anyone
remembering.

The index handler is also the delete path in disguise: if the record no longer
resolves when the event is relayed, it **removes** instead of indexing. An
update and a delete can be relayed in either order, and a delete that lost the
race must not be undone by an update that arrives after it.

The projection itself — `buildSearchDocuments` in `@crm/db` — is one function,
used by the relay and by `reindexTenant`. `pnpm db:seed` calls the latter,
because the seed inserts records straight into the tables and so emits no
events; without it the demo tenant would have an empty palette.

### 3. The provider interface is vendor-neutral, and the context is the transaction

`SearchProvider` lives in `@crm/core`: no SQL, no tsquery, no index name, no
type from `@crm/db`. `SearchRequest` carries the tenant, the term, and one
`SearchObjectScope` per object type the actor may read — each holding a
`RecordConstraint` (a pure domain value) and the list of field keys that actor
may match on. Translating a constraint into a filter is the adapter's job;
Postgres turns it into SQL, and an engine with its own filter language would
turn it into that.

The interface is generic over the handle it needs, `SearchProvider<Ctx>`, and
the API binds it to `Tx`. That is not an implementation detail that leaked. The
Postgres provider needs the caller's **tenant-scoped transaction**, because
that is where `SET LOCAL app.tenant_id` lives and therefore where RLS applies.
Typing it rather than hiding it behind `unknown` means a replacement has to
decide deliberately what to do about tenancy instead of dropping it by
omission.

### 4. Full-text matches; pg_trgm is a fallback, not a second ranker

The hot path is one GIN index scan:

- the tsquery is `a:* | b:*` — **or**, not **and**. One index row holds one
  field, so "John Smith" has `john` in `first_name` and `smith` in `last_name`
  and no single row contains both; requiring both would find nobody. Summing
  the per-row `ts_rank` puts the record that matched two words above the one
  that matched one, which is what `and` was for.
- every term is a prefix, so results appear while somebody is still typing.
- the terms are a single bound parameter built by `searchTerms` in `@crm/core`,
  which has already reduced the input to bare words — no `&`, `|`, `!`, `:` or
  quote can reach `to_tsquery` (CLAUDE.md §5.7). It is a pure function with its
  own tests, because it is the only place a user's string is taken apart.
- the configuration is `simple`, not `english`. These are names, companies,
  addresses and phone numbers; an English stemmer would mangle them, drop `A`
  and `IT` as stopwords, and be wrong for every tenant not writing English
  (ADR-0011). The separators in `john.smith@acme.com` and `+91-98765-43210` are
  folded to spaces on both sides — in the generated column and in `searchTerms`
  — so a fragment of an address or a number finds the record.

A **second** query runs only when the first came back short: `'akme' <% value`,
pg_trgm's word-similarity operator, for a typo or an infix fragment full-text
cannot reach. Measured at 280,000 index rows, the full-text pass is 8–12 ms and
the trigram pass is 106–124 ms, which is exactly why it is a fallback and not
part of every keystroke.

Results are merged full-text first. `SearchHit.score` is therefore diagnostic
only; the array order is the ranking, because the two passes are not on one
scale.

### 5. Every hit is re-resolved against the live record

The index carries copies: the owner id and the text as they were when the relay
last ran. Between a reassignment and the next event being relayed, the index
says a rep still owns a record they no longer do.

So the API takes the hits and asks each owning module — through its service's
`linkLabels`, the same method an activity link uses (ADR-0005, ADR-0001) —
which of those ids it can resolve **now**, for this actor. A hit that does not
come back is dropped. That costs at most five primary-key lookups per response
and closes the staleness window, and it is also where the title comes from,
because only the owning module knows which of its columns the label is made of
and which of them this actor may read.

This is defence in depth, not the defence. The scoping is in the SQL; this
catches the gap between a write and the relay.

### 6. What moving to Meilisearch would cost

`SEARCHABLE_FIELDS`, `SearchRequest`, `SearchHit`, the tokenizer and the
provider interface are all engine-agnostic and stay. What a new adapter must
reproduce:

- **tenant isolation without RLS.** The Postgres provider gets it free from the
  transaction; a remote engine has to enforce `SearchRequest.tenantId` itself,
  in its own filter language, and that becomes the single most important line
  in the adapter.
- **the per-object-type field list**, or hidden fields become searchable.
- **the per-object-type scope filter**, or a rep sees a colleague's records.
- **removal on soft delete**, since there is no `deleted_at` to filter on.

It is also the point at which custom fields become indexable: the index schema
stops needing to be fixed, which is the reason they are out of scope here.

### 7. Two operators marked `LEAKPROOF`, because RLS and index scans collide

This is the part to read before changing anything.

A table with Row-Level Security is a **security barrier**. Postgres will not
evaluate a qual that is not marked `LEAKPROOF` before the policy has filtered
the rows — and a qual it will not evaluate early is a qual that can never
become an index condition. Neither `tsvector @@ tsquery` nor pg_trgm's `<%` is
marked leakproof in core, so on `search_documents` the planner was reduced to:

```
Parallel Seq Scan on search_documents
  Filter: ((tenant_id = …) AND (search_vector @@ '''surname1234'':*'::tsquery))
  Rows Removed by Filter: 66633
```

— or, with sequential scans disabled, a bitmap scan whose index condition was
`tenant_id` alone, fetching every one of the tenant's entries and re-checking
the match on the heap. Measured: 70 ms where the same query outside RLS took
4 ms, and the gap grows with the table. At a thousand tenants holding a million
records each that is not a slow feature, it is an unusable one. No index shape
fixes it; the ordering rule is about the operator.

The bootstrap therefore marks exactly two functions leakproof:

```sql
ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF;
ALTER FUNCTION word_similarity_op(text, text) LEAKPROOF;
```

With them, the same query plans as `Index Cond: (tenant_id = … AND
search_vector @@ …)` and runs in 6 ms.

Why this is a narrow, defensible weakening:

- **Row security is untouched.** The policy still filters every row; marking
  only lets the planner apply the match earlier, which is where the index is.
  A leakproof qual is still applied to rows the policy allows. The isolation
  suite is unchanged and still passes.
- **`LEAKPROOF` means "reveals nothing about its arguments except through its
  return value"** — in practice, raises no error whose occurrence or message
  depends on the data. Both operators return a boolean and have no
  data-dependent error path: parsing a tsquery, which can fail, happens in
  `to_tsquery`, outside the operator.
- **The barrier exists to stop a _caller-supplied_ qual from seeing rows before
  the policy does.** No caller here can supply a qual. Every predicate on every
  table is built in application code from a closed set of whitelisted fields
  and operators (CLAUDE.md §5.7), and the tenant predicate is additionally
  written into the query rather than left to the policy alone.
- **It is two named functions**, not a class, an extension, or
  `DISABLE ROW LEVEL SECURITY`.

It is superuser-only, so it lives in `packages/db/sql/bootstrap` beside the
role creation and not in a migration — `crm_migrator` is deliberately not a
superuser. `search.perf.spec.ts` asserts both are still leakproof, so removing
the line fails a test that names this section rather than producing a planner
mystery three months later.

**A development database created before this line existed does not have it.**
Re-create the container, or apply the two statements once as a superuser.

### 8. What breaks the latency budget

The cost of a GIN lookup is proportional to **how many entries match**, not to
how large the table is. A selective term stays flat as a tenant grows; the
things that do not:

- **a term that matches a large fraction of a tenant's rows.** Every match has
  to be ranked before the top ten can be known. A first name shared by 5% of a
  tenant's contacts is the realistic case, and the honest answer when it starts
  to hurt is a cheaper ranking or a bounded candidate set, not a bigger index.
- **a one-character term**, which is why `MIN_SEARCH_TERM_LENGTH` is 2 and the
  palette simply waits for the second keystroke.
- **the trigram fallback**, an order of magnitude dearer than the full-text
  pass, which is why it runs only when the first pass came back short.
- **losing either leakproof marking** (§7), which turns every query into a
  sequential scan of the whole table.
- **`ANALYZE` never running** on `search_documents`. Without statistics the
  planner is guessing, and the guess is a sequential scan.

`packages/db/src/search.perf.spec.ts` seeds 280,000 index rows across two
tenants, `EXPLAIN`s the exact statements the provider runs, and asserts the GIN
indexes are used, that `tenant_id` is part of the index condition rather than a
recheck — that is what `btree_gin` buys, and without it every tenant's matches
for a term would be fetched and thrown away — and that a rep's narrower query
still reads the index.

## Consequences

- **The index is eventually consistent.** A record is findable a moment after
  it is saved, not instantly. §5 keeps that from being a correctness or a
  security problem; it does mean a Playwright test that creates a record and
  immediately searches for it needs the relay to have run.
- **`search_documents` is roughly four rows per record.** It will be among the
  larger tables. It is also entirely derivable, so it can be rebuilt, truncated
  per tenant, or moved to another engine without touching customer data.
- **The API reads the index and never writes it; the relay writes it and never
  serves it.** Asymmetric grants, so a flaw in a request path cannot poison
  what other people find.
- **A fifth object type was added to the permission surface implicitly.**
  Search reads `activity` alongside the four record types, which is why
  `ActivitiesService` gained a `linkLabels` of its own even though an activity
  is not a link target.
- **Custom fields are not searchable yet**, and neither is `activities.body`.
  The first is §6; the second is deliberate — sanitized markup is both wrong
  and slow to match inside, and a note is the likeliest place in the product
  for something a colleague should not stumble over (ADR-0024).
