import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppModule } from './app.module.js';
import { DomainErrorFilter } from './common/domain-error.filter.js';
import { createLogger } from './common/logger.js';
import { runWithRequestContext, type RequestContext } from './common/request-context.js';
import { corsOrigins, loadApiEnv, previousAuthSecrets, type ApiEnv } from './config/env.js';
import type { AuthenticatedRequest } from './auth/auth.guard.js';

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

  // Rate limit per user and per tenant, not just per IP (CLAUDE.md §5.14).
  // An office behind one NAT address is many users; a single abusive tenant
  // across many addresses is still one tenant.
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX_PER_USER,
    timeWindow: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
    keyGenerator: (request: FastifyRequest) => {
      const actor = (request as AuthenticatedRequest).actor;
      if (actor !== undefined) return `u:${actor.userId}`;
      return `ip:${request.ip}`;
    },
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
    };

    void reply.header('x-request-id', requestId);
    runWithRequestContext(context, done);
  });

  app.enableCors({
    origin: corsOrigins(env),
    credentials: true,
    // CSRF protection for cookie-authenticated state changes (CLAUDE.md §5.9).
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-tenant-id',
      'x-request-id',
      'x-csrf-token',
    ],
    exposedHeaders: ['x-request-id'],
  });

  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new DomainErrorFilter(logger));
  app.enableShutdownHooks();

  return app;
}
