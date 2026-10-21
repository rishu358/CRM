import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { classifyAddress, type AddressDecision, type OutboundUrlPolicy } from '@crm/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOutboundHttp, OutboundError, type OutboundResponse } from './index.js';
import { allowLoopbackToo, createUnsafeOutboundHttpForTests } from './testing.js';

/**
 * The guarded client against real sockets (CLAUDE.md §5.13, ADR-0040).
 *
 * The rules are unit-tested in `@crm/core`. What is proved here is that the *client*
 * applies them where it matters: that a refused request never reaches the server, that
 * the connection goes to the address that was checked and not to one looked up later,
 * and that time and size are bounded against a server that misbehaves.
 *
 * Local servers listen on loopback, which the real client refuses by design, so these
 * tests use `@crm/outbound/testing` to allow it. The first tests use the *real* client
 * against the same servers to prove that without that, none of them can be reached.
 */

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

interface Fixture {
  readonly server: http.Server;
  readonly port: number;
  readonly seen: Seen[];
}

async function listen(
  host: string,
  handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void,
): Promise<Fixture> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return { server, port: (server.address() as AddressInfo).port, seen };
}

const close = (fixture: Fixture) =>
  new Promise<void>((resolve) => {
    fixture.server.closeAllConnections();
    fixture.server.close(() => resolve());
  });

const policyFor = (...ports: number[]): OutboundUrlPolicy => ({
  schemes: ['http', 'https'],
  ports,
  maxUrlLength: 2048,
});

async function failure(promise: Promise<OutboundResponse>): Promise<OutboundError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OutboundError) return error;
    throw error;
  }
  throw new Error('Expected the request to be refused, but it succeeded');
}

let echo: Fixture;
let second: Fixture;
let hang: Fixture;

beforeAll(async () => {
  echo = await listen('127.0.0.1', (req, res, seen) => {
    if (seen.url === '/json') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'session=abc; HttpOnly');
      res.end(JSON.stringify({ ok: true }));
    } else if (seen.url.startsWith('/redirect-to-second')) {
      res.statusCode = 302;
      res.setHeader('location', `http://127.0.0.1:${second.port}/landing`);
      res.end();
    } else if (seen.url === '/redirect-loop') {
      res.statusCode = 302;
      res.setHeader('location', `http://127.0.0.1:${echo.port}/redirect-loop`);
      res.end();
    } else if (seen.url === '/redirect-same') {
      res.statusCode = 307;
      res.setHeader('location', '/json');
      res.end();
    } else if (seen.url === '/redirect-303') {
      res.statusCode = 303;
      res.setHeader('location', '/json');
      res.end();
    } else if (seen.url === '/redirect-to-blocked') {
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.2:1/');
      res.end();
    } else if (seen.url === '/redirect-to-metadata') {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
      res.end();
    } else if (seen.url === '/redirect-to-file') {
      res.statusCode = 302;
      res.setHeader('location', 'file:///etc/passwd');
      res.end();
    } else if (seen.url === '/redirect-to-userinfo') {
      res.statusCode = 302;
      res.setHeader('location', `http://user:pass@127.0.0.1:${echo.port}/json`);
      res.end();
    } else if (seen.url === '/big') {
      res.setHeader('content-length', String(5_000_000));
      res.end(Buffer.alloc(5_000_000, 97));
    } else if (seen.url === '/endless') {
      res.write('x');
      const timer = setInterval(() => res.write('x'.repeat(16_384)), 1);
      res.on('close', () => clearInterval(timer));
    } else if (seen.url === '/head') {
      res.setHeader('content-length', '9000000');
      res.end();
    } else if (seen.url === '/gzip') {
      res.setHeader('content-type', 'text/plain');
      res.end('plain');
    } else {
      res.end('hello');
    }
  });
  second = await listen('127.0.0.1', (_req, res) => {
    res.end('landed');
  });
  hang = await listen('127.0.0.1', (req) => {
    if (req.url === '/slow-headers') return; // never answers
    if (req.url === '/slow-body') {
      // Headers now, then a byte at a time, forever.
    }
  });
});

afterAll(async () => {
  await Promise.all([close(echo), close(second), close(hang)]);
});

