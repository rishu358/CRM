import 'reflect-metadata';
import { createApp } from './bootstrap.js';
import { loadApiEnv } from './config/env.js';
import { createLogger } from './common/logger.js';

const env = loadApiEnv();
const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');

const app = await createApp(env);
await app.listen({ port: env.API_PORT, host: env.API_HOST });

logger.info({ port: env.API_PORT, env: env.NODE_ENV }, 'API listening');
