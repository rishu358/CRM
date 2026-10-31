# ADR-0076: The unsubscribe link every email carries

- **Status:** Accepted (PR 3b of the email plan, built after the owner approved `docs/plans/email-delivery-status.md`)
- **Date:** 2026-10-31
- **Related:** `docs/plans/email-delivery-status.md` (the plan this builds, section 5), ADR-0075 (delivery events and
  blocked addresses, whose machinery this reuses), ADR-0073 (send and log), ADR-0065 (the lead form's public door,
  which this copies), ADR-0049 (key ids and rotating `AUTH_SECRET`), CLAUDE.md sections 5 and 13

## Context

Every company shares one sending address, and a person who no longer wants a company's email needs a way to say so
that does not depend on the company's goodwill. Until now the only way a refusal reached the system was a spam
complaint, the worst way to receive one. The plan asked for a one-click unsubscribe on every email, recorded as a
refusal that the send path already respects, and approved it for every email, not only templates (question 2).

## Decision

1. **Every email carries a token**, put in the row when the API queues it (`email_messages.unsubscribe_token`,
   migration 0035): `v1.<email id>.<signature>`, where the signature is an HMAC-SHA256 of the email id under a key
   derived (HKDF, label `crm:email-unsubscribe:v1`) from `AUTH_SECRET`. It names an email, never a person's address,
   and carries no company id. It does not expire, because a link in an old email must still work. **No new secret
   and no new variable**, as the plan said.
