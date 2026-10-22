# ADR-0040: Outbound requests and the browser's policy — one guarded door, and a boundary test that keeps it the only one

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

CLAUDE.md §5.13 says outbound requests (webhooks, URL previews, later) must block private
IP ranges. Nothing in the product makes such a request yet, which is exactly when to
build the rule: a webhook feature written first and guarded afterwards gets guarded by
whoever remembers. The first real caller is the email provider (Resend, over REST), and
the next are webhooks and link previews, whose destination is typed by a customer.

The same week has two smaller findings about what the web tier tells the browser:

- The API already ran `helmet` with a strict CSP and, in production, HSTS. **The web app,
  which is the thing a browser renders, sent neither.** A policy on a JSON API protects
  nothing; the one on the HTML matters.
- The credential proxy (`/api/proxy/*`) attaches the session token and forwards to a fixed
  origin. The origin is not caller-chosen, but the _path_ was built by string join, so its
  safety depended on what every future API route outside `/api/v1` looked like.

## Decision

### 1. One rule for "may I connect to that?", in `@crm/core`

`classifyAddress` and `checkOutboundUrl` (`packages/core/src/outbound`) are pure: no DNS,
no sockets. The rule is **default deny**: an IPv4 address is refused if it is in any
special-purpose range IANA lists (loopback, private, link-local, carrier-grade NAT,
benchmarking, documentation, multicast, reserved), and the cloud metadata addresses are
named separately so the log says "metadata" and not "link-local". An IPv6 address is
allowed only inside `2000::/3`, minus Teredo and protocol assignments, documentation and
6to4. IPv4-mapped (`::ffff:a.b.c.d`) is judged by the address inside it, so loopback in
disguise is refused; a mapped _public_ address and every NAT64 address are refused too,
because a translated address is one the allow-list cannot vouch for. Zone ids, leading
zeros (`010.0.0.1`) and anything that does not parse are refused, never interpreted.

The URL check runs before any DNS is spent: https and port 443 only by default; no
userinfo; no space or control character anywhere (the parser would silently strip or
encode them, so what is checked would not be what is dialled); no `localhost`, `.local`,
`.internal`, `.lan` and the like; no single-label name (`http://intranet/` resolves against
the server's search domains). The URL is parsed once, by the parser the runtime connects
with, so `2130706433`, `0x7f.1` and `127.1` arrive as `127.0.0.1` and are refused as
loopback. A caller that talks to one vendor pins it (`allowedHosts`, `*.example.com`
allowed, the bare suffix not), so a stored URL edited to point elsewhere is refused
whatever it resolves to.

### 2. One guarded client, `@crm/outbound`, that cannot be built unguarded

`OutboundHttp.request` is the only way application code makes an outbound call.

- **It resolves the name itself and connects to the address it checked.** A check on one
  lookup and a connection on another is DNS rebinding. Here there is one lookup per hop,
  every answer is judged (a name resolving to one public and one private address is
  refused, because which the connection uses is not ours to bet on), and the socket is
  given that address through a pinned `lookup` (`pinnedLookup`, tested in both of Node's
  calling shapes), so no second resolution exists to lie.
- **Redirects are followed by hand**, up to a limit, and each hop is parsed, judged and
  resolved afresh: a public URL that redirects to `169.254.169.254` is refused at the hop.
  Anything the caller attached other than `accept`, `accept-language`, `user-agent` and
  `content-type` is dropped when the origin changes. 303, and 301/302 after a POST, become
  a body-less GET, as a browser does.
- **Time and size are bounded:** one deadline across the lookup, the connect, the
  redirects and the body; a declared `Content-Length` over the cap is refused before the
  body is read, and a streaming cap stops one that never ends; the identity encoding is
  requested so a small body cannot expand.
- **A caller cannot weaken it.** Request headers `host`, `cookie`, `content-length`,
  `transfer-encoding`, `connection`, `upgrade`, `accept-encoding` and `proxy-*` are the
  client's, and a header name or value that could end a header (CR, LF, NUL) is refused.
  There are no cookies, no keep-alive, no proxy support, and `Set-Cookie` is never
  returned.
- **The test seam is a different entry point.** `createOutboundHttp` exposes only the URL
  policy, limits, user agent and a resolver (whose answers are still judged). Allowing
  loopback, which the client's own tests need to talk to local servers, is
  `@crm/outbound/testing`, and the boundary test (below) fails if production code imports
  it.

### 3. A test that fails when anything else opens a connection

`packages/outbound/src/boundary.spec.ts` reads the source of `apps/api`, `apps/worker`,
`apps/web` and `packages` and fails on a raw `fetch(`, a network module (`node:http`,
`https`, `http2`, `net`, `tls`, `dgram`, `dns`), an HTTP library (`undici`, `axios`, `got`,
`node-fetch`, `ws`, `superagent`, `request`), a browser network API, `rejectUnauthorized`
or `NODE_TLS_REJECT_UNAUTHORIZED`, or an import of the test-only client. The places that
legitimately do (the web proxy to its fixed origin, the browser's own fetch wrapper, the
guarded client itself) are listed with the reason, and the list is checked both ways: a
call that is not listed fails, and an entry whose call has gone fails, so it cannot rot
into a blanket exemption.

What it does not see, and why that is acceptable today: the AWS SDK's S3 calls (one fixed
endpoint from configuration, in `packages/storage`), and Better Auth's sign-in with Google
(fixed hosts inside the library). Neither takes a destination from a user. A feature that
does must use `OutboundHttp`.

