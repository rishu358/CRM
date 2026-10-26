# ADR-0016: Explicit `@Inject` tokens instead of inferred constructor types

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

NestJS can resolve a constructor parameter from its TypeScript type, but only
when the compiler emits `design:paramtypes` metadata. Emitting that metadata is
a property of the **toolchain**, not of the source:

| Pipeline                            | Emits metadata |
| ----------------------------------- | -------------- |
| `tsc` (builds, CI)                  | yes            |
| oxc (Vitest 5)                      | yes            |
| esbuild (`tsx`, used by `pnpm dev`) | **no**         |

The result is a failure mode worth describing, because we hit it: the API's
tests passed, `pnpm build` and `pnpm typecheck` passed, and `pnpm dev` produced
a process that exited with no output at all. Nest _did_ report
`Nest can't resolve dependencies of the SessionService (?, API_ENV)` — but to
its own logger, which we had disabled in favour of pino, so nothing reached the
terminal. It read as a hang; it was a crash.

## Decision

**Every injected constructor parameter names its token explicitly:**

```ts
constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
```

The wiring is then declared in the code rather than inferred from compiler
output, and works identically under every pipeline.

Two supporting changes:

- `main.ts` wraps startup in try/catch and logs through pino, so a boot failure
  can never again be silent.
- `emitDecoratorMetadata` stays on for `tsc` builds. Nothing depends on it, but
  turning it off would be a second thing to remember.

## Consequences

- DI behaves the same under `tsx`, Vitest and compiled output.
- Constructors are more verbose, and a new parameter added without `@Inject`
  reintroduces the problem in that one place. The cost is visible and local; the
  previous failure was invisible and global.
- Nothing in the application depends on decorator metadata any more, which keeps
  the door open to runtimes that will never emit it — including Node's own type
  stripping.

## Alternatives considered

- **Run the dev server through `tsc --watch`.** Correct, but it makes local
  development slower and adds a second process, to work around a problem the
  explicit tokens remove outright.
- **Leave it and only run tests.** Rejected: `pnpm dev` is the command every
  contributor runs first, and "it starts and prints nothing" is the worst
  possible first impression of a codebase.
