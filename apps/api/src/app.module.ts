import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health.controller.js';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { ContactsModule } from './modules/contacts/contacts.module.js';
import { InvitationsModule } from './modules/invitations/invitations.module.js';
import { PlatformModule } from './platform/platform.module.js';
import type { ApiEnv } from './config/env.js';

/**
 * The modular monolith's root (ADR-0001).
 *
 * `AuthGuard` is registered as a global guard, so every route is authenticated
 * unless it explicitly opts out with `@Public()`. Default-deny applies to
 * routing as well as to permissions: a controller added by someone who forgets
 * the decorator ends up protected, not open.
 */
@Module({})
export class AppModule {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.forRoot(env),
        AuthModule,
        PlatformModule,
        AccountsModule,
        ContactsModule,
        InvitationsModule,
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_GUARD, useExisting: AuthGuard }],
    };
  }
}
