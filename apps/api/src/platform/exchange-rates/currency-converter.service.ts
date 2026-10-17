import { Inject, Injectable } from '@nestjs/common';
import { add, convert, money, toCurrency, zero, type Money } from '@crm/core';
import { eq, tenants, type Tx } from '@crm/db';
import { EXCHANGE_RATE_SOURCE, type ExchangeRateSource } from './exchange-rate.source.js';

/** An amount in one currency, and how many records it is the sum of. */
export interface CurrencyBucket {
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly count: number;
}

export interface ConvertedTotal {
  /** In the target currency; null when nothing could be converted. */
  readonly total: Money | null;
  /** Buckets with no rate, left in their own currency and never dropped. */
  readonly unconverted: readonly CurrencyBucket[];
}

/**
 * Totals across currencies, in the tenant's default currency (ADR-0021).
 *
 * Takes **per-currency subtotals**, not individual amounts, and converts each
 * subtotal once. Rounding 10,000 deals one at a time and adding them up drifts
 * from the rounded sum by up to half a minor unit per deal; rounding twelve
 * subtotals drifts by twelve half-units at most, and the number is the same
 * wherever the grouping happens.
 *
 * Which rates apply is not decided here — that is the `ExchangeRateSource` —
 * so a live feed changes nothing in this file.
 */
@Injectable()
export class CurrencyConverter {
  constructor(@Inject(EXCHANGE_RATE_SOURCE) private readonly source: ExchangeRateSource) {}

  /** The tenant's reporting currency. Read, never assumed to be INR. */
  async defaultCurrency(tx: Tx, tenantId: string): Promise<string> {
    const rows = await tx
      .select({ currency: tenants.defaultCurrency })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return rows[0]?.currency ?? 'INR';
  }

  async totalIn(
    tx: Tx,
    tenantId: string,
    target: string,
    buckets: readonly CurrencyBucket[],
    asOf: Date = new Date(),
  ): Promise<ConvertedTotal> {
    const targetCode = toCurrency(target);
    const foreign = buckets.filter((bucket) => bucket.currency !== targetCode);
    const rates = await this.source.ratesTo(
      tx,
      tenantId,
      targetCode,
      foreign.map((bucket) => bucket.currency),
      asOf,
    );

    let total: Money | null = null;
    const unconverted: CurrencyBucket[] = [];

    for (const bucket of buckets) {
      const amount = money(bucket.amountMinor, bucket.currency);
      let converted: Money | null = null;

      if (bucket.currency === targetCode) {
        converted = amount;
      } else {
        const rate = rates.get(bucket.currency);
        if (rate !== undefined) converted = convert(amount, targetCode, rate);
      }

      if (converted === null) {
        unconverted.push(bucket);
      } else {
        total = add(total ?? zero(targetCode), converted);
      }
    }

    return { total, unconverted };
  }
}
