import { Module } from '@nestjs/common';
import { AuditLogController } from './audit-log.controller.js';
import { AuditLogRepository } from './audit-log.repository.js';
import { AuditLogService } from './audit-log.service.js';

/**
 * The audit viewer (ADR-0001, MVP_SPEC M11).
 *
 * `AuditLogService` is exported because the data-rights module asks it whether
 * the caller may read history before queueing an audit-log archive — through
 * the service's public method, never by reaching for its repository or its
 * table (CLAUDE.md §3).
 */
@Module({
  controllers: [AuditLogController],
  providers: [AuditLogService, AuditLogRepository],
  exports: [AuditLogService],
})
export class AuditLogModule {}
