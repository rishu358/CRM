import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Body,
} from '@nestjs/common';
import {
  attachmentCreateSchema,
  attachmentListQuerySchema,
  attachmentParamsSchema,
  type AttachmentCreateInput,
  type AttachmentListQuery,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { AttachmentsService } from './attachments.service.js';

/**
 * `/api/v1/attachments` (ADR-0007, ADR-0035).
 *
 * Validate with Zod, hand off to the service, wrap the result in the response
 * envelope — and nothing else. There is no endpoint here that accepts a file:
 * create returns a presigned PUT and the bytes go straight to the object store
 * (CLAUDE.md §5.12). There is no PATCH either, because an attachment is
 * immutable; a new version of a document is a new attachment.
 */
@Controller('attachments')
export class AttachmentsController {
  constructor(@Inject(AttachmentsService) private readonly attachments: AttachmentsService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(attachmentListQuerySchema)) query: AttachmentListQuery,
  ) {
    return this.attachments.list(actor, query);
  }

  @Get(':id')
  async getById(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(attachmentParamsSchema)) params: { id: string },
  ) {
    return { data: await this.attachments.getById(actor, params.id) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(attachmentCreateSchema)) body: AttachmentCreateInput,
  ) {
    return { data: await this.attachments.create(actor, body) };
  }

  @Post(':id/uploaded')
  @HttpCode(202)
  async confirmUploaded(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(attachmentParamsSchema)) params: { id: string },
  ) {
    return { data: await this.attachments.confirmUploaded(actor, params.id) };
  }

  /**
   * A POST because handing out the link is the moment the file leaves, and
   * that is the thing being audited — a GET would be cached, prefetched and
   * replayed by things that are not the user.
   */
  @Post(':id/download')
  @HttpCode(200)
  async downloadLink(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(attachmentParamsSchema)) params: { id: string },
  ) {
    return { data: await this.attachments.downloadLink(actor, params.id) };
  }

  /** No `version`: an attachment cannot be edited, so nothing can be stale. */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(attachmentParamsSchema)) params: { id: string },
  ): Promise<void> {
    await this.attachments.remove(actor, params.id);
  }
}
