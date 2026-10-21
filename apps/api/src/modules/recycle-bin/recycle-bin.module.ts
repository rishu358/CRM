import { Module } from '@nestjs/common';
import { RecycleBinController } from './recycle-bin.controller.js';
import { RecycleBinService } from './recycle-bin.service.js';

/**
 * The Recycle Bin (ADR-0001, MVP_SPEC M4).
 *
 * No repository of its own: the statements live in `@crm/db/recycle-bin`
 * because the worker's purge job needs exactly the same ones, and a second copy
 * is how "restore" and "purge" end up disagreeing about which rows are in the
 * Bin.
 */
@Module({
  controllers: [RecycleBinController],
  providers: [RecycleBinService],
  exports: [RecycleBinService],
})
export class RecycleBinModule {}
