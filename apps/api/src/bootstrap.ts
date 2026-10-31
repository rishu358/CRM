import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppModule } from './app.module.js';
import { DomainErrorFilter } from './common/domain-error.filter.js';
import { createLogger } from './common/logger.js';
import {
  runWithRequestContext,
  wasIdempotentReplay,
  type RequestContext,
} from './common/request-context.js';
import { corsOrigins, loadApiEnv, previousAuthSecrets, type ApiEnv } from './config/env.js';
import {
  acceptOneClickPosts,
  captureRawBody,
  isPublicApiPath,
  limitPublicBodies,
} from './common/public-routes.js';
import { AddressRateLimitService } from './platform/rate-limit.service.js';

/**
 * Builds the application. Separate from `main.ts` so tests can start the same
 * app, with the same middleware and the same guards, rather than a simplified
 * stand-in that would not prove anything about production behaviour.
 */
export async function createApp(env: ApiEnv = loadApiEnv()): Promise<NestFastifyApplication> {
  const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');

  // `abortOnError: false` matters as much as the disabled logger. Nest's
  // default is to catch a bootstrap failure, hand it to its own logger and end
  // the process itself — so with `logger: false` the process would exit with no
  // output at all, and the try/catch in `main.ts` would never run. A startup
  // failure must be reportable: let it throw, and let the caller log it.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(env),
    new FastifyAdapter({ trustProxy: true, bodyLimit: 2 * 1024 * 1024 }),
    { logger: false, abortOnError: false },
  );

  const instance = app.getHttpAdapter().getInstance();

  // Nothing signs a cookie today (a session is a random token, not keyed by this); if something
  // does, a key kept for a rotation still verifies what it signed (ADR-0049).
  await app.register(cookie, { secret: [env.AUTH_SECRET, ...previousAuthSecrets(env)] });

  // Strict security headers (MVP_SPEC §8). The API serves JSON only, so the
  // CSP can forbid essentially everything rather than allowlisting sources.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    // DENY, not helmet's default SAMEORIGIN: the API is never framed, and
    // MVP_SPEC §8 asks for DENY explicitly.
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  // Request context and X-Request-Id, before anything else can log.
  instance.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    const incoming = request.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && /^[\w-]{1,128}$/.test(incoming) ? incoming : randomUUID();

    const context: RequestContext = {
      requestId,
      tenantId: null,
      userId: null,
      ipAddress: request.ip,
      userAgent:
        typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
      replay: { replayed: false },
    };

    void reply.header('x-request-id', requestId);
    runWithRequestContext(context, done);
  });

  // A request answered from a remembered Idempotency-Key says so (ADR-0060).
  instance.addHook('onSend', (_request: FastifyRequest, reply: FastifyReply, payload, done) => {
    if (wasIdempotentReplay()) void reply.header('idempotent-replayed', 'true');
    done(null, payload);
  });

  // The pre-authentication ceiling per address (CLAUDE.md §5.14, ADR-0053). The per-user and per-tenant
  // limits are checked by the auth guard, once the session has said who is asking; this is the only one
  // that can apply to a request with no valid session. It runs after the request context so a refusal
  // carries a request id, and not for the health route, which a load balancer polls and which must keep
  // answering whoever is asking.
  const addressLimit = app.get(AddressRateLimitService, { strict: false });
  instance.addHook('onRequest', async (request: FastifyRequest) => {
    if (request.url.split('?')[0] === '/api/v1/health') return;
    await addressLimit.check(request.ip);
  });

  // The public lead-form routes are the one part of the API a stranger reaches (ADR-0065). Their body
  // is capped before it is read, and the browser's cross-origin approval is never given there: they
  // take no cookies, and v1 has no cross-origin embed.
  limitPublicBodies(instance);
  // The mail service's reports are signed over their exact bytes, so that one address keeps them raw (ADR-0075).
  captureRawBody(instance);
  // A mail program's one-click unsubscribe is a form post; that address, and no other, accepts one (ADR-0076).
  acceptOneClickPosts(instance);

  const credentialedCors = {
    origin: corsOrigins(env),
    credentials: true,
    // CSRF protection for cookie-authenticated state changes (CLAUDE.md §5.9).
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-tenant-id',
      'x-request-id',
      'x-csrf-token',
      'idempotency-key',
    ],
    exposedHeaders: ['x-request-id', 'idempotent-replayed'],
  };
  // One answer per request: the credentialed allow-list everywhere, and no approval at all for the
  // public routes. (`delegator` is @fastify/cors's per-request option.)
  app.enableCors({
    delegator: (request, callback) => {
      callback(null, isPublicApiPath(request.url) ? { origin: false } : credentialedCors);
    },
  });

  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new DomainErrorFilter(logger));
  app.enableShutdownHooks();

  return app;
}
