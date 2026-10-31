# Email delivery status, bounces and unsubscribe: plan for PR 3

Written 2026-10-31 for the owner. **Plan only: no code, no migration and no dependency is added by this pull request.**
Nothing is built until you approve it.

It is the third step of `docs/plans/email-send-log.md` (section 11). That plan, and the three pull requests
that built the first steps (#35 the server, #36 the screens, #37 templates and signatures), are not merged yet, so
this plan refers to them by number and by ADR (0073, 0074), which live on those branches.

## 1. The short version

1. **Today "Sent" only means the mail service accepted the message.** This step makes the log say what happened next:
   **Delivered**, **Bounced** (the address does not exist or is full) or **Reported as spam**.
2. **A bounced or complained-about address is never written to again** until an administrator says so (bounces) or
   never (complaints and unsubscribes in the first version). Continuing to mail dead addresses is what ruins a
   sender's reputation, and every company here shares one sending address.
3. **Every email carries a working way to stop receiving them**: a one-click unsubscribe link. It records the
   person's refusal as consent withdrawn, which the send path already respects.
4. **Both need the internet to reach us**: the mail service calls us when something happens, and a person clicks a link
   from their inbox. Those are two new public doors, the second and third in the product after the lead form. They
   get their own security design below, built on what the lead form's door taught us.
5. **I recommend two pull requests**: 3a (delivery events and suppression) and 3b (the unsubscribe link). **Do this before
   anyone sends in volume.**
6. **I can only build the part for the provider you choose, and I cannot verify any provider's event format from
   here.** You have not named a provider (question 1). Until you do, the plan is the shape and the checks, not a
   vendor's field names.
7. **Legal review is still pending** for the consent and unsubscribe wording (question 6).

## 2. What I read, and what I found (not assumed)

Read: the two earlier email plans and the code from #35 to #37 (adapters, worker handlers, the `email_messages`
table and grants), ADR-0065 (the lead form's public door, its routing role and its threat table), ADR-0053 (rate limits),
`apps/api/src/common/public-routes.ts`, `packages/core/src/lead-forms/token.ts`, the privacy and DPA drafts. I ran
nothing for this plan.

| Finding                                                                                                                                                                                                                                 | Why it matters                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The database already allows the statuses `delivered`, `bounced` and `complained`, the worker may already update `status`, and the screens already have words and colours for all three.                                                 | No migration is needed to hold the new statuses, and the web change is small.                                                                            |
| `provider_message_id` is stored when the provider returns one. SMTP returns the **server's** id, which no later event will quote, and an SMTP server sends no events at all.                                                            | **For SMTP, "Sent" stays final.** Events exist only for a provider that reports them, and each needs a way to find our message from the id it quotes.    |
| The Resend and SES adapters do not pass our own `Message-ID` header through; only the SMTP adapter does (ADR-0073).                                                                                                                     | We cannot match an event by our id. We match by the provider's id, which means a **cross-company lookup before the company is known**.                   |
| `contacts.consent` (jsonb) is read by the send path and **written by nothing** except a lead form's own record. It is not in the contact update contract. The privacy draft says the product has no consent management today.           | Withdrawing consent needs a deliberate write path, in the tenant's own transaction, through the contacts module. This step builds the smallest one.      |
| A public door already exists (`/api/v1/public/*`): a small body cap before parsing, no cookies, no cross-origin approval, a column-limited routing grant for the platform's `crm_auth` role, and identical answers for "no such thing". | Both new doors copy it. The hosted public page pattern (`/f/<key>` in the web app) is what the unsubscribe page copies.                                  |
| The outbox can hold work dated in the future and retries with a backoff (ADR-0025, the relay).                                                                                                                                          | A provider can report "delivered" **before** our worker has saved its id; an event that finds no message yet is retried later, not lost and not guessed. |
| Our own auth secret already derives a signing key for the lead form's fill token (HKDF with a fixed label).                                                                                                                             | The unsubscribe token can be signed the same way: **no new secret** for that half.                                                                       |

## 3. Part A: delivery events (PR 3a)

### 3.1 How the mail service tells us

- **The door:** `POST /api/v1/public/email-events/<provider>` where `<provider>` is the name of an adapter, nothing
  else. No session, no cookies, no tenant or user id read from the request, body cap of 256 KB before parsing (batches
  are possible), JSON only.
- **Signature first, nothing else before it.** Each adapter that supports events gets one more method,
  `verifyEvents(headers, rawBody, now)`, returning **normalized events** or a refusal: `{ providerEventId,
providerMessageId, type: 'delivered' | 'bounced' | 'complained', permanent, at }`. The vendor's field names live only in
  that adapter, exactly as they do for sending. The API needs the **raw body** for the check, so that one route keeps
  it. A bad or missing signature, or a timestamp more than five minutes off, is a **401 with one fixed body** and
  writes nothing. A good one is a **204**, whatever the events turn out to be (a provider retries on anything else).
- **The secret** is a new registry variable per provider whose events we accept (for example `RESEND_WEBHOOK_SECRET`),
  marked secret, in the `api` scope only, and `pnpm config:docs` is run. Never in `web`. An adapter with no secret set
  refuses the route (the door answers 404, as for an unknown provider).
- **I will check the chosen provider's current documentation for the signing method and the event names when you name
  it.** What I believe today (**unverified**): Resend signs webhooks in the Svix style (an id, a timestamp and a signature
  header, HMAC-SHA256 with a per-endpoint secret). SES delivers events through Amazon SNS, whose messages are signed with
  a certificate **that we would have to fetch from a URL in the message** (a server-side request to an address a stranger
  supplied, which CLAUDE.md section 5.13 makes an SSRF risk), so SES events are **deferred** to a later step with their
  own plan. SMTP has none.

### 3.2 Finding the company, safely

The event names a provider id and nothing about a company. Following the lead form (ADR-0065 3.2):

1. Route as `crm_auth` through a **column-limited** grant: `SELECT (id, tenant_id, provider_message_id)` on
   `email_messages`, with a policy for that role, and a **unique partial index** on `provider_message_id`. That role
   still has no grant on the subject, body or address.
2. Do the work as `crm_app` inside the company that row named. The tenant comes from the database row found by the
   provider's id, never from the request.
3. Unknown id: if our message is not saved yet, **the event is parked** as an outbox event dated a minute ahead, up to
   five tries (the race in section 2); after that it is dropped with a counter, never guessed at.

### 3.3 Recording it

- The door writes one outbox event per accepted provider event (`email.provider_event.v1`, ids and the type only) and
  a row in a new `email_provider_events` table keyed `(tenant, provider, provider_event_id)` so a **replay changes
  nothing**. The worker, which already holds the narrow `UPDATE` on status, applies it.
- **The status can only move forward:** `sent` to `delivered`; `sent` or `delivered` to `bounced` or `complained`
  (a bounce can be reported after a delivery). It never goes back, and it never touches `failed`. A **soft** bounce
  (the mailbox is full, the server is busy) is the provider's to retry and is ignored; only a **permanent** one counts.
- Timeline lines `email.delivered`, `email.bounced` and `email.complained`, with ids and codes only (the rule from
  ADR-0073: no address, subject or body in an event).
- The bounce reason is a closed list, never the provider's text: `mailbox_not_found`, `domain_not_found`, `mailbox_full`,
  `blocked`, `other`.

## 4. Part B: stopping mail to a dead address (PR 3a)

- **A new table `email_suppressions`:** `(tenant_id, address citext, reason: hard_bounce | complaint | unsubscribed,
source_email_id, created_at, lifted_at, lifted_by)`, unique per company and address while not lifted. It is by
  **address**, not by contact: a lead has no consent field, and the same address can sit on several records.
- **The send path refuses** an address that is suppressed: 422 `ADDRESS_SUPPRESSED`, with the reason in plain words
  ("this address bounced on 3 November"). The dialog says so before anything is typed, from the same context answer.
- **A hard bounce or a complaint adds the suppression automatically** from the event. A complaint and an unsubscribe also
  set the matching contacts' `consent.email.status` to `withdrawn` (in the same transaction, through the contacts
  module, as an identity-based call like the lead form's), so the rule that already exists applies too.
- **Who may lift one:** an administrator (`tenant_settings:update`), for a **hard bounce only**, after the address has been
  corrected; it writes an audit entry. A complaint or an unsubscribe **cannot be lifted in the first version**:
  sending to someone who asked you to stop is where the legal risk is (question 3).
- **A screen:** Settings > Email gains "Suppressed addresses" (list with reason and date, lift for bounces), with loading,
  empty, error and no-permission states.
- **A company-level guard against a bad run** (question 4): when a company's recent hard bounces or complaints pass a
  threshold, its email is paused and the Owner told. Proposed: more than 5 hard bounces in the last 50 sent, or 3
  complaints in a day. **Unverified numbers**, written as constants for you to change.

## 5. Part C: the unsubscribe link (PR 3b)

- **Every email carries one.** A line at the bottom of the text ("To stop receiving email from {company}, open: {link}")
  and, where the adapter can carry it, the `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  headers (RFC 8058), so a mail program can offer its own button. Whether Resend and SES pass custom headers is
  **unverified**; the line in the body is what we rely on.
- **The link:** `<WEB_URL>/u/<token>`, a hosted page in the web app (as `/f/<key>` is). The token is the email's id plus an
  HMAC from a key derived from the instance's auth secret with its own label (`crm:email-unsubscribe:v1`), so **no new
  secret and no new variable**. It names the email, never a person's address, and carries no tenant id.
- **A page that asks, then does it.** Opening the link (a GET) shows "Stop emails from {company}?" with one button;
  only the button (a POST) does it, because mail scanners open every link and must not unsubscribe people. The answer
  to a bad, tampered or unknown token is one fixed "this link is not valid". Doing it twice is harmless.
- **Routing and writing** are as in section 3.2: the same column-limited `crm_auth` lookup finds the company, and the
  work runs as `crm_app` in that company. It adds an `unsubscribed` suppression, sets the matching contacts' consent to
  `withdrawn`, writes an audit entry (actor: none, source: unsubscribe) and a timeline line.
- **Rate limits:** per address and per token on both public doors, from the existing counters (ADR-0053), with the daily
  caps for the events door counted in the database so they hold without Redis.
- **The wording** of the page and the footer line is the part counsel should read (question 6). It is in the web strings.

## 6. Data, permissions and configuration

- **Migration 0034** (after 0033 on #37; the number is re-checked at push): `email_provider_events`, `email_suppressions`
  (both with row-level security, grants chosen as in 0032), the column-limited `crm_auth` grant and policy on
  `email_messages`, and the partial unique index on `provider_message_id`. Created empty; the index is on a table that is
  small and new, so no lock worth naming.
- **Permissions:** no new object type. Reading the list and lifting a bounce use `tenant_settings`; the public doors have
  none, by design, as the lead form's. Each public route is registered in the contract with `auth: 'none'` and covered by
  the boundary test that fails if the module imports another module's repository, a table, `fetch`, or the credential
  proxy.
- **Audit:** every suppression added or lifted, every status change from an event (system actor), every unsubscribe.
- **Registry variables (new):** one webhook secret per provider whose events we build (secret, `api`, never `web`),
  `pnpm config:docs` run. Nothing for the unsubscribe half.
- **Dependencies:** none. Signature checks use `node:crypto`. If a provider's scheme needs more, I ask first.

## 7. Screens

All strings through `t()`; dates through the shared formatters; keyboard reachable; AA contrast; light and dark.

1. **Emails card:** the badges for Delivered, Bounced and Reported as spam already exist; a bounced row says why in one
   sentence and links to the record's email address to correct it. A suppressed address shows a notice on the record's
   Send button state.
2. **Send dialog:** the suppressed or withdrawn notice from the context answer; the send button is disabled with the
   reason. States unchanged: loading, error, no permission, feature off.
3. **Settings > Email > Suppressed addresses:** loading, empty ("no addresses are blocked"), error, no permission.
4. **The public unsubscribe page** in the web app: asking, done, not valid; works without scripts; no cookies read.

## 8. Tests (CLAUDE.md section 10)

- **(a) Tenant isolation:** an event, an unsubscribe or a suppression for company A never changes company B; the routing
  role reads three columns and nothing else (database spec); the same provider id in two companies resolves to the one
  that owns it.
- **(b) Scope:** reading and lifting suppressions need `tenant_settings`; a rep gets 403; the public doors need nothing and
  give nothing back.
- **(c) Fields:** an event or an unsubscribe request that carries a company id, user id, address or status is ignored or
  refused; nothing personal appears in an event payload, the timeline or an audit entry.
- **(d) Unauthenticated:** every authenticated route 401; the public ones answer as designed (401 for a bad signature, a
  fixed page for a bad token).
- **The doors:** bad, missing and stale signatures; a replay changes nothing; an oversized body is refused before it is read;
  an unknown provider and an unconfigured one answer alike; an event before our `sent` is parked, then applied; status never
  goes backward; a soft bounce does nothing; the link-scanner case (a GET changes nothing); a tampered token; a token for
  another company's email; a double unsubscribe.
- **The send path:** a suppressed address is refused with the reason; a lifted one is allowed; the pause stops a company at
  the threshold and nobody else.
- **E2E:** a rep sends, a signed sample event (made by the test with the test secret) marks it Bounced, the card says why, and
  the next send to that address is refused; the unsubscribe page asks, does it, and the person is then refused. **No real mail and no
  real provider are used by any test.**
- **CI first:** push a draft early, read the checks per job; locally only formatting, lint, types and the light unit specs.

## 9. Phases

| PR     | What                                                                                                                                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **3a** | The events door for **one provider** (the one you name), the status moves, the suppression table and its send-path refusal, the suppressed-addresses screen, the company pause, the migration, ADR-0075 (or the next free number), tests. |
| **3b** | The unsubscribe link, page, `List-Unsubscribe` headers where the adapter carries them, the consent write, tests.                                                                                                                          |
| Later  | SES events through SNS (its own plan: the certificate fetch), a second provider, soft-bounce policy, complaint feedback for providers that report it by another route.                                                                    |

## 10. Questions for you, with my recommended answer

1. **Which provider will send first (Resend, Amazon SES, or an SMTP server)?** _Recommend: whichever you already hold an
   account with, and Resend if you have none._ It decides which events I build. With SMTP there are no events, so this step
   would be only the unsubscribe link. I will read that provider's current documentation, and test with a signed sample I
   make myself. Real events arrive only once you connect your own account.
2. **An unsubscribe line on every email, or only on templates?** _Recommend every email._ It is the one thing that makes
   "stop" work for a person who wants it, and it costs one line. Some salespeople dislike it in a one-to-one message; the
   footer text is yours to word.
3. **May an administrator lift a suppression?** _Recommend: a hard bounce yes, after correcting the address; a complaint or an
   unsubscribe no, in the first version._
4. **Pause a company's email automatically on a bad run?** _Recommend yes, with the proposed thresholds and an alert to the
   Owner._ The numbers are my guess, not a standard I verified.
5. **Two pull requests (3a events and suppression, 3b the unsubscribe link)?** _Recommend yes._
6. **Who reviews the consent and unsubscribe wording?** _Recommend counsel, before the first real customer sends an
   email._ I have not drafted legal text, and I do not claim any rule is satisfied.

## 11. Risks and honest limits

- Nothing in this plan was run. Every statement about a provider's event format, signing and headers is unverified until the
  provider is named and its documentation read.
- Two new public doors are new attack surface. They copy the lead form's design (small body cap, no cookies, uniform
  answers, a column-limited routing grant, a boundary test), and the events door adds a signature check that happens before
  anything else.
- A provider can deliver an event twice, late, out of order, or before we know the message. The design handles each (dedupe
  key, forward-only status, parking), and a test covers each.
- With SMTP, or with a provider whose events are not built, "Sent" stays final and bounces stay invisible. The screens
  say what the status means, and the plan does not hide it.
- Suppression is by address, so a typo corrected on a record does not free the old address; that is intended.
- Each pull request is cut from the one below it and re-checks the migration number at push.
