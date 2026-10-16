import { pino, type Logger } from 'pino';
import { currentRequestContext } from './request-context.js';

/**
 * Structured JSON logs (CLAUDE.md §5.8, §8).
 *
 * The redaction list is not decoration: tokens, passwords, OTPs and full PII
 * must never reach a log sink, because logs are retained longer, copied more
 * widely and secured less carefully than the database.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'otp',
  '*.otp',
  'accessToken',
  'refreshToken',
];

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    // Every line gets the request identifiers, with no call site having to
    // remember to pass them.
    mixin() {
      const context = currentRequestContext();
      if (context === undefined) return {};
      return {
        requestId: context.requestId,
        tenantId: context.tenantId,
        userId: context.userId,
      };
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}
