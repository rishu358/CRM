import { Module } from '@nestjs/common';
import { ExportsController } from './exports.controller.js';
import { ExportsRepository } from './exports.repository.js';
import { ExportsService } from './exports.service.js';

/**
 * The exports module (ADR-0001, ADR-0029).
 *
 * Owns export *jobs*. The rows are read and written to a file by the worker;
 * this module never touches a record table, so there is no second code path in
 * the API that can read a customer list outside the record modules' own
 * serializers and scope checks.
 */
@Module({
  controllers: [ExportsController],
  providers: [ExportsService, ExportsRepository],
  exports: [ExportsService],
})
export class ExportsModule {}
