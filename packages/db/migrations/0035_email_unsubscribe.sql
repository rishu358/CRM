-- The unsubscribe link every email carries (ADR-0076, PR 3b of the email plan).
--
--   email_messages         gains unsubscribe_token: the link's token, kept so the worker can put it in the
--                          message it sends (the worker holds no signing key, by design)
--   email_provider_events  now also records a person's own unsubscribe, as the event type 'unsubscribed'
--
-- Read ADR-0076 before changing either: they are part of the design of the public door that feeds them.
--
-- Size: one nullable column with no default (no rewrite) on email_messages, which is new in 0032 and small, and
-- a CHECK replaced on email_provider_events, which is new in 0034 and empty or nearly. The runner wraps the file
-- in one transaction.
--
-- Who may touch what: nothing new is granted. crm_app already INSERTs and SELECTs, and crm_worker SELECTs, the
-- whole of email_messages, so the new column needs no grant. The platform's routing role (crm_auth) holds a
-- column-limited SELECT that does NOT include it: the door finds an email by the id inside the token after
-- checking the signature, and never needs to read a token.

ALTER TABLE email_messages ADD COLUMN unsubscribe_token text;
-- Null on a message queued before this step: it is sent without a link, and the screens say nothing about it.
ALTER TABLE email_messages ADD CONSTRAINT email_messages_unsubscribe_token_chk
  CHECK (unsubscribe_token IS NULL OR char_length(unsubscribe_token) BETWEEN 1 AND 200);

ALTER TABLE email_provider_events DROP CONSTRAINT email_provider_events_type_chk;
ALTER TABLE email_provider_events ADD CONSTRAINT email_provider_events_type_chk
  CHECK (event_type IN ('delivered', 'bounced', 'complained', 'unsubscribed'));
