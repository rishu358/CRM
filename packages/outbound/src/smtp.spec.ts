import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EmailSendError, SmtpEmailProvider, type SmtpSecurity } from './index.js';

/**
 * The SMTP adapter (ADR-0009, ADR-0048), against a small SMTP server on the loopback interface.
 *
 * What is checked is what leaves the process: that a message arrives whole, that **nothing is sent
 * in clear** when TLS is required and the server does not offer it, and that a failure says a code and
 * a status and never the server's words (which may repeat the recipient).
 */

interface Fake {
  readonly port: number;
  /** Every command line the client sent. */
  readonly commands: string[];
  /** The DATA section of each delivered message. */
  readonly messages: string[];
  close(): Promise<void>;
}

interface FakeOptions {
  readonly offerStartTls?: boolean;
  /** Replace the answer to `RCPT TO`. */
  readonly rcpt?: string;
}

const open: Fake[] = [];

async function fakeServer(options: FakeOptions = {}): Promise<Fake> {
  const commands: string[] = [];
  const messages: string[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = '';
    let data: string | null = null;
    socket.write('220 fake.example ESMTP\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (data !== null) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          data = null;
          socket.write('250 2.0.0 queued\r\n');
          continue;
        }
        const newline = buffer.indexOf('\r\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        commands.push(line);
        const verb = line.split(' ')[0]?.toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') {
          socket.write(
            options.offerStartTls === true
              ? '250-fake.example\r\n250 STARTTLS\r\n'
              : '250 fake.example\r\n',
          );
        } else if (verb === 'STARTTLS') {
          // A server that does not do TLS says so. (One that did would start a handshake, which
          // this fake cannot; the client's behaviour on a refusal is what is under test.)
          socket.write('502 5.5.1 STARTTLS not supported\r\n');
        } else if (verb === 'RCPT') {
          socket.write(options.rcpt ?? '250 2.1.5 ok\r\n');
        } else if (verb === 'DATA') {
          data = '';
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 ok\r\n');
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  const fake: Fake = {
    port: address.port,
    commands,
    messages,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  open.push(fake);
  return fake;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((fake) => fake.close()));
});

const FROM = 'CRM <no-reply@mail.example.com>';
const message = {
  to: 'sam@example.com',
  subject: 'Verify your address',
  text: 'Link: https://app.example.com/verify?t=TOKEN123',
};

const provider = (port: number, security: SmtpSecurity, extra: object = {}) =>
  new SmtpEmailProvider({
    host: '127.0.0.1',
    port,
    security,
    from: FROM,
    nodeEnv: 'test',
    ...extra,
  });

async function failureOf(promise: Promise<void>): Promise<EmailSendError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EmailSendError) return error;
    throw error;
  }
  throw new Error('Expected the send to fail');
}

describe('delivery', () => {
  it('hands over the whole message to the server', async () => {
    const server = await fakeServer();
    await provider(server.port, 'none').send({ ...message, html: '<p>Hi</p>' });

    expect(server.commands).toContain('MAIL FROM:<no-reply@mail.example.com>');
    expect(server.commands).toContain('RCPT TO:<sam@example.com>');
    expect(server.messages).toHaveLength(1);
    const delivered = server.messages[0] as string;
    expect(delivered).toContain('Subject: Verify your address');
    expect(delivered).toContain('From: CRM <no-reply@mail.example.com>');
    expect(delivered).toContain('To: sam@example.com');
    expect(delivered).toContain('TOKEN123');
    expect(delivered).toContain('<p>Hi</p>');
  }, 20_000);
});

