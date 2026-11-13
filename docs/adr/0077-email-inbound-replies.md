# ADR-0077: Inbound replies, by a second reply address

- **Status:** Accepted (PR 4a of the email plan, the server half; the screens are PR 4b). Built after the owner said
  to go ahead on the plan in [#41](https://github.com/rishu358/CRM/pull/41), with the plan's recommended answers to
  its seven questions.
- **Date:** 2026-11-10
- **Related:** `docs/plans/email-inbound-replies.md` (the plan this builds, on #41), ADR-0073 (send and log),
  ADR-0075 (delivery events, whose door this reuses), ADR-0076 (the unsubscribe link, whose secret and token
  machinery this reuses), CLAUDE.md sections 5 and 13

## Context

A customer's reply used to land only in the rep's own inbox, so the record told half the story. The plan asked for
the reply to be filed on the record without reading anyone's mailbox and without holding any mailbox credentials,
and for nothing in a reply to be trusted: anyone who has ever received one of our emails can send to the address it
carries, and a sender line can say anything.

## Decision

1. **Every email carries a second reply address**, while `EMAIL_INBOUND_DOMAIN` is set: the reply line holds the rep's
   address, as before, **and** `r.<32 hex: the email's id>.<26 base32>@<inbound domain>`. A mail program that answers a
   `Reply-To` with two addresses addresses the answer to both, so the rep keeps every reply in their own inbox and
   the CRM gets a copy: turning this on removes nothing. The 26 characters are a 128-bit HMAC of the email id under a
   key derived (HKDF, its own label) from the unsubscribe secret, written in lower-case base32 so the local part is 61
   characters (a mail address allows 64) and survives a mail system changing its case. **Unset, nothing is added and
   nothing changes.** The API signs the address when it queues the email and stores the token
   (`email_messages.reply_token`), as it does the unsubscribe token, because only the API holds the key; the worker
   puts it in the message.
2. **No new secret.** The reply address shares `EMAIL_UNSUBSCRIBE_SECRET` and its `_PREVIOUS` list with the unsubscribe
   link: the same lifetime (an address printed in an old email must keep working) and the same rule (set once, never
   rotated on a schedule). Each use derives its key under its own label, so a token made for one is worth nothing to the
   other, and a test says so. The variable's name mentions only one of its uses: renaming it later is a breaking
   change, so it was left, and `docs/SECRETS.md` says both.
3. **Resend receives; the existing door hears about it.** `email.received` is one more event through
   `/api/v1/public/email-events/resend`, with the same security: raw body capped, **signature checked first**, no
   session, no company read from the request. The adapter turns it into the same kind of normalized event, and from it
   keeps **only the recipients that have the shape of one of our reply addresses**; the sender, the subject, the
   attachment names and every other recipient stay in the adapter, because they are people.
4. **The door finds the email from the address, not from the request.** In this order: the feature is on; a recipient is on
   our domain and has the right shape; **its signature checks out, with no database**; only then a one-column routing read
   as `crm_auth` for the email's company. An address we did not issue, a wrong signature, another domain, an email that
   is gone, a suspended company and a feature that is off are **all the same quiet 204**, so the catch-all costs one
   signature check per junk message, tells no one which part was wrong and **fetches and stores nothing**. A good one is
   recorded once in the company's own transaction (`email_provider_events`, keyed by Svix's id, so a replay changes
   nothing) and queued as `email.reply_received.v1`, which holds ids only.
5. **The worker fetches and files it**, with the network call outside every transaction, as the send does. It looks first
   (the sent email is there and not erased, this received message is not already filed, the limits below), then fetches
   through the new `InboundEmailProvider` interface (`GET /emails/receiving/{id}` at Resend, through the same pinned,
   https-only client, to `api.resend.com` and nowhere else; no `download_url` or `raw` link is ever followed), then files
   one row, links it to the records the sent email is linked to, audits it and queues one timeline event. A temporary
   failure is retried by the relay; a permanent one, a message with no usable sender and a message that claims to be from
   our own sending address (a loop) are dropped with a log line of ids only.
6. **What is stored is shaped to fit, and is text.** The row is `direction = 'inbound'`, `status = 'received'`; the sender
   as **claimed**, lower-cased, with the name cut to 80 characters (the address stands in when there is none); the subject
   cut to 200 on one line; **the plain-text part only**, normalised and with control characters dropped, cut to the same
   10,000 characters an outgoing body may have, with a flag (`body_shortened`) when it was cut; a message with no plain-text
   part says so ("this message had no plain-text part"). **No HTML is ever stored** and none is drawn. Attachments are
   counted (`attachment_count`) and never fetched. `to_address` is the rep's address, never the capture address,
   because the row requires a recipient. The sender's own `Message-ID` is the log's unique key, so a message that reached two
   of our addresses is filed once.
7. **Nothing in a reply is trusted, and nothing is done from one.** It changes no status, no consent, no record. The
   sender is shown as unverified. Nothing written to an event, the audit log or the timeline holds the address, the
   subject or the words.
8. **Limits**, counted from the rows themselves so they hold without Redis: 20 replies filed under one sent email, 500 per
   company per day, 1 MB read from Resend per message (constants in `@crm/core`, a proposal, not a verified standard).
   Past them the message is dropped before anything is fetched.
9. **The deliberate widening of two rights** (migration 0036). The worker may now `INSERT` into `email_messages`, but a
   **restrictive** row-level policy lets it insert only `direction = 'inbound'` rows, and a second restrictive policy limits the
   application role's insert to outbound. So a bug in the worker still cannot write an email that says it was sent, and
   nothing the API is asked can write a received message. And the worker may now change `from_address` and `from_name`,
   because an erasure must scrub the name and address a person sent a reply from; a **trigger** refuses any change to either
   column of an email we sent, with the same error a missing grant gives, so the company's own sender stays fixed. (The worker
   could already link any message, since 0033, so links need no policy of their own.) A CHECK ties direction and status together (`inbound` if and only if `received`), and keeps the reply-only
   columns off what we sent and the sent-only token off a reply. A database spec proves each refusal.
