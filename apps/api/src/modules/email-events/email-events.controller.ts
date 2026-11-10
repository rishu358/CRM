import { Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { emailEventParamsSchema, type EmailEventParams } from '@crm/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../auth/auth.guard.js';
import { rawBodyOf } from '../../common/public-routes.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { EmailEventsService } from './email-events.service.js';

/**
 * `/api/v1/public/email-events/{provider}` (ADR-0075): where the mail service reports what happened to an
 * email. It is **not** called by people, and it takes no session, no cookie and no tenant or user id: the
 * signature is the credential, and the company is found from a database row, never from the request.
 *
 * The handler is marked `@Public()` on its own, as the lead form's are, and the set of public routes is a
 * frozen list in a test. The answer is `no-store` and has no body.
 */
@Controller('public/email-events')
export class EmailEventsController {
  constructor(@Inject(EmailEventsService) private readonly events: EmailEventsService) {}

  @Post(':provider')
  @Public()
  @HttpCode(204)
  async receive(
    @Param(zodPipe(emailEventParamsSchema)) params: EmailEventParams,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    void reply.header('cache-control', 'no-store');
    await this.events.receive(params.provider, request.headers, rawBodyOf(request));
  }
}
