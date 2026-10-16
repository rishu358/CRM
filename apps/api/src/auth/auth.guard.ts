import {
  Inject,
  Injectable,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { UnauthenticatedError, isUuid, type Actor } from '@crm/core';
import type { FastifyRequest } from 'fastify';
import { API_ENV_TOKEN } from '../config/env.js';
import type { ApiEnv } from '../config/env.js';
import { TenantRateLimitService } from '../platform/rate-limit.service.js';
import { ActorService } from './actor.service.js';
import { SessionService } from './session.service.js';

/**
 * Authenticate the request and attach the resolved Actor.
 *
 * Applied globally, so a route is protected unless it explicitly opts out with
 * `@Public()`. The default is the safe one: a new controller added by someone
 * who forgets the decorator is authenticated, not open (CLAUDE.md §5.3).
 */
export const PUBLIC_ROUTE_KEY = 'crm:public-route';

export interface AuthenticatedRequest extends FastifyRequest {
  actor?: Actor;
  sessionId?: string;
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
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler() as { [PUBLIC_ROUTE_KEY]?: boolean };
    const controller = context.getClass() as { [PUBLIC_ROUTE_KEY]?: boolean };
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

    request.actor = actor;
    request.sessionId = session.sessionId;
    return true;
  }

  /**
   * Cookie first, bearer token second.
   *
   * The browser uses an httpOnly cookie (CLAUDE.md §5.9) so that script on the
   * page cannot read it. The bearer header exists for the public API and for
   * tests, where there is no cookie jar.
   */
  private extractToken(request: FastifyRequest): string | null {
    const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> })
      .cookies;
    const fromCookie = cookies?.[this.env.SESSION_COOKIE_NAME];
    if (typeof fromCookie === 'string' && fromCookie.length > 0) return fromCookie;

    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const value = header.slice('Bearer '.length).trim();
      if (value.length > 0) return value;
    }
    return null;
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