10. **Erasure covers a reply** like any email: the person's own address and name on an inbound row are scrubbed to empty
    and "Erased", the recipient, subject and body as for outbound, and the row stays so counts and the audit trail stay true.
11. **Configuration:** one new variable, `EMAIL_INBOUND_DOMAIN` (API and worker scopes, not a secret, no default; set but
    not a plain host name refuses to start, so a typo cannot print addresses that go nowhere). Nothing for the web scope.

## Differences from the plan

- **Resend's documentation said more than the plan could use.** The plan was written from the receiving, webhook and
  attachments pages, which gave no HTTP path for fetching a message and said nothing about authentication results. The
  API reference, read while building this, gives `GET /emails/receiving/{id}`, a `headers` object, a `raw` link and an
  `authentication` object holding `spf`, `dkim` and `dmarc` results. This PR **uses the path** and **does not yet use the
  authentication results**: every reply is still treated as unauthenticated, as the plan said. Storing the results and showing
  "the sender's domain passed DMARC" is an obvious, small next step, and is left for the owner to ask for (it changes what
  the screen can honestly say about a sender).
- **No counter table.** The plan listed a small table for the caps; the replies are rows already, so the limits count them
  (indexes in 0036 make that cheap) and nothing else is stored.
- **The bell notification comes with the screens** (4b), not here: a notification with no label or digest wording would
  show as something generic, and it is not useful until the screen that explains it exists. The server files the reply,
  audits it and writes the timeline event.
- **`In-Reply-To` is not used for matching.** It is documented as possibly present in the headers, but the address already
  names the email, and the plan keeps header matching for mail somebody forwards by hand, which is later.

## Consequences and limits

- **Nothing here has been tested against a real Resend account or a real mail program.** Five things need one real reply:
  that mail programs address a reply to **both** reply-to addresses (the weakest point: some may use only the first, in
  which case the rep's copy still works and the CRM simply gets none); that `email.received` is signed as the other events
  are; that `GET /emails/receiving/{id}` answers as its reference shows; whether a message can be fetched the moment its event
  arrives (a 404 is treated as "not yet" and retried, within the relay's own limit on attempts); and whether `Auto-Submitted`
  and `In-Reply-To` are in the headers. Until then the feature is off wherever `EMAIL_INBOUND_DOMAIN` is unset, which is every
  installation.
- **The reply address is a capability anyone who has received our email holds.** They can put text on that one record's
  timeline, as an unverified, capped line. The design contains what that allows; it cannot make it impossible.
- **Amazon SES and SMTP cannot receive**: only Resend has a receiving adapter, and a configuration with an inbound domain and
  another provider logs a warning at start-up and files nothing.
- **Changing or losing `EMAIL_UNSUBSCRIBE_SECRET` now ends the reply addresses in old email as well as the unsubscribe
  links**, with the same remedy: keep the old key in `EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS`.
- A reply with only an HTML part is stored as a note that it had no plain-text part. Whether that is common is for real
  replies to show; an HTML-to-text step would be a dependency, so it is asked about first.
- The MX record for a receiving domain must be the lowest priority for that domain, so it belongs on a subdomain nothing else
  receives mail on (the plan's section 3.1). The platform cannot check DNS; an administrator is told what to add.

## Alternatives considered

- **Only our address as `Reply-To`, and the CRM forwards each reply to the rep.** The rep's inbox then depends on us, and we
  would be sending a customer's words by email: a loop and abuse risk of its own.
- **The rep BCCs or forwards by hand to a company-wide address.** Needs no change to what we send, but relies on a person
  remembering. It is the fallback if a real test shows mail programs ignore the second address.
- **A random token per email, stored as a hash.** No signing key, but the routing role would need to read the hash column, and
  the worker could not build the address from a hash.
- **Putting the reply token in the routing role's column grant.** It would widen what the public door can read for the sake
  of a lookup the signature already makes unnecessary.
- **Storing the HTML part, sanitised.** A stored-XSS surface for little value in v1; the plain text is what a reader needs.
