# ADR-0061: WhatsApp starts as a plain chat link

Status: accepted

## Context

Small businesses in India run their sales in WhatsApp. The Business API (approved
message templates, a Meta account, a provider) is a Phase 2 piece of its own and
is not built yet. What people need on day one is smaller: from a contact, account
or lead, open a WhatsApp chat on that person's number.

## Decision

1. **A link, not an integration.** The button is an `<a>` whose address is
   `https://wa.me/<digits>` (optionally `?text=`). The user's own device opens it in
   the WhatsApp app or WhatsApp Web. Our servers send nothing, log nothing and hold
   no Meta account, so no consent flow, webhook or secret is involved.
2. **One builder, strict input.** `buildWhatsAppLink` and `whatsAppTarget` in
   `packages/core/src/whatsapp` are the only code that turns a phone number into
   an address. They accept strict E.164 (a plus, 8 to 15 digits, no leading zero)
   and return `null` for anything else, so nothing typed into a record can become a
   `javascript:` or other-host link. The optional message is cleaned (invisible
   and control characters removed), capped at 500 characters and percent-encoded.
3. **The host is configuration, handled as operator input.** CLAUDE.md section 13.1 keeps
   domains out of code and 13.5 keeps vendor hostnames out of application code, so
   the link base is `WHATSAPP_LINK_BASE` in the configuration registry (web scope, not
   a secret, default `https://wa.me`), reaching components through the same public
   brand context as the product name (ADR-0045). The builder takes the base as a
   parameter and names no host. Because the person's phone number is part of the
   address, whatever host is configured is sent people's phone numbers: it is an
   operator decision, never tenant or user input. The value is validated when the web
   app starts and again by the builder: an https origin and nothing else (no
   credentials, path, query or fragment), or the web app refuses to start.
4. **Which number.** The WhatsApp number when the record has one, otherwise the
   phone number. A WhatsApp number that is present but malformed is reported, not
   swapped for the phone: the person should fix what they entered. The accessible
   label and tooltip say which number is used.
5. **Accounts and leads have a phone number only** (no `whatsapp` field), so they
   always use it. No field was added.
6. **Consent.** Consent is stored on contacts (`consent` jsonb) but the API does not
   expose it, and it is empty for every record today. Version 1 therefore shows no
   consent notice. The button is a one-to-one chat the user starts on their own
   device, not a send by us.
7. **No default greeting in version 1.** A per-company message needs a read path for
   every user (the company profile is readable only with the settings grant), an
   admin editor, audit and outbox events and the mandatory security tests. That is
   a change of its own. The builder already supports the text.
8. **No content security policy change.** Opening a link is a navigation, not a
   fetch, so `connect-src` and the other fetch directives are unaffected. The link
   uses `rel="noopener noreferrer"`.

## Consequences

- Nothing is recorded when a chat is opened; logging it as an activity is a
  possible follow-up.
- Follow-ups: expose consent read-only and show a non-blocking notice when WhatsApp
  consent is withdrawn or absent; a per-company greeting with placeholders; a
  WhatsApp field on accounts and leads if wanted; the Business API behind the
  provider interface.
