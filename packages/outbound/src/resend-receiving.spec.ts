import { EMAIL_REPLY_LIMITS } from '@crm/core';
import { describe, expect, it } from 'vitest';
import {
  EmailFetchError,
  OutboundError,
  ResendReceivingProvider,
  parseFromHeader,
  type OutboundHttp,
  type OutboundRequest,
  type OutboundResponse,
} from './index.js';

/**
 * Fetching a received message from Resend (ADR-0077). The request it builds, what it takes from the answer and
 * the way it reports failure are tested against a fake client; the answer's shape is the one Resend's API
 * reference shows (read 2026-11-10). **None of it is a test against a real Resend account.**
 */

const KEY = 're_live_SECRETSECRETSECRET';
const ID = '4ef9a417-02e9-4d39-ad75-9611e0fcc33c';

function respond(status: number, body: unknown = {}): OutboundResponse {
  return {
    status,
    headers: {},
    body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
    url: 'https://api.resend.com/emails/receiving/x',
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

const answer = (change: Record<string, unknown> = {}) => ({
  object: 'email',
  id: ID,
  to: ['r.0197c5a21b6e7f3a9c0d2e4f6a8b0c1d.abcdefghijklmnopqrstuvwxyz@reply.example.com'],
  from: 'sam@customer.example',
  created_at: '2026-11-22T23:41:12.126Z',
  subject: 'Re: Your quote',
  html: '<p>Thanks, that works.</p>',
  text: 'Thanks, that works.',
  headers: { from: 'Sam Customer <sam@customer.example>', 'in-reply-to': '<x@send.example>' },
  message_id: '<abc@customer.example>',
  attachments: [],
  raw: {
    download_url: 'https://example.invalid/never-followed',
    expires_at: '2026-11-23T00:00:00Z',
  },
  ...change,
});

async function failureOf(promise: Promise<unknown>): Promise<EmailFetchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EmailFetchError) return error;
    throw error;
  }
  throw new Error('Expected the fetch to fail');
}

