import type { SearchProvider } from '@crm/core';
import type { Tx } from '@crm/db';

/**
 * The injection token for whichever search engine is configured (ADR-0009).
 *
 * A string token, like `EMAIL_PROVIDER` and `EXCHANGE_RATE_SOURCE`, and named
 * explicitly at every constructor with `@Inject` — esbuild emits no decorator
 * metadata, so an interface-typed parameter without it resolves to nothing and
 * the API exits silently at boot while the tests still pass (ADR-0016).
 *
 * `Tx` is baked into the type on purpose. The Postgres provider needs the
 * caller's tenant-scoped transaction, because that is where RLS gets its
 * tenant from; a provider in another process ignores the handle and must
 * enforce `SearchRequest.tenantId` itself (ADR-0028 §6). Typing it means a
 * replacement has to decide that deliberately rather than by omission.
 */
export const SEARCH_PROVIDER = 'SEARCH_PROVIDER';

export type ApiSearchProvider = SearchProvider<Tx>;
