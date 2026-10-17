import { Injectable } from '@nestjs/common';
import { parseDecimalRate, type DecimalRate } from '@crm/core';
import { and, eq, exchangeRates, inArray, type Tx } from '@crm/db';
import type { ExchangeRateSource } from './exchange-rate.source.js';

/**
 * Rates a person entered, from `exchange_rates` (MVP_SPEC M5, P0).
 *
 * Direct pairs only: a rate for INR→USD does not imply one for USD→INR. Deriving
 * the reciprocal is tempting and wrong in a quiet way — the rounding differs
 * by direction, and a tenant who has typed both has told us they are not the
 * same number. A missing pair is reported as missing.
 */
@Injectable()
export class ManualExchangeRateSource implements ExchangeRateSource {
  async ratesTo(
    tx: Tx,
    tenantId: string,
    to: string,
    from: readonly string[],
    _asOf: Date,
  ): Promise<ReadonlyMap<string, DecimalRate>> {
    const wanted = [...new Set(from)].filter((code) => code !== to);
    if (wanted.length === 0) return new Map();

    const rows = await tx
      .select({ from: exchangeRates.fromCurrency, rate: exchangeRates.rate })
      .from(exchangeRates)
      .where(
        and(
          eq(exchangeRates.tenantId, tenantId),
          eq(exchangeRates.toCurrency, to),
          inArray(exchangeRates.fromCurrency, wanted),
        ),
      );

    return new Map(rows.map((row) => [row.from, parseDecimalRate(row.rate)]));
  }
}
