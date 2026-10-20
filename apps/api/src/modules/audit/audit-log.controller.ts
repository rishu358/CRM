import { Controller, Get, Inject, Query } from '@nestjs/common';
import { auditListQuerySchema, type AuditListQuery } from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { AuditLogService } from './audit-log.service.js';

/**
 * `/api/v1/audit-logs` (ADR-0007).
 *
 * Validate, hand off, envelope — nothing else. The capability check, the window
 * default and the field-permission filter all live behind the service, so the
 * public API and a future mobile client get them without this controller
 * remembering anything.
 */
@Controller('audit-logs')
export class AuditLogController {
  constructor(@Inject(AuditLogService) private readonly auditLogs: AuditLogService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(auditListQuerySchema)) query: AuditListQuery,
  ) {
    return this.auditLogs.list(actor, query);
  }
}
