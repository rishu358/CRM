-- Audit viewer, Recycle Bin and data rights (MVP_SPEC M4, M11).
--
-- Six things, in this order:
--   1. two more audit-log indexes, so the viewer's filters land on an index
--      and on the partition key rather than scanning the biggest table we have
--   2. Recycle Bin indexes: the soft-deleted slice of each record table
--   3. `data_export_jobs` — the audit-log, whole-tenant and one-person archives
--   4. `erasure_requests` — the record of a DPDP/GDPR erasure
--   5. `crm_erasure`: the narrow privileged path that lets an erasure redact
--      audit diffs **without** giving the application role UPDATE on history
--      (ADR-0032). This is the part to read twice.
--   6. backfills: the new capability grants for tenants that already exist,
--      and the Recycle Bin purge sweep armed for each of them
--
-- Every new table is created empty, so none of its index builds takes a long
-- lock. The two audit indexes are the only builds against an existing table;
-- see the note above them.

-- ---------------------------------------------------------------------------
-- 1. Audit-log indexes for the viewer (MVP_SPEC M11)
--
-- The viewer filters by user, object, action and date. `occurred_at` is the
-- partition key, so a date range is what keeps the query off every month we
-- have ever stored: with a bounded range the planner prunes to the partitions
-- that can contain it, and only then applies the index. The API therefore
-- always sends a range — it defaults to the last 30 days rather than leaving it
-- open — because an unbounded audit query against a thousand tenants' history
-- is not a slow page, it is an outage.
--
-- 0003 already indexes (tenant_id, occurred_at), (tenant_id, actor_id,
-- occurred_at) and (tenant_id, object_type, record_id). That covers "who did
-- this" and "the history of this record". What it does not cover is the other
-- two filters combined with a range — "every change to contacts last quarter",
-- "every export this year" — which on a busy tenant means reading the whole
-- month and discarding most of it. These two close that gap.
--
-- Lock note (CLAUDE.md §7): CREATE INDEX on a partitioned table recurses and
-- takes a lock per partition, and CONCURRENTLY cannot run inside the
-- transaction a migration is. That is acceptable **here** because the index is
-- built per month and only the current partition holds many rows. At real
-- volume the recipe is CREATE INDEX ... ON ONLY audit_logs, then one
-- CONCURRENTLY per partition outside a transaction, then ATTACH PARTITION —
-- recorded in ADR-0034 so the next person adding an index here does not have to
-- work it out again.
-- ---------------------------------------------------------------------------
CREATE INDEX audit_logs_tenant_object_time_idx
  ON audit_logs (tenant_id, object_type, occurred_at);

CREATE INDEX audit_logs_tenant_action_time_idx
  ON audit_logs (tenant_id, action, occurred_at);

