# ADR-0045: Branding and new-workspace defaults are configuration, applied per installation

- **Status:** Accepted
- **Date:** 2026-10-24
- **Related:** ADR-0044 (the configuration registry), CLAUDE.md §13, MVP_SPEC §9 (accessibility)

## Context

The product was written for one operator in India, and it showed in the code: "CRM" was a literal in the
page title, the sign-in screen, the navigation, four email texts, the invitation and digest emails and the
authenticator's issuer; a new workspace got INR, `Asia/Kolkata`, `en-IN`, an April financial year and the
region label `ap-south-1` from database column defaults. Selling the product, white-labelling it, or handing
it to another operator in another market would have meant editing and rebuilding it.

## Decision

### 1. Two levels, and only the first now

Branding is **per installation** (one deployment, one set of environment variables), set through the
configuration registry (ADR-0044). **Per-tenant** white-labelling, where each customer of one installation
has its own name and logo, is a different feature: it needs columns on `tenants`, a migration, a way to
resolve the tenant before sign-in (by hostname), and a settings screen. It is deliberately **not** done
here; nothing in this change forecloses it, and the places that read the brand (`useBrand()`, the email
builders) are the places that would read a tenant's instead.

### 2. What is configurable

| Variable                                                                          | Read by          | Used for                                                    |
| --------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------- |
| `APP_NAME` (default `CRM`)                                                        | api, worker, web | Page titles, sign-in, navigation, every email, TOTP issuer  |
| `BRAND_LOGO_URL`, `BRAND_FAVICON_URL`                                             | web              | Logo in place of the name; tab icon                         |
| `BRAND_COLOR`, `BRAND_COLOR_DARK`                                                 | web              | Primary colour of each theme                                |
| `SUPPORT_EMAIL`, `TERMS_URL`, `PRIVACY_URL`                                       | web              | Footer links on the sign-in screens, each shown only if set |
| `DEFAULT_CURRENCY`, `_TIMEZONE`, `_LOCALE`, `_FISCAL_YEAR_START_MONTH`, `_REGION` | api              | What a new workspace, and its first user, start with        |

Every default equals what the code did before, so an existing deployment changes nothing. The sender
address and the web and API domains were already configuration (`EMAIL_FROM`, `WEB_URL`, `API_URL`).

### 3. A brand colour cannot break accessibility

The design tokens are proven to meet WCAG 2.1 AA by `contrast.test.ts`, and a configurable colour would
walk around that proof. So a colour is **refused at start-up** unless it satisfies the same rules the
built-in one does, evaluated on the colour exactly as the browser renders it (after rounding to HSL):
text on the page and on cards at 4.5:1 (links), text inside a badge tinted 15% with it at 4.5:1, the focus
ring at 3:1, and the label on a primary button at 4.5:1 (white, the dark ink, or black, chosen
automatically). The two themes are separate settings, because a colour that reads on a light page almost
never reads on a dark one. The rules and the surfaces they are measured against are in
`packages/ui/src/brand.ts`; the surfaces are numbers there only because a stylesheet cannot be imported,
and a test parses `styles.css` and fails if any drifts.

The tint used for a selected row or hovered menu item is derived from the brand hue, then checked the same
way; if a hue cannot be made to pass it, the built-in tint is kept rather than the colour refused.

An independent sweep (`brand.test.ts`) re-derives every pair `contrast.test.ts` asserts for hundreds of
colours in both themes and fails if one is accepted that the design-token proof would reject. It earned its
place: it found that the dark ink is not pure black, so for a mid-tone such as `#6666ff` the better of white
and the ink reaches only 4.35:1; black is now the fallback, and no colour is refused for its label.

The colours reach the page as CSS custom properties on the root element (`style-src-attr` already allows
style attributes, which cannot run script); `styles.css` reads them with the built-in values as fallbacks, so
an unset colour is the stock theme and nothing else changes.

### 4. Images go through the content security policy, not around it

`img-src` was `'self' data: blob:`. A logo or favicon on another host adds exactly that host's origin to
`img-src`, and nothing else is opened (`connect-src`, `font-src` and scripts are untouched, which a test
checks). Addresses are limited to http(s) URLs and paths on the web app's own origin; `javascript:`,
`data:` and protocol-relative `//host` are refused by the registry. A path such as `/brand/logo.svg` is
served from `apps/web/public`, which is part of the web build, so changing it means redeploying the web
app; an https URL on a host you control does not.

### 5. New-workspace defaults come from the server's configuration

`AuthRepository` writes the five tenant defaults, and the first user's locale and time zone, explicitly at
creation, from configuration. The database column defaults (INR, `Asia/Kolkata`, ...) remain as a last
fallback, because a column default cannot read an environment variable and changing it needs a migration for
no gain. A time zone must be an IANA `Area/City` name or `UTC` (Node's `Intl` also accepts abbreviations such
as `IST`, which Postgres reads differently). Existing workspaces are never touched.

## Behaviour changes

- The "you already have an account" email is reworded from "a CRM account" to "an account on {name}".
  A configurable name makes "a" ungrammatical for half of all names ("a Orchid account"), so the article
  is gone rather than guessed.
- The authenticator issuer is `APP_NAME`. An entry already enrolled keeps the label it was enrolled
  under; verification does not depend on it.
- `SUPPORT_EMAIL`, `TERMS_URL` and `PRIVACY_URL` are new, optional, and show nothing when unset.

## Not done, and said so

- **The web app's formatting fallbacks** (`DEFAULT_PREFERENCES` in `apps/web/src/lib/format.ts`: `en-IN`,
  `Asia/Kolkata`) are still constants. They apply only when a signed-in user has no stored preferences,
  which cannot happen for a user created after this change (they get the configured defaults). They are
  worth routing through configuration if a non-Indian market ever sees them.
- **The currency pickers list INR first** (`CURRENCIES` in the web app): menu ordering, not a default.
- **`plan` still defaults to `'free'`** in the schema; entitlements replace it in a later change.
- **The session cookie's default name `crm_session`** and the OpenAPI document's title ("CRM Platform
  API") still say CRM. The cookie name is already configurable (`SESSION_COOKIE_NAME`). The OpenAPI
  document is a generated artifact of the contracts package, fixed at build time rather than per
  deployment; it describes the API, not the brand.
- **Legal text** in `docs/legal` is drafted separately and names the operator it was drafted for.
- Per-tenant branding (above).
