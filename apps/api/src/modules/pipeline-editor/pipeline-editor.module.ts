import { Module } from '@nestjs/common';
import { DealsModule } from '../deals/deals.module.js';
import { PipelinesModule } from '../pipelines/pipelines.module.js';
import { PipelineEditorController } from './pipeline-editor.controller.js';
import { PipelineEditorService } from './pipeline-editor.service.js';

/**
 * The pipeline and stage editor (ADR-0001, ADR-0062).
 *
 * Its own module because it needs the pipelines (to edit them) and the deals (to count what a stage
 * holds and to move deals out of a stage being retired), and the deals module already imports the
 * pipelines module. It reaches both through their services, never their repositories.
 */
@Module({
  imports: [PipelinesModule, DealsModule],
  controllers: [PipelineEditorController],
  providers: [PipelineEditorService],
})
export class PipelineEditorModule {}
