import { Module } from '@nestjs/common';
import { CustomizationController } from './customization.controller.js';
import { CustomizationRepository } from './customization.repository.js';
import { CustomizationService } from './customization.service.js';

/**
 * Custom fields and picklists (MVP_SPEC M9, ADR-0039).
 *
 * Owns writes to `field_definitions`; everything else reads them through
 * `FieldMetadataService`. The repository is not exported, like every other module's.
 */
@Module({
  controllers: [CustomizationController],
  providers: [CustomizationRepository, CustomizationService],
})
export class CustomizationModule {}
