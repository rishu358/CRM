# ADR-0033: The permission engine explains itself

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

Every CRM makes permissions opaque. An administrator ticks boxes in a role editor
and finds out who could see what when somebody complains. This product has
something those do not: one central policy engine (ADR-0008) that already
computes the answer for every request. Administrators should be able to ask it
**why**, and to see what a change would do **before** they make it:

- on a record: _who can see this, and why_ — "Priya, because they own it",
  "Rahul, because they share the North team with the owner", "Anita, because
  their role reaches every contact" — and, per field, who sees the phone number;
- for a person or role: _what can they reach_ — which objects, at which scope,
  which fields hidden;
- on a change: _what would this do_ — "3 people can no longer see up to 1,240
  contacts each" — as a diff of **effect**, not of configuration.

This is the one screen where being wrong is worse than being absent. An
explainer that says somebody cannot see a record when they can is actively
harmful; so is one that says they can when they cannot, because an administrator
will rely on it to decide whether a record is exposed. The failure mode that
produces both is a **second implementation** — a function that describes what it
believes the rules are, written beside the engine, and drifting from it the first
time the engine changes.

## Decision

**The engine explains itself. Nothing else does.**

### 1. `can()` returns its reasoning, in the same pass

Every `Decision`, allowed or denied, now carries a `derivation`
(`packages/core/permissions`): which roles granted the action and at what scope,
which of them decided, the effective scope, and — when a record was judged — a
`RecordMatch` saying _why_ it matched or not (`owner`, `team` with the team,
`unscoped`, or `not_owner` / `no_shared_team` / `unowned`).

It is assembled from the values the decision is taken on, in the loop that takes
it. **Nothing branches on it.** The decision path is exactly what it was:
`can.spec.ts` and `field-access.spec.ts` are unchanged and pass unchanged, and
`satisfiesConstraint` is now literally `matchConstraint(...).satisfied`, so the
matcher that decides and the matcher that narrates are one function.

The field engine does the same: `fieldAccessDerivation` reports, per role, the
base access from the object grant and the field rule that narrowed it — so the
explainer can say whether a field is dark because the role cannot read the
_object_ or because a rule hides _this field_, which are different problems with
different fixes. `fieldAccess` (the hot path, run per field per row) keeps its
early exit and allocates nothing; a test asserts the two agree on the whole
matrix of actors, objects and fields.

### 2. The explainer is a translation, not a computation

`explainRecordAccess`, `explainFieldVisibility`, `explainReach` and `diffAccess`
(`packages/core/permissions/explain.ts`) call `can()` and the field engine and
translate what they report into stable codes. The file does not read
`role_permissions`, `field_permissions` or `team_members`, and does not compare a
role name. The API sends **codes** (`shared_team`, `narrowed`), never sentences;
the words live in the web app's i18n layer.

Actors are built by `loadActors` in `@crm/db` — the function every request builds
its actor with (`loadActor` is now that function for one user). The explainer,
the worker's import and the request path therefore share one definition of "who
may".

### 3. A change's effect is the engine, run twice

The preview loads each affected person's real `Actor`, builds a second one with
the proposed permissions compiled in, and diffs what `can()` says for each.
`applyPermissionPatch` is the one function that turns "current + patch" into
"proposed"; the preview and the save both use it, so what an administrator is
shown the consequences of is, by construction, what is written. A save carries a
**digest** of the permissions the preview was computed against and is refused
(409) if the role has since changed; the role row is locked across the check and
the write.

Record counts are the one thing the engine cannot do itself. They are counted
under the **constraint `can()` handed back**, translated by the same
`constraintToSql` every list endpoint puts in its WHERE clause, so a number is
the length of the list that person would be given. A read-only catalogue in
`@crm/db` (`access/records.ts`) knows each owned table's owner column — the same
arrangement the search index has (ADR-0028) — so the access module does not read
another module's tables. Writes never go through it: a reassignment is one shared
statement (`reassignOwned`) driven with the table names each owning module
**registers** (`OwnershipRegistry`), then audited, versioned and announced as an
ordinary edit would be.

### 4. It is a read path across people, so it is fenced

- **Administrators only**, by `can()`: `role:read` and `membership:read`
  (administrative objects, `all` scope only). A rep or manager gets 403 on every
  route and learns nothing — not who their colleagues are, not their own role's
  grants, not which fields are hidden from them.