describe('transport security', () => {
  it('sends nothing in clear when STARTTLS is required and the server does not offer it', async () => {
    const server = await fakeServer({ offerStartTls: false });
    const error = await failureOf(provider(server.port, 'starttls').send(message));

    expect(error.retryable).toBe(false);
    // The point: no sender, no recipient, no message crossed the wire.
    expect(server.commands.some((line) => /^(MAIL|RCPT|DATA)/i.test(line))).toBe(false);
    expect(server.messages).toEqual([]);
  }, 20_000);

  it('fails, and sends nothing, when TLS is required and the server speaks plain text', async () => {
    const server = await fakeServer();
    await failureOf(provider(server.port, 'tls').send(message));
    expect(server.commands.some((line) => /^(MAIL|RCPT|DATA)/i.test(line))).toBe(false);
    expect(server.messages).toEqual([]);
  }, 20_000);

  it('refuses plain text in production, before it ever connects', () => {
    expect(() => provider(2525, 'none', { nodeEnv: 'production' })).toThrow(
      'SMTP_SECURITY=none cannot be used in production',
    );
    expect(() => provider(2525, 'starttls', { nodeEnv: 'production' })).not.toThrow();
    expect(() => provider(465, 'tls', { nodeEnv: 'production' })).not.toThrow();
  });
});

describe('failures', () => {
  it('say a code and a status, never the server’s words, the address or the token', async () => {
    const server = await fakeServer({
      rcpt: '550 5.1.1 <sam@example.com> user unknown TOKEN123\r\n',
    });
    const error = await failureOf(provider(server.port, 'none').send(message));

    expect(error.status).toBe(550);
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/^Email was not sent: SMTP [A-Z_]+ 550$/);
    for (const secret of ['sam@example.com', 'TOKEN123', 'unknown']) {
      expect(error.message).not.toContain(secret);
    }
  }, 20_000);

  it('treats a temporary refusal as worth another try', async () => {
    const server = await fakeServer({ rcpt: '451 4.3.0 try again later\r\n' });
    const error = await failureOf(provider(server.port, 'none').send(message));
    expect(error.status).toBe(451);
    expect(error.retryable).toBe(true);
  }, 20_000);

  it('treats an unreachable server as worth another try', async () => {
    const server = await fakeServer();
    const port = server.port;
    await server.close();
    const error = await failureOf(provider(port, 'none').send(message));
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(true);
  }, 20_000);

  it('refuses a line break in the recipient or subject, and sends nothing', async () => {
    const server = await fakeServer();
    const sender = provider(server.port, 'none');
    for (const bad of [
      { ...message, subject: 'Hi\r\nBcc: attacker@example.com' },
      { ...message, to: 'sam@example.com\r\nBcc: attacker@example.com' },
    ]) {
      const error = await failureOf(sender.send(bad));
      expect(error.retryable).toBe(false);
    }
    expect(server.commands).toEqual([]);
  }, 20_000);
});

describe('configuration', () => {
  it('needs a host that is a host and a port that is a port', () => {
    for (const host of ['', ' ', 'smtp.example.com/evil', 'a b']) {
      expect(() => new SmtpEmailProvider({ ...base(), host })).toThrow('SMTP_HOST');
    }
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      expect(() => new SmtpEmailProvider({ ...base(), port })).toThrow('SMTP_PORT');
    }
  });

  it('takes a login and a password together or not at all, and says nothing of their value', () => {
    expect(() => new SmtpEmailProvider({ ...base(), user: 'u' })).toThrow(
      'SMTP_USER and SMTP_PASSWORD must be set together',
    );
    expect(() => new SmtpEmailProvider({ ...base(), password: 'p' })).toThrow(
      'SMTP_USER and SMTP_PASSWORD must be set together',
    );
    expect(() => new SmtpEmailProvider({ ...base(), user: 'u', password: 'p' })).not.toThrow();
    expect(() => new SmtpEmailProvider({ ...base(), user: 'u', password: 'p\nRCPT TO:x' })).toThrow(
      'The SMTP credentials are malformed',
    );
  });

  it('refuses a sender address with a line break', () => {
    expect(
      () => new SmtpEmailProvider({ ...base(), from: 'a@example.com\r\nBcc: x@example.com' }),
    ).toThrow('EMAIL_FROM is malformed');
  });
});

function base() {
  return {
    host: '127.0.0.1',
    port: 2525,
    security: 'none' as SmtpSecurity,
    from: FROM,
    nodeEnv: 'test',
  };
}
