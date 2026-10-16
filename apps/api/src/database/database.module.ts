import { Global, Module, type DynamicModule } from '@nestjs/common';
import { API_ENV_TOKEN, type ApiEnv } from '../config/env.js';
import { DatabaseService } from './database.service.js';

/**
 * Configured with an explicit `ApiEnv` rather than reading process.env itself.
 *
 * That way the tests start the *same* application against a Testcontainers
 * database, instead of a simplified stand-in that would prove nothing about
 * how production behaves.
 */
@Global()
@Module({})
export class DatabaseModule {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: API_ENV_TOKEN, useValue: env },
        {
          provide: DatabaseService,
          inject: [API_ENV_TOKEN],
          useFactory: (resolved: ApiEnv) => new DatabaseService(resolved),
        },
      ],
      exports: [DatabaseService, API_ENV_TOKEN],
    };
  }
}