describe('the request', () => {
  it('asks Resend, and only Resend, for one received message, with the key, no redirects and a size cap', async () => {
    const { http, seen } = fake(() => respond(200, answer()));
    await new ResendReceivingProvider({ apiKey: KEY, http }).retrieve(ID);
    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    expect(request.method).toBe('GET');
    expect(request.url).toBe(`https://api.resend.com/emails/receiving/${ID}?html_format=cid`);
    expect(request.headers?.['authorization']).toBe(`Bearer ${KEY}`);
    expect(request.maxRedirects).toBe(0);
    expect(request.maxResponseBytes).toBe(EMAIL_REPLY_LIMITS.fetchMaxBytes);
  });

  it('refuses an id that is not the shape of one before it makes any request', async () => {
    const { http, seen } = fake(() => respond(200, answer()));
    const provider = new ResendReceivingProvider({ apiKey: KEY, http });
    for (const id of ['', '../health', 'a b', 'x?y=1', 'a/b', '\n', 'x'.repeat(200)]) {
      const error = await failureOf(provider.retrieve(id));
      expect(error.retryable).toBe(false);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses a key that could break a header, or that is empty', () => {
    expect(() => new ResendReceivingProvider({ apiKey: '' })).toThrow();
    expect(() => new ResendReceivingProvider({ apiKey: 'a\r\nb' })).toThrow();
  });
});

describe('what it takes from the answer', () => {
  it('takes the sender, the name from the From header, the subject, the plain text, the Message-ID and a count', async () => {
    const { http } = fake(() => respond(200, answer({ attachments: [{ id: 'a' }, { id: 'b' }] })));
    expect(await new ResendReceivingProvider({ apiKey: KEY, http }).retrieve(ID)).toEqual({
      fromAddress: 'sam@customer.example',
      fromName: 'Sam Customer',
      subject: 'Re: Your quote',
      text: 'Thanks, that works.',
      messageId: '<abc@customer.example>',
      attachmentCount: 2,
    });
  });

  it('never takes the HTML, the raw link or any other header', async () => {
    const { http } = fake(() => respond(200, answer()));
    const received = await new ResendReceivingProvider({ apiKey: KEY, http }).retrieve(ID);
    const everything = JSON.stringify(received);
    for (const left of ['<p>', 'never-followed', 'in-reply-to', 'x@send.example']) {
      expect(everything).not.toContain(left);
    }
  });

  it('reports no plain-text part as null, and a missing Message-ID as null', async () => {
    const { http } = fake(() => respond(200, answer({ text: null, message_id: undefined })));
    const received = await new ResendReceivingProvider({ apiKey: KEY, http }).retrieve(ID);
    expect(received.text).toBeNull();
    expect(received.messageId).toBeNull();
  });

  it('takes a sender from a `from` that carries a name, and from the header when `from` is missing', async () => {
    const named = fake(() => respond(200, answer({ from: '"Sam C." <sam@customer.example>' })));
    expect(
      await new ResendReceivingProvider({ apiKey: KEY, http: named.http }).retrieve(ID),
    ).toMatchObject({
      fromAddress: 'sam@customer.example',
      fromName: 'Sam C.',
    });
    const headerOnly = fake(() => respond(200, answer({ from: undefined })));
    expect(
      await new ResendReceivingProvider({ apiKey: KEY, http: headerOnly.http }).retrieve(ID),
    ).toMatchObject({ fromAddress: 'sam@customer.example', fromName: 'Sam Customer' });
  });

  it('counts at most a thousand attachments, however many the answer claims', async () => {
    const { http } = fake(() =>
      respond(
        200,
        answer({ attachments: Array.from({ length: 5000 }, (_, i) => ({ id: String(i) })) }),
      ),
    );
    expect(
      (await new ResendReceivingProvider({ apiKey: KEY, http }).retrieve(ID)).attachmentCount,
    ).toBe(1000);
  });

  it.each([
    ['not JSON', 'this is not json'],
    ['a list', '[]'],
    ['no sender at all', JSON.stringify({ subject: 'x', text: 'y' })],
    ['an unusable sender', JSON.stringify(answer({ from: 'not an address', headers: {} }))],
  ])('refuses an answer that is %s, for good', async (_what, body) => {
    const { http } = fake(() => respond(200, body));
    const error = await failureOf(new ResendReceivingProvider({ apiKey: KEY, http }).retrieve(ID));
    expect(error.retryable).toBe(false);
  });
});

describe('failure', () => {
  it.each([
    [404, true],
    [408, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [403, false],
    [422, false],
  ])('answers %i as retryable=%s', async (status, retryable) => {
    const { http } = fake(() =>
      respond(status, { name: 'secret_error_name', message: 'sam@customer.example' }),
    );
    const error = await failureOf(new ResendReceivingProvider({ apiKey: KEY, http }).retrieve(ID));
    expect(error.status).toBe(status);
    expect(error.retryable).toBe(retryable);
    // Resend's own words can repeat an address: only the status is kept.
    expect(error.message).not.toContain('sam@customer.example');
    expect(error.message).not.toContain('secret_error_name');
  });

  it.each([
    ['timeout', true],
    ['dns', true],
    ['network', true],
    ['blocked', false],
    ['too_large', false],
    ['redirect', false],
  ])('treats a client failure of kind %s as retryable=%s', async (code, retryable) => {
    const { http } = fake(() => new OutboundError(code as never, 'x'));
    const error = await failureOf(new ResendReceivingProvider({ apiKey: KEY, http }).retrieve(ID));
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(retryable);
  });

  it('never puts the key, the id or the address in an error message', async () => {
    const { http } = fake(() => respond(500));
    const error = await failureOf(new ResendReceivingProvider({ apiKey: KEY, http }).retrieve(ID));
    for (const secret of [KEY, ID, 'customer.example']) expect(error.message).not.toContain(secret);
  });
});

describe('reading a From header', () => {
  it.each([
    ['sam@customer.example', null, 'sam@customer.example'],
    ['Sam <sam@customer.example>', 'Sam', 'sam@customer.example'],
    ['"Sam, C." <sam@customer.example>', 'Sam, C.', 'sam@customer.example'],
    ['<sam@customer.example>', null, 'sam@customer.example'],
    ['  Sam   <sam@customer.example>  ', 'Sam', 'sam@customer.example'],
  ])('reads %j', (value, name, address) => {
    expect(parseFromHeader(value)).toEqual({ name, address });
  });

  it.each(['', 'Sam', 'Sam <not an address>', 'Sam <>'])('refuses %j', (value) => {
    expect(parseFromHeader(value)).toBeNull();
  });
});
