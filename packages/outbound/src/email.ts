import type { EmailProvider } from '@crm/core';
import { createResendEmailProvider } from './resend.js';
import { createSesEmailProvider } from './ses.js';
import { createSmtpEmailProvider, type SmtpSecurity } from './smtp.js';

/**
 * The providers that really send mail, chosen by `EMAIL_PROVIDER` (ADR-0009, ADR-0048).
 *
 * One place both processes (the API and the worker) build them from, so the two cannot disagree
 * about what a provider needs. `console` and `memory` are not here: they deliver nothing and each
 * process keeps its own, with its own refusal to run in production. A missing setting is reported
 * by the variable's name, never its value (CLAUDE.md §5.8).
 */
export type RemoteEmailConfig =
  | {
      readonly kind: 'resend';
      readonly from: string;
      readonly resendApiKey?: string | undefined;
    }
  | {
      readonly kind: 'ses';
      readonly from: string;
      readonly sesRegion?: string | undefined;
      readonly sesAccessKeyId?: string | undefined;
      readonly sesSecretAccessKey?: string | undefined;
      readonly sesConfigurationSet?: string | undefined;
    }
  | {
      readonly kind: 'smtp';
      readonly from: string;
      readonly nodeEnv: string;
      readonly smtpHost?: string | undefined;
      readonly smtpPort: number;
      readonly smtpSecurity: SmtpSecurity;
      readonly smtpUser?: string | undefined;
      readonly smtpPassword?: string | undefined;
    };

export function createRemoteEmailProvider(config: RemoteEmailConfig): EmailProvider {
  if (config.kind === 'resend') {
    if (config.resendApiKey === undefined || config.resendApiKey === '') {
      throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY');
    }
    return createResendEmailProvider({ apiKey: config.resendApiKey, from: config.from });
  }

  if (config.kind === 'smtp') {
    if (config.smtpHost === undefined || config.smtpHost === '') {
      throw new Error('EMAIL_PROVIDER=smtp requires SMTP_HOST');
    }
    return createSmtpEmailProvider({
      host: config.smtpHost,
      port: config.smtpPort,
      security: config.smtpSecurity,
      user: config.smtpUser,
      password: config.smtpPassword,
      from: config.from,
      nodeEnv: config.nodeEnv,
    });
  }

  const missing = [
    ['SES_REGION', config.sesRegion],
    ['SES_ACCESS_KEY_ID', config.sesAccessKeyId],
    ['SES_SECRET_ACCESS_KEY', config.sesSecretAccessKey],
  ].filter(([, value]) => value === undefined || value === '');
  if (missing.length > 0) {
    throw new Error(`EMAIL_PROVIDER=ses requires ${missing.map(([name]) => name).join(', ')}`);
  }
  return createSesEmailProvider({
    region: config.sesRegion as string,
    accessKeyId: config.sesAccessKeyId as string,
    secretAccessKey: config.sesSecretAccessKey as string,
    from: config.from,
    configurationSet: config.sesConfigurationSet,
  });
}
