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
  accountCreateSchema,
  accountDuplicateCheckSchema,
  accountDeleteQuerySchema,
  accountListQuerySchema,
  accountParamsSchema,
  accountUpdateSchema,
  type AccountCreateInput,
  type AccountDuplicateCheckInput,
  type AccountDeleteQuery,
  type AccountListQuery,
  type AccountUpdateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { parseIdempotencyKey } from '../../common/idempotency.js';
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

  /**
   * The records this one may duplicate, for the "Possible duplicates" card and its Merge button
   * (ADR-0064). Declared before `:id` only for readability; the paths differ in depth.
   */
  @Get(':id/duplicates')
  async duplicates(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(accountParamsSchema)) params: { id: string },
  ) {
    return { data: await this.accounts.duplicatesOf(actor, params.id) };
  }

  @Get(':id')
  async getById(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(accountParamsSchema)) params: { id: string },
  ) {
    return { data: await this.accounts.getById(actor, params.id) };
  }

  /**
   * "Would this account duplicate something?", asked before it is saved. A POST so the draft stays
   * out of URLs (CLAUDE.md §5.8). Nothing is written (ADR-0023).
   */
  @Post('duplicate-check')
  @HttpCode(200)
  async checkDuplicates(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(accountDuplicateCheckSchema)) body: AccountDuplicateCheckInput,
  ) {
    return { data: await this.accounts.checkDuplicates(actor, body) };
  }

  /** Created whatever it matches: duplicates are reported in `meta`, never a reason to refuse. */
  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(accountCreateSchema)) body: AccountCreateInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const { account, duplicates } = await this.accounts.createWithDuplicates(
      actor,
      body,
      parseIdempotencyKey(idempotencyKey),
    );
    return { data: account, meta: { duplicates } };
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