- **The collection-level grant is checked before the record is loaded**, so 403
  never depends on whether an id exists; and an ownership-reassignment request
  settles everything that depends on the _actor_ before it looks up the person
  they named. Otherwise "unknown member" versus "forbidden" is a membership
  oracle.
- **Your own tenant**, by construction: people come from `memberships` under RLS.
- **Only records you can read yourself.** The record is judged for the _viewer_
  first; one outside their reach is a 404, byte-identical to a missing id.
- **Only fields you can read yourself.** A field hidden from the viewer is not
  listed, not even to say who else can see it.
- **Counts only where you could count anyway** (`read` at `all` scope on that
  object). Without this, anybody who may edit roles could size the whole
  workspace's data by previewing a change.

### 5. Two rules that make editing roles safe to expose

- **You cannot grant what you do not hold.** `grantsBeyond` asks the engine
  whether the actor's own `can()` reaches as far as each grant a patch adds,
  assigns, or copies. `role:update` is otherwise a path to every other
  permission. It is asked of `can()`, not of a role name, so it holds for a
  custom "People manager" role.
- **The workspace keeps an administrator.** After a change is written and before
  it commits, the engine is asked whether anybody can still manage roles and
  members; if not, the whole change rolls back (`LAST_ADMINISTRATOR`). The
  preview reports it beforehand.

### 6. A bug this surfaced, and the fix

Team scope was resolved in SQL for lists ("owned by me or by anyone on my teams")
but, in the record-level `can()` call every service makes, only `ownerId` was
supplied — so a teammate's record was in the list and a **404 when opened**, in
the API and in imports. The explainer cannot tell an administrator the truth
unless the list, the record page and the explanation apply one rule, so the
services now pass the owner's teams (`recordRefFor`). This changes behaviour:
**a team-scope user can now open and edit a teammate's record**, as the list had
always implied and as `constraintToSql` documents. One worker test that recorded
the old behaviour as a known gap was updated; it said it would show where the
platform gained team-aware record checks.

## Consequences

- **Every future change to `can()` is a change to what it explains.** A new rule
  (territory, deal size — ADR-0008) must be reflected in `derivation`, or the
  explainer will describe the old engine. The parity suite is the contract: it
  asks the explainer, then asks the real HTTP API as each member, and fails on
  any disagreement. A mutation check (reverting item 6) was confirmed to fail it.
- `can()` allocates a small derivation object per call. It is called per request
  and per object, never per field per row, so the cost is not on the serializer
  path. If a future caller needs `can()` in a hot loop, a reasoning-free variant
  can be split out — over the same loop, never as a copy of it.
- A new object type must be added to `GRANT_CATALOGUE`, or the editor cannot
  grant it; a test fails if one is missing.
- Counts are exact `count(*)`s under the actor's constraint, memoised per
  distinct constraint. That is fine to a few hundred thousand rows per object;
  at 1M a statement timeout and an approximate count are the next step.

## Known limits (deliberate, and stated on the screens or here)

- "Who can see this" explains `read` only. Update and delete follow the same
  engine and are visible in the reach view per object.
- A person holds one role today (`memberships.role_id`). The engine and the
  explainer are written for several — the derivation names the deciding role —
  but `loadActor` loads one, so nothing here is exercised with two.
- Team **membership** changes are audited as `permission_change` but not
  previewed; they alter `team`-scope reach the same way a role edit does.
- The team hierarchy (`parent_team_id`) is kept acyclic but does not widen
  anybody's reach: scope resolves through direct membership only.
- Support impersonation (MVP_SPEC M3, P1) is not built.

## Alternatives considered

- **A separate `explain()` that re-derives the answer from the rows.** Rejected:
  this is exactly the second implementation. It is cheaper to write and will be
  wrong the day `can()` changes.
- **Storing the reason alongside each decision.** Rejected: decisions are made
  per request from current rows, and a stored reason is stale the moment a role
  is edited.
- **Computing visibility in SQL for the whole tenant.** Rejected: it would be a
  third translation of scope (after `constraintToSql` and `satisfiesConstraint`),
  and the only way to keep three in agreement is to test all three against each
  other, which is more machinery than asking the one that already decides.
