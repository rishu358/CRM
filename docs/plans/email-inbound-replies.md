# Email inbound replies: plan for PR 4

Written 2026-11-10 for the owner. **Plan only: no code, no migration and no dependency is added by this pull request.**
Nothing is built until you approve it.

It is the fourth step of `docs/plans/email-send-log.md` (sections 8 and 11). The first three steps are built and merged:
#35, #36 and #37 (send and log, the screens, templates), #39 (3a: delivery events, blocked addresses, the pause,
ADR-0075) and #40 (3b: the unsubscribe link, ADR-0076). **This plan builds on #39 and #40** (the public events door, the
signed-token machinery and the secret that signs it), which are now on master, so the migration numbers 0034 and 0035
are taken and the next is 0036.

## 1. The short version

1. **Today a customer's reply lands only in the rep's own inbox.** The CRM shows what was sent and what happened to it,
   and nothing the customer said back. A rep who wants the record to tell the whole story has to copy and paste.
2. **This step puts the reply on the record**, under the email it answers, as plain text, with a line on the timeline and a
   notice to the rep. It does **not** read anyone's mailbox and holds no mailbox credentials (that is the "connect your
   Gmail" option in section 8 of the first plan, which stays later or never).
3. **How it works, in one sentence:** every email we send carries a second reply address, a long unguessable one on a
   domain you point at Resend, so a customer's reply goes **both** to the rep (as now) and to us. Resend parses the
   message and tells our public door; the door finds the company from the address, and the worker fetches the text and
   files it.
4. **Nothing about a reply is trusted.** Anyone who learns the address could send to it, and a sender line can say
   anything. So a reply is shown as **unverified**, it can never change a status, a consent or a record, and mail to an
   address we did not issue is dropped without being fetched or stored.
5. **Resend does the hard part.** Its documentation says it receives, parses and delivers the text and attachments as
   structured data, so **no MIME parsing and no new dependency** are needed, which the first plan expected to be.
6. **I recommend two pull requests**, as for the first step: **4a** the server, **4b** the screens.
7. **It needs you to choose a domain** (section 3.1) and to confirm one thing only a real send and a real reply can show:
   that mail programs put **both** reply addresses in the answer (section 11). Nothing here has been tested against a real
   Resend account or a real mail program.

## 2. What I read, and what I found (not assumed)

Read: the first plan (sections 4 to 8, 11), the PR 3 plan, ADR-0073 to ADR-0076, migration 0032 and the code from #35 to
#40 (adapters, worker handlers, the events door, the unsubscribe token), the notification types, and Resend's public
documentation for receiving on 2026-11-10 (section 3.2). I ran nothing for this plan.

