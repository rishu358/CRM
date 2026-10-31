import { describe, expect, it } from 'vitest';
import {
  EmailSendError,
  ResendEmailProvider,
  SesEmailProvider,
  SmtpEmailProvider,
  type OutboundHttp,
  type OutboundRequest,
  type OutboundResponse,
} from './index.js';
import { formatFromHeader } from './message.js';

/**
 * What the adapters do with the per-message sender name, reply address and message id (ADR-0073).
 *
 * Tested against fakes only: nothing here proves how a real provider treats a display name or a
 * `Reply-To`. A real send through the chosen provider is the first manual check.
 */

const FROM = 'CRM <mail@send.example>';
const message = {
  to: 'sam@customer.example',
  subject: 'Quote',
  text: 'Hello',
  fromName: 'Sharma Traders',
  replyTo: 'priya@sharma.example',
  messageId: '<abc@send.example>',
};

function fakeHttp(body: unknown, headers: Record<string, string> = {}) {
  const seen: OutboundRequest[] = [];
  const http: OutboundHttp = {
    request: (request) => {
      seen.push(request);
      const response: OutboundResponse = {
        status: 200,
        headers,
        body: new TextEncoder().encode(JSON.stringify(body)),
        url: request.url,
        redirects: [],
      };
      return Promise.resolve(response);
    },
  };
  return { http, seen };
}

const sentBody = (seen: OutboundRequest[]): Record<string, unknown> =>
  JSON.parse(String(seen[0]?.body)) as Record<string, unknown>;

describe('the From header', () => {
  it('keeps the configured address and changes only the name', () => {
    expect(formatFromHeader(FROM, undefined)).toBe(FROM);
    expect(formatFromHeader(FROM, 'Sharma & Sons, Ltd.')).toBe(
      '"Sharma & Sons, Ltd." <mail@send.example>',
    );
  });

  it('encodes a name with non-ASCII letters as short encoded words', () => {
    const header = formatFromHeader(FROM, 'श्री शर्मा ट्रेडर्स एंड संस प्राइवेट लिमिटेड');
    expect(header).toMatch(/^(=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= ?)+ <mail@send\.example>$/);
    for (const word of header.split(' <')[0]?.split(' ') ?? []) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });
});

