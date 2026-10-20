# Design review screenshots

Before and after the UI pass (ADR-0031). Every route, light and dark, so the change
is reviewable as something other than a diff.

- `before/` — master at `b7490e4`.
- `after/` — this branch.
- Numbering groups them: `0x` signed-out screens, `1xx` app screens, `2xx` the four
  required states, `3xx` the sales-rep view, `4xx` keyboard and responsive surfaces
  (new in this pass, so they have no "before").

Taken at 1440×900 unless the name says otherwise (`-800`, `-390`). Full-page
captures; the Next.js dev badge is hidden.

## Regenerate

With the web app and API running and a seeded tenant (`pnpm db:seed` prints the
credentials):

```bash
export CRM_OWNER_EMAIL=… CRM_REP_EMAIL=… CRM_PASSWORD=…
pnpm --filter @crm/web exec tsx scripts/capture-screens.mts after
# ONLY=states or ONLY=keyboard re-takes just those groups
```

The four states are produced by intercepting the page's own API calls — a held
response for loading, a 500 for error, a 403 for no-permission — so they are
deterministic. Error takes a few seconds: the query retries a failed request before
it gives up.

Note for repeated runs: sign-in and the general request limiter are per IP, so
running this next to the E2E suite on one machine can trip them. Restart the API, or
raise `AUTH_RATE_LIMIT_MAX_PER_IP` and `RATE_LIMIT_MAX_PER_USER` in your local
`.env`.

## Index

