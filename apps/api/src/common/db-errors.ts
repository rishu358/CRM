/**
 * Recognising a specific database constraint failure.
 *
 * Some invariants are enforced in the database rather than only in a service,
 * because an import, a seed or a future code path must not be able to write a
 * row the service would have refused (CLAUDE.md §5). The cost of that choice is
 * here: when the database is the one that says no, the API still has to answer
 * with its own error envelope rather than a 500.
 *
 * Matching on the **constraint name** rather than the message: SQLSTATE alone
 * is too coarse (`23514` is every CHECK on every table) and the message is
 * prose that a future edit will reword.
 *
 * Drizzle wraps the driver error and keeps the original on `cause`, so the
 * chain has to be walked — reading `error.constraint` off the wrapper finds
 * nothing and quietly turns every refusal into a 500.
 */
export function isConstraintViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);

    if (typeof current === 'object' && 'constraint' in current) {
      const name = (current as { constraint?: unknown }).constraint;
      if (name === constraint) return true;
    }

    current = current instanceof Error ? current.cause : undefined;
  }

  return false;
}
