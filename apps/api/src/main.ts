import 'reflect-metadata';
import { createApp } from './bootstrap.js';
import { loadApiEnv } from './config/env.js';
import { createLogger } from './common/logger.js';

const env = loadApiEnv();
const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');

/**
 * Startup failures are logged and exit non-zero.
 *
 * Nest's own logger is disabled (we use pino), which means a dependency
 * resolution failure would otherwise be reported nowhere at all: the process
 * simply exits with no output, which reads as a hang rather than a crash.
 */
try {
  const app = await createApp(env);
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  logger.info({ port: env.API_PORT, env: env.NODE_ENV }, 'API listening');
} catch (error) {
  logger.fatal({ err: error }, 'API failed to start');
  // Give pino's transport a moment to flush before the process goes away.
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.exit(1);
}
