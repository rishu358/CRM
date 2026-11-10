# ADR-0075: Delivery events, blocked addresses and the pause

- **Status:** Accepted (PR 3a of the email plan, built after the owner approved `docs/plans/email-delivery-status.md`)
- **Date:** 2026-10-31
- **Related:** `docs/plans/email-delivery-status.md` (the plan this builds), ADR-0073 (send and log), ADR-0065 (the
  lead form's public door, which this copies), ADR-0006 (outbox), ADR-0048 (the SES signing vector, the same
  discipline), CLAUDE.md sections 5 and 13

## Context

Until now "Sent" meant only that the mail service accepted a message. Every company shares one sending address, so a
company that keeps writing to dead addresses damages the others'. The plan asked for three things in this step: say
what happened next (delivered, bounced, reported as spam), stop writing to an address that bounced or complained, and
stop a company's email when a run of bounces is bad. The provider is Resend (the owner's answer).

## Decision

1. **A public door the mail service calls**: `POST /api/v1/public/email-events/{provider}` (migration 0034). It is
   the third public door after the lead form, and copies it: a body cap before anything is read (256 KB here, because a
   provider may batch; the form's 16 KB stays for everything else), no session, no cookie, no cross-origin approval,
   a routing read by the platform's `crm_auth` role limited to **three columns** of `email_messages`, and the work
   done as `crm_app` inside the company that row named. The company is never taken from the request. The handler is
   `@Public()` on its own, the route is on the frozen list of public routes, and a boundary test fails if the
   module's imports widen.
2. **The signature is the credential, checked first, over the raw bytes.** Resend signs with Svix's scheme (`svix-id`,
   `svix-timestamp`, `svix-signature`): HMAC-SHA256 of `id.timestamp.body` under the secret with its `whsec_` prefix
   removed and the rest base64-decoded, any matching `v1` entry valid, compared in constant time. Implemented with
   `node:crypto`, no library, and tested against the vector Svix publishes for it (the algorithm was checked against
   that vector before the code relied on it). The five-minute timestamp window is our choice: neither page names one. The
   door keeps the raw body for that one address only. A bad, stale or missing signature is a 401 with one fixed body.
3. **A normalized event and no vendor field leaves the adapter.** `verifyResendEvents` returns ids, a type
   (`delivered`, `bounced`, `complained`) and a closed reason, and nothing about the person (`to`, `subject` and the
   bounce text are dropped). A permanent bounce and Resend's own `email.suppressed` are bounces; a temporary bounce and
   every other type are ignored. We do not subscribe to opened or clicked: there is no tracking.
4. **Recorded once, applied by the worker.** The door writes a row in `email_provider_events`, keyed by the company, the
   provider and the provider's event id, so a replay does nothing, and one outbox event. The worker, which already holds
   the narrow right to change a message's status, applies it, in the same company transaction.
5. **The status only moves forward**, and never for an email that failed or is still in flight. A bounce is applied to
   the block list even for an email marked "outcome unknown": it has told us the address is bad.
6. **Blocked addresses are held by hash.** `email_suppressions` stores `SHA-256(company, lower-cased address)`, never
   the address, so an erasure of a person leaves nothing of theirs there. The list screen shows the address from the email
   that caused the block, while that email still holds it. **A block caused by a complaint or an unsubscribe cannot be
   lifted**, and the database enforces it with a CHECK, not only the service. A bounce can be lifted by an administrator
   (`tenant_settings:update`) after the address is corrected, with an audit entry. The send path refuses a blocked
   address (422 `ADDRESS_SUPPRESSED`) before spending a send, and the dialog says so beforehand.
7. **A complaint also withdraws consent** on the contacts that carry the address (`contacts.consent.email`), each
   with an audit entry. A lead has no consent record. A bounce does not: it says the address does not work, not that
   the person refused.
8. **The pause.** After a bounce or complaint is applied, the worker looks at the last fifty sent emails and the
   complaints of the last day: more than five hard bounces, or three complaints, pauses the company's email (one live
   pause at a time). The send path refuses (409 `EMAIL_PAUSED`) and the screens say so; an administrator resumes it.
   The numbers are the plan's proposal, as constants.
9. **Configuration:** one new secret, `RESEND_WEBHOOK_SECRET`, in the `api` scope only, documented in
   `docs/SECRETS.md` with its rotation note. Unset means the door answers 404, like an unknown provider.

## Differences from the plan

- **An event that arrives before the worker has saved the provider's id is not parked.** The door has no company yet,
  so it cannot park an event under one; it answers 204 and drops it. The window is small (the id is saved right after the
  send returns) and the cost is one status that stays "Sent"; the sweep of that is a later step if it ever matters. The
  plan said an event would be parked; that was not possible under the same design.
- **The alert to the Owner is not a notification in the bell.** A pause shows as a banner on Settings > Email, in the
  Send dialog and on every refused send, and is in the audit log. A bell notification needs a new notification type and
  its rendering; it is left for a follow-up if the owner wants it.

## Consequences and limits

- Nothing here has been tested against a real Resend account. Four things need one real send and one real event:
  that the event's `email_id` equals the id the send call returned (our adapter saves `id`), that `List-Unsubscribe`
  headers are carried (3b), that a supplied `Message-ID` is kept, and that Resend's `Idempotency-Key` behaves as its page
  says. Until then "Sent" is the last status an email reaches, and the door answers 404.
- With SMTP, or with SES, there are no events: "Sent" stays final. SES events (SNS) are deferred, because verifying them
  means fetching a certificate from a URL in the message, which CLAUDE.md section 5.13 treats as an SSRF risk.
- Resend keeps its own suppression list as well. Ours is separate: per company, covering unsubscribes (3b), held in our
  database whichever provider is used later.
- A suppression is by address, so a typo corrected on a record does not free the old address.

## Alternatives considered

- **A tenant id in the webhook URL.** Puts the company in a URL a provider stores, and the owner's rule is that the
  company never comes from the request.
- **Storing the address in the block list.** Simpler to show, and would have kept personal data through an erasure.
- **Letting the door change the status itself.** It would need the worker's right on the public path; the door only
  records and queues.
- **Parking an event for an unknown email.** Impossible without a company, as above.
