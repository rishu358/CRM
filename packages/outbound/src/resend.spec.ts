import { describe, expect, it } from 'vitest';
import {
  EmailSendError,
  OutboundError,
  ResendEmailProvider,
  type OutboundHttp,
  type OutboundRequest,
  type OutboundResponse,
} from './index.js';
import { pinnedResendClient } from './resend.js';

/**
 * The Resend adapter (ADR-0009, ADR-0041).
 *
 * The request it builds and the way it reports failure are tested against a fake client; that
 * the real client is pinned to Resend's host is tested against the real one, with URLs that are
 * refused before any DNS lookup, so no test here touches the network.
 */

const KEY = 're_live_SECRETSECRETSECRET';
const FROM = 'CRM <no-reply@mail.acme-crm.io>';

function respond(status: number, body: unknown = {}): OutboundResponse {
  return {
    status,
    headers: {},
    body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
    url: 'https://api.resend.com/emails',
    redirects: [],
  };
}

function fake(handler: (request: OutboundRequest) => OutboundResponse | Error) {
  const seen: OutboundRequest[] = [];
  const http: OutboundHttp = {
    request: (request) => {
      seen.push(request);
      const result = handler(request);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  return { http, seen };
}

const message = {
  to: 'sam@example.com',
  subject: 'Verify',
  text: 'Link: https://x/verify?t=TOKEN123',
};

async function failureOf(promise: Promise<void>): Promise<EmailSendError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EmailSendError) return error;
    throw error;
  }
  throw new Error('Expected the send to fail');
}

describe('the request', () => {
  it('posts the message to Resend with the key as a bearer token', async () => {
    const { http, seen } = fake(() => respond(200, { id: 'abc' }));
    await new ResendEmailProvider({ apiKey: KEY, from: FROM, http }).send({
      ...message,
      html: '<p>Hi</p>',
    });
    const request = seen[0]!;
    expect(request.url).toBe('https://api.resend.com/emails');
    expect(request.method).toBe('POST');
    expect(request.headers?.['authorization']).toBe(`Bearer ${KEY}`);
    expect(request.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(request.body as string)).toEqual({
      from: FROM,
      to: ['sam@example.com'],
      subject: 'Verify',
      text: message.text,
      html: '<p>Hi</p>',
    });
  });

  it('omits html when there is none, and never follows a redirect with the key attached', async () => {
    const { http, seen } = fake(() => respond(200));
    await new ResendEmailProvider({ apiKey: KEY, from: FROM, http }).send(message);
    expect(JSON.parse(seen[0]!.body as string)).not.toHaveProperty('html');
    expect(seen[0]!.maxRedirects).toBe(0);
  });

  it('refuses an empty or malformed key before any request is made', () => {
    expect(() => new ResendEmailProvider({ apiKey: '  ', from: FROM })).toThrow(/API key/);
    expect(() => new ResendEmailProvider({ apiKey: 're_x\r\nX-Injected: 1', from: FROM })).toThrow(
      /malformed/,
    );
  });
});

describe('failure', () => {
  it.each([
    [400, false],
    [401, false],
    [403, false],
    [422, false],
    [408, true],
    [409, true],
    [429, true],
    [500, true],
    [503, true],
  ])('classifies a %i answer as retryable=%s', async (status, retryable) => {
    const { http } = fake(() => respond(status, { name: 'validation_error', message: 'bad' }));
    const error = await failureOf(
      new ResendEmailProvider({ apiKey: KEY, from: FROM, http }).send(message),
    );
    expect(error.status).toBe(status);
    expect(error.retryable).toBe(retryable);
    expect(error.message).toContain(String(status));
    expect(error.message).toContain('(validation_error)');
  });

  it.each([
    ['timeout', true],
    ['dns', true],
    ['network', true],
    ['blocked', false],
    ['invalid_request', false],
    ['too_many_redirects', false],
  ] as const)('classifies a client %s as retryable=%s', async (code, retryable) => {
    const { http } = fake(() => new OutboundError(code, 'x'));
    const error = await failureOf(
      new ResendEmailProvider({ apiKey: KEY, from: FROM, http }).send(message),
    );
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(retryable);
  });

  it('never puts the key, the recipient, the body or the token in an error', async () => {
    // A hostile or confused answer that echoes the request back must not reach the error.
    const echo = JSON.stringify({ name: 'x', echoed: message.text, key: KEY, to: message.to });
    const { http } = fake(() => respond(400, `${echo} sam@example.com ${KEY}`));
    const error = await failureOf(
      new ResendEmailProvider({ apiKey: KEY, from: FROM, http }).send(message),
    );
    for (const secret of [KEY, 'sam@example.com', 'TOKEN123', message.subject]) {
      expect(error.message).not.toContain(secret);
    }
    const nonJson = fake(() => respond(502, `<html>${KEY} TOKEN123</html>`));
    const second = await failureOf(
      new ResendEmailProvider({ apiKey: KEY, from: FROM, http: nonJson.http }).send(message),
    );
    expect(second.message).not.toContain(KEY);
    expect(second.message).not.toContain('TOKEN123');
  });

  it('does not take an error name that could be something else', async () => {
    const { http } = fake(() => respond(400, { name: 'Bearer re_live_SECRET and more' }));
    const error = await failureOf(
      new ResendEmailProvider({ apiKey: KEY, from: FROM, http }).send(message),
    );
    expect(error.message).not.toContain('Bearer');
  });
});

describe('the pinned client', () => {
  const client = pinnedResendClient();

  it.each([
    ['https://evil.example/emails', 'host_not_allowed'],
    ['https://api.resend.com.evil.example/emails', 'host_not_allowed'],
    ['https://evil.example/api.resend.com', 'host_not_allowed'],
    ['https://xapi.resend.com/emails', 'host_not_allowed'],
    ['http://api.resend.com/emails', 'scheme'],
    ['https://api.resend.com:8443/emails', 'port'],
    ['https://user:pw@api.resend.com/emails', 'credentials'],
    ['https://169.254.169.254/emails', 'metadata'],
  ])('refuses %s before any lookup', async (url, reason) => {
    const error = await client.request({ url, headers: { authorization: `Bearer ${KEY}` } }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(OutboundError);
    expect(error).toMatchObject({ code: 'blocked', reason });
  });
});