-- ---------------------------------------------------------------------------
-- 2. The Recycle Bin (MVP_SPEC M4)
--
-- Partial indexes over the soft-deleted slice only. Deleted records are a tiny
-- fraction of a tenant's rows, so a partial index is small enough to stay in
-- cache while the Bin's two queries — "what can I restore", and the purge job's
-- "what is past retention" — never touch a live record.
--
-- `deleted_at DESC, id` is the keyset order the Bin pages by (ADR-0012): most
-- recently deleted first, with `id` as the tiebreak that keeps the cursor
-- total. Declared here rather than in the Drizzle schema because Drizzle cannot
-- express a descending column in an index, and a half-expressed index in
-- TypeScript is worse than an honest pointer to where it lives.
-- ---------------------------------------------------------------------------
CREATE INDEX accounts_tenant_deleted_idx
  ON accounts (tenant_id, deleted_at DESC, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX contacts_tenant_deleted_idx
  ON contacts (tenant_id, deleted_at DESC, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX leads_tenant_deleted_idx
  ON leads (tenant_id, deleted_at DESC, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX deals_tenant_deleted_idx
  ON deals (tenant_id, deleted_at DESC, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX activities_tenant_deleted_idx
  ON activities (tenant_id, deleted_at DESC, id) WHERE deleted_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Data-rights archives (MVP_SPEC M11)
--
-- A separate table from `export_jobs`, not a widened `object_type` CHECK on it.
-- A list export is "this object type, these filters, under your record scope";
-- these three are "the audit log", "everything this workspace has" and "one
-- person's file". They are produced by a different handler, authorized by a
-- different capability and shaped differently, and folding them into
-- `export_jobs` would mean every list-export code path had to start asking
-- which kind it was holding.
-- ---------------------------------------------------------------------------
CREATE TABLE data_export_jobs (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- audit_log | tenant | data_subject
  kind            text NOT NULL,
  status          text NOT NULL DEFAULT 'queued',
  format          text NOT NULL,
  -- What was asked for: the audit filters, or the subject record. Validated by
  -- Zod at the API boundary before it is stored, and re-read by the worker.
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  storage_key     text NOT NULL,
  row_count       integer,
  size_bytes      bigint,
  failure_reason  text,
  expires_at      timestamptz NOT NULL,
  started_at      timestamptz,
  finished_at     timestamptz,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,
  CONSTRAINT data_export_jobs_kind_chk
    CHECK (kind IN ('audit_log', 'tenant', 'data_subject')),
  CONSTRAINT data_export_jobs_status_chk
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  CONSTRAINT data_export_jobs_format_chk CHECK (format IN ('csv', 'json'))
);

CREATE INDEX data_export_jobs_tenant_creator_idx
  ON data_export_jobs (tenant_id, created_by, created_at);
CREATE UNIQUE INDEX data_export_jobs_idempotency_key
  ON data_export_jobs (tenant_id, created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Erasure requests (MVP_SPEC M11)
--
-- The record that somebody exercised their right to erasure, who approved it,
-- and what it reached. It is also the **authorization token for the redaction
-- itself**: the policy on `audit_logs` below permits a diff to be rewritten
-- only while a row here says this subject's erasure is in flight. See
-- ADR-0032.
-- ---------------------------------------------------------------------------
CREATE TABLE erasure_requests (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- contact | lead. Narrower than LINK_TARGET_TYPES: an account is a company,
  -- and a company has no data-protection rights to exercise.
  subject_object_type text NOT NULL,
  subject_record_id   uuid NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  -- Free text from the requester, shown in the audit entry. Never PII of the
  -- subject: the API length-caps it and it is written by an administrator.
  reason              text,
  records_erased      integer NOT NULL DEFAULT 0,
  audit_rows_redacted integer NOT NULL DEFAULT 0,
  failure_reason      text,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_by          uuid,
  CONSTRAINT erasure_requests_subject_chk
    CHECK (subject_object_type IN ('contact', 'lead')),
  CONSTRAINT erasure_requests_status_chk
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT erasure_requests_reason_chk
    CHECK (reason IS NULL OR length(reason) <= 500)
);

-- One in-flight request per subject. Two concurrent erasures of the same person
-- would each redact what the other had already redacted and report doubled
-- counts; more importantly, the redaction window below is defined by "there is
-- a processing request", and that should mean exactly one.
CREATE UNIQUE INDEX erasure_requests_one_in_flight
  ON erasure_requests (tenant_id, subject_object_type, subject_record_id)
  WHERE status IN ('pending', 'processing');

-- The lookup the audit policy makes, once per row it considers.
CREATE INDEX erasure_requests_processing_idx
  ON erasure_requests (tenant_id, subject_object_type, subject_record_id)
  WHERE status = 'processing';

CREATE INDEX erasure_requests_tenant_created_idx
  ON erasure_requests (tenant_id, created_at, id);

-- ---------------------------------------------------------------------------
-- RLS and grants for the two new tables
-- ---------------------------------------------------------------------------
CALL apply_tenant_rls('data_export_jobs');
CALL apply_tenant_rls('erasure_requests');

-- The API queues an archive; the worker runs it and writes the outcome.
GRANT SELECT, INSERT ON data_export_jobs TO crm_app;
GRANT SELECT, INSERT, UPDATE ON data_export_jobs TO crm_worker;

-- The API records the request; the worker drives it through its states.
-- No DELETE for either: an erasure request is itself a compliance record.
GRANT SELECT, INSERT ON erasure_requests TO crm_app;
GRANT SELECT, INSERT, UPDATE ON erasure_requests TO crm_worker;

-- ---------------------------------------------------------------------------
-- 5. The erasure path (ADR-0032) — read this before changing it
--
-- The conflict: CLAUDE.md §5.10 requires the audit log to be append-only, and
-- 0004 enforces that by **withholding** UPDATE and DELETE from crm_app rather
-- than by a policy, precisely so that no future migration can quietly undo it.
-- DPDP §12 and GDPR Art. 17 require that, on request, personal values stop
-- being readable. MVP_SPEC M11 states the resolution: the audit row is kept and
-- its personal values are replaced by `[erased]`. That is an UPDATE, and the
-- application role must not be the one able to make it.
--
-- So the capability lives in `crm_erasure`, a role the API holds no credentials
-- for — only the worker's erasure job connects as it — and it is narrowed three
-- ways, each of which is enforced by Postgres and not by our code:
--
--   a. COLUMN grant. `UPDATE (changes)` and nothing else. The role cannot
--      change `action`, `actor_id`, `occurred_at`, `object_type` or
--      `record_id`, so the *structure* of history — who did what to which
--      record, and when — is immutable even to the erasure path. Only the
--      values inside the diff can be rewritten, which is exactly the
--      obligation and nothing more.
--   b. No INSERT, no DELETE. It cannot fabricate history and it cannot remove
--      a row. The audit entry recording that an erasure happened is written by
--      crm_worker, through the ordinary append-only path.
--   c. POLICY. It may touch a row only while an `erasure_requests` row for
--      that exact (tenant, object_type, record_id) says `processing`. The
--      worker opens that window immediately before redacting and closes it
--      immediately after, as crm_worker. Outside that window the role can read
--      and write nothing at all — which is the property the security suite
--      asserts directly.
--
-- What remains: a compromised worker *during* an erasure it also controls could
-- blank the diffs of that one subject in that one tenant. That residual is
-- stated plainly in ADR-0032 rather than papered over. The alternatives were
-- giving crm_app UPDATE on audit_logs (strictly worse: every request path), or
-- refusing erasure (not lawful).
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION current_tenant_id() TO crm_erasure;
GRANT EXECUTE ON FUNCTION current_app_user_id() TO crm_erasure;

GRANT SELECT ON audit_logs TO crm_erasure;
GRANT UPDATE (changes) ON audit_logs TO crm_erasure;
GRANT SELECT ON erasure_requests TO crm_erasure;

-- The window. Repeated in USING and WITH CHECK because an UPDATE is judged
-- against both the row as it was and the row as it will be; the column grant
-- means the two can only differ in `changes`, but saying so here keeps the rule
-- true even if that grant is ever widened by mistake.
CREATE POLICY audit_logs_erasure_select ON audit_logs
  FOR SELECT TO crm_erasure
  USING (
    tenant_id = current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM erasure_requests r
      WHERE r.tenant_id = audit_logs.tenant_id
        AND r.subject_object_type = audit_logs.object_type
        AND r.subject_record_id = audit_logs.record_id
        AND r.status = 'processing'
    )
  );

CREATE POLICY audit_logs_erasure_redact ON audit_logs
  FOR UPDATE TO crm_erasure
  USING (
    tenant_id = current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM erasure_requests r
      WHERE r.tenant_id = audit_logs.tenant_id
        AND r.subject_object_type = audit_logs.object_type
        AND r.subject_record_id = audit_logs.record_id
        AND r.status = 'processing'
    )
  )
  WITH CHECK (
    tenant_id = current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM erasure_requests r
      WHERE r.tenant_id = audit_logs.tenant_id
        AND r.subject_object_type = audit_logs.object_type
        AND r.subject_record_id = audit_logs.record_id
        AND r.status = 'processing'
    )
  );

-- The policy above reads `erasure_requests`, which has FORCE ROW LEVEL
-- SECURITY of its own; without a policy for this role the subquery would see
-- nothing and the window would never open. Narrow to match: only the processing
-- row, only in the current tenant.
CREATE POLICY erasure_requests_erasure_read ON erasure_requests
  FOR SELECT TO crm_erasure
  USING (tenant_id = current_tenant_id() AND status = 'processing');

-- ---------------------------------------------------------------------------
-- 6a. One pending purge sweep per tenant
--
-- The Recycle Bin purge is scheduled the way every other recurring job in this
-- system is: as an outbox row dated to when it is due (ADR-0025). The handler
-- purges a batch and arms the next sweep in the same transaction, so the chain
-- sustains itself with no cron and no cross-tenant scan.
--
-- A per-record event dated to `deleted_at + 30 days` was the obvious
-- alternative and is the wrong shape at scale: a bulk delete of 50,000 contacts
-- would leave 50,000 rows in the relay's pending index for a month. One row per
-- tenant is 1,000 rows for the whole platform.
--
-- This index is what makes arming idempotent: `ON CONFLICT DO NOTHING` against
-- it means a redelivered sweep, a concurrent soft delete and the migration's
-- own backfill cannot between them queue two. It covers `pending` only, so the
-- sweep currently being processed can still arm its successor.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX outbox_events_one_pending_sweep
  ON outbox_events (tenant_id, event_type)
  WHERE event_type = 'recycle_bin.sweep_due.v1' AND status = 'pending';

-- ---------------------------------------------------------------------------
-- 6b. Backfill for tenants that already exist
--
-- `provisionTenantDefaults` equips new tenants. Existing ones need the same
-- capability rows or the audit viewer and the data-rights screens are invisible
-- to them — a migration that only equips new tenants ships a feature nobody can
-- reach (the lesson 0010 wrote down).
--
-- Matched on the **system** roles named Owner and Admin, which is how the seed
-- itself is keyed. A tenant that renamed or deleted them, or that built custom
-- roles, gets nothing here and grants the capability deliberately in the role
-- editor — the right default-deny answer for a capability this sharp.
--
-- The temporary migrator policies are the pattern 0007 and 0010 established:
-- every tenant table has FORCE ROW LEVEL SECURITY, which applies to the owner
-- too, so a backfill must be allowed explicitly and then disallowed again, in
-- this same transaction.
-- ---------------------------------------------------------------------------
CREATE POLICY role_permissions_m11_backfill ON role_permissions
  FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY roles_m11_backfill ON roles
  FOR SELECT TO crm_migrator USING (true);
CREATE POLICY tenants_m11_backfill ON tenants
  FOR SELECT TO crm_migrator USING (true);
CREATE POLICY outbox_events_m11_backfill ON outbox_events
  FOR ALL TO crm_migrator USING (true) WITH CHECK (true);

INSERT INTO role_permissions (id, tenant_id, role_id, object_type, action, scope,
                              created_at, updated_at)
SELECT gen_random_uuid(), r.tenant_id, r.id, g.object_type, g.action, 'all', now(), now()
FROM roles r
CROSS JOIN (
  VALUES
    ('Owner', 'audit_log',    'read'),
    ('Owner', 'audit_log',    'export'),
    ('Owner', 'tenant_data',  'export'),
    ('Owner', 'data_subject', 'read'),
    ('Owner', 'data_subject', 'export'),
    ('Owner', 'data_subject', 'delete'),
    ('Admin', 'audit_log',    'read'),
    ('Admin', 'audit_log',    'export'),
    ('Admin', 'data_subject', 'read'),
    ('Admin', 'data_subject', 'export')
) AS g(role_name, object_type, action)
WHERE r.is_system AND r.name = g.role_name
ON CONFLICT (tenant_id, role_id, object_type, action) DO NOTHING;

-- Arm the purge sweep for every existing tenant, due an hour from now so that
-- a deployment does not immediately start deleting on top of itself. New
-- tenants are armed by `provisionTenantDefaults`.
INSERT INTO outbox_events (id, tenant_id, event_type, object_type, record_id,
                           payload, status, available_at, created_at)
SELECT gen_random_uuid(), t.id, 'recycle_bin.sweep_due.v1', 'tenant', t.id,
       '{}'::jsonb, 'pending', now() + interval '1 hour', now()
FROM tenants t
ON CONFLICT DO NOTHING;

DROP POLICY role_permissions_m11_backfill ON role_permissions;
DROP POLICY roles_m11_backfill ON roles;
DROP POLICY tenants_m11_backfill ON tenants;
DROP POLICY outbox_events_m11_backfill ON outbox_events;
