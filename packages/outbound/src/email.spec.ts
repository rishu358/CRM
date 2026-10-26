import { describe, expect, it } from 'vitest';
import { createRemoteEmailProvider } from './email.js';

describe('createRemoteEmailProvider', () => {
  const from = 'App <no-reply@mail.example.com>';

  it('builds Resend with its key, and says which variable is missing without one', () => {
    expect(
      createRemoteEmailProvider({ kind: 'resend', from, resendApiKey: 're_key' }),
    ).toBeDefined();
    expect(() => createRemoteEmailProvider({ kind: 'resend', from })).toThrow(
      'EMAIL_PROVIDER=resend requires RESEND_API_KEY',
    );
  });

  it('builds SES with a region and both keys', () => {
    expect(
      createRemoteEmailProvider({
        kind: 'ses',
        from,
        sesRegion: 'ap-south-1',
        sesAccessKeyId: 'AKIAEXAMPLE',
        sesSecretAccessKey: 'example-secret',
      }),
    ).toBeDefined();
  });

  it('names every SES variable that is missing, and none that is not, and never a value', () => {
    expect(() => createRemoteEmailProvider({ kind: 'ses', from, sesRegion: 'ap-south-1' })).toThrow(
      'EMAIL_PROVIDER=ses requires SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY',
    );
    expect(() =>
      createRemoteEmailProvider({
        kind: 'ses',
        from,
        sesRegion: '',
        sesAccessKeyId: 'AKIAEXAMPLE',
        sesSecretAccessKey: 'example-secret',
      }),
    ).toThrow('EMAIL_PROVIDER=ses requires SES_REGION');
  });

  it('refuses a region that is not an AWS region name', () => {
    expect(() =>
      createRemoteEmailProvider({
        kind: 'ses',
        from,
        sesRegion: 'ap-south-1.evil.example',
        sesAccessKeyId: 'AKIAEXAMPLE',
        sesSecretAccessKey: 'example-secret',
      }),
    ).toThrow('SES_REGION is not an AWS region name');
  });

  describe('smtp', () => {
    const smtp = {
      kind: 'smtp' as const,
      from,
      nodeEnv: 'production',
      smtpHost: 'smtp.mail.example.com',
      smtpPort: 587,
      smtpSecurity: 'starttls' as const,
      smtpUser: 'u',
      smtpPassword: 'p',
    };

    it('builds with a host, and says which variable is missing without one', () => {
      expect(createRemoteEmailProvider(smtp)).toBeDefined();
      expect(() => createRemoteEmailProvider({ ...smtp, smtpHost: undefined })).toThrow(
        'EMAIL_PROVIDER=smtp requires SMTP_HOST',
      );
    });

    it('refuses plain text in production, even if the configuration check was skipped', () => {
      expect(() => createRemoteEmailProvider({ ...smtp, smtpSecurity: 'none' })).toThrow(
        'SMTP_SECURITY=none cannot be used in production',
      );
      expect(() =>
        createRemoteEmailProvider({ ...smtp, smtpSecurity: 'none', nodeEnv: 'development' }),
      ).not.toThrow();
    });
  });
});
