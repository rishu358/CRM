import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller.js';
import { OnboardingRepository } from './onboarding.repository.js';
import { OnboardingService } from './onboarding.service.js';

/**
 * Company setup, the setup checklist and sample data (MVP_SPEC M2, ADR-0037).
 *
 * The repository is not exported, like every other module's. What this module
 * does not do is write another module's tables: sample data is created by a
 * single transactional function in `@crm/db` (the same arrangement as
 * `provisionTenantDefaults`), and removing it is the worker's job.
 */
@Module({
  controllers: [OnboardingController],
  providers: [OnboardingRepository, OnboardingService],
})
export class OnboardingModule {}
