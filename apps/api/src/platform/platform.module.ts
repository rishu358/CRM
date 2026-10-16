import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { FieldMetadataService } from './field-metadata.service.js';
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
  providers: [AuditService, OutboxService, FieldMetadataService, TenantRateLimitService],
  exports: [AuditService, OutboxService, FieldMetadataService, TenantRateLimitService],
})
export class PlatformModule {}