describe('Resend', () => {
  it('sends the name and reply address, and returns the id it was given', async () => {
    const { http, seen } = fakeHttp({ id: 'abc-123' });
    const receipt = await new ResendEmailProvider({ apiKey: 'k', from: FROM, http }).send(message);
    const body = sentBody(seen);
    expect(body['from']).toBe('"Sharma Traders" <mail@send.example>');
    expect(body['reply_to']).toBe('priya@sharma.example');
    expect(receipt).toEqual({ providerMessageId: 'abc-123' });
  });

  it('sends system mail exactly as before when the new fields are absent', async () => {
    const { http, seen } = fakeHttp({});
    const receipt = await new ResendEmailProvider({ apiKey: 'k', from: FROM, http }).send({
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    expect(sentBody(seen)['from']).toBe(FROM);
    expect(sentBody(seen)['reply_to']).toBeUndefined();
    expect(receipt).toEqual({});
  });
});

describe('SES', () => {
  it('sends the name, the reply address and returns the message id', async () => {
    const { http, seen } = fakeHttp({ MessageId: 'ses-456' });
    const receipt = await new SesEmailProvider({
      region: 'ap-south-1',
      accessKeyId: 'AKIAEXAMPLEEXAMPLE12',
      secretAccessKey: 'exampleSecretKeyExampleSecretKey0000000',
      from: FROM,
      http,
    }).send(message);
    const body = sentBody(seen);
    expect(body['FromEmailAddress']).toBe('"Sharma Traders" <mail@send.example>');
    expect(body['ReplyToAddresses']).toEqual(['priya@sharma.example']);
    expect(receipt).toEqual({ providerMessageId: 'ses-456' });
  });
});

describe('SMTP', () => {
  it('passes the name as a name, so the library encodes it, plus reply-to and message id', async () => {
    const calls: Record<string, unknown>[] = [];
    const transport = {
      sendMail: (options: Record<string, unknown>) => {
        calls.push(options);
        return Promise.resolve({ messageId: '<abc@send.example>' });
      },
    };
    const provider = new SmtpEmailProvider({
      host: 'smtp.example',
      port: 587,
      security: 'starttls',
      from: FROM,
      nodeEnv: 'test',
      transport: transport as never,
    });
    const receipt = await provider.send(message);
    expect(calls[0]?.['from']).toEqual({ name: 'Sharma Traders', address: 'mail@send.example' });
    expect(calls[0]?.['replyTo']).toBe('priya@sharma.example');
    expect(calls[0]?.['messageId']).toBe('<abc@send.example>');
    expect(receipt).toEqual({ providerMessageId: '<abc@send.example>' });
  });
});

describe('every adapter refuses what could inject a header', () => {
  const bad: [string, Partial<typeof message>][] = [
    ['a line break in the subject', { subject: 'Quote\r\nBcc: x@evil.example' }],
    ['a line break in the recipient', { to: 'a@b.example\r\nBcc: x@evil.example' }],
    ['an address in the sender name', { fromName: 'Bank <ceo@bank.example>' }],
    ['a list in reply-to', { replyTo: 'a@b.example, c@d.example' }],
    ['a malformed message id', { messageId: 'abc@send.example' }],
  ];

  const adapters: [
    string,
    () => { send: (m: typeof message) => Promise<unknown>; calls: () => number },
  ][] = [
    [
      'Resend',
      () => {
        const { http, seen } = fakeHttp({});
        const p = new ResendEmailProvider({ apiKey: 'k', from: FROM, http });
        return { send: (m) => p.send(m), calls: () => seen.length };
      },
    ],
    [
      'SES',
      () => {
        const { http, seen } = fakeHttp({});
        const p = new SesEmailProvider({
          region: 'ap-south-1',
          accessKeyId: 'AKIAEXAMPLEEXAMPLE12',
          secretAccessKey: 'exampleSecretKeyExampleSecretKey0000000',
          from: FROM,
          http,
        });
        return { send: (m) => p.send(m), calls: () => seen.length };
      },
    ],
    [
      'SMTP',
      () => {
        let count = 0;
        const p = new SmtpEmailProvider({
          host: 'smtp.example',
          port: 587,
          security: 'starttls',
          from: FROM,
          nodeEnv: 'test',
          transport: {
            sendMail: () => {
              count += 1;
              return Promise.resolve({});
            },
          } as never,
        });
        return { send: (m) => p.send(m), calls: () => count };
      },
    ],
  ];

  for (const [adapter, build] of adapters) {
    for (const [what, patch] of bad) {
      it(`${adapter}: ${what}`, async () => {
        const { send, calls } = build();
        const error = await send({ ...message, ...patch }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(EmailSendError);
        expect((error as EmailSendError).retryable).toBe(false);
        expect(calls()).toBe(0);
      });
    }
  }
});

describe('the unsubscribe headers (ADR-0076)', () => {
  const link = 'https://api.example/api/v1/public/email-unsubscribe/v1.id.signature';
  const withLink = { ...message, unsubscribeUrl: link };
  const HEADERS = {
    'List-Unsubscribe': `<${link}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };

  it('Resend carries them as headers, and sends none when the message has no link', async () => {
    const first = fakeHttp({ id: 'a' });
    await new ResendEmailProvider({ apiKey: 'k', from: FROM, http: first.http }).send(withLink);
    expect(sentBody(first.seen)['headers']).toEqual(HEADERS);

    const second = fakeHttp({ id: 'b' });
    await new ResendEmailProvider({ apiKey: 'k', from: FROM, http: second.http }).send(message);
    expect(sentBody(second.seen)['headers']).toBeUndefined();
  });

  it('SES carries them in the message’s own header list', async () => {
    const { http, seen } = fakeHttp({ MessageId: 'x' });
    await new SesEmailProvider({
      region: 'ap-south-1',
      accessKeyId: 'AKIAEXAMPLEEXAMPLE12',
      secretAccessKey: 'exampleSecretKeyExampleSecretKey0000000',
      from: FROM,
      http,
    }).send(withLink);
    const simple = (sentBody(seen)['Content'] as { Simple: Record<string, unknown> }).Simple;
    expect(simple['Headers']).toEqual(
      Object.entries(HEADERS).map(([Name, Value]) => ({ Name, Value })),
    );
  });

  it('SMTP passes them as headers for the library to write', async () => {
    const calls: Record<string, unknown>[] = [];
    const provider = new SmtpEmailProvider({
      host: 'smtp.example',
      port: 587,
      security: 'starttls',
      from: FROM,
      nodeEnv: 'test',
      transport: {
        sendMail: (options: Record<string, unknown>) => {
          calls.push(options);
          return Promise.resolve({});
        },
      } as never,
    });
    await provider.send(withLink);
    await provider.send(message);
    expect(calls[0]?.['headers']).toEqual(HEADERS);
    expect(calls[1]?.['headers']).toBeUndefined();
  });

  const unsafe: [string, string][] = [
    ['a line break', `${link}\r\nBcc: x@evil.example`],
    ['a space', 'https://api.example/a b'],
    ['an angle bracket that would end the header value early', 'https://api.example/a>, <mailto:x'],
    ['a scheme that is not http or https', 'javascript:alert(1)'],
    ['no address at all', ''],
    ['an address that is far too long', `https://api.example/${'a'.repeat(600)}`],
  ];
  for (const [what, url] of unsafe) {
    it(`every adapter refuses an unsubscribe address with ${what}`, async () => {
      let sent = 0;
      const { http } = fakeHttp({});
      const counting: OutboundHttp = {
        request: (request) => {
          sent += 1;
          return http.request(request);
        },
      };
      const providers = [
        new ResendEmailProvider({ apiKey: 'k', from: FROM, http: counting }),
        new SesEmailProvider({
          region: 'ap-south-1',
          accessKeyId: 'AKIAEXAMPLEEXAMPLE12',
          secretAccessKey: 'exampleSecretKeyExampleSecretKey0000000',
          from: FROM,
          http: counting,
        }),
        new SmtpEmailProvider({
          host: 'smtp.example',
          port: 587,
          security: 'starttls',
          from: FROM,
          nodeEnv: 'test',
          transport: {
            sendMail: () => {
              sent += 1;
              return Promise.resolve({});
            },
          } as never,
        }),
      ];
      for (const provider of providers) {
        const error = await provider
          .send({ ...message, unsubscribeUrl: url })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(EmailSendError);
        expect((error as EmailSendError).retryable).toBe(false);
      }
      expect(sent).toBe(0);
    });
  }
});
