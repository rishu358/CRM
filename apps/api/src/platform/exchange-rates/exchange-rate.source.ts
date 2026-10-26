import type { DecimalRate } from '@crm/core';
import type { Tx } from '@crm/db';

/**
 * Where exchange rates come from (ADR-0021).
 *
 * The seam between "what is a USD worth in this tenant's currency" and "where
 * that number is kept". P0 reads rates a person typed in (`ManualExchangeRateSource`);
 * P1 swaps in a live feed by providing another class under this token. Nothing
 * that converts money names a vendor, a table or an HTTP client — only this
 * interface — so that swap touches one provider registration and no caller.
 *
 * The transaction is passed in rather than owned by the source because the
 * manual implementation reads a tenant-scoped table and must do it inside the
 * request's own RLS context. A live source simply ignores it.
 */
export const EXCHANGE_RATE_SOURCE = 'EXCHANGE_RATE_SOURCE';

export interface ExchangeRateSource {
  /**
   * Rates into `to`, for each currency in `from` that has one.
   *
   * A currency with no rate is **absent from the map**, not given a rate of 1
   * or 0. The caller decides what a missing rate means, and for money it must
   * mean "say so" rather than "guess".
   *
   * `asOf` is the moment the conversion is for. The manual source has one rate
   * per pair and ignores it; a live source uses it to pick a quote, and it is
   * on the signature now so adding history later is not a breaking change.
   */
  ratesTo(
    tx: Tx,
    tenantId: string,
    to: string,
    from: readonly string[],
    asOf: Date,
  ): Promise<ReadonlyMap<string, DecimalRate>>;
}
