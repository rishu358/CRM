import { Module } from '@nestjs/common';
import { TagsController } from './tags.controller.js';
import { TagsService } from './tags.service.js';

/**
 * Tags (ADR-0001, ADR-0063).
 *
 * Owns `tags` and `record_tags`. The four record modules import this module and call
 * `TagsService.tagsFor`; none of them reads a tag table. Adding and removing a tag on a record is
 * the bulk module's job (ADR-0056), which keeps its own statements for the same tables in `@crm/db`.
 */
@Module({
  controllers: [TagsController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
