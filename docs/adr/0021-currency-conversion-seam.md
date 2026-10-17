# ADR-0021: Currency conversion behind an exchange-rate source

- **Status:** Accepted
- **Date:** 2026-10-17

## Context

Deals are stored in their own currency, as minor units beside an ISO-4217 code
(ADR-0011). The Kanban board shows a total per column, and a column can hold
rupee, dollar and dirham deals. MVP_SPEC M5 says those totals are shown in the
tenant's default currency, with **manual** exchange rates in P0 and **live**
rates in P1.

Two things about that sentence are expensive to get wrong:

- **Where rates come from will change, and every caller of "convert" will have
  been written against the first answer.** If the board reads a table directly,
  live rates mean finding every place that does.
- **A total across currencies is only as honest as its treatment of the
  currencies it could not convert.** Dropping a deal because its currency has no
  rate, and saying nothing, produces a wrong number that looks right.

And one thing about the arithmetic: ADR-0011 forbids floats for money, and a
rate is a fraction.

## Decision

### 1. One interface, one registration

`ExchangeRateSource` (`apps/api/src/platform/exchange-rates`) answers a single
question: _the rates into this currency, for these currencies, as of this
moment_. It is registered under the `EXCHANGE_RATE_SOURCE` token in
`PlatformModule`. P0 provides `ManualExchangeRateSource`, which reads the
tenant's `exchange_rates` rows. P1 provides a live source under the same token
— one provider registration changes, and no caller does.

`CurrencyConverter` is what the rest of the API uses. It owns the tenant's
reporting currency and `totalIn(target, buckets)`. Nothing outside it names a
table, a vendor or an HTTP client.

`asOf` is on the signature although the manual source ignores it (one rate per
pair). A live source needs it to pick a quote, and adding a parameter to an
interface with a dozen callers is a breaking change; adding it now is free.

### 2. Rates are exact, and applied in bigint

A rate is stored as `numeric(24,12)` and read as a **string**. `parseDecimalRate`
turns `"83.250000000000"` into `{ numerator: 83250000000000n, denominator:
10n ** 12n }`, and `convert` multiplies in bigint and rounds half-up once. The
rate is major-unit to major-unit ("1 USD = 83.25 INR"), which is how a person
states one, and `convert` scales by the difference in minor-unit exponents, so
converting yen (no decimals) into rupees (two) does not come out a hundred
times wrong. No floating-point value touches an amount.

### 3. Subtotals are converted once, not amounts one at a time

The board aggregates **per stage and per currency in SQL**, then converts each
subtotal. Converting ten thousand deals individually and summing drifts from the
rounded sum by up to half a minor unit per deal; converting a handful of
subtotals drifts by at most a handful of half-units. It also means the database
returns a dozen rows per board rather than every deal in it.

### 4. A missing rate is reported, never papered over

A currency with no rate is **absent** from the source's answer — not given a rate
of 1, and not given 0. The converter leaves that bucket out of the total **and
returns it** as `unconverted: [{ currency, count, amountMinor }]`, which the
board renders as "Not in total: no exchange rate for EUR". Direct pairs only:
USD→INR does not imply INR→USD, because the rounding differs by direction and
a tenant who entered both has said they are different numbers.

### 5. Hiding the amount hides the total

A caller who may not read `deal.amount` receives the **counts** for each column
and no totals and no `unconverted` list. A sum is the amounts; a permission that
hid the field and served its total would hide nothing. The `currency` column has
no permission key of its own and is not sortable or filterable, for the same
reason — it is half of `amount`.

## Consequences

- Rates are read on every board request, so a changed rate shows on the next
  load. At board scale (a dozen subtotal rows, one rate query per column) this
  is cheap; a live source will want a short cache of its own, which belongs in
  that source and not in the converter.
- **There is no UI or endpoint to enter rates yet.** The table, the source and
  the conversion exist and are tested; the demo seed inserts USD and AED. An
  admin screen needs its own permission object — rates are configuration, not
  records — and is a decision to take with M3 and M9. Until then rates are
  written by seed or by SQL.
- Sorting a list by `amount` orders the minor-unit number and only means
  something within one currency. Sorting across currencies by converted value
  needs rates inside the query and is a reporting problem for P1.
- Other money (account revenue, future invoices) should convert through
  `CurrencyConverter` as well, rather than growing a second implementation.

## Alternatives considered

- **Convert in the browser.** Rejected: the browser would need every rate, and
  the conversion rules would exist in two languages.
- **Store the converted amount on each deal.** Rejected: it goes stale the
  moment a rate changes, and a live feed would mean rewriting every row daily.
- **Derive the reciprocal when only the opposite pair exists.** Rejected, above.
- **`rate` as a float or an integer count of micro-units.** A float is
  forbidden by ADR-0011. Micro-units cap precision at six places, which
  mis-states a rate such as INR→USD (about 0.012) by a visible margin on a large
  deal; `numeric(24,12)` costs nothing and does not.
