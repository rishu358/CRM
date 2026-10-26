import { Module } from '@nestjs/common';
import { SavedViewsController } from './saved-views.controller.js';
import { SavedViewsRepository } from './saved-views.repository.js';
import { SavedViewsService } from './saved-views.service.js';

/**
 * Saved views (ADR-0001, ADR-0056).
 *
 * Owns the `saved_views` table and nothing else. The repository is not exported: a view is
 * applied by the client sending its conditions to an object's own list endpoint, so no other
 * module needs to read one.
 */
@Module({
  controllers: [SavedViewsController],
  providers: [SavedViewsService, SavedViewsRepository],
  exports: [SavedViewsService],
})
export class SavedViewsModule {}
