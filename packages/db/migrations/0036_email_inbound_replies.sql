-- Inbound replies (ADR-0077, PR 4a of the email plan).
--
--   email_messages         gains reply_token (outbound: the local part of the reply address the email carries),
--                          reply_to_email_id (inbound: the email it answers), attachment_count and body_shortened
--                          (inbound: what was left out), and a new status, 'received'
--   email_provider_events  now also records a received reply, as the event type 'received'
--
-- Read ADR-0077 before changing the grants and policies: they are part of the design of the public door that feeds
-- these, and the one place the worker is allowed to write a message at all.
--
-- Size: four columns on email_messages, nullable or with a constant default (no rewrite, on a table that is
-- new in 0032 and small), three small partial indexes, and a CHECK replaced on each of two small tables. The runner
-- wraps the file in one transaction.
--
-- Who may touch what:
--   crm_app    unchanged, except that a restrictive policy now limits its INSERT to outbound rows: the API cannot
--              write a received message, whatever a request says.
--   crm_worker may now INSERT into email_messages and email_message_links, **only inbound rows**, by restrictive
--              policy. It still cannot update a message beyond the columns 0032 and 0034 gave it, and it still
--              cannot write an outbound row, so no bug in the worker can create an email that says it was sent.
--   crm_auth   unchanged: it still reads three columns of email_messages and none of the new ones.

-- ---------------------------------------------------------------------------
-- email_messages
-- ---------------------------------------------------------------------------
ALTER TABLE email_messages DROP CONSTRAINT email_messages_status_chk;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_status_chk
  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'delivered', 'bounced', 'complained', 'received'));

-- Outbound mail only: the signed local part of the address a reply can be sent to. Null on mail queued before
-- this step, or while no inbound domain is configured: that mail carries no second reply address.
ALTER TABLE email_messages ADD COLUMN reply_token text;
-- Inbound only: the sent email a reply answers, found from the address it was sent to.
ALTER TABLE email_messages ADD COLUMN reply_to_email_id uuid;
-- Inbound only: what was left out of the stored copy, so the screen can say so.
ALTER TABLE email_messages ADD COLUMN attachment_count integer NOT NULL DEFAULT 0;
ALTER TABLE email_messages ADD COLUMN body_shortened boolean NOT NULL DEFAULT false;

ALTER TABLE email_messages ADD CONSTRAINT email_messages_reply_token_chk
  CHECK (reply_token IS NULL OR (direction = 'outbound' AND char_length(reply_token) BETWEEN 1 AND 80));
ALTER TABLE email_messages ADD CONSTRAINT email_messages_reply_to_chk
  CHECK (reply_to_email_id IS NULL OR direction = 'inbound');
ALTER TABLE email_messages ADD CONSTRAINT email_messages_attachment_count_chk
  CHECK (attachment_count >= 0 AND (attachment_count = 0 OR direction = 'inbound'));
ALTER TABLE email_messages ADD CONSTRAINT email_messages_shortened_chk
  CHECK (NOT body_shortened OR direction = 'inbound');
-- A received message is inbound and nothing else is.
ALTER TABLE email_messages ADD CONSTRAINT email_messages_direction_status_chk
  CHECK ((direction = 'inbound') = (status = 'received'));
ALTER TABLE email_messages ADD CONSTRAINT email_messages_reply_to_fkey
  FOREIGN KEY (tenant_id, reply_to_email_id) REFERENCES email_messages (tenant_id, id)
  ON DELETE SET NULL (reply_to_email_id);

-- One received email is filed once, whatever number of times its event arrives.
CREATE UNIQUE INDEX email_messages_inbound_provider_key
  ON email_messages (tenant_id, provider_message_id)
  WHERE direction = 'inbound' AND provider_message_id IS NOT NULL;
-- The per-email cap counts the replies filed under one sent email.
CREATE INDEX email_messages_reply_to_idx
  ON email_messages (tenant_id, reply_to_email_id) WHERE reply_to_email_id IS NOT NULL;
-- The per-company daily cap counts the replies filed in the last day.
CREATE INDEX email_messages_inbound_recent_idx
  ON email_messages (tenant_id, created_at) WHERE direction = 'inbound';

GRANT INSERT ON email_messages TO crm_worker;
-- Restrictive policies are ANDed with the tenant policy: each role may insert only its own direction.
CREATE POLICY email_messages_worker_inbound_only ON email_messages
  AS RESTRICTIVE FOR INSERT TO crm_worker WITH CHECK (direction = 'inbound');
CREATE POLICY email_messages_app_outbound_only ON email_messages
  AS RESTRICTIVE FOR INSERT TO crm_app WITH CHECK (direction = 'outbound');

-- ---------------------------------------------------------------------------
-- email_message_links: a reply is linked to the records its original is linked to
-- ---------------------------------------------------------------------------
GRANT INSERT ON email_message_links TO crm_worker;
CREATE POLICY email_message_links_worker_inbound_only ON email_message_links
  AS RESTRICTIVE FOR INSERT TO crm_worker
  WITH CHECK (EXISTS (
    SELECT 1 FROM email_messages m
    WHERE m.tenant_id = email_message_links.tenant_id
      AND m.id = email_message_links.email_message_id
      AND m.direction = 'inbound'));

-- ---------------------------------------------------------------------------
-- email_provider_events
-- ---------------------------------------------------------------------------
ALTER TABLE email_provider_events DROP CONSTRAINT email_provider_events_type_chk;
ALTER TABLE email_provider_events ADD CONSTRAINT email_provider_events_type_chk
  CHECK (event_type IN ('delivered', 'bounced', 'complained', 'unsubscribed', 'received'));
