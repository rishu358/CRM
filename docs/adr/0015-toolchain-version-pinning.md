# ADR-0015: Toolchain pinned to the type-aware-lint-compatible set

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

At scaffold time the newest published versions were TypeScript 7.0.2 and ESLint
10.12.0. Neither is yet supported by `typescript-eslint` 8.71.2, whose peer range is
`typescript >=4.8.4 <6.1.0` and `eslint ^8 || ^9`, nor by `eslint-plugin-jsx-a11y`
6.10.2 (`eslint ^3 ... ^9`).

`typescript-eslint` drives the **type-aware** rules this project depends on to
enforce CLAUDE.md mechanically: the `no-unsafe-*` family that makes "no `any`" real,
`no-floating-promises`, and `switch-exhaustiveness-check`. Running those rules on an
unsupported compiler means they may silently stop analysing rather than fail loudly —
the worst possible failure mode for a rule whose job is to catch unsafe code.

CLAUDE.md §11.6 forbids disabling a lint rule to make something pass. Running the
newest compiler at the cost of degrading those rules would be that same trade in a
less visible form.

## Decision

Pin the workspace, via `pnpm.overrides` so every package resolves identically:

| Tool              | Version | Reason                                                   |
| ----------------- | ------- | -------------------------------------------------------- |
| TypeScript        | 5.9.3   | Newest release inside the `typescript-eslint` peer range |
| ESLint            | 9.39.5  | Newest v9; v10 unsupported by `jsx-a11y`                 |
| typescript-eslint | 8.71.2  | Latest stable                                            |

TypeScript 7 was verified to emit `design:paramtypes` correctly, so the NestJS
dependency-injection requirement is **not** what blocks the upgrade. Only the lint
toolchain blocks it.

## Consequences

- Type-aware linting is trustworthy, which is the point.
- We are one major version behind on two tools, and we forgo TypeScript 7 compile
  speed.
- **This decision is explicitly temporary.** Revisit when `typescript-eslint`
  publishes a stable release declaring TypeScript 7 support, and when `jsx-a11y`
  supports ESLint 10. Renovate will raise the bumps; they must be taken together with
  a full `pnpm lint` run, not merged piecemeal.

## Alternatives considered

- **Newest versions, disable type-aware rules.** Rejected: it trades away the rules
  that enforce CLAUDE.md §2 and §5 for compile speed we do not need.
- **Newest versions, ignore peer warnings.** Rejected: unsupported combinations fail
  silently, so lint would appear to pass while checking less than we think.
