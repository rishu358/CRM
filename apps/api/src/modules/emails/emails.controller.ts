import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  emailContextQuerySchema,
  emailListQuerySchema,
  emailParamsSchema,
  emailSendSchema,
  emailSettingsUpdateSchema,
  type EmailContextQuery,
  type EmailListQuery,
  type EmailSendInput,
  type EmailSettingsUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { parseIdempotencyKey } from '../../common/idempotency.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { EmailSettingsService } from './email-settings.service.js';
import { EmailsService } from './emails.service.js';

/**
 * `/api/v1/emails` (ADR-0007, ADR-0073).
 *
 * Validate with Zod, hand off to the service, wrap the result in the envelope. Who may send, which
 * records, and the recipient are all decided in the service.
 */
@Controller('emails')
export class EmailsController {
  constructor(@Inject(EmailsService) private readonly emails: EmailsService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(emailListQuerySchema)) query: EmailListQuery,
  ) {
    return this.emails.list(actor, query);
  }

  /** Declared before `:id` so `context` is never read as an id. */
  @Get('context')
  async context(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(emailContextQuerySchema)) query: EmailContextQuery,
  ) {
    return { data: await this.emails.context(actor, query) };
  }

  @Get(':id')
  async getById(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(emailParamsSchema)) params: { id: string },
  ) {
    return { data: await this.emails.getById(actor, params.id) };
  }

  /** 202: the email is queued, and the worker sends it. */
  @Post()
  @HttpCode(202)
  async send(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(emailSendSchema)) body: EmailSendInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return { data: await this.emails.send(actor, body, parseIdempotencyKey(idempotencyKey)) };
  }

  @Post(':id/retry')
  @HttpCode(202)
  async retry(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(emailParamsSchema)) params: { id: string },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return { data: await this.emails.retry(actor, params.id, parseIdempotencyKey(idempotencyKey)) };
  }
}

/** `/api/v1/email-settings`: the company's sender. */
@Controller('email-settings')
export class EmailSettingsController {
  constructor(@Inject(EmailSettingsService) private readonly settings: EmailSettingsService) {}

  @Get()
  async get(@CurrentActor() actor: Actor) {
    return { data: await this.settings.get(actor) };
  }

  @Patch()
  async save(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(emailSettingsUpdateSchema)) body: EmailSettingsUpdateInput,
  ) {
    return { data: await this.settings.save(actor, body) };
  }
}
