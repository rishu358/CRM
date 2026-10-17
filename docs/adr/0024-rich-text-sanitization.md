# ADR-0024: Rich-text sanitization — allow-list, on write and on read

- **Status:** Accepted
- **Date:** 2026-10-17

## Context

Activity bodies are rich text (MVP_SPEC §6.2) and MVP_SPEC §8 lists HTML
sanitization under Input. This is the first place in the product where markup
one user types is stored and later rendered in another user's browser, inside
their authenticated session. A stored XSS here is not a defaced page: it runs
with the reader's session against an API that trusts the session, so it can
read and change anything that reader can.

Three decisions were open: what the policy is, where it runs, and what we
sanitize with.

## Decision

**An allow-list, not a block-list.** `@crm/core/html` names the tags that may
survive (`p`, `br`, `strong`, `em`, `u`, `s`, lists, `blockquote`, `code`,
`pre`, `h3`, `h4`, `a`) and the single attribute that may (`href` on `a`,
restricted to `http`, `https`, `mailto`, `tel`). Everything else is removed.
A block-list fails the first time somebody finds a vector nobody listed, and
the history of XSS is a history of vectors nobody listed.

No `img`, `iframe`, `object`, `embed`, `svg`, `math`, `style`, `script`,
`form`, `template` — each is either a script-execution vector or remote
content, and remote content in a note is a tracking pixel at best. No `class`
or `id`, so a note cannot borrow the application's chrome to fake UI or
clobber the DOM. Surviving links get `rel="noopener noreferrer nofollow"` and
`target="_blank"`.

**Sanitize on write _and_ on read.** The write pass means nothing dangerous is
ever stored. The read pass, in the serializer, means the rendering side does
not depend on every writer having been careful — an import, a seed, a restored
backup, a future code path or a hand-written row all go through it. The second
pass is cheap and idempotent, and it is the one that is still there after
somebody adds a sixth way to write a row.

**`sanitize-html` as the implementation.** A pure-Node allow-list sanitizer
built on `htmlparser2`, with no DOM dependency; the alternative,
DOMPurify + jsdom, pulls a browser-sized dependency into the API runtime. The
policy lives behind our own `sanitizeRichText`, so swapping the library is one
file. It is exported from `@crm/core/html` rather than the package index
because the web app imports `@crm/core`, and a server-side HTML parser has no
business in a browser bundle.

## Consequences

- One function decides what markup is safe, and it has a test file of real
  payloads: script tags, `javascript:` and `data:` URLs, `onerror`,
  SVG-based vectors, `<math><annotation-xml>`, mutation-XSS shapes.
- The UI renders the body with `dangerouslySetInnerHTML`, which is safe
  _because_ of the two passes and for no other reason. It is the only place
  in the web app that does, and it carries a comment saying so.
- Anything inside a discarded tag is discarded with it, so
  `<svg><p>hello</p></svg>` leaves nothing. That is correct — the text was
  inside a vector — but it surprises people, so it is tested explicitly.
- Plain-text extraction (`richTextToPlain`) decodes entities, so its output is
  text and must be escaped again by anything that puts it into HTML. The
  digest email does exactly that with `escapeHtml`.
- A body is capped at 32,000 characters at the column, the contract and the
  sanitizer, so one note cannot be a denial of service against a list page.

## Alternatives considered

- **Plain text only.** Safest and dependency-free, but the spec asks for rich
  text and people paste formatted notes out of email; they would paste markup
  that renders as literal angle brackets instead.
- **Sanitize on read only.** Leaves hostile markup at rest, where an export, a
  future endpoint or a report renderer finds it without the serializer.
- **Sanitize on write only.** What most products do, and it is one forgotten
  write path away from a stored XSS.
- **Markdown instead of HTML.** Moves the problem rather than solving it:
  every Markdown renderer still has to decide about raw HTML and
  `[x](javascript:...)`.
