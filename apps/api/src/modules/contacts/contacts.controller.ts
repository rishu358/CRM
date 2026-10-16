import {
  Body,
  Controller,
  Delete,
  Get,
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
  contactListQuerySchema,
  contactParamsSchema,
  contactUpdateSchema,
  type ContactCreateInput,
  type ContactDeleteQuery,
  type ContactListQuery,
  type ContactUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
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

  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(contactCreateSchema)) body: ContactCreateInput,
  ) {
    return { data: await this.contacts.create(actor, body) };
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
