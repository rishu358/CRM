import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from './database/database.service.js';
import { Public } from './auth/auth.guard.js';

/**
 * Liveness and readiness.
 *
 * Public, because a load balancer has no session. It reveals nothing beyond
 * "the process is up and can reach its database" — deliberately no version,
 * no hostname, no dependency detail.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  @Public()
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public()
  async readiness(): Promise<{ status: string }> {
    const reachable = await this.database.ping();
    return { status: reachable ? 'ok' : 'degraded' };
  }
}
