import { Global, Module } from '@nestjs/common';
import { ActorService } from './actor.service.js';
import { AuthGuard } from './auth.guard.js';
import { SessionService } from './session.service.js';

@Global()
@Module({
  providers: [SessionService, ActorService, AuthGuard],
  exports: [SessionService, ActorService, AuthGuard],
})
export class AuthModule {}
