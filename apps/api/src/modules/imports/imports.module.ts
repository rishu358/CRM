import { Module } from '@nestjs/common';
import { ImportsController } from './imports.controller.js';
import { ImportsRepository } from './imports.repository.js';
import { ImportsService } from './imports.service.js';

/**
 * The imports module (ADR-0001, ADR-0029).
 *
 * It owns import *jobs* and nothing else. The records an import creates are
 * written by the worker, through the same field validation and permission
 * checks the record modules use, not by calling into those modules from here:
 * a request handler that created 50,000 contacts would be exactly the thing
 * the background pipeline exists to avoid.
 *
 * The repository is not exported, for the reason every module's is not.
 */
@Module({
  controllers: [ImportsController],
  providers: [ImportsService, ImportsRepository],
  exports: [ImportsService],
})
export class ImportsModule {}
