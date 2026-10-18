-- Global search index (MVP_SPEC §M7, ADR-0028).
--
-- One table, `search_documents`, holding **one row per (record, field)** rather
-- than one row per record. That shape is the whole security design, so it is
-- worth saying why before the DDL:
--
--   A caller's field permissions decide what they may match on. With one row
--   per record carrying a single tsvector built from every field, a match tells
--   you nothing about *which* field matched, so a hidden field would still be
--   searchable — type a colleague's hidden phone number, get the record back,
--   and the field permission has been walked around without ever reading the
--   column. Splitting by field makes "do not search what you may not read" a
--   `field_key = ANY(...)` predicate the planner applies while selecting rows,
--   and makes the quoted snippet structurally a value of a readable field.
--
-- It is a projection, not a source of truth: every row here is derived from a
-- record in another table, written by the outbox relay (ADR-0006), and can be
-- rebuilt from scratch by `pnpm db:reindex`. Nothing reads it except search.
--
-- The table is created empty, so no index build takes a long lock.

CREATE TABLE search_documents (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  object_type        text NOT NULL,
  record_id          uuid NOT NULL,
  -- The `field_definitions` key, which is also the column the value came from.
  -- Matching it against what `canReadField` allows is what keeps a hidden field
  -- out of both the match and the snippet.
  field_key          text NOT NULL,
  -- A copy of the record's ownership column (`assigned_to` for an activity,
  -- `owner_id` for everything else), so the actor's own/team/all scope is a
  -- predicate on this table rather than a join back to five others. A copy is
  -- only as fresh as the last event the relay saw; the API re-resolves every
  -- hit against the live record before returning it (ADR-0028 §5).
  owner_id           uuid,
  -- What was indexed, kept verbatim because it is also the snippet. Bounded
  -- because a snippet nobody can read is only cost.
  value              text NOT NULL,
  weight             text NOT NULL,
  -- The record's updated_at, for a stable tie-break between equal scores.
  record_updated_at  timestamptz NOT NULL,

  -- Generated, not supplied. A column the writer fills could be made to
  -- disagree with `value` — indexing terms that are not in the text, which is
  -- a way to make a record findable by something it does not contain. Here the
  -- vector is a function of the row, so there is nothing to lie with.
  --
  -- `translate` folds the separators in addresses and phone numbers to spaces
  -- before tokenizing, so `john.smith@acme.com` indexes as four words and a
  -- person typing `acme` finds it. The same folding happens to the query, in
  -- `searchTerms` (@crm/core/search).
  --
  -- `simple`, not `english`: these are names, companies, addresses and phone
  -- numbers. An English stemmer would mangle them, drop `A` and `IT` as
  -- stopwords, and be wrong for every tenant that is not writing English
  -- (ADR-0011).
  search_vector      tsvector GENERATED ALWAYS AS (
                       setweight(
                         to_tsvector('simple', translate(value, '@._/+-', '      ')),
                         weight::"char"
                       )
                     ) STORED,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_by         uuid,

  CONSTRAINT search_documents_object_type_chk
    CHECK (object_type IN ('account', 'contact', 'lead', 'deal', 'activity')),
  CONSTRAINT search_documents_weight_chk CHECK (weight IN ('A', 'B', 'C', 'D')),
  CONSTRAINT search_documents_value_chk
    CHECK (length(value) > 0 AND length(value) <= 500)
);

-- The upsert key. Also the prefix lookup the relay deletes a record by.
CREATE UNIQUE INDEX search_documents_record_field_key
  ON search_documents (tenant_id, object_type, record_id, field_key);

-- ---------------------------------------------------------------------------
-- The two indexes the query budget depends on (MVP_SPEC §9: < 300 ms at 1M
-- records). Both are GIN, and both lead with `tenant_id` via btree_gin, which
-- the bootstrap already installs — without it the tenant predicate would be a
-- recheck over every tenant's matches rather than part of the index scan.
-- ---------------------------------------------------------------------------

-- Matching. `search_vector @@ query` with the tenant in the same index.
CREATE INDEX search_documents_fts_idx
  ON search_documents USING gin (tenant_id, search_vector);

-- Fuzziness: `'akme' <% value`, for a typo or a fragment full-text cannot
-- reach. Only consulted when the full-text pass came back short, so the hot
-- path stays a single index scan (ADR-0028 §4).
CREATE INDEX search_documents_trgm_idx
  ON search_documents USING gin (tenant_id, value gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Row-Level Security and grants (0004)
--
-- Asymmetric on purpose. The API **reads** the index and never writes it; the
-- relay writes it and never serves it. So a flaw in a request path cannot
-- poison what other people find, and the index cannot be used as a side door
-- to write into a tenant whose records the caller cannot touch.
-- ---------------------------------------------------------------------------
CALL apply_tenant_rls('search_documents');

GRANT SELECT ON search_documents TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON search_documents TO crm_worker;