describe('without the test-only rule, a server on loopback cannot be reached at all', () => {
  it.each(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0', '2130706433', '0x7f.1', '127.1'])(
    'refuses %s and the server never sees a request',
    async (host) => {
      const before = echo.seen.length;
      const policy = policyFor(echo.port);
      const error = await failure(
        createOutboundHttp({ urlPolicy: policy }).request({
          url: `http://${host}:${echo.port}/json`,
        }),
      );
      expect(error.code).toBe('blocked');
      expect(echo.seen.length).toBe(before);
    },
  );

  it('refuses the cloud metadata address, and says what it is', async () => {
    const error = await failure(
      createOutboundHttp().request({ url: 'https://169.254.169.254/latest/meta-data/' }),
    );
    expect(error).toMatchObject({ code: 'blocked', reason: 'metadata' });
  });

  it('refuses plain http and any port but 443 by default', async () => {
    const client = createOutboundHttp();
    expect(await failure(client.request({ url: 'http://example.com/' }))).toMatchObject({
      reason: 'scheme',
    });
    expect(await failure(client.request({ url: 'https://example.com:8443/' }))).toMatchObject({
      reason: 'port',
    });
  });

  it('refuses a name that resolves to a private address, and one that resolves to both', async () => {
    const toPrivate = createOutboundHttp({
      resolve: () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]),
    });
    expect(await failure(toPrivate.request({ url: 'https://example.com/' }))).toMatchObject({
      code: 'blocked',
      reason: 'dns_blocked',
    });

    const mixed = createOutboundHttp({
      resolve: () =>
        Promise.resolve([
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ]),
    });
    expect(await failure(mixed.request({ url: 'https://example.com/' }))).toMatchObject({
      code: 'blocked',
      reason: 'dns_blocked',
    });

    const mappedLoopback = createOutboundHttp({
      resolve: () => Promise.resolve([{ address: '::ffff:127.0.0.1', family: 6 }]),
    });
    expect(await failure(mappedLoopback.request({ url: 'https://example.com/' }))).toMatchObject({
      code: 'blocked',
    });
  });

  it('reports a name that does not resolve, and an empty answer, as a DNS failure', async () => {
    const none = createOutboundHttp({ resolve: () => Promise.resolve([]) });
    expect(await failure(none.request({ url: 'https://example.com/' }))).toMatchObject({
      code: 'dns',
    });
    const broken = createOutboundHttp({ resolve: () => Promise.reject(new Error('SERVFAIL')) });
    expect(await failure(broken.request({ url: 'https://example.com/' }))).toMatchObject({
      code: 'dns',
    });
  });
});

const client = (extra: Partial<Parameters<typeof createUnsafeOutboundHttpForTests>[0]> = {}) =>
  createUnsafeOutboundHttpForTests({
    urlPolicy: policyFor(echo.port, second.port, hang.port),
    ...extra,
  });

describe('a permitted request', () => {
  it('fetches, returns the body and headers, and never returns a Set-Cookie', async () => {
    const response = await client().request({ url: `http://127.0.0.1:${echo.port}/json` });
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe('{"ok":true}');
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.redirects).toEqual([]);
  });

  it('sends the method, the body and a short list of headers, and identifies itself', async () => {
    await client().request({
      url: `http://127.0.0.1:${echo.port}/post`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': 'abc' },
      body: '{"a":1}',
    });
    const seen = echo.seen.at(-1)!;
    expect(seen.method).toBe('POST');
    expect(seen.body).toBe('{"a":1}');
    expect(seen.headers['x-signature']).toBe('abc');
    expect(seen.headers['user-agent']).toBe('crm-outbound/1');
    expect(seen.headers['accept-encoding']).toBe('identity');
    expect(seen.headers['connection']).toBe('close');
    expect(seen.headers['cookie']).toBeUndefined();
  });

  it.each([
    ['host', 'evil.example'],
    ['cookie', 'session=stolen'],
    ['content-length', '1'],
    ['transfer-encoding', 'chunked'],
    ['connection', 'keep-alive'],
    ['proxy-authorization', 'Basic x'],
    ['upgrade', 'websocket'],
    ['accept-encoding', 'gzip'],
  ])('refuses a caller-supplied %s header', async (name, value) => {
    const before = echo.seen.length;
    const error = await failure(
      client().request({ url: `http://127.0.0.1:${echo.port}/json`, headers: { [name]: value } }),
    );
    expect(error.code).toBe('invalid_request');
    expect(echo.seen.length).toBe(before);
  });

  it('refuses a header value that could split the request', async () => {
    const error = await failure(
      client().request({
        url: `http://127.0.0.1:${echo.port}/json`,
        headers: { 'x-a': 'ok\r\nX-Injected: yes' },
      }),
    );
    expect(error.code).toBe('invalid_request');
  });

  it('refuses a request body past the limit', async () => {
    const error = await failure(
      client({ limits: { maxRequestBytes: 10 } }).request({
        url: `http://127.0.0.1:${echo.port}/post`,
        method: 'POST',
        body: 'x'.repeat(11),
      }),
    );
    expect(error.code).toBe('invalid_request');
  });

  it('answers a HEAD whose Content-Length is larger than the cap, because it has no body', async () => {
    const response = await client({ limits: { maxResponseBytes: 100 } }).request({
      url: `http://127.0.0.1:${echo.port}/head`,
      method: 'HEAD',
    });
    expect(response.status).toBe(200);
    expect(response.body.byteLength).toBe(0);
  });
});

