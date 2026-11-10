import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resendSigningKey, verifyResendEvents } from './resend-events.js';

/**
 * Reading Resend's events (ADR-0075). The signature check is tested against the vector Svix publishes for
 * manual verification (docs.svix.com, read 2026-10-31), which a wrong signed text, key decoding or
 * encoding cannot match by accident. Everything else is tested against payloads shaped like the ones
 * Resend's documentation shows. **None of it is a test against a real Resend account.**
 */

// Svix's published example.
const VECTOR = {
  secret: 'whsec_plJ3nmyCDGBKInavdOK15jsl',
  id: 'msg_loFOjxBNrRLzqYUf',
  timestamp: '1731705121',
  body: '{"event_type":"ping","data":{"success":true}}',
  signature: 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=',
};
const VECTOR_NOW = new Date(Number(VECTOR.timestamp) * 1000);

const headersFor = (signature: string, id = VECTOR.id, timestamp = VECTOR.timestamp) => ({
  'svix-id': id,
  'svix-timestamp': timestamp,
  'svix-signature': signature,
});

describe('the signature', () => {
  it('accepts the published example', () => {
    const result = verifyResendEvents({
      secret: VECTOR.secret,
      headers: headersFor(VECTOR.signature),
      rawBody: VECTOR.body,
      now: VECTOR_NOW,
    });
    // It verifies; it is not an email event, so there is nothing to act on.
    expect(result).toEqual({ ok: true, events: [] });
  });

  it('accepts any one of several entries, and ignores a version it does not know', () => {
    const header = `v2,AAAA v1,${Buffer.from('wrong').toString('base64')} ${VECTOR.signature}`;
    expect(
      verifyResendEvents({
        secret: VECTOR.secret,
        headers: headersFor(header),
        rawBody: VECTOR.body,
        now: VECTOR_NOW,
      }).ok,
    ).toBe(true);
    expect(
      verifyResendEvents({
        secret: VECTOR.secret,
        headers: headersFor(VECTOR.signature.replace('v1,', 'v2,')),
        rawBody: VECTOR.body,
        now: VECTOR_NOW,
      }).ok,
    ).toBe(false);
  });

  it('refuses a body changed by one character, a changed id or timestamp, and another secret', () => {
    const base = { secret: VECTOR.secret, now: VECTOR_NOW };
    expect(
      verifyResendEvents({
        ...base,
        headers: headersFor(VECTOR.signature),
        rawBody: VECTOR.body + ' ',
      }).ok,
    ).toBe(false);
    expect(
      verifyResendEvents({
        ...base,
        headers: headersFor(VECTOR.signature, 'msg_other'),
        rawBody: VECTOR.body,
      }).ok,
    ).toBe(false);
    expect(
      verifyResendEvents({
        ...base,
        headers: headersFor(VECTOR.signature, VECTOR.id, String(Number(VECTOR.timestamp) + 1)),
        rawBody: VECTOR.body,
      }).ok,
    ).toBe(false);
    expect(
      verifyResendEvents({
        secret: 'whsec_' + Buffer.from('another secret').toString('base64'),
        headers: headersFor(VECTOR.signature),
        rawBody: VECTOR.body,
        now: VECTOR_NOW,
      }).ok,
    ).toBe(false);
  });

  it('refuses a request outside the time window, in either direction', () => {
    const at = (offsetSeconds: number) =>
      verifyResendEvents({
        secret: VECTOR.secret,
        headers: headersFor(VECTOR.signature),
        rawBody: VECTOR.body,
        now: new Date(VECTOR_NOW.getTime() + offsetSeconds * 1000),
      }).ok;
    expect(at(0)).toBe(true);
    expect(at(299)).toBe(true);
    expect(at(301)).toBe(false);
    expect(at(-301)).toBe(false);
  });

  it('refuses a missing or malformed header, and a secret that is not in the shape Svix gives', () => {
    const run = (headers: Record<string, string>, secret = VECTOR.secret) =>
      verifyResendEvents({ secret, headers, rawBody: VECTOR.body, now: VECTOR_NOW }).ok;
    expect(run({})).toBe(false);
    expect(run({ 'svix-id': VECTOR.id, 'svix-timestamp': VECTOR.timestamp })).toBe(false);
    expect(run(headersFor(VECTOR.signature, VECTOR.id, 'yesterday'))).toBe(false);
    expect(run(headersFor(''))).toBe(false);
    expect(run(headersFor(VECTOR.signature), 'plJ3nmyCDGBKInavdOK15jsl')).toBe(false);
    expect(run(headersFor(VECTOR.signature), 'whsec_')).toBe(false);
    expect(resendSigningKey('whsec_not base64!')).toBeNull();
    expect(resendSigningKey(VECTOR.secret)).not.toBeNull();
  });
});

