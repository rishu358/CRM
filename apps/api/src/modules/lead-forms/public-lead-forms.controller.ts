import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  publicFormParamsSchema,
  publicFormQuerySchema,
  type PublicFormParams,
} from '@crm/contracts';
import { DomainError, ErrorCode } from '@crm/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../auth/auth.guard.js';
import { parseIdempotencyKey } from '../../common/idempotency.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { PublicLeadFormsService } from './public-lead-forms.service.js';

/** The one content type a submission may carry. A form-encoded or text body is refused, never parsed. */
const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

/**
 * `/api/v1/public/forms` (ADR-0065): **the only routes in the API a stranger reaches.**
 *
 * Each handler is marked `@Public()` one by one (the decorator is method-only on purpose), and a test
 * keeps the set of public routes to a frozen list. What is true of both of them:
 *
 *  - no cookie is read and none is set, and `Authorization` and `X-Tenant-Id` are ignored: the key in
 *    the path is the only thing that selects a workspace;
 *  - no CORS approval is given (the bootstrap answers none under `/api/v1/public/`), so a page on
 *    another site cannot make a visitor's browser use these routes in any way that matters;
 *  - the query string must be empty, and every answer is `no-store`, so a disabled form stops working
 *    at once and nothing here is kept by a cache.
 */
@Controller('public/forms')
export class PublicLeadFormsController {
  constructor(@Inject(PublicLeadFormsService) private readonly forms: PublicLeadFormsService) {}

  @Get(':key')
  @Public()
  async definition(
    @Param(zodPipe(publicFormParamsSchema)) params: PublicFormParams,
    @Query(zodPipe(publicFormQuerySchema)) _query: Record<string, never>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    return { data: await this.forms.definition(params.key, request.ip) };
  }

  @Post(':key/submissions')
  @Public()
  @HttpCode(201)
  async submit(
    @Param(zodPipe(publicFormParamsSchema)) params: PublicFormParams,
    @Query(zodPipe(publicFormQuerySchema)) _query: Record<string, never>,
    @Body() body: unknown,
    @Headers('content-type') contentType: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    if (contentType === undefined || !JSON_CONTENT_TYPE.test(contentType)) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'That content type is not accepted', 415);
    }
    return {
      data: await this.forms.submit({
        key: params.key,
        address: request.ip,
        body,
        idempotencyKey: parseIdempotencyKey(idempotencyKey),
      }),
    };
  }
}
