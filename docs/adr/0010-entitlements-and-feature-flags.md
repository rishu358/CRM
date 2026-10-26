# ADR-0010: Entitlements and feature flags

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

MVP_SPEC §12 plans Free / Pro / Enterprise tiers, and pilots will need features
enabled individually before they are ready for everyone. Branching on a plan name in
business logic means every pricing change becomes a code change, and the checks
inevitably disagree with each other.

## Decision

One lookup: `entitlements.has(tenant, feature)`.

- Plans map to **feature sets** in data, not in code.
- **No plan name may appear in business logic.** A lint rule rejects comparisons
  against a `plan` property.
- The same mechanism serves gradual rollout: a feature can be enabled per tenant
  regardless of plan.
- Limits (record caps, seat counts, API quotas) are entitlement **values**, not just
  booleans.

## Consequences

- Pricing and packaging change without a deploy.
- Pilot-specific enablement needs no code forks.
- Entitlements are consulted on hot paths, so they are resolved once per request
  alongside permissions and cached per tenant.
- Enforcement must happen in the **API**, never only in the UI; hiding a button is
  cosmetic (CLAUDE.md §9).

## Alternatives considered

- **Hardcoded plan checks.** Rejected by CLAUDE.md §6.
- **A third-party flag service.** Rejected for MVP: entitlement data belongs with
  tenant data, and an outage of that service must never gate customer access.