| Finding                                                                                                                                                                                                                                                                          | Why it matters                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email_messages.direction` already allows `inbound` and the contract already carries it, but the status CHECK has no value for a received message, and the row requires a sender name (1 to 80 characters), a subject (at most 200), a body (at most 10,000) and a `to_address`. | One small migration widens the status list; a reply is shortened to fit, and the row's `to_address` is the rep's address (the one the customer was replying to).                                                                                |
| **The application role can only insert and read `email_messages`; the worker can read, update a few columns and delete, but cannot insert.**                                                                                                                                     | Filing a reply needs the worker to be allowed to insert, **only inbound rows**. That is a deliberate widening of a right the design of ADR-0073 kept narrow (no bug in the API can mark an email "sent"), so it is enforced by the database.    |
| `isValidReplyTo` and every adapter accept **one** plain reply address.                                                                                                                                                                                                           | Sending two reply addresses means changing the check and the three adapters, with their refusal tests.                                                                                                                                          |
| A mail address's local part is limited to 64 characters, and mail systems may change its case.                                                                                                                                                                                   | The address must be short and **lower-case only**: a token like the unsubscribe link's (36-character id plus a 43-character mixed-case signature) does not fit. Section 3.3 shortens it.                                                        |
| The 3a events door already exists: signed, capped, no session, company found from a database row, a replay recognised, an outbox event queued.                                                                                                                                   | Receiving a reply is one more event type through the same door, not a new public door.                                                                                                                                                          |
| #40 added `EMAIL_UNSUBSCRIBE_SECRET`: a secret that is **not** rotated on a schedule, because links in old email must still work.                                                                                                                                                | A reply address printed in an old email has exactly the same life. The reply token can be derived from the same secret under its own label: **no new secret**. The variable's name then says "unsubscribe" for two uses (a naming wart, below). |
| The notification types are a closed list written only by the worker (`activity.assigned`, `activity.due`, two web-form types).                                                                                                                                                   | "A reply arrived" is one new type, written by the worker the same way.                                                                                                                                                                          |
| The privacy and DPA drafts say emails are stored in the CRM and scrubbed on erasure. They do not yet say that **a third party's own words** are stored too.                                                                                                                      | Inbound mail is personal data of the customer, written by them. It needs the same erasure and a line in the privacy documents (not drafted by me; counsel's).                                                                                   |

## 3. How a reply reaches us

### 3.1 The domain (needs you)

Resend can receive at a domain you control by an MX record, or at a Resend-managed `<id>.resend.app` address. **Use a
domain of your own, and a subdomain** (for example `reply.<your domain>`): Resend's page says its MX record must have the
lowest priority value for the domain, so putting it on a domain that already receives your staff's mail would either
receive nothing or take your staff's mail away. A managed address on `resend.app` works for a trial but puts a vendor's
name on every customer's reply line and is not stable enough to print in email that lives for years. **You provide the
domain and add the MX record Resend shows you; I build against a configuration variable, never a literal** (CLAUDE.md
section 13.1).

### 3.2 What Resend's documentation says (read 2026-11-10, nothing tested)

Read at `resend.com/docs`: the receiving introduction, custom domains for receiving, the received-email webhook, getting
a received email's content, and received attachments.

- **Receiving:** "any username" at a receiving domain is accepted once its MX record is verified, so the addresses are a
  catch-all and **we are responsible for refusing the ones we did not issue**.
- **The event:** `email.received`. Its payload holds `email_id` (Resend's id for the received email), `from` (a bare
  address), `to`, `cc`, `bcc`, `received_for`, `message_id` (the RFC `Message-ID`), `subject` and attachment **metadata**.
  **It does not hold the body or the headers.** The page does not say whether `In-Reply-To` or `References` are
  anywhere, and does not say anything about signing or retries for this event; the signing of the other events
  (Svix's scheme, ADR-0075) is the working assumption and **must be confirmed with one real event**.
- **The content:** fetched afterwards through a "received emails" API, whose SDK call is `emails.receiving.get(email_id)`.
  The page names no HTTP path, says the response has the HTML and plain-text bodies and the headers, but **does not list the
  headers** and does not say whether `In-Reply-To` and `References` are in them, whether raw MIME is available, how soon
  after receipt the content can be fetched, or how long it is kept.
- **Attachments:** a separate API returns metadata and a `download_url` valid for one hour. No size limit, scanning or
  content-type handling is mentioned.
- **Not on any page I read:** a maximum message size, spam or virus filtering, plan limits, delivery order,
  de-duplication, and authentication results (SPF, DKIM) for the sender. **I therefore treat every received message
  as unauthenticated.**

### 3.3 The reply address

Every outgoing email gets a **capture address** for **that email**, built when the API queues it (as the unsubscribe
token is):

`r.<32 hex characters: the email's id without hyphens>.<26 lower-case base32 characters>@<inbound domain>`

That is 61 characters before the `@`, inside the limit of 64, and lower-case only. The 26 characters are a **128-bit HMAC
of the email id**, under a key derived (HKDF, its own label) from `EMAIL_UNSUBSCRIBE_SECRET`. It names an email, never a
person, and carries no company id. Like the unsubscribe token it is stored on the email row so the worker, which holds no
signing key, can put it in the message; checking one is stateless, and the routing role cannot read the stored copy.

