import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  mfaActivateSchema,
  mfaDisableSchema,
  mfaVerifySchema,
  resendVerificationSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
  verifyEmailSchema,
  type ChangePasswordInput,
  type ForgotPasswordInput,
  type MfaActivateInput,
  type MfaDisableInput,
  type MfaVerifyInput,
  type ResendVerificationInput,
  type ResetPasswordInput,
  type SignInInput,
  type SignUpInput,
  type VerifyEmailInput,
} from '@crm/contracts';
import { InvalidCredentialsError, NotFoundError, type Actor } from '@crm/core';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { API_ENV_TOKEN, type ApiEnv } from '../config/env.js';
import { zodPipe } from '../common/zod-validation.pipe.js';
import { currentRequestContext } from '../common/request-context.js';
import { AuthRateLimitGuard } from './auth-rate-limit.guard.js';
import { AuthService } from './auth.service.js';
import { CurrentActor, CurrentSessionId, Public, SkipMfaCheck } from './auth.guard.js';
import {
  GoogleAuthService,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
} from './google.service.js';
import { MfaService } from './mfa.service.js';
import { PASSWORD_HASHER, type PasswordHasher } from './crypto/password.hasher.js';
import { AuthRepository } from './auth.repository.js';

/**
 * `/api/v1/auth` (ADR-0007).
 *
 * Same shape as every other controller: validate with Zod, call the service,
 * wrap in the envelope. The one thing it does that others do not is set the
 * session cookie, because that is a transport concern and belongs at the edge
 * rather than in a service that the public API also calls.
 *
 * ## Which routes are `@Public()`
 *
 * Only the ones that cannot have a session yet: sign-up, sign-in, the MFA
 * second step, email verification, and the password-reset pair. Everything
 * else is authenticated, because `AuthGuard` is global and the default is
 * protected (CLAUDE.md §5.3).
 *
 * `AuthRateLimitGuard` sits on the whole controller but only bites on the
 * `@Public()` routes — the ones with no user to key a limit on.
 *
 * The enrolment routes are authenticated **and** `@SkipMfaCheck()`: a
 * workspace that requires MFA blocks every other route until the user has
 * enrolled, so the routes that let them enrol must stay reachable. Without
 * that exemption, turning on the requirement would lock out everyone who had
 * not already enrolled, with no way back in.
 */
const sessionQuerySchema = z.object({ id: z.uuid() }).strict();
const googleCallbackSchema = z
  .object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(512) })
  .strict();