/** Sign a body with the example secret as Resend would, for the payload tests. */
function signed(body: string, id = 'msg_test_1', now = new Date('2026-11-22T23:41:12.126Z')) {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const key = resendSigningKey(VECTOR.secret)!;
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    secret: VECTOR.secret,
    headers: headersFor(`v1,${signature}`, id, timestamp),
    rawBody: body,
    now,
  };
}

const bouncedPayload = (bounce: Record<string, unknown>) =>
  JSON.stringify({
    type: 'email.bounced',
    created_at: '2026-11-22T23:41:12.126Z',
    data: {
      email_id: '56761188-7520-42d8-8898-ff6fc54ce618',
      message_id: '<111-222-333@email.example.com>',
      from: 'Acme <onboarding@resend.dev>',
      to: ['someone@customer.example'],
      subject: 'Your confidential quote',
      bounce,
    },
  });

const eventsOf = (result: ReturnType<typeof verifyResendEvents>) =>
  result.ok ? result.events : [];

describe('the events', () => {
  it('reads a permanent bounce as a bounce, by the id, keeping nothing about the person', () => {
    const result = verifyResendEvents(
      signed(
        bouncedPayload({
          type: 'Permanent',
          subType: 'MessageRejected',
          message: 'secret reply 550 someone@customer.example',
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toEqual([
      {
        providerEventId: 'msg_test_1',
        providerMessageId: '56761188-7520-42d8-8898-ff6fc54ce618',
        type: 'bounced',
        reason: 'other',
        at: new Date('2026-11-22T23:41:12.126Z'),
      },
    ]);
    const everything = JSON.stringify(result.events);
    for (const secret of [
      'someone@customer.example',
      'confidential',
      'secret reply',
      'onboarding@resend.dev',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('ignores a temporary bounce, which is the provider’s to retry', () => {
    const result = verifyResendEvents(
      signed(bouncedPayload({ type: 'Temporary', subType: 'MailboxFull' })),
    );
    expect(result).toEqual({ ok: true, events: [] });
  });

  it('reads Resend’s own suppression as a bounce for a blocked address', () => {
    const body = JSON.stringify({
      type: 'email.suppressed',
      created_at: '2026-11-22T23:41:12.126Z',
      data: { email_id: 'abc-123' },
    });
    const result = verifyResendEvents(signed(body));
    expect(result.ok && result.events[0]).toMatchObject({
      type: 'bounced',
      reason: 'blocked',
      providerMessageId: 'abc-123',
    });
    const documented = verifyResendEvents(
      signed(bouncedPayload({ type: 'Permanent', subType: 'Suppressed' })),
    );
    expect(documented.ok && documented.events[0]).toMatchObject({ reason: 'blocked' });
  });

  it('reads delivered and complained, and ignores every other event type', () => {
    const event = (type: string) =>
      verifyResendEvents(
        signed(
          JSON.stringify({
            type,
            created_at: '2026-11-22T23:41:12.126Z',
            data: { email_id: 'abc-123' },
          }),
        ),
      );
    expect(eventsOf(event('email.delivered'))[0]?.type).toBe('delivered');
    expect(eventsOf(event('email.complained'))[0]?.type).toBe('complained');
    for (const type of [
      'email.sent',
      'email.opened',
      'email.clicked',
      'email.delivery_delayed',
      'email.failed',
      'contact.created',
    ]) {
      expect(event(type), type).toEqual({ ok: true, events: [] });
    }
  });

  it('ignores a signed body that is not JSON or has no usable email id', () => {
    expect(verifyResendEvents(signed('not json'))).toEqual({ ok: true, events: [] });
    expect(verifyResendEvents(signed('[]'))).toEqual({ ok: true, events: [] });
    for (const emailId of [undefined, '', 'has space', 'x'.repeat(200), 42]) {
      const body = JSON.stringify({ type: 'email.delivered', data: { email_id: emailId } });
      expect(verifyResendEvents(signed(body)), String(emailId)).toEqual({ ok: true, events: [] });
    }
  });
});