describe('the connection goes to the address that was checked', () => {
  it('dials the resolved address and does not look the name up again', async () => {
    let lookups = 0;
    const rebinding = client({
      resolve: () => {
        lookups += 1;
        return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
      },
    });
    // `rebind.test` does not exist in DNS. Reaching the server proves the socket used
    // the address the resolver returned and did not resolve the name a second time.
    const response = await rebinding.request({ url: `http://rebind.test:${echo.port}/json` });
    expect(response.status).toBe(200);
    expect(lookups).toBe(1);
    expect(echo.seen.at(-1)!.headers['host']).toBe(`rebind.test:${echo.port}`);
  });

  it('resolves again for each hop of a redirect, and judges each answer', async () => {
    const answers = new Map<string, string>([
      ['first.test', '127.0.0.1'],
      ['second.test', '10.0.0.9'],
    ]);
    const hops: string[] = [];
    const guarded = createUnsafeOutboundHttpForTests({
      urlPolicy: policyFor(echo.port),
      addressRule: allowLoopbackToo,
      resolve: (hostname) => {
        hops.push(hostname);
        const address = answers.get(hostname);
        return Promise.resolve(address === undefined ? [] : [{ address, family: 4 }]);
      },
    });

    const lander = await listen('127.0.0.1', (_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://second.test:' + echo.port + '/x');
      res.end();
    });
    try {
      const error = await failure(
        createUnsafeOutboundHttpForTests({
          urlPolicy: policyFor(lander.port, echo.port),
          resolve: (hostname) => {
            hops.push(hostname);
            const address = answers.get(hostname);
            return Promise.resolve(address === undefined ? [] : [{ address, family: 4 }]);
          },
        }).request({ url: `http://first.test:${lander.port}/` }),
      );
      expect(error).toMatchObject({ code: 'blocked', reason: 'dns_blocked' });
      expect(hops).toEqual(['first.test', 'second.test']);
    } finally {
      await close(lander);
    }
    expect(guarded).toBeDefined();
  });
});

