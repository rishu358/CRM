import { describe, expect, it } from 'vitest';
import { EMAIL_PAUSE, shouldPauseEmail, statusAfter, suppressionFor } from './events.js';

describe('what an event does to an email’s status', () => {
  it('moves forward only', () => {
    expect(statusAfter('sent', 'delivered')).toBe('delivered');
    expect(statusAfter('delivered', 'bounced')).toBe('bounced');
    expect(statusAfter('sent', 'bounced')).toBe('bounced');
    expect(statusAfter('sent', 'complained')).toBe('complained');
    expect(statusAfter('delivered', 'complained')).toBe('complained');
    expect(statusAfter('bounced', 'complained')).toBe('complained');
  });

  it('never goes back, and a repeat changes nothing', () => {
    expect(statusAfter('delivered', 'delivered')).toBeNull();
    expect(statusAfter('bounced', 'delivered')).toBeNull();
    expect(statusAfter('complained', 'delivered')).toBeNull();
    expect(statusAfter('complained', 'bounced')).toBeNull();
    expect(statusAfter('bounced', 'bounced')).toBeNull();
  });

  it('never touches an email that failed or is still in flight', () => {
    for (const status of ['queued', 'sending', 'failed'] as const) {
      for (const type of ['delivered', 'bounced', 'complained', 'unsubscribed'] as const) {
        expect(statusAfter(status, type), `${status} ${type}`).toBeNull();
      }
    }
  });
});

describe('a person’s own unsubscribe', () => {
  it('says nothing about whether the mail arrived: the status stays as it was', () => {
    for (const status of ['sent', 'delivered', 'bounced', 'complained'] as const) {
      expect(statusAfter(status, 'unsubscribed'), status).toBeNull();
    }
  });
});

describe('what suppresses an address', () => {
  it('a bounce and a complaint do, a delivery does not', () => {
    expect(suppressionFor('bounced')).toBe('hard_bounce');
    expect(suppressionFor('complained')).toBe('complaint');
    expect(suppressionFor('delivered')).toBeNull();
    expect(suppressionFor('unsubscribed')).toBe('unsubscribed');
  });
});

describe('when a company’s email is paused', () => {
  it('pauses only past the thresholds', () => {
    expect(
      shouldPauseEmail({
        hardBouncesInWindow: EMAIL_PAUSE.hardBouncesInWindow,
        complaintsToday: 0,
      }),
    ).toBe(false);
    expect(
      shouldPauseEmail({
        hardBouncesInWindow: EMAIL_PAUSE.hardBouncesInWindow + 1,
        complaintsToday: 0,
      }),
    ).toBe(true);
    expect(
      shouldPauseEmail({
        hardBouncesInWindow: 0,
        complaintsToday: EMAIL_PAUSE.complaintsPerDay - 1,
      }),
    ).toBe(false);
    expect(
      shouldPauseEmail({ hardBouncesInWindow: 0, complaintsToday: EMAIL_PAUSE.complaintsPerDay }),
    ).toBe(true);
  });
});
