import { SesEmailProvider } from '@crm/outbound';
import { describe, expect, inject, it } from 'vitest';
import { EMAIL_PROVIDER } from '../platform/email/email.provider.js';
import { startApiHarness } from '../testing/harness.js';

/**
 * `EMAIL_PROVIDER` chooses the sender when the application boots (ADR-0009, ADR-0048): the right
 * adapter for the setting, and a start-up refusal naming the variable when a setting it needs is
 * missing, rather than a 500 on the first verification email.
 */
describe('choosing the email provider at start-up', () => {
  const ses = {
    EMAIL_PROVIDER: 'ses',
    SES_REGION: 'ap-south-1',
    SES_ACCESS_KEY_ID: 'AKIATESTEXAMPLE0000',
    SES_SECRET_ACCESS_KEY: 'exampleSecretForATestOnly000000',
  };

  it('builds the Amazon SES adapter when asked for it', async () => {
    const harness = await startApiHarness(inject('dbUrls'), ses);
    try {
      expect(harness.app.get(EMAIL_PROVIDER)).toBeInstanceOf(SesEmailProvider);
    } finally {
      await harness.close();
    }
  }, 240_000);

  it('refuses to start without the settings it needs, naming them and not their values', async () => {
    const attempt = startApiHarness(inject('dbUrls'), { ...ses, SES_SECRET_ACCESS_KEY: '' });
    await expect(attempt).rejects.toThrow('EMAIL_PROVIDER=ses requires SES_SECRET_ACCESS_KEY');
    await attempt.catch((error: unknown) => {
      expect(String(error)).not.toContain(ses.SES_ACCESS_KEY_ID);
    });
  }, 240_000);
});
