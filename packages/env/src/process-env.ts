/**
 * The one place in the codebase that reads `process.env` (CLAUDE.md §5.8, §13).
 *
 * Everything else asks `loadEnv(scope)`, which calls this when it is not handed a source. An ESLint
 * rule (`no-restricted-properties` in packages/config/eslint) forbids `process.env` everywhere
 * except this file and tool configuration (`*.config.ts`, which run outside the application), so a
 * second reader cannot appear without somebody switching the rule off on purpose.
 */
export function readProcessEnv(): Readonly<Record<string, string | undefined>> {
  return process.env;
}
