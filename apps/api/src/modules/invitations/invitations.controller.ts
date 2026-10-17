import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  invitationAcceptQuerySchema,
  invitationAcceptSchema,
  invitationCreateSchema,
  invitationListQuerySchema,
  invitationParamsSchema,
  type InvitationAcceptInput,
  type InvitationAcceptQuery,
  type InvitationCreateInput,
  type InvitationListQuery,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { API_ENV_TOKEN, type ApiEnv } from '../../config/env.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { AuthRateLimitGuard } from '../../auth/auth-rate-limit.guard.js';
import { CurrentActor, Public, extractSessionToken } from '../../auth/auth.guard.js';
import { SessionService } from '../../auth/session.service.js';
import { InvitationsService } from './invitations.service.js';

/**
 * `/api/v1/invitations` (ADR-0007).
 *
 * Same shape as every other controller: validate with Zod, call the service,
 * wrap in the envelope. Two things here are unlike the contacts template, and
 * both are deliberate.
 *
 * **The acceptance routes are `@Public()`** — they have to be reachable by
 * somebody who has no account yet. They are not unauthenticated, though: the
 * token in the link *is* the credential, and it is checked against the
 * invitation's own row (ADR-0019).
 *
 * **They still look for a session.** Acceptance behaves differently when the
 * recipient is already signed in, so the session is resolved by hand rather
 * than by the guard, which would have refused the request before the handler
 * ever ran. `AuthRateLimitGuard` covers the public routes for the same reason
 * it covers sign-in: a link with a secret in it is something worth guessing at,
 * and these two are the only routes in the module with no user to key a limit
 * on.
 */
@Controller('invitations')
@UseGuards(AuthRateLimitGuard)
export class InvitationsController {
  constructor(
    @Inject(InvitationsService) private readonly invitations: InvitationsService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  // -------------------------------------------------------------------------
  // Acceptance. Declared before `:id` so Nest does not read "accept" as one.
  // -------------------------------------------------------------------------

  /** What this link is for, without consuming it. */
  @Get('accept')
  @Public()
  async preview(
    @Req() request: FastifyRequest,
    @Query(zodPipe(invitationAcceptQuerySchema)) query: InvitationAcceptQuery,
  ) {
    const session = await this.currentSession(request);
    return { data: await this.invitations.preview(query.token, session?.userId ?? null) };
  }

  /**
   * Accept, and — only when an account had to be created — sign in.
   *
   * The cookie is set here for the same reason sign-in sets it at the edge: a
   * token the page can read is a token `localStorage` ends up holding. It is
   * also returned in the body, because the public API and the test harness
   * have no cookie jar.
   */
  @Post('accept')
  @Public()
  @HttpCode(200)
  async accept(
    @Req() request: FastifyRequest,
    @Body(zodPipe(invitationAcceptSchema)) body: InvitationAcceptInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const session = await this.currentSession(request);
    const result = await this.invitations.accept(body, session);

    if (result.token !== undefined) {
      void reply.setCookie(this.env.SESSION_COOKIE_NAME, result.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: this.env.NODE_ENV === 'production',
        path: '/',
        maxAge: this.env.SESSION_TTL_DAYS * 24 * 60 * 60,
      });
    }

    return { data: result };
  }

  // -------------------------------------------------------------------------
  // Administration
  // -------------------------------------------------------------------------

  /** Declared before `:id` so the router does not read "roles" as an id. */
  @Get('roles')
  async roles(@CurrentActor() actor: Actor) {
    return { data: await this.invitations.assignableRoles(actor) };
  }

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(invitationListQuerySchema)) query: InvitationListQuery,
  ) {
    return this.invitations.list(actor, query);
  }

  @Post()
  @HttpCode(201)
  async invite(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(invitationCreateSchema)) body: InvitationCreateInput,
  ) {
    return { data: await this.invitations.invite(actor, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(
    @CurrentActor() actor: Actor,
    @Param(zodPipe(invitationParamsSchema)) params: { id: string },
  ): Promise<void> {
    await this.invitations.revoke(actor, params.id);
  }

  /**
   * Who is signed in, if anyone, on a route the guard does not protect.
   *
   * A bad or expired token is treated as no session rather than as an error:
   * somebody whose session has lapsed is in the same position as somebody who
   * never had one, and refusing them would strand a recipient behind a cookie
   * they cannot see or clear.
   */
  private async currentSession(
    request: FastifyRequest,
  ): Promise<{ userId: string; sessionId: string } | null> {
    const token = extractSessionToken(request, this.env.SESSION_COOKIE_NAME);
    if (token === null) return null;

    const session = await this.sessions.verify(token);
    return session === null ? null : { userId: session.userId, sessionId: session.sessionId };
  }
}
