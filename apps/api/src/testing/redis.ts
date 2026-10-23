import { createServer } from 'node:net';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

/**
 * A real Redis for a test (CLAUDE.md §10: shared state is tested against the real thing).
 *
 * The host port is chosen up front and kept across `stop()` and `start()`, so a test can take Redis
 * away and bring it back at the same address, which is what an outage and a recovery look like to
 * the API.
 */
export interface TestRedis {
  readonly url: string;
  /** Take Redis away. Connections drop and new ones are refused. */
  stop(): Promise<void>;
  /** Bring it back at the same address, with nothing in it. */
  start(): Promise<void>;
  /** Remove it for good. */
  destroy(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function startTestRedis(): Promise<TestRedis> {
  const port = await freePort();
  const create = () =>
    new GenericContainer('redis:7.4-alpine')
      .withExposedPorts({ container: 6379, host: port })
      .withCommand(['redis-server', '--save', '', '--appendonly', 'no'])
      .start();

  let container: StartedTestContainer | null = await create();
  return {
    url: `redis://127.0.0.1:${String(port)}`,
    stop: async () => {
      await container?.stop({ remove: false, timeout: 1 });
    },
    start: async () => {
      if (container === null) container = await create();
      else await container.restart({ timeout: 1 });
    },
    destroy: async () => {
      await container?.stop({ remove: true, timeout: 1 });
      container = null;
    },
  };
}