**The reply-to line carries both addresses:** the rep's, as today, and the capture address. A mail program that answers
to a `Reply-To` with two addresses addresses the answer to both (RFC 5322 allows a list). The rep keeps getting every reply
in their own inbox exactly as in v1, so **turning this on removes nothing**, and the CRM gets a copy.

**Unverified, and the weakest point of the design:** how Gmail, Outlook, Apple Mail and phones treat a `Reply-To` with two
addresses (some may use only the first). One real reply from each is the test. If it fails, the fallback is the other
option in section 10, question 1.

### 3.4 What happens when mail arrives

1. **Resend calls the events door** (`/api/v1/public/email-events/resend`, ADR-0075) with `email.received`. The door is
   unchanged in its security: raw body capped, **signature checked first**, no session, no tenant read from the
   request. You add `email.received` to the events the Resend endpoint sends.
2. **The adapter normalizes it** into the same kind of event as a delivery: ids and a type, nothing about the person.
   The sender, subject and attachment names in the payload are **dropped at the door**, as `to` and `subject` are for a
   bounce today.
3. **The door finds the email from the address, not from the request.** It takes the recipients on **our** inbound domain,
   checks the HMAC (no database), and only then reads the email's company with the existing one-column routing read. A
   recipient on another domain, a made-up address, a wrong signature, an email that is gone and a suspended company are
   **all the same quiet 204**, so nothing tells a prober which part was wrong, and **nothing is fetched or stored**. The
   catch-all therefore costs one signature check, not one API call, for junk.
4. **Recorded once and queued.** In the company's own transaction the door writes one `email_provider_events` row (the
   Svix id, so a replay changes nothing) and one outbox event naming the original email and Resend's received-email id.
5. **The worker fetches and files it**, in three short steps with the network call in none, as the send does: check the
   limits and that this received id is not already filed; fetch the text from Resend through a new adapter interface (a
   fixed host, a timeout, a cap on how much it will read; no vendor call outside its adapter, CLAUDE.md section 13.5);
   then, in one transaction, write the row, link it to the same records the original is linked to, queue the timeline
   line and the notice. A fetch that fails for a temporary reason is retried by the relay with its backoff; one that
   keeps failing is dropped with a counter and a log line that carries ids only.

### 3.5 What is stored

An inbound message is a row in `email_messages` (so the Emails card, erasure, export and purge already know it):

