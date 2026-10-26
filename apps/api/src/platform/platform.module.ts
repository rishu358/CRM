import { Global, Module } from '@nestjs/common';
import { PostgresSearchProvider } from '@crm/db';
import { createStorageProvider } from '@crm/storage';
import { API_ENV_TOKEN, type ApiEnv } from '../config/env.js';
import { AuditService } from './audit.service.js';
import { FieldMetadataService } from './field-metadata.service.js';
import { IdempotencyService } from './idempotency.service.js';
import { CurrencyConverter } from './exchange-rates/currency-converter.service.js';
import { EXCHANGE_RATE_SOURCE } from './exchange-rates/exchange-rate.source.js';
import { ManualExchangeRateSource } from './exchange-rates/manual-exchange-rate.source.js';
import { EntitlementsOperator } from './entitlements-operator.service.js';
import { EntitlementsService } from './entitlements.service.js';
import { OutboxService } from './outbox.service.js';
import { OwnershipRegistry } from './ownership.registry.js';
import { TenantClock } from './tenant-clock.service.js';
import { ActorRateLimitService, AddressRateLimitService } from './rate-limit.service.js';
import { RATE_LIMIT_COUNTER } from './rate-limit/counter.js';
import { createRateLimitCounter } from './rate-limit/rate-limit.providers.js';
import { SEARCH_PROVIDER } from './search/search.tokens.js';
import { STORAGE_PROVIDER } from './storage/storage.tokens.js';

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
    OwnershipRegistry,
    FieldMetadataService,
    IdempotencyService,
    ActorRateLimitService,
    AddressRateLimitService,
    // Redis when REDIS_URL is set, this process's own counts when it is not (ADR-0053). Every rate limit
    // spends from this one counter.
    {
      provide: RATE_LIMIT_COUNTER,
      inject: [API_ENV_TOKEN],
      useFactory: (env: ApiEnv) => createRateLimitCounter(env),
    },
    CurrencyConverter,
    TenantClock,
    EntitlementsService,
    // Deliberately not exported: only the operator command reaches it, never another module (ADR-0047).
    EntitlementsOperator,
    // The one line that changes when live rates arrive (ADR-0021, P1).
    { provide: EXCHANGE_RATE_SOURCE, useClass: ManualExchangeRateSource },
    // The one line that changes when Postgres full-text is outgrown (CLAUDE.md §2, ADR-0009, ADR-0041).
    { provide: SEARCH_PROVIDER, useClass: PostgresSearchProvider },
    // One line decides the vendor (ADR-0009). The API only signs URLs and reads
    // metadata through this; it never reads or writes a file's bytes (§5.12).
    {
      provide: STORAGE_PROVIDER,
      inject: [API_ENV_TOKEN],
      useFactory: (env: ApiEnv) => createStorageProvider(env, env.NODE_ENV),
    },
  ],
  exports: [
    AuditService,
    OutboxService,
    OwnershipRegistry,
    FieldMetadataService,
    IdempotencyService,
    ActorRateLimitService,
    AddressRateLimitService,
    RATE_LIMIT_COUNTER,
    CurrencyConverter,
    TenantClock,
    EntitlementsService,
    STORAGE_PROVIDER,
    SEARCH_PROVIDER,
  ],
})
export class PlatformModule {}
