import { Module } from '@nestjs/common';
import { PipelinesController } from './pipelines.controller.js';
import { PipelinesRepository } from './pipelines.repository.js';
import { PipelinesService } from './pipelines.service.js';

/**
 * The pipelines module (ADR-0001).
 *
 * The repository is **not** exported. Deals reach pipelines through
 * `PipelinesService`, never through its repository or its tables.
 */
@Module({
  controllers: [PipelinesController],
  providers: [PipelinesService, PipelinesRepository],
  exports: [PipelinesService],
})
export class PipelinesModule {}