describe('redirects', () => {
  it('follows a same-origin redirect and reports the final URL', async () => {
    const response = await client().request({ url: `http://127.0.0.1:${echo.port}/redirect-same` });
    expect(response.status).toBe(200);
    expect(response.url).toBe(`http://127.0.0.1:${echo.port}/json`);
    expect(response.redirects).toEqual([`http://127.0.0.1:${echo.port}/json`]);
  });

  it('refuses a redirect to an address the rules forbid, and the target is never contacted', async () => {
    for (const path of ['/redirect-to-blocked', '/redirect-to-metadata']) {
      const guarded = createUnsafeOutboundHttpForTests({
        urlPolicy: policyFor(echo.port, 1),
        // Loopback is allowed for the test server, but only 127.0.0.1: 127.0.0.2 is not.
        addressRule: (address): AddressDecision =>
          address === '127.0.0.1' ? { allowed: true, family: 4 } : classifyAddress(address),
      });
      const error = await failure(guarded.request({ url: `http://127.0.0.1:${echo.port}${path}` }));
      expect(error.code, path).toBe('blocked');
    }
  });

  it('refuses a redirect to another scheme, and one with credentials in the URL', async () => {
    expect(
      await failure(client().request({ url: `http://127.0.0.1:${echo.port}/redirect-to-file` })),
    ).toMatchObject({ code: 'blocked', reason: 'scheme' });
    expect(
      await failure(
        client().request({ url: `http://127.0.0.1:${echo.port}/redirect-to-userinfo` }),
      ),
    ).toMatchObject({ code: 'blocked', reason: 'credentials' });
  });

  it('stops at the redirect limit', async () => {
    const error = await failure(
      client({ limits: { maxRedirects: 2 } }).request({
        url: `http://127.0.0.1:${echo.port}/redirect-loop`,
      }),
    );
    expect(error.code).toBe('too_many_redirects');
    const request = (limit: number) =>
      client().request({ url: `http://127.0.0.1:${echo.port}/redirect-loop`, maxRedirects: limit });
    expect((await failure(request(0))).code).toBe('too_many_redirects');
  });

  it('drops what the caller attached when the origin changes, and keeps it within one origin', async () => {
    await client().request({
      url: `http://127.0.0.1:${echo.port}/redirect-to-second`,
      headers: { authorization: 'Bearer secret', 'x-signature': 'sig', accept: 'text/html' },
    });
    const landed = second.seen.at(-1)!;
    expect(landed.headers['authorization']).toBeUndefined();
    expect(landed.headers['x-signature']).toBeUndefined();
    expect(landed.headers['accept']).toBe('text/html');

    await client().request({
      url: `http://127.0.0.1:${echo.port}/redirect-same`,
      headers: { authorization: 'Bearer secret' },
    });
    const staying = echo.seen.at(-1)!;
    expect(staying.url).toBe('/json');
    expect(staying.headers['authorization']).toBe('Bearer secret');
  });

  it('turns a POST into a GET with no body on a 303, as a browser does', async () => {
    await client().request({
      url: `http://127.0.0.1:${echo.port}/redirect-303`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"secret":1}',
    });
    const after = echo.seen.at(-1)!;
    expect(after.method).toBe('GET');
    expect(after.body).toBe('');
    expect(after.headers['content-type']).toBeUndefined();
  });
});

describe('time and size are bounded', () => {
  it('refuses a response whose declared length is over the cap, before reading it', async () => {
    const error = await failure(
      client({ limits: { maxResponseBytes: 1000 } }).request({
        url: `http://127.0.0.1:${echo.port}/big`,
      }),
    );
    expect(error.code).toBe('too_large');
  });

  it('cuts off a response that never ends, at the cap', async () => {
    const started = Date.now();
    const error = await failure(
      client({ limits: { maxResponseBytes: 100_000 } }).request({
        url: `http://127.0.0.1:${echo.port}/endless`,
      }),
    );
    expect(error.code).toBe('too_large');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('gives up on a server that never answers, at the deadline', async () => {
    const started = Date.now();
    const error = await failure(
      client().request({ url: `http://127.0.0.1:${hang.port}/slow-headers`, timeoutMs: 400 }),
    );
    expect(error.code).toBe('timeout');
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(350);
    expect(took).toBeLessThan(5_000);
  });

  it('puts one deadline across the whole exchange, redirects included', async () => {
    const slowResolve = (): Promise<{ address: string; family: 4 }[]> =>
      new Promise((resolve) =>
        setTimeout(() => resolve([{ address: '127.0.0.1', family: 4 }]), 300),
      );
    const error = await failure(
      client({ resolve: slowResolve }).request({
        url: `http://slow.test:${echo.port}/json`,
        timeoutMs: 100,
      }),
    );
    expect(error.code).toBe('timeout');
  });

  it('reports a refused connection as a network error and not a hang', async () => {
    const dead = await listen('127.0.0.1', () => undefined);
    const port = dead.port;
    await close(dead);
    const error = await failure(
      createUnsafeOutboundHttpForTests({ urlPolicy: policyFor(port) }).request({
        url: `http://127.0.0.1:${port}/`,
      }),
    );
    expect(error.code).toBe('network');
  });

  it('does not decompress: it asks for the identity encoding, so a small body cannot grow', async () => {
    await client().request({ url: `http://127.0.0.1:${echo.port}/gzip` });
    expect(echo.seen.at(-1)!.headers['accept-encoding']).toBe('identity');
  });
});
