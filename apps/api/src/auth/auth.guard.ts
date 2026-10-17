import {
  Inject,
  Injectable,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { MfaEnrolmentRequiredError, UnauthenticatedError, isUuid, type Actor } from '@crm/core';
import type { FastifyRequest } from 'fastify';
import { API_ENV_TOKEN } from '../config/env.js';
import type { ApiEnv } from '../config/env.js';
import { TenantRateLimitService } from '../platform/rate-limit.service.js';
import { ActorService } from './actor.service.js';
import { AuthRepository } from './auth.repository.js';
import { MfaService } from './mfa.service.js';
import { SessionService } from './session.service.js';
import { mfaRequiredFor } from './tenant-settings.js';

/**
 * Authenticate the request and attach the resolved Actor.
 *
 * Applied globally, so a route is protected unless it explicitly opts out with
 * `@Public()`. The default is the safe one: a new controller added by someone
 * who forgets the decorator is authenticated, not open (CLAUDE.md §5.3).
 */
export const PUBLIC_ROUTE_KEY = 'crm:public-route';

/**
 * Routes that stay reachable in a workspace that requires MFA but where the
 * user has not enrolled yet.
 *
 * Without this, switching the requirement on would lock out every member who
 * had not already enrolled — including the administrator who switched it on —
 * because the enrolment endpoints would be blocked by the rule they exist to
 * satisfy.
 */
export const SKIP_MFA_KEY = 'crm:skip-mfa-check';

export interface AuthenticatedRequest extends FastifyRequest {
  actor?: Actor;
  sessionId?: string;
}

/**
 * Pull the session token off a request: cookie first, bearer second.
 *
 * Exported because one route genuinely needs an *optional* session. Accepting
 * an invitation is reachable both signed out (a new account is created) and
 * signed in (the membership is linked to the existing one), so it cannot sit
 * behind the guard — and must still be able to see who is signed in
 * (ADR-0019). Sharing this function rather than copying three lines keeps the
 * two paths from drifting over which credential wins.
 */
export function extractSessionToken(request: FastifyRequest, cookieName: string): string | null {
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> })
    .cookies;
  const fromCookie = cookies?.[cookieName];
  if (typeof fromCookie === 'string' && fromCookie.length > 0) return fromCookie;

  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const value = header.slice('Bearer '.length).trim();
    if (value.length > 0) return value;
  }
  return null;
}

/** Inject the Actor into a handler parameter. */
export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (request.actor === undefined) {
    // Reachable only if a route skipped the guard; failing loudly beats
    // handing a controller an undefined actor it might not check.
    throw new UnauthenticatedError();
  }
  return request.actor;
});

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ActorService) private readonly actors: ActorService,
    @Inject(TenantRateLimitService) private readonly tenantLimit: TenantRateLimitService,
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(AuthRepository) private readonly repository: AuthRepository,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler() as {
      [PUBLIC_ROUTE_KEY]?: boolean;
      [SKIP_MFA_KEY]?: boolean;
    };
    const controller = context.getClass() as {
      [PUBLIC_ROUTE_KEY]?: boolean;
      [SKIP_MFA_KEY]?: boolean;
    };
    if (handler[PUBLIC_ROUTE_KEY] === true || controller[PUBLIC_ROUTE_KEY] === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);
    if (token === null) throw new UnauthenticatedError();

    const session = await this.sessions.verify(token);
    if (session === null) throw new UnauthenticatedError();

    const tenantId = this.resolveTenantId(request, session.activeTenantId);
    if (tenantId === null) throw new UnauthenticatedError('No workspace selected');

    // resolveActor checks membership, so a header-supplied tenant is only ever
    // accepted for a tenant this user actually belongs to.
    const actor = await this.actors.resolve(session.userId, tenantId);

    // Counted against the tenant membership proved, not the header the client
    // sent, so one caller cannot exhaust another workspace's budget.
    this.tenantLimit.check(actor.tenantId);

    // MFA enforcement (MVP_SPEC M1 acceptance): a workspace with "MFA
    // required" blocks access until the user enrols. Checked here rather than
    // per controller so a new module cannot forget it, and after the actor is
    // resolved because the requirement belongs to the tenant, not the user —
    // the same person may be required to use MFA in one workspace and not in
    // another.
    const skipMfa = handler[SKIP_MFA_KEY] === true || controller[SKIP_MFA_KEY] === true;
    if (!skipMfa && (await this.mfaOutstanding(actor))) {
      throw new MfaEnrolmentRequiredError();
    }

    request.actor = actor;
    request.sessionId = session.sessionId;

    // Last-seen powers the "your devices" list. Deliberately not awaited: it
    // is write-behind bookkeeping, it is rate-limited in SQL to one update a
    // minute, and a request must not fail or wait because of it.
    void this.repository.touchSession(session.sessionId).catch(() => undefined);

    return true;
  }

  /** Does this workspace require a second factor this user has not enrolled? */
  private async mfaOutstanding(actor: Actor): Promise<boolean> {
    const memberships = await this.repository.listMemberships(actor.userId);
    const active = memberships.find((row) => row.tenant_id === actor.tenantId);
    if (active === undefined || !mfaRequiredFor(active.settings)) return false;
    return !(await this.mfa.isEnrolled(actor.userId));
  }

  /**
   * Cookie first, bearer token second.
   *
   * The browser uses an httpOnly cookie (CLAUDE.md §5.9) so that script on the
   * page cannot read it. The bearer header exists for the public API and for
   * tests, where there is no cookie jar.
   */
  private extractToken(request: FastifyRequest): string | null {
    return extractSessionToken(request, this.env.SESSION_COOKIE_NAME);
  }

  /**
   * Which workspace this request is for.
   *
   * A user may belong to several tenants (agencies, consultants), so the client
   * may name one with `X-Tenant-Id`. That is a *request*, not an authorization:
   * membership is verified in `ActorService.resolve`, and a tenant the user does
   * not belong to is refused there.
   */
  private resolveTenantId(request: FastifyRequest, sessionTenantId: string | null): string | null {
    const header = request.headers['x-tenant-id'];
    const requested = Array.isArray(header) ? header[0] : header;
    if (typeof requested === 'string' && isUuid(requested)) return requested;
    return sessionTenantId;
  }
}

/**
 * Inject the current session's id into a handler parameter.
 *
 * Needed by anything that must distinguish "this device" from the others —
 * the session list, sign-out, and the password change that keeps the caller
 * signed in while revoking everyone else.
 */
export const CurrentSessionId = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.sessionId === undefined) throw new UnauthenticatedError();
    return request.sessionId;
  },
);

/**
 * Keep a route reachable for a user who has not yet enrolled in MFA that
 * their workspace requires. Only for the routes that let them enrol, sign out
 * or read their own profile.
 */
export function SkipMfaCheck() {
  return <T>(
    _target: object,
    _key: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    const handler = descriptor.value as Record<string, unknown> | undefined;
    if (handler !== undefined) handler[SKIP_MFA_KEY] = true;
  };
}

/**
 * Opt a route out of authentication. Use sparingly and deliberately.
 *
 * Marks the handler function itself, which is what the guard reads via
 * `context.getHandler()`. Deliberately method-only: making a whole controller
 * public is the kind of thing that should be visible on every route it affects.
 */
export function Public() {
  return <T>(
    _target: object,
    _key: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    const handler = descriptor.value as Record<string, unknown> | undefined;
    if (handler !== undefined) handler[PUBLIC_ROUTE_KEY] = true;
  };
}