| Screen                       | Before                                                                                                                | After                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| auth sign in                 | [light](before/01-auth-sign-in.light.png) · [dark](before/01-auth-sign-in.dark.png)                                   | [light](after/01-auth-sign-in.light.png) · [dark](after/01-auth-sign-in.dark.png)                                   |
| auth sign up                 | [light](before/02-auth-sign-up.light.png) · [dark](before/02-auth-sign-up.dark.png)                                   | [light](after/02-auth-sign-up.light.png) · [dark](after/02-auth-sign-up.dark.png)                                   |
| auth forgot password         | [light](before/03-auth-forgot-password.light.png) · [dark](before/03-auth-forgot-password.dark.png)                   | [light](after/03-auth-forgot-password.light.png) · [dark](after/03-auth-forgot-password.dark.png)                   |
| auth reset password          | [light](before/04-auth-reset-password.light.png) · [dark](before/04-auth-reset-password.dark.png)                     | [light](after/04-auth-reset-password.light.png) · [dark](after/04-auth-reset-password.dark.png)                     |
| auth verify email            | [light](before/05-auth-verify-email.light.png) · [dark](before/05-auth-verify-email.dark.png)                         | [light](after/05-auth-verify-email.light.png) · [dark](after/05-auth-verify-email.dark.png)                         |
| auth accept invite           | [light](before/06-auth-accept-invite.light.png) · [dark](before/06-auth-accept-invite.dark.png)                       | [light](after/06-auth-accept-invite.light.png) · [dark](after/06-auth-accept-invite.dark.png)                       |
| auth sign in error           | [light](before/07-auth-sign-in-error.light.png) · [dark](before/07-auth-sign-in-error.dark.png)                       | [light](after/07-auth-sign-in-error.light.png) · [dark](after/07-auth-sign-in-error.dark.png)                       |
| my day                       | [light](before/101-my-day.light.png) · [dark](before/101-my-day.dark.png)                                             | [light](after/101-my-day.light.png) · [dark](after/101-my-day.dark.png)                                             |
| leads                        | [light](before/102-leads.light.png) · [dark](before/102-leads.dark.png)                                               | [light](after/102-leads.light.png) · [dark](after/102-leads.dark.png)                                               |
| contacts                     | [light](before/103-contacts.light.png) · [dark](before/103-contacts.dark.png)                                         | [light](after/103-contacts.light.png) · [dark](after/103-contacts.dark.png)                                         |
| accounts                     | [light](before/104-accounts.light.png) · [dark](before/104-accounts.dark.png)                                         | [light](after/104-accounts.light.png) · [dark](after/104-accounts.dark.png)                                         |
| deals board                  | [light](before/105-deals-board.light.png) · [dark](before/105-deals-board.dark.png)                                   | [light](after/105-deals-board.light.png) · [dark](after/105-deals-board.dark.png)                                   |
| import                       | [light](before/106-import.light.png) · [dark](before/106-import.dark.png)                                             | [light](after/106-import.light.png) · [dark](after/106-import.dark.png)                                             |
| settings team                | [light](before/107-settings-team.light.png) · [dark](before/107-settings-team.dark.png)                               | [light](after/107-settings-team.light.png) · [dark](after/107-settings-team.dark.png)                               |
| settings security            | [light](before/108-settings-security.light.png) · [dark](before/108-settings-security.dark.png)                       | [light](after/108-settings-security.light.png) · [dark](after/108-settings-security.dark.png)                       |
| deals list                   | [light](before/109-deals-list.light.png) · [dark](before/109-deals-list.dark.png)                                     | [light](after/109-deals-list.light.png) · [dark](after/109-deals-list.dark.png)                                     |
| contacts detail              | [light](before/110-contacts-detail.light.png) · [dark](before/110-contacts-detail.dark.png)                           | [light](after/110-contacts-detail.light.png) · [dark](after/110-contacts-detail.dark.png)                           |
| accounts detail              | [light](before/111-accounts-detail.light.png) · [dark](before/111-accounts-detail.dark.png)                           | [light](after/111-accounts-detail.light.png) · [dark](after/111-accounts-detail.dark.png)                           |
| leads detail                 | [light](before/112-leads-detail.light.png) · [dark](before/112-leads-detail.dark.png)                                 | [light](after/112-leads-detail.light.png) · [dark](after/112-leads-detail.dark.png)                                 |
| deals detail                 | [light](before/113-deals-detail.light.png) · [dark](before/113-deals-detail.dark.png)                                 | [light](after/113-deals-detail.light.png) · [dark](after/113-deals-detail.dark.png)                                 |
| palette                      | [light](before/114-palette.light.png) · [dark](before/114-palette.dark.png)                                           | [light](after/114-palette.light.png) · [dark](after/114-palette.dark.png)                                           |
| new contact dialog           | [light](before/115-new-contact-dialog.light.png) · [dark](before/115-new-contact-dialog.dark.png)                     | [light](after/115-new-contact-dialog.light.png) · [dark](after/115-new-contact-dialog.dark.png)                     |
| deals board 800              | [light](before/116-deals-board-800.light.png) · [dark](before/116-deals-board-800.dark.png)                           | [light](after/116-deals-board-800.light.png) · [dark](after/116-deals-board-800.dark.png)                           |
| contacts 390                 | [light](before/117-contacts-390.light.png) · [dark](before/117-contacts-390.dark.png)                                 | [light](after/117-contacts-390.light.png) · [dark](after/117-contacts-390.dark.png)                                 |
| state contacts loading       | [light](before/201-state-contacts-loading.light.png) · [dark](before/201-state-contacts-loading.dark.png)             | [light](after/201-state-contacts-loading.light.png) · [dark](after/201-state-contacts-loading.dark.png)             |
| state contacts error         | — · —                                                                                                                 | [light](after/202-state-contacts-error.light.png) · [dark](after/202-state-contacts-error.dark.png)                 |
| state contacts no permission | [light](before/203-state-contacts-no-permission.light.png) · [dark](before/203-state-contacts-no-permission.dark.png) | [light](after/203-state-contacts-no-permission.light.png) · [dark](after/203-state-contacts-no-permission.dark.png) |
| state deals loading          | [light](before/204-state-deals-loading.light.png) · [dark](before/204-state-deals-loading.dark.png)                   | [light](after/204-state-deals-loading.light.png) · [dark](after/204-state-deals-loading.dark.png)                   |
| state deals error            | — · —                                                                                                                 | [light](after/205-state-deals-error.light.png) · [dark](after/205-state-deals-error.dark.png)                       |
| state deals no permission    | [light](before/206-state-deals-no-permission.light.png) · [dark](before/206-state-deals-no-permission.dark.png)       | [light](after/206-state-deals-no-permission.light.png) · [dark](after/206-state-deals-no-permission.dark.png)       |
| state my day loading         | [light](before/207-state-my-day-loading.light.png) · [dark](before/207-state-my-day-loading.dark.png)                 | [light](after/207-state-my-day-loading.light.png) · [dark](after/207-state-my-day-loading.dark.png)                 |
| state my day error           | — · —                                                                                                                 | [light](after/208-state-my-day-error.light.png) · [dark](after/208-state-my-day-error.dark.png)                     |
| state my day no permission   | [light](before/209-state-my-day-no-permission.light.png) · [dark](before/209-state-my-day-no-permission.dark.png)     | [light](after/209-state-my-day-no-permission.light.png) · [dark](after/209-state-my-day-no-permission.dark.png)     |
| state contacts no results    | [light](before/210-state-contacts-no-results.light.png) · [dark](before/210-state-contacts-no-results.dark.png)       | [light](after/210-state-contacts-no-results.light.png) · [dark](after/210-state-contacts-no-results.dark.png)       |
| rep deals board              | [light](before/301-rep-deals-board.light.png) · —                                                                     | [light](after/301-rep-deals-board.light.png) · —                                                                    |
| keys go to chip              | — · —                                                                                                                 | [light](after/401-keys-go-to-chip.light.png) · [dark](after/401-keys-go-to-chip.dark.png)                           |
| keys shortcut list           | — · —                                                                                                                 | [light](after/402-keys-shortcut-list.light.png) · [dark](after/402-keys-shortcut-list.dark.png)                     |
| keys focus ring              | — · —                                                                                                                 | [light](after/403-keys-focus-ring.light.png) · [dark](after/403-keys-focus-ring.dark.png)                           |
| deals board rail             | — · —                                                                                                                 | [light](after/404-deals-board-rail.light.png) · [dark](after/404-deals-board-rail.dark.png)                         |
| deals 390                    | — · —                                                                                                                 | [light](after/405-deals-390.light.png) · [dark](after/405-deals-390.dark.png)                                       |
| nav drawer 390               | — · —                                                                                                                 | [light](after/406-nav-drawer-390.light.png) · [dark](after/406-nav-drawer-390.dark.png)                             |

The "before" error-state captures (contacts, deals, My Day) are absent on purpose:
the script that took them did not wait out the query's retries, so they showed the
loading skeleton. The error states themselves existed; only the picture was wrong.
