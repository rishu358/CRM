# ADR-0011: i18n, multi-currency and time zones from day one

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

The beachhead is Indian SMBs, but the stated goal is to expand beyond India
(MVP_SPEC §1). Retrofitting internationalisation is one of the most expensive
refactors a product can undertake: every hardcoded string, every naive `Date`, every
float amount has to be found and fixed, and the bugs that remain are silent.

## Decision

Even though MVP ships only English:

- **All user-facing strings** go through the i18n layer as `t('...')`. No literal
  strings in components.
- **Money** is `amount_minor bigint` plus `currency char(3)`. **Never floats.**
  Deals carry their own currency; board totals convert to the tenant default using
  stored rates (manual in P0, live in P1).
- **Timestamps** are `timestamptz` stored in UTC, displayed in the user's time zone.
  Tenants have a time zone; users may override it.
- **Numbers and dates** are formatted through shared helpers that support the Indian
  lakh/crore grouping as well as Western grouping.
- Tenants carry `locale`, `timezone`, `default_currency` and `fiscal_year_start`.

## Consequences

- Adding a language is a translation file, not a refactor.
- Money arithmetic is exact. Integer minor units avoid the rounding errors that
  floats produce on tax and discount calculations.
- Every amount must carry its currency; a bare number is never enough.
- Slightly more ceremony in every component and every formatter call, from the first
  line of code, in exchange for never paying the retrofit.

## Alternatives considered

- **English first, internationalise later.** Rejected: this is the refactor the
  decision exists to avoid.
- **Decimal or numeric money columns.** Workable, but invites accidental float
  arithmetic in JavaScript, where there is no native decimal type.