@Controller('auth')
@UseGuards(AuthRateLimitGuard)
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(GoogleAuthService) private readonly googleAuth: GoogleAuthService,
    @Inject(AuthRepository) private readonly repository: AuthRepository,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  // -------------------------------------------------------------------------
  // Registration and verification
  // -------------------------------------------------------------------------

  @Post('sign-up')
  @Public()
  @HttpCode(202)
  async signUp(@Body(zodPipe(signUpSchema)) body: SignUpInput) {
    return { data: await this.auth.signUp(body) };
  }

  @Post('resend-verification')
  @Public()
  @HttpCode(202)
  async resendVerification(@Body(zodPipe(resendVerificationSchema)) body: ResendVerificationInput) {
    return { data: await this.auth.resendVerification(body.email) };
  }

  @Post('verify-email')
  @Public()
  @HttpCode(204)
  async verifyEmail(@Body(zodPipe(verifyEmailSchema)) body: VerifyEmailInput): Promise<void> {
    await this.auth.verifyEmail(body.token);
  }

  // -------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------

  @Post('sign-in')
  @Public()
  @HttpCode(200)
  async signIn(
    @Body(zodPipe(signInSchema)) body: SignInInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const context = currentRequestContext();
    const result = await this.auth.signIn(body, {
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
    });
    return { data: this.applySession(reply, result) };
  }

  @Post('mfa/verify')
  @Public()
  @HttpCode(200)
  async verifyMfa(
    @Body(zodPipe(mfaVerifySchema)) body: MfaVerifyInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const context = currentRequestContext();
    const result = await this.auth.verifyMfaChallenge(body, {
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
    });
    return { data: this.applySession(reply, result) };
  }

  @Post('sign-out')
  @HttpCode(204)
  @SkipMfaCheck()
  async signOut(
    @CurrentActor() actor: Actor,
    @CurrentSessionId() sessionId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.signOut(actor, sessionId);
    void reply.clearCookie(this.env.SESSION_COOKIE_NAME, { path: '/' });
  }

  // -------------------------------------------------------------------------
  // Passwords
  // -------------------------------------------------------------------------

  @Post('forgot-password')
  @Public()
  @HttpCode(202)
  async forgotPassword(@Body(zodPipe(forgotPasswordSchema)) body: ForgotPasswordInput) {
    return { data: await this.auth.forgotPassword(body.email) };
  }

  @Post('reset-password')
  @Public()
  @HttpCode(204)
  async resetPassword(@Body(zodPipe(resetPasswordSchema)) body: ResetPasswordInput): Promise<void> {
    await this.auth.resetPassword(body.token, body.password);
  }

  /**
   * Returns the replacement session, like sign-in does.
   *
   * The change invalidates every session issued before it, this one included,
   * so the response has to hand back the one that replaces it — in the cookie
   * for a browser, and in the body for everything else. A 204 here would sign
   * the caller out of the device they are standing at.
   */
  @Post('change-password')
  @HttpCode(200)
  @SkipMfaCheck()
  async changePassword(
    @CurrentActor() actor: Actor,
    @CurrentSessionId() sessionId: string,
    @Body(zodPipe(changePasswordSchema)) body: ChangePasswordInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { token } = await this.auth.changePassword(actor, sessionId, body);
    this.setSessionCookie(reply, token);
    return { data: { status: 'signed_in', token, tenantId: actor.tenantId } };
  }

  // -------------------------------------------------------------------------
  // Profile and sessions
  // -------------------------------------------------------------------------

  @Get('me')
  @SkipMfaCheck()
  async me(@CurrentActor() actor: Actor) {
    return { data: await this.auth.currentUser(actor) };
  }

  @Get('sessions')
  async sessions(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string) {
    return { data: await this.auth.listSessions(actor, sessionId) };
  }

  /** "Sign out other devices" (MVP_SPEC M1). The caller stays signed in. */
  @Delete('sessions/others')
  async signOutOthers(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string) {
    const revoked = await this.auth.signOutOtherSessions(actor, sessionId);
    return { data: { revoked } };
  }

  @Delete('sessions')
  @HttpCode(204)
  async revokeSession(
    @CurrentActor() actor: Actor,
    @Query(zodPipe(sessionQuerySchema)) query: { id: string },
  ): Promise<void> {
    // 404 rather than 403 for a session that is not theirs: a 403 would
    // confirm the id names a real session belonging to somebody else
    // (CLAUDE.md §5.5).
    if (!(await this.auth.revokeSession(actor, query.id))) throw new NotFoundError('Session');
  }

  // -------------------------------------------------------------------------
  // MFA
  // -------------------------------------------------------------------------

  @Post('mfa/enroll')
  @SkipMfaCheck()
  async enrollMfa(@CurrentActor() actor: Actor) {
    const user = await this.repository.findUserById(actor.userId);
    if (user === null) throw new InvalidCredentialsError();
    return { data: await this.mfa.begin(actor.userId, user.email) };
  }

  @Post('mfa/activate')
  @HttpCode(204)
  @SkipMfaCheck()
  async activateMfa(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(mfaActivateSchema)) body: MfaActivateInput,
  ): Promise<void> {
    await this.mfa.activate(actor.userId, body.code);
  }

  @Get('mfa')
  @SkipMfaCheck()
  async mfaStatus(@CurrentActor() actor: Actor) {
    return {
      data: {
        enrolled: await this.mfa.isEnrolled(actor.userId),
        backupCodesRemaining: await this.mfa.remainingBackupCodes(actor.userId),
      },
    };
  }

  /**
   * Turn MFA off. Requires the password, not just the session.
   *
   * Removing a second factor with nothing but a stolen session cookie would
   * make the second factor worth very little — the whole point is that it
   * survives a compromised session.
   *
   * A POST rather than a DELETE because it carries a body. Bodies on DELETE
   * are poorly supported all the way along the path — the web app's own proxy
   * drops them, which is how this was found — and an endpoint that silently
   * loses the credential it is meant to check is not one to leave in place.
   */
  @Post('mfa/disable')
  @HttpCode(204)
  async disableMfa(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(mfaDisableSchema)) body: MfaDisableInput,
  ): Promise<void> {
    const credential = await this.repository.findCredential(actor.userId, 'credential');
    const hash = credential?.password_hash ?? null;
    if (hash === null || !(await this.passwords.verify(hash, body.password))) {
      throw new InvalidCredentialsError();
    }
    await this.mfa.disable(actor.userId);
  }

  // -------------------------------------------------------------------------
  // Google
  // -------------------------------------------------------------------------

  @Get('google')
  @Public()
  @HttpCode(302)
  async googleStart(@Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    const { url, stateCookie } = await this.googleAuth.start();
    void reply.setCookie(OAUTH_STATE_COOKIE, stateCookie, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.env.NODE_ENV === 'production',
      path: '/',
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });
    void reply.redirect(url, 302);
  }

  @Get('google/callback')
  @Public()
  async googleCallback(
    @Query(zodPipe(googleCallbackSchema)) query: { code: string; state: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const cookies = (reply.request as { cookies?: Record<string, string | undefined> }).cookies;
    const stateCookie = cookies?.[OAUTH_STATE_COOKIE] ?? '';
    void reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });

    const identity = await this.googleAuth.complete({ ...query, stateCookie });
    const { userId } = await this.googleAuth.resolveUser(identity);
    const token = await this.auth.completeSocialSignIn(userId);

    this.setSessionCookie(reply, token);
    // Back to the app, not to a JSON body: this endpoint is reached by a
    // browser redirect, so the only sensible response is another redirect.
    void reply.redirect(`${this.env.WEB_URL}/contacts`, 302);
  }

  // -------------------------------------------------------------------------
  // Cookie handling
  // -------------------------------------------------------------------------

  /**
   * Put the session in an httpOnly cookie and keep it out of the body.
   *
   * The token is also returned in the body, because the public API and the
   * test harness have no cookie jar. The web app ignores it and relies on the
   * cookie, so the token never reaches JavaScript there — which is the point:
   * a token the page can read is a token `localStorage` ends up holding, and
   * that is where XSS goes shopping.
   */
  private applySession<T extends { status: string }>(reply: FastifyReply, result: T): T {
    if (result.status !== 'signed_in') return result;
    const withToken = result as T & { token?: string };
    if (typeof withToken.token === 'string') {
      this.setSessionCookie(reply, withToken.token);
    }
    return result;
  }

  private setSessionCookie(reply: FastifyReply, token: string): void {
    void reply.setCookie(this.env.SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.env.NODE_ENV === 'production',
      path: '/',
      maxAge: this.env.SESSION_TTL_DAYS * 24 * 60 * 60,
    });
  }
}
