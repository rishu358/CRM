import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { FieldMetadataService } from './field-metadata.service.js';
import { CurrencyConverter } from './exchange-rates/currency-converter.service.js';
import { EXCHANGE_RATE_SOURCE } from './exchange-rates/exchange-rate.source.js';
import { ManualExchangeRateSource } from './exchange-rates/manual-exchange-rate.source.js';
import { OutboxService } from './outbox.service.js';
import { TenantRateLimitService } from './rate-limit.service.js';

/**
 * Cross-cutting services every business module depends on.
 *
 * Global because every module needs all three, and because a module that
 * forgot to import them would silently stop writing audit entries and events.
 */
@Global()
@Module({
  providers: [
    AuditService,
    OutboxService,
    FieldMetadataService,
    TenantRateLimitService,
    CurrencyConverter,
    // The one line that changes when live rates arrive (ADR-0021, P1).
    { provide: EXCHANGE_RATE_SOURCE, useClass: ManualExchangeRateSource },
  ],
  exports: [
    AuditService,
    OutboxService,
    FieldMetadataService,
    TenantRateLimitService,
    CurrencyConverter,
  ],
})
export class PlatformModule {}
