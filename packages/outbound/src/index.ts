import { GuardedOutboundHttp, type GuardedClientOptions } from './client.js';
import type { OutboundHttp } from './types.js';

export * from './types.js';
export { createResendEmailProvider, EmailSendError, ResendEmailProvider } from './resend.js';
export { createSesEmailProvider, SesEmailProvider } from './ses.js';
export { createSmtpEmailProvider, SmtpEmailProvider, type SmtpSecurity } from './smtp.js';
export { createRemoteEmailProvider, type RemoteEmailConfig } from './email.js';

/**
 * The options a caller may set. The rule for which addresses are acceptable is not one
 * of them: that is `@crm/core`'s `classifyAddress`, and the only way to change it is
 * `@crm/outbound/testing`, which a source-scanning test keeps out of production code.
 */
export type OutboundOptions = Pick<
  GuardedClientOptions,
  'urlPolicy' | 'limits' | 'userAgent' | 'resolve'
>;

export function createOutboundHttp(options: OutboundOptions = {}): OutboundHttp {
  return new GuardedOutboundHttp(options);
}