### 4. The web app sends a Content Security Policy, built per request, and HSTS

`apps/web/src/proxy.ts` makes a fresh nonce for every request and sets the policy on the
request (so Next puts the nonce on its own scripts) and on the response. `buildCsp`
(pure, tested) produces:

- `script-src 'self' 'nonce-…' 'strict-dynamic'`: a script runs only if it carries the
  nonce or was loaded by one that did. No `unsafe-inline`, no `unsafe-eval` in a production
  build, and no host allow-list, which is the part older policies were walked through.
- `style-src 'self' 'nonce-…'`, with the one concession `style-src-attr 'unsafe-inline'`:
  a server-rendered `style="width:40%"` (the dashboard's bars) is an attribute and cannot
  run script.
- `connect-src 'self'` plus the object store's public origin (`S3_PUBLIC_ENDPOINT`), the
  one other place the browser talks to (presigned uploads, §5.12).
- `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`,
  `default-src 'self'`; `upgrade-insecure-requests` only when the request was https, so a
  plain-http deployment does not break.
- HSTS in production only, one year, without `preload` (preload is a decision about the
  domain that this repository should not make for it).

A nonce means the root layout renders dynamically (`await connection()`). That is the
cost and it is accepted: every page here is behind sign-in and reads per-user data.

Two things in the client bundle tripped the policy and are fixed at the cause rather than
by loosening it. Zod probes for `eval` with `new Function`, which the browser reports as a
violation; `z.config({ jitless: true })` is set before any schema is built
(`instrumentation-client.ts`). And a `util` polyfill with a generator-function probe was
being bundled because `@crm/core`'s barrel re-exports modules importing `node:crypto`;
`"sideEffects": false` on `@crm/core` lets the bundler drop them (the client chunks
shrank by about 20% as a side effect).

### 5. The credential proxy decides the path

`upstreamPath` (`apps/web/src/lib/proxy-path.ts`) builds `/api/v1/…` from the matched
segments and refuses a segment that is `.` or `..`, empty, longer than 200 characters,
contains `/`, `\` or a control character, or a path of more than 20 segments. The origin
was already fixed; this means the path cannot leave `/api/v1` either. Honest finding:
nothing on the API is outside `/api/v1` today and Next itself resolves `%2e%2e` before the
handler runs, so this closes a door nobody has walked through. It is here because a
metrics route, a documentation UI or an admin route is exactly what gets added outside the
versioned prefix later, when this proxy would be attaching a session to a request for it.

## Consequences

- **No caller yet.** Row 13 of the security review moves from "not built" to "built, no
  caller yet", not to "met". It becomes met when the first feature that takes a
  destination (the email provider is the first; webhooks and link previews follow) goes
  through `OutboundHttp` with a test through it.
- **Four mutations survive, and each is explained.** The addresses, URL rules, client,
  boundary scan, CSP builder and proxy path were mutation-tested with 127 deliberate
  breaks; 123 are caught by a test. The four that are not: accepting an IPv6 zone id
  (the hextet check refuses it anyway), a case-sensitive host (the URL parser lowercases
  first), a second judgement of a literal address in the client (the URL check already
  made it), and sending an SNI name for a literal IP address in TLS (needs a TLS fixture;
  Node ignores it with a warning). The first three are redundant defences kept on
  purpose; the fourth is untested.
- **The CSP's strength is in the E2E test, not only the string.** `hardening.spec.ts`
  runs against a production build and fails if a nonce-less inline script or an inline
  handler in the real response runs or is not reported as a `script-src` violation, if
  any page the product uses reports a violation, or if the header, the nonce on the page
  or HSTS is missing. A DevTools-injected script cannot be used to check enforcement,
  since the browser exempts it from the page policy; the test puts the markup in the
  response instead.
- **Connection pooling is given up** for outbound calls (`Connection: close`, one
  socket each). The first caller sends a handful of emails a minute. A bulk sender would
  want a pinned agent with a per-host pool, and that is a decision for then.
- **A name that resolves to an IPv6 address needs IPv6 egress** on the host; a name with
  both uses the first answer. Nothing here makes that choice for the platform.

## Alternatives considered

- **A deny-list of "private" ranges.** Every list in the wild is missing something
  (`100.64/10`, `::ffff:`, 6to4, the metadata addresses). Default deny with a short
  allow-list for IPv6 and a complete IANA table for IPv4 fails closed.
- **Check the address, then hand the URL to `fetch`.** This is the textbook rebinding bug.
  The client connects to the address it checked, so there is nothing to rebind.
- **Use an off-the-shelf SSRF library or an `undici` dispatcher.** An `undici` dispatcher
  with a `connect` hook can do the same; it would add a dependency to review for a client of
  about 400 lines that we need to test against our own rules anyway. CLAUDE.md asks that a
  dependency be approved, and the built-in `http`/`https` with `lookup` do the job.
- **A network-level control (an egress proxy or a firewall) instead.** It is the right
  second layer for production and the runbook should say so, but it does not exist in
  development and CI, and an application that is only safe behind a firewall is not safe.
- **`style-src-attr` without `'unsafe-inline'`.** It would mean replacing every
  `style="width: …%"` with a class or a CSS variable set by script, which `strict-dynamic`
  allows but which turns a progress bar into a script dependency. An attribute cannot run
  code, and the risk it leaves (CSS-based data exfiltration through an injected style) needs
  an injection that the script policy already denies.
- **Hash-based CSP, avoiding the dynamic render.** Next's inline bootstrap scripts change
  with every build; maintaining hashes is more fragile than a nonce per request.
