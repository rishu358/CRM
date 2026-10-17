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
  accountCreateSchema,
  accountDeleteQuerySchema,
  accountListQuerySchema,
  accountParamsSchema,
  accountUpdateSchema,
  type AccountCreateInput,
  type AccountDeleteQuery,
  type AccountListQuery,
  type AccountUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { AccountsService } from './accounts.service.js';

/**
 * `/api/v1/accounts` (ADR-0007).
 *
 * The controller does three things and nothing else: validate with Zod, hand
 * off to the service, wrap the result in the response envelope. Authorization,
 * tenancy and field permissions all live in the service and the serializer, so
 * the public API and a future mobile client get them for free rather than
 * depending on a controller remembering to check.
 */
@Controller('accounts')
export class AccountsController {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(accountListQuerySchema)) query: AccountListQuery,
  ) {
    return this.accounts.list(actor, query);
  }

  @Get(':id')
  async getById(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(accountParamsSchema)) params: { id: string },
  ) {
    return { data: await this.accounts.getById(actor, params.id) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(accountCreateSchema)) body: AccountCreateInput,
  ) {
    return { data: await this.accounts.create(actor, body) };
  }

  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(accountParamsSchema)) params: { id: string },
    @Body(zodPipe(accountUpdateSchema)) body: AccountUpdateInput,
  ) {
    return { data: await this.accounts.update(actor, params.id, body) };
  }

  /**
   * Soft delete. The version is required for the same reason it is on PATCH:
   * deleting a record someone else has just edited should fail loudly.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(accountParamsSchema)) params: { id: string },
    @Query(zodPipe(accountDeleteQuerySchema)) query: AccountDeleteQuery,
  ): Promise<void> {
    await this.accounts.remove(actor, params.id, query.version);
  }
}
