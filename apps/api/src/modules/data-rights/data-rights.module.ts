import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit/audit-log.module.js';
import { DataRightsController } from './data-rights.controller.js';
import { DataRightsRepository } from './data-rights.repository.js';
import { DataRightsService } from './data-rights.service.js';

/**
 * Data rights (ADR-0001, MVP_SPEC M11).
 *
 * Imports `AuditLogModule` for one reason: an audit-log archive must answer the
 * same question the viewer answers before it is queued, and it asks through
 * `AuditLogService`'s public method rather than re-deriving the rule
 * (CLAUDE.md §3).
 */
@Module({
  imports: [AuditLogModule],
  controllers: [DataRightsController],
  providers: [DataRightsService, DataRightsRepository],
  exports: [DataRightsService],
})
export class DataRightsModule {}
