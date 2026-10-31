import { Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import {
  emailUnsubscribeParamsSchema,
  emailUnsubscribeQuerySchema,
  type EmailUnsubscribeParams,
} from '@crm/contracts';
import type { FastifyReply } from 'fastify';
import { Public } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { EmailUnsubscribeService } from './email-unsubscribe.service.js';

/**
 * `/api/v1/public/email-unsubscribe/{token}` (ADR-0076): the link at the foot of every email.
 *
 * Two handlers, each marked `@Public()` on its own as the lead form's are, both on the frozen list of public
 * routes. Neither reads a cookie or a credential, and the company is never taken from the request: the signed
 * token names an email, and the email names the company.
 *
 *  - **GET** says whose email it is and changes nothing, because mail scanners open every link in a message;
 *  - **POST** does it. It is the address a mail program posts to for its own "unsubscribe" button (RFC 8058),
 *    and the one the web page's button posts to. The body (`List-Unsubscribe=One-Click`) is never read.
 *
 * Every answer is `no-store`.
 */
@Controller('public/email-unsubscribe')
export class EmailUnsubscribeController {
  constructor(
    @Inject(EmailUnsubscribeService) private readonly unsubscribes: EmailUnsubscribeService,
  ) {}

  @Get(':token')
  @Public()
  async page(
    @Param(zodPipe(emailUnsubscribeParamsSchema)) params: EmailUnsubscribeParams,
    @Query(zodPipe(emailUnsubscribeQuerySchema)) _query: Record<string, never>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    return { data: await this.unsubscribes.page(params.token) };
  }

  @Post(':token')
  @Public()
  @HttpCode(204)
  async unsubscribe(
    @Param(zodPipe(emailUnsubscribeParamsSchema)) params: EmailUnsubscribeParams,
    @Query(zodPipe(emailUnsubscribeQuerySchema)) _query: Record<string, never>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    void reply.header('cache-control', 'no-store');
    await this.unsubscribes.unsubscribe(params.token);
  }
}
