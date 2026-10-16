import { Global, Module } from '@nestjs/common';
import { ActorService } from './actor.service.js';
import { AuthGuard } from './auth.guard.js';
import { SessionService } from './session.service.js';

/**
 * Services here declare their dependencies with explicit `@Inject` tokens
 * rather than letting Nest infer them from constructor types.
 *
 * Implicit injection relies on `emitDecoratorMetadata`, which only some
 * TypeScript pipelines produce — tsc and oxc do, esbuild does not. That made DI
 * work under the test runner and fail under the dev runner, reported as an
 * "undefined dependency" that pointed at the wrong thing. Naming the token
 * makes wiring independent of how a file happened to be compiled.
 */
@Global()
@Module({
  providers: [SessionService, ActorService, AuthGuard],
  exports: [SessionService, ActorService, AuthGuard],
})
export class AuthModule {}
