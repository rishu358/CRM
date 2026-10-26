import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Patch,
  Query,
} from '@nestjs/common';
import {
  contactCreateSchema,
  contactDeleteQuerySchema,
  contactDuplicateCheckSchema,
  contactListQuerySchema,
  contactParamsSchema,
  contactUpdateSchema,
  type ContactCreateInput,
  type ContactDeleteQuery,
  type ContactDuplicateCheckInput,
  type ContactListQuery,
  type ContactUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { parseIdempotencyKey } from '../../common/idempotency.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { ContactsService } from './contacts.service.js';

/**
 * `/api/v1/contacts` (ADR-0007).
 *
 * The controller does three things and nothing else: validate with Zod, hand
 * off to the service, wrap the result in the response envelope. Authorization,
 * tenancy and field permissions all live in the service and the serializer, so
 * the public API and a future mobile client get them for free rather than
 * depending on a controller remembering to check.
 */
@Controller('contacts')
export class ContactsController {
  constructor(@Inject(ContactsService) private readonly contacts: ContactsService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(contactListQuerySchema)) query: ContactListQuery,
  ) {
    return this.contacts.list(actor, query);
  }

  @Get(':id')
  async getById(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(contactParamsSchema)) params: { id: string },
  ) {
    return { data: await this.contacts.getById(actor, params.id) };
  }

  /**
   * "Would this contact duplicate something?", asked before it is saved.
   *
   * A POST because the question carries an email address and a phone number, which do not belong in
   * a URL (CLAUDE.md §5.8). Nothing is written (ADR-0023).
   */
  @Post('duplicate-check')
  @HttpCode(200)
  async checkDuplicates(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(contactDuplicateCheckSchema)) body: ContactDuplicateCheckInput,
  ) {
    return { data: await this.contacts.checkDuplicates(actor, body) };
  }

  /** Created whatever it matches: duplicates are reported in `meta`, never a reason to refuse. */
  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(contactCreateSchema)) body: ContactCreateInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const { contact, duplicates } = await this.contacts.createWithDuplicates(
      actor,
      body,
      parseIdempotencyKey(idempotencyKey),
    );
    return { data: contact, meta: { duplicates } };
  }

  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(contactParamsSchema)) params: { id: string },
    @Body(zodPipe(contactUpdateSchema)) body: ContactUpdateInput,
  ) {
    return { data: await this.contacts.update(actor, params.id, body) };
  }

  /**
   * Soft delete. The version is required for the same reason it is on PATCH:
   * deleting a record someone else has just edited should fail loudly.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(contactParamsSchema)) params: { id: string },
    @Query(zodPipe(contactDeleteQuerySchema)) query: ContactDeleteQuery,
  ): Promise<void> {
    await this.contacts.remove(actor, params.id, query.version);
  }
}