| Column                          | Holds                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direction`, `status`           | `inbound`, `received` (the one new status value, in migration 0036).                                                                              |
| `source_*`, `contact_id`, links | Copied from the original email, so the reply is on the same contact, lead or deal and follows a converted lead as the original does.              |
| `from_name`, `from_address`     | The sender's display name (cut to 80 characters, or the address if none) and bare address, lower-cased, as **claimed**. Shown with "unverified".  |
| `to_address`                    | The address the original named for replies (the rep's), because the row requires one. Never the capture address.                                  |
| `subject`                       | The sender's subject, cut to 200 characters, single line.                                                                                         |
| `body_text`                     | **The plain-text part only**, cut to the same 10,000 characters as an outbound body, with a visible note when it was shortened. **Never HTML.**   |
| `message_id`                    | The sender's own `Message-ID` (unique per company, so a duplicate is refused by the database); a made-up one from Resend's id when there is none. |
| `provider_message_id`           | Resend's id for the received email.                                                                                                               |
| `created_by`                    | Null: no person wrote it into the CRM.                                                                                                            |

**Not stored:** attachments (their count and names are shown as "not saved"; saving them goes through the file service with
the magic-byte and size checks of CLAUDE.md section 5.12, and is its own later decision), raw headers, the quoted history
below the reply (stored as received; the screen collapses it, and no trimming is attempted because trimming guesses),
and an HTML part (a reply with only an HTML part is stored as "(this message had no plain-text part)" until you decide
about question 4).

## 4. Security and abuse

A stranger can reach this, and so can anyone who has ever received one of our emails (they all carry an address).

| Threat                                                                           | What stops it                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A forged call to the door                                                        | The signature is the credential and is checked first, over the raw bytes; the 3a tests (bad, stale, missing, replayed) apply unchanged.                                                                                                                          |
| Someone mails an address of their own making to the catch-all                    | The HMAC check fails with no database and no fetch; the answer is the same as for anything else.                                                                                                                                                                 |
| Someone who has received one of our emails sends to its address                  | **Accepted as possible, and contained.** The reply is filed on that one record as "unverified"; it can change nothing; it is capped per email (section 6); it cannot name another company or record, because both come from the signed address and the database. |
| A forged "From" (a message that claims to be your customer, your CEO, or a bank) | The sender is shown as **claimed**, with whether it matches the contact's address; nothing treats it as proof; no action is taken from a reply, ever.                                                                                                            |
| Stored cross-site scripting through the body or subject                          | Plain text only is stored and drawn as text (React escapes it; the existing page-source test that forbids raw HTML is extended to the new components); no HTML is stored.                                                                                        |
| A mail bomb or a loop (an auto-responder answering an auto-responder)            | A per-email cap, a per-company daily cap and a size cap (section 6), counted in the database so they hold without Redis; mail from our own sending address is dropped; an excess is dropped with a counter.                                                      |
| A reply that is an automatic answer (out of office, bounce notice)               | Kept and shown like any reply, because the headers that mark one (`Auto-Submitted` and the like) are not documented as available. **If a real fetch shows they are, they are flagged.** A bounce still arrives as a bounce event, not as a reply.                |
| A very large message or attachment                                               | The fetch reads at most a fixed size; attachments are never fetched.                                                                                                                                                                                             |
| Server-side request forgery                                                      | The only outbound call is to Resend's own host through the pinned client; nothing in a message chooses an address to fetch (a received message's `download_url` is never followed).                                                                              |
| Personal data held without a way out                                             | An erasure of a contact scrubs the inbound rows linked to them exactly as it scrubs outbound ones; export and purge already cover the table.                                                                                                                     |
| **Untrusted text reaching AI features later**                                    | Noted for the future: a reply is attacker-controlled text and must never be fed to an assistant as an instruction. Nothing in this step does.                                                                                                                    |

**The one deliberate widening:** the worker may insert into `email_messages` and `email_message_links`. A second, restrictive
row-level policy lets the worker role insert **only** rows with `direction = 'inbound'`, so a bug in the worker still cannot
write an email that says it was sent, and the application role stays unable to update or insert an inbound row at all
(its insert is limited to outbound the same way). A migration spec proves each refusal.

## 5. Privacy

A reply is personal data written by someone who is not a user of the product. It is held for as long as the record it is
linked to (the first plan's retention rule), scrubbed on erasure, included in an export of the contact, and removed when
every record it is linked to is gone. **Three more lines are needed in the privacy and DPA documents** (not drafted by me):
that customers' replies sent to a reply address are stored in the CRM; that Resend is a sub-processor for received mail as
it is for sent mail; and that erasure scrubs the stored copy but not Resend's own retention, which I could not find
documented. A reply does **not** change consent: nothing parses it for "stop" or "unsubscribe". The unsubscribe link of ADR-0076
is the mechanism, and the sentence in every email says so.

## 6. Data, permissions and configuration

- **Migration 0036** (the number is re-checked at push): widens the status CHECK by `received`; adds
  `email_messages.reply_token` (nullable, no default, no rewrite); the worker's insert grants and the restrictive policies
  above on `email_messages` and `email_message_links`; a unique partial index on `(tenant_id, provider_message_id)` for
  inbound rows so one received email is filed once; the event-type CHECK on `email_provider_events` widened by
  `received`; a small counter table for the inbound caps. All created empty or nullable.
- **Permissions:** no new object type and no new grant for people: reading a reply needs the `email_message` read grant
  **and** the ability to see the record, exactly as reading an outbound email. The public door has no permission, by design,
  as before; the routes list does not change (the same events address).
- **Caps (constants in `@crm/core`, not variables, for you to change):** 20 replies filed per sent email, 500 per company
  per day, 1 MB read from Resend per message. **These numbers are my proposal, not a standard I verified.**
- **Audit and events:** a filed reply writes an audit entry (actor: none; the email id, never the address or the words) and
  the events `email.reply_received.v1` (timeline: "Reply received") and one notification of a new type
  `email.reply_received` to the person who sent the original, written by the worker like the others.
- **Registry variables (new):** `EMAIL_INBOUND_DOMAIN` (api and worker scopes, not secret, no default: unset means the
  feature is off and **no capture address is added**, so nothing changes for anyone until you opt in). **No new secret**:
  the reply token reuses `EMAIL_UNSUBSCRIBE_SECRET` under its own derivation label, so `docs/SECRETS.md` gains a sentence that
  the secret now also signs reply addresses and has the same rule (set once, never rotated on a schedule, an earlier key kept
  in `EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS` while old mail matters). `pnpm config:docs` is run. Never in `web`.
- **Dependencies:** none. Resend parses the message, so there is no MIME library, and the hash and encoding are Node's own.
  If a reply with only an HTML part must be shown, an HTML-to-text step would be a dependency, and **I ask first** (question 4).

## 7. Screens (PR 4b)

All strings through `t()`, dates through the shared formatters, keyboard reachable, AA contrast, light and dark.

1. **Emails card:** a reply is a row with an "In" marker and the sender as claimed, "Unverified sender" and, when it
   matches, "Matches the contact's address"; the body is collapsed with the quoted history folded; "message shortened" and
   "attachments not saved" notes where true. States unchanged: loading, empty, error, no permission, feature off.
2. **Timeline:** one line, "Reply received", with no content.
3. **The bell:** "A reply to your email '{subject}' arrived" is not shown with the subject (it is the customer's text in a
   notification list); it says "A reply arrived on {record name}" and links to the record.
4. **Settings > Email:** shows whether reply capture is on (the inbound domain is configured), read-only; an administrator
   is told what to add in Resend and DNS when it is off. No new stored setting.

## 8. Tests (CLAUDE.md section 10)

- **(a) Tenant isolation:** a reply to company A's address never creates, links or notifies anything in company B; the
  routing role still reads one column and not the new token; the same sender address in two companies files twice, each
  in its own.
- **(b) Scope:** a rep sees a reply only on a record they may see; Read-only cannot; the worker cannot insert an outbound
  row and the application role cannot insert or update an inbound row (migration spec).
- **(c) Fields:** nothing in the event (a company id, a record id, a status, an address in the body) chooses where the reply is
  filed; the sender, subject and attachment names never reach an event payload, the audit log or the timeline; an HTML
  body is never stored.
- **(d) Unauthenticated:** every authenticated route still answers 401; the door answers as designed (a bad signature is
  the fixed 401; everything else is a quiet 204).
- **The door:** a good `email.received` for our address; a replay; a recipient on another domain; a wrong, short, long,
  upper-case and truncated token; an address for an email that is gone; a suspended company; two addresses in one message;
  an oversized body; the catch-all case does not fetch.
- **The worker:** files once however many times the event arrives; truncation of subject, name and body; no plain-text
  part; a temporary fetch failure retried and then filed; a permanent one dropped with a counter; the three caps; the
  loop rule (mail from our own sending address); the notification and timeline line; erasure scrubs a filed reply.
- **The adapters:** the Resend receiving adapter against a fake client (the response shape as documented, an oversized
  response, a 404, a timeout); a two-address reply-to in all three sending adapters, and the refusal of a list with a
  line break, a third address or a malformed one.
- **E2E:** a rep sends; the test posts a signed `email.received` made with the test secret and a fake receiving client; the
  reply appears on the record, marked unverified, with a bell notice; a second post changes nothing. **No real mail and no real
  provider are used by any test.**
- **CI first:** push a draft early, read the checks per job; locally only formatting, lint, types and the light unit specs.

## 9. Phases

| PR     | What                                                                                                                                                                                                              | Why it stands alone                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **4a** | **Server.** Migration 0036, the reply token and address, the two-address reply-to in the contract and adapters, the new event type through the door, the receiving adapter, the worker handler, caps, ADR, tests. | Invisible until `EMAIL_INBOUND_DOMAIN` is set, so safe to merge. |
| **4b** | **Screens.** The Emails card rows, timeline line, bell notice, Settings > Email status, i18n, Playwright flow, `docs/MVP_SPEC.md`.                                                                                | The smallest thing a user can actually see.                      |
| Later  | Saving attachments through the file service; an HTML-only reply; matching by `In-Reply-To` for mail that someone forwards to the platform by hand; connecting a mailbox (Phase 3 in the first plan).              | Each is a decision of its own.                                   |

## 10. Questions for you, with my recommended answer

1. **How should a reply reach us?** _Recommend: the reply-to line carries both the rep's address and ours._ The rep loses
   nothing and the CRM gets a copy. The alternatives: **(b)** only our address as `Reply-To`, and the CRM forwards each reply to
   the rep (the rep's inbox then depends on us, and we would be sending a customer's words by email, which is a loop and abuse
   risk of its own); **(c)** the rep BCCs or forwards by hand to a company-wide address, which needs no change to what we send
   but relies on a person remembering. (a) needs one real test with the main mail programs before it is trusted; (c) is the
   fallback if (a) fails.
2. **Which domain will receive replies?** _Recommend a subdomain of one you own_ (for example `reply.<your domain>`), with
   the MX record Resend shows. **I need the name from you** (it is configuration, not code), and DNS access is yours.
3. **A reply to an address we did not issue, or that does not verify:** drop it (recommended) or keep it somewhere for an
   administrator to look at? _Recommend drop, with a counter._ Keeping strangers' mail needs a place to put it, a retention
   rule and a review screen, and nobody has asked for them.
4. **A reply with only an HTML part:** show a note that it had no plain-text part (recommended for now), or add a small
   HTML-to-text library (a dependency, so **I ask first**)? _Recommend the note until real replies show how common it is._
5. **Attachments on a reply:** not saved, but listed (recommended), or saved through the file service in this step? _Recommend
   not saved._ It needs its own security pass (type, size, scanning) and storage cost decisions.
6. **Tell the rep when a reply arrives?** _Recommend yes, in the bell, without the customer's words in it._ It is one new
   notification type. An email to the rep about the reply is not planned (the reply is already in their inbox).
7. **Who reads the privacy lines** (section 5)? _Recommend counsel, before the first real customer's replies are stored._ I have
   not drafted legal text and I do not claim any rule is satisfied.

## 11. Risks and honest limits

- **Nothing in this plan was run.** What I say about Resend comes from its public documentation as I read it on 2026-11-10,
  not from a test; where a page did not say something, the plan says it does not. **Five things need one real reply to settle:**
  that mail programs address a reply to both reply-to addresses; that the `email.received` event is signed as the others are;
  the HTTP path and response shape of the receiving API (I know only the SDK call); whether `In-Reply-To`, `References` and
  `Auto-Submitted` are in the headers; and how soon after receipt the content can be fetched.
- **The reply address is a capability anyone who receives our email holds.** The design contains what it allows (an unverified
  line on one record, capped), but cannot make it impossible, and a company should know that anyone it has emailed could
  send text onto that record's timeline.
- **The catch-all is ours to police.** Resend accepts any address on the domain; every refusal is in our code, and the cost of
  a flood of junk is the webhook calls Resend makes, each answered after one hash check.
- **Resend is a single dependency for receiving**, as for sending. The adapter interface keeps a second provider possible;
  none is built or planned.
- **A reply that is also sent to the rep's address is not matched to that copy.** The rep's inbox and the CRM each have their
  own; nothing reconciles them, and nothing reads the rep's inbox.
- **The reply token shares a secret with the unsubscribe link.** They have the same lifetime and the same "never rotate on a
  schedule" rule, which is why no new secret is proposed; the cost is a variable whose name mentions only one of its uses.
  If you would rather have a neutral name or a second secret, say so before 4a is built; renaming afterwards is a breaking change.
- Each pull request is cut from the one below it and re-checks the migration number at push.
