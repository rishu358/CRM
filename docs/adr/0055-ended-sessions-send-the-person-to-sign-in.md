# ADR-0055: A session that has ended sends the person to the sign-in screen

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

Nothing in the web app checked for a session. `/` redirected to `/dashboard` for everybody, and every
page drew the application frame whether or not the person was signed in. A visitor with no cookie, a
cookie the database does not know, or a session the server had ended (revoked from another device,
expired, superseded by a password change under ADR-0036) therefore saw the sidebar and a dashboard on
which every card said "Could not load this", while the API answered 401 `UNAUTHENTICATED` to each call.
Signing out and in again fixed it, but nothing said so. CLAUDE.md §5.9 requires sessions to be revoked
on a password change; the revoking worked and what the person saw afterwards did not.

The API answers every kind of dead session with the same 401 and code. That is deliberate (it would
otherwise say which sessions exist) and means the web app cannot, and should not, tell the cases apart.
`INVALID_CREDENTIALS` is also a 401, so the status alone cannot identify a dead session.

## Decision

- **A full page load of a protected page is checked in `proxy.ts`.** No cookie: redirect to
  `/sign-in`. A cookie: ask the API (`GET /api/v1/auth/me`, which is exempt from the MFA-enrolment
  block) with a 3 second limit. Only a 401 with code `UNAUTHENTICATED` redirects, to
  `/sign-in?reason=session-ended&returnTo=<path>`, and clears the httpOnly cookie on that response.
  A timeout, a 5xx or a network failure lets the page render and leaves the cookie alone, so an outage
  does not sign everybody out.
- **Pages are protected unless listed.** The signed-out screens (`/sign-in`, `/sign-up`,
  `/forgot-password`, `/reset-password`, `/verify-email`, `/accept-invite`) are listed in
  `lib/session-gate.ts`; a page added later needs a session until somebody lists it, as with `@Public()`
  in the API. A request for a file (a path whose last segment has an extension, such as a configured
  logo) is left alone.
- **Only document loads call the API.** Client-side navigations and prefetches carry no extra cost; the
  browser handler covers them when their own calls come back refused.
- **One browser handler for a session that ends while the app is open** (`lib/session-ended.ts`),
  called from `api-client.ts` and `session.ts`, the two functions every request goes through. On the
  first 401 `UNAUTHENTICATED` it calls `DELETE /api/session` (which clears the cookie), then does a full
  page navigation to the sign-in screen, which also discards the query cache. It does nothing on a
  signed-out screen.
- **No redirect loop is possible.** Edges only point _to_ `/sign-in`, from protected pages. `/sign-in`
  does not redirect anywhere, and the handler ignores signed-out screens. If "already signed in, go to
  the dashboard" is ever added to sign-in, it must ask the API first rather than trust the cookie.
- **`returnTo` is a path on this site and nothing else.** `safeReturnTo` accepts a single-slash path,
  parses it and checks the _parsed_ pathname (`/.//host` becomes `//host`), refuses backslashes, control
  characters, sign-in and `/api` targets, and drops the query and fragment, which can hold search terms
  and names and would end up in history and logs. It is checked on the server in the sign-in page, so
  the browser never receives an unchecked value.
- **The sign-in screen understands one `reason`, `session-ended`,** and shows a fixed, translated
  sentence. Nothing from the URL is reflected.
- This changes which screen is shown, not what is permitted. The API still authenticates and authorizes
  every call.

## Consequences

- Each full page load by a signed-in person costs one extra API call, counted against the tenant's
  rate limit.
- A person who left a tab open and whose session was revoked sees nothing change until the tab next
  asks the server for something (a navigation, a refetch on focus, the notification bell).
- A back-button return to a page from before sign-out can show the frame briefly, until its first call
  is refused and the handler moves the person on.
- A valid session with no active workspace is also answered 401 by the API and so also lands on sign-in.
  Sign-in does not forward anyone, so this cannot loop.

## Alternatives considered

- **Gate in a shared layout.** Pages draw their own `AppShell`; a layout for the protected pages means
  moving every route directory into a route group, which conflicts with every open branch for no gain.
- **Check only that a cookie is present.** Fixes a visitor with no cookie and nothing else; the stale
  cookie is the case that prompted this.
- **A TanStack Query default error handler.** Covers queries and mutations but not the plain `fetch`
  calls in `session.ts`; the two request functions cover all of them.
- **Telling the person why (revoked, expired, changed password).** Impossible without the API leaking it,
  and not wanted.
