import { describe, expect, it } from 'vitest';
import {
  EmailSendError,
  OutboundError,
  SesEmailProvider,
  type OutboundHttp,
  type OutboundRequest,
  type OutboundResponse,
} from './index.js';
import { pinnedSesClient, sesHost } from './ses.js';

/**
 * The SES adapter (ADR-0009, ADR-0048).
 *
 * The request it builds and the way it reports failure are tested against a fake client; that the
 * real client is pinned to SES's host is tested against the real one, with URLs that are refused
 * before any DNS lookup, so no test here touches the network.
 */

const ACCESS_KEY = 'AKIAEXAMPLEEXAMPLE12';
const SECRET = 'exampleSecretKeyExampleSecretKey0000000';
const FROM = 'CRM <no-reply@mail.acme-crm.io>';
const NOW = new Date('2026-10-24T18:00:00Z');

function respond(status: number, headers: Record<string, string> = {}): OutboundResponse {
  return {
    status,
    headers,
    body: new TextEncoder().encode('{"message":"echo of the request would be bad"}'),
    url: 'https://email.ap-south-1.amazonaws.com/v2/email/outbound-emails',
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

const provider = (http: OutboundHttp, extra: object = {}) =>
  new SesEmailProvider({
    region: 'ap-south-1',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    from: FROM,
    http,
    now: () => NOW,
    ...extra,
  });

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
  it('is one signed POST to the region host, carrying the message as SES expects it', async () => {
    const { http, seen } = fake(() => respond(200));
    await provider(http).send({ ...message, html: '<p>Hi</p>' });

    expect(seen).toHaveLength(1);
    const request = seen[0] as OutboundRequest;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://email.ap-south-1.amazonaws.com/v2/email/outbound-emails');
    expect(request.maxRedirects).toBe(0);
    expect(JSON.parse(request.body as string)).toEqual({
      FromEmailAddress: FROM,
      Destination: { ToAddresses: ['sam@example.com'] },
      Content: {
        Simple: {
          Subject: { Data: 'Verify', Charset: 'UTF-8' },
          Body: {
            Text: { Data: message.text, Charset: 'UTF-8' },
            Html: { Data: '<p>Hi</p>', Charset: 'UTF-8' },
          },
        },
      },
    });
  });

  it('is signed for the SES service in that region at the moment it is sent', async () => {
    const { http, seen } = fake(() => respond(200));
    await provider(http).send(message);
    const headers = (seen[0] as OutboundRequest).headers ?? {};
    expect(headers['x-amz-date']).toBe('20261024T180000Z');
    expect(headers['authorization']).toMatch(
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/20261024/ap-south-1/ses/aws4_request, ` +
          'SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$',
      ),
    );
    // The secret itself is never sent, in any header.
    expect(JSON.stringify(headers)).not.toContain(SECRET);
  });

  it('adds a configuration set only when one is configured', async () => {
    const { http, seen } = fake(() => respond(200));
    await provider(http).send(message);
    await provider(http, { configurationSet: 'transactional' }).send(message);
    const bodies = seen.map((r) => JSON.parse(r.body as string) as Record<string, unknown>);
    expect(bodies[0]).not.toHaveProperty('ConfigurationSetName');
    expect(bodies[1]?.['ConfigurationSetName']).toBe('transactional');
  });
});

describe('failures', () => {
  it('say the status and SES error type, never the message, the address or a key', async () => {
    const { http } = fake(() => respond(400, { 'x-amzn-errortype': 'MessageRejected' }));
    const error = await failureOf(provider(http).send(message));
    expect(error.message).toBe('Email was not sent: SES answered 400 (MessageRejected)');
    for (const secret of [SECRET, ACCESS_KEY, 'TOKEN123', 'sam@example.com']) {
      expect(error.message).not.toContain(secret);
    }
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(400);
  });

  it('drops the documentation suffix some error types carry, and anything that is not a name', async () => {
    const { http: suffixed } = fake(() =>
      respond(403, { 'x-amzn-errortype': 'AccessDeniedException:http://internal.example/doc' }),
    );
    expect((await failureOf(provider(suffixed).send(message))).message).toContain(
      '(AccessDeniedException)',
    );
    const { http: odd } = fake(() => respond(403, { 'x-amzn-errortype': 'a b\nc' }));
    expect((await failureOf(provider(odd).send(message))).message).toBe(
      'Email was not sent: SES answered 403',
    );
  });

  it.each([
    [408, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [403, false],
    [404, false],
  ])('treats %i as retryable: %s', async (status, retryable) => {
    const { http } = fake(() => respond(status));
    expect((await failureOf(provider(http).send(message))).retryable).toBe(retryable);
  });

  it('retries a slow or unreachable network, and does not retry a refusal', async () => {
    for (const [code, retryable] of [
      ['timeout', true],
      ['dns', true],
      ['network', true],
      ['blocked', false],
      ['invalid_request', false],
    ] as const) {
      const { http } = fake(() => new OutboundError(code, 'x'));
      const error = await failureOf(provider(http).send(message));
      expect(error.retryable).toBe(retryable);
      expect(error.status).toBeNull();
      expect(error.message).toBe(`Email was not sent: ${code}`);
    }
  });
});

describe('configuration', () => {
  it('accepts a region name and nothing that could become another host', () => {
    expect(sesHost('ap-south-1')).toBe('email.ap-south-1.amazonaws.com');
    expect(sesHost('us-gov-west-1')).toBe('email.us-gov-west-1.amazonaws.com');
    for (const bad of [
      '',
      'AP-SOUTH-1',
      'ap-south-1.evil.example',
      'ap-south-1/../x',
      'evil.example#',
      'ap-south',
      'ap-south-1\n',
      'cn-north-1.amazonaws.com.cn',
    ]) {
      expect(() => sesHost(bad)).toThrow('SES_REGION is not an AWS region name');
    }
  });

  it('refuses empty or malformed keys when it is built, naming which, never the value', () => {
    const { http } = fake(() => respond(200));
    expect(() => provider(http, { accessKeyId: '' })).toThrow('needs the access key id');
    expect(() => provider(http, { secretAccessKey: ' ' })).toThrow('needs the secret access key');
    const bad = 'secret\nInjected: header';
    expect(() => provider(http, { secretAccessKey: bad })).toThrow(
      'secret access key is malformed',
    );
    try {
      provider(http, { secretAccessKey: bad });
    } catch (error) {
      expect(String(error)).not.toContain('Injected');
    }
  });
});

describe('the real client', () => {
  it('is pinned to the region host over https', async () => {
    const client = pinnedSesClient('ap-south-1');
    for (const url of [
      'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails',
      'https://example.com/v2/email/outbound-emails',
      'http://email.ap-south-1.amazonaws.com/v2/email/outbound-emails',
      'https://email.ap-south-1.amazonaws.com:8443/v2/email/outbound-emails',
    ]) {
      await expect(client.request({ url, method: 'POST', body: '{}' })).rejects.toBeInstanceOf(
        OutboundError,
      );
    }
  });
});
