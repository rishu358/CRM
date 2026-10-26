-- Audit log, transactional outbox and notifications.

-- ---------------------------------------------------------------------------
-- Audit log (CLAUDE.md §5.10).
--
-- Partitioned monthly by occurred_at. This is the fastest-growing table in the
-- system, and partitions let an old month be detached and archived instantly
-- instead of a DELETE that would hold locks for hours on a live table.
--
-- Partitioning requires the partition key in the primary key, hence (id, occurred_at).
-- Append-only is enforced by grants in 0004, not by convention: crm_app is
-- never given UPDATE or DELETE here.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          uuid NOT NULL,
  tenant_id   uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  action      text NOT NULL,
  object_type text NOT NULL,
  record_id   uuid,
  changes     jsonb,
  ip_address  text,
  user_agent  text,
  request_id  text,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX audit_logs_tenant_time_idx ON audit_logs (tenant_id, occurred_at);
CREATE INDEX audit_logs_tenant_record_idx ON audit_logs (tenant_id, object_type, record_id);
CREATE INDEX audit_logs_tenant_actor_idx ON audit_logs (tenant_id, actor_id, occurred_at);

-- Create partitions for a window around now so that a fresh database, a test
-- container and a development machine all work immediately. A scheduled worker
-- job keeps the window rolling; this bootstrap covers the first year.
DO $$
DECLARE
  start_month date := date_trunc('month', now() - interval '1 month')::date;
  partition_start date;
  partition_end date;
BEGIN
  FOR i IN 0..13 LOOP
    partition_start := (start_month + (i || ' months')::interval)::date;
    partition_end := (partition_start + interval '1 month')::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
      'audit_logs_' || to_char(partition_start, 'YYYY_MM'),
      partition_start,
      partition_end
    );
  END LOOP;
END
$$;

-- A row that falls outside every partition would otherwise abort the whole
-- transaction it was written in — losing the business write along with the
-- audit entry. The default partition keeps the write succeeding and makes the
-- gap visible instead.
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;

-- ---------------------------------------------------------------------------
-- Transactional outbox (ADR-0006).
--
-- Written in the same transaction as the state change it describes, so the
-- event exists if and only if the change committed. The worker relays it.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  event_type   text NOT NULL,
  object_type  text,
  record_id    uuid,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending',
  attempts     integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  actor_id     uuid,
  request_id   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  relayed_at   timestamptz,
  CONSTRAINT outbox_events_status_chk
    CHECK (status IN ('pending', 'processing', 'relayed', 'failed'))
);

-- The worker's claim query. Partial, so relayed rows leave the index entirely
-- and it stays small no matter how much history accumulates.
CREATE INDEX outbox_events_pending_idx
  ON outbox_events (available_at) WHERE status = 'pending';
CREATE INDEX outbox_events_tenant_idx ON outbox_events (tenant_id, created_at);

-- ---------------------------------------------------------------------------
-- In-app notifications.
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);
CREATE INDEX notifications_tenant_user_idx ON notifications (tenant_id, user_id, created_at);
