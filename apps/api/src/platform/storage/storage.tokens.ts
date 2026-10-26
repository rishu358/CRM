/**
 * DI token for the object store (ADR-0009).
 *
 * A string token like `EMAIL_PROVIDER` and `EXCHANGE_RATE_SOURCE`, and
 * injected with `@Inject(STORAGE_PROVIDER)` — esbuild emits no decorator
 * metadata, so a bare constructor type would pass every test and leave
 * `pnpm dev` exiting silently (ADR-0016).
 *
 * The API holds this only to **sign URLs and look at metadata**. It has no
 * code path that reads or writes a file's bytes: a file never passes through
 * the API process (CLAUDE.md §5.12). The worker, which does parse them,
 * builds its own provider from the same configuration.
 */
export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';
