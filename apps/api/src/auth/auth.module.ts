import { createResendEmailProvider } from '@crm/outbound';
import { Global, Module } from '@nestjs/common';
import { API_ENV_TOKEN } from '../config/env.js';
import {
  ConsoleEmailProvider,
  EMAIL_PROVIDER,
  MemoryEmailProvider,
} from '../platform/email/email.provider.js';
import { ActorService } from './actor.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthRateLimitGuard } from './auth-rate-limit.guard.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { AuthThrottleService } from './auth-throttle.service.js';
import { GoogleAuthService } from './google.service.js';
import { MfaService } from './mfa.service.js';
import { SessionService } from './session.service.js';
import { BetterAuthPasswordHasher, PASSWORD_HASHER } from './crypto/password.hasher.js';
import { BetterAuthTotpProvider, TOTP_PROVIDER } from './crypto/totp.provider.js';
import type { ApiEnv } from '../config/env.js';

/**
 * Services here declare their dependencies with explicit `@Inject` tokens
 * rather than letting Nest infer them from constructor types.
 *
 * Implicit injection relies on `emitDecoratorMetadata`, which only some
 * TypeScript pipelines produce — tsc and oxc do, esbuild does not. That made DI
 * work under the test runner and fail under the dev runner, reported as an
 * "undefined dependency" that pointed at the wrong thing. Naming the token
 * makes wiring independent of how a file happened to be compiled (ADR-0016).
 *
 * The cryptography and the mail provider are bound behind tokens for a
 * different reason (ADR-0009, ADR-0017): nothing outside `crypto/` imports a
 * Better Auth symbol, so moving to Argon2id — or to SES — is a provider line
 * here rather than a search through the codebase.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    SessionService,
    ActorService,
    AuthGuard,
    AuthRepository,
    AuthService,
    AuthThrottleService,
    AuthRateLimitGuard,
    MfaService,
    GoogleAuthService,
    { provide: PASSWORD_HASHER, useClass: BetterAuthPasswordHasher },
    { provide: TOTP_PROVIDER, useClass: BetterAuthTotpProvider },
    {
      provide: EMAIL_PROVIDER,
      inject: [API_ENV_TOKEN],
      useFactory: (env: ApiEnv) => {
        if (env.EMAIL_PROVIDER === 'memory') return new MemoryEmailProvider(env);
        if (env.EMAIL_PROVIDER === 'resend') {
          if (env.RESEND_API_KEY === undefined || env.RESEND_API_KEY === '') {
            throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY');
          }
          return createResendEmailProvider({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM });
        }
        return new ConsoleEmailProvider(env);
      },
    },
  ],
  exports: [
    AuthRateLimitGuard,
    SessionService,
    ActorService,
    AuthGuard,
    AuthRepository,
    AuthService,
    MfaService,
    EMAIL_PROVIDER,
  ],
})
export class AuthModule {}