2. **The worker puts the link in the message when it sends**, not the API when it queues: the footer is built from
   the stored token, the company's `WEB_URL` and `API_URL`. Plain text gets the sentence "To stop receiving email from
   {name}, open: {link}" under the same separator as the company footer; HTML gets the same sentence with the link as a
   link (everything escaped). The adapters that can carry a header add `List-Unsubscribe: <the API address>` and
   `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058): Resend as `headers`, SES as the message's own header
   list, SMTP through the library. Each adapter refuses an address that is not a plain `http(s)` address with no space,
   bracket or quote. **The sentence in the body is what is relied on**: whether a provider honours the headers is not
   something to assume (section "Consequences").
3. **A public door**, the fourth after the lead form, the events door and the sign-in family:
   `GET` and `POST /api/v1/public/email-unsubscribe/{token}`. Copied from the others: a body cap before anything is
   read (the form's 16 KB), no session, no cookie, no cross-origin approval, an empty query string, `no-store`, each
   handler `@Public()` on its own, both routes on the frozen list, and a boundary test that fails if the module's
   imports widen. In this order, and nothing else:
   - **the signature is checked first, with no database**; a made-up value, a changed id, a signature made with a key
     this installation does not hold, and a good signature for an email that is gone or whose company is suspended are
     **one 404 with one body**, so nothing says which part was wrong;
   - **the company is found from the email the signed token names** (a routing read by `crm_auth` that returns one
     column, the company id, and cannot read the token, the address or the words), never from the request;
   - **GET asks and changes nothing**, because mail scanners open every link in a message: it answers with the name
     the email was sent under, so the page can say "Stop emails from {name}?";
   - **POST does it.** It is the address a mail program posts to, and the one the page's button posts to. Its body
     (`List-Unsubscribe=One-Click`) is capped at 16 KB before anything reads it, parsed by the framework like any form
     body, and then ignored by the handler: nothing in it can name a company, a person or an address, and a test posts
     a company, an address and a reason in it to show that.
4. **It is applied by the machinery that applies a spam complaint** (ADR-0075), not by a second path. The door records
   one row in `email_provider_events` (provider `unsubscribe_link`, the event id is the email id, so a repeat is
   recognised and does nothing) and one `email.provider_event.v1` outbox event of type `unsubscribed`. The worker, in
   the company's own transaction: blocks the address by hash with the reason `unsubscribed` (**which no one can lift**,
   enforced by the database CHECK from 0034, not only by the service); withdraws consent to email on every contact that
   carries the address (source `unsubscribe_link`; a contact that has already withdrawn is left as it is, so the first
   refusal is the one on record); writes an audit entry for the block and one for each contact; and files one timeline
   line, "Unsubscribed from email", on the record the email was sent from. It leaves the email's status alone (the
   unsubscribe says nothing about whether the mail arrived) and **never counts toward a pause**: a person choosing to
   stop is not a bad run.
5. **The page** is `/u/<token>` in the web app, public like `/f/<key>`: it asks, and its button is a plain form post
   to `/u/<token>/confirm`, which asks the API, then answers 303, to `/u/<token>/done` when it worked and back to the
   question when it did not (a link that is not valid then says so). It works without scripts, reads no cookie, sends no
   credential, tells search engines not to index it and sends no referrer, because the token is in the address. The
   done page checks nothing and says the same to anyone who opens it. All its words are in the web strings, which is
   the one place counsel reads before the first real customer sends (question 6).
6. **Limits.** One link may be used twenty times an hour (counted in the shared counter, so it holds across API
   instances); the per-address limit that already applies to every request applies as well.
7. **Configuration:** `API_URL` is now also read by the worker (it is a public origin, not a secret), to build the
   address a mail program posts to. Nothing else.

## Differences from the plan

- **The token is stored, and the plan said it was stateless.** The plan derived the key from `AUTH_SECRET` and signed
  the token when it was needed. The worker has to put the link in the message, and the worker does not hold
  `AUTH_SECRET` and must not (CLAUDE.md section 13.4: the secret encrypts everyone's authenticator and is deliberately
  in the API's scope only). So the API signs the token when it queues the email and stores it, and the worker reads it.
  Checking a token is still stateless: the signature is the proof, and the stored copy is never used to check one.
  The column is readable by the application role and the worker only; the routing role cannot read it (a database
  spec says so).
- **The limit is per link, not per address.** The door never learns the address (the person's address is on the email,
  not in the request), so "per address and per token" became per token, plus the per-address limit every request
  already has.
- **The audit entry has no "source: unsubscribe" field of its own.** The block's audit entry names the reason
  (`unsubscribed`) and the email that caused it, and the consent entry says "unsubscribed from the link in an email";
  that is the same information without a second vocabulary.
- **Every block now has an audit entry, not only an unsubscribe.** The plan said so for suppressions in general, and
  the worker built in 3a did not write one when it added a block for a bounce or a complaint. Adding it for the
  unsubscribe without the others would have left an inconsistency, so the same line now covers all three.

## Consequences and limits

- **Rotating `AUTH_SECRET` ends every link signed under the old key unless that key stays in `AUTH_SECRET_PREVIOUS`.**
  A token is checked against the current key and every key in `AUTH_SECRET_PREVIOUS` (at most three), so links keep
  working through a rotation, but `docs/SECRETS.md` says to remove the old key once authenticators are re-encrypted.
  Removing it also ends the links in email sent under it. The document now says so, and leaves the decision to the
  operator: keep the old key as long as links in those emails should work. This is the price of "no new secret"; a
  dedicated, rarely rotated secret would remove it, and is the alternative below.
- **There is a short window between a click and the block.** The door records the unsubscribe and queues the event;
  the worker applies it a moment later (the relay's polling interval). A send queued in those seconds still goes. The
  same window exists for a spam complaint and for a bounce, and closing it would mean the public door writing to the
  contact and the block list itself, which the door's boundary test exists to prevent.
- **An email queued before this step has no token** and is sent without a link; nothing is made up for it. Nothing is
  deployed anywhere, so this is a note for whoever upgrades a running installation: it applies only to messages still
  waiting in the queue at that moment.
- **Nothing here has been tested against a real mail provider or a real mail program.** What needs one real send and
  one real inbox: that the headers survive (Resend's page does not say that it carries `List-Unsubscribe`), that Gmail
  and Outlook offer their own button for them, and that the one-click post arrives as the standard describes.
  Until then the sentence and link in the body are the working mechanism, and the headers are an addition that may do
  nothing.
- **The wording is not legal advice and has not been reviewed.** The owner's answer to question 6 is that counsel
  reads the sentence and the page before the first real customer sends an email. It is in
  `packages/core/src/email/outreach.ts` (`unsubscribeLine`, `unsubscribeHtml`) and the `unsubscribe.*` web strings.
- With SMTP the headers go through the library untested against a real server; with SES they go in the API's own
  header list, also untested. Both are covered only by fakes.
- A person who unsubscribes is blocked **by address, for the company that sent the email**. Another company that
  writes to the same address is a different sender, and the person has not refused it.
- A suppression is by address, so a typo corrected on a record does not free the old address (ADR-0075).

## Alternatives considered

- **A dedicated unsubscribe secret** (`EMAIL_UNSUBSCRIBE_SECRET`, in the API scope, rotated rarely). It would remove the
  rotation trap above, at the cost of a new secret, a new variable and a new rotation procedure, all of which the plan
  said not to add. Worth reconsidering if the owner would rather add a secret than carry that note.
- **A random token and a stored hash**, as the lead form's key does. No signing key at all, so no rotation trap, but the
  worker cannot build a link from a hash, and the routing role would need to read the hash column to find the email.
- **Giving the worker the signing key.** Rejected: it widens a secret's scope for a convenience (CLAUDE.md section 13.4).
- **Letting the GET unsubscribe, as many mailers do.** Rejected: link scanners and previewers would unsubscribe people
  who never saw the message.
- **The public door writing the block and the consent itself.** Closes the window above, but gives a stranger-facing
  module the right to change contacts, which is exactly what the boundary tests are there to stop.
