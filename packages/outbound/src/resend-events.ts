import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  EMAIL_EVENT_TOLERANCE_SECONDS,
  type EmailBounceReason,
  type EmailProviderEvent,
} from '@crm/core';

/**
 * Reading what Resend tells us about an email (ADR-0075), in the one place that knows Resend's field names.
 *
 * Resend signs each webhook with Svix's scheme. From Svix's own page (read 2026-10-31) and checked against
 * the test vector it publishes (see the spec): the signed text is the `svix-id`, the `svix-timestamp` and
 * the **raw body**, joined by full stops; the key is the endpoint's secret with its `whsec_` prefix removed
 * and the rest base64-decoded; the signature is the HMAC-SHA256 of the signed text, base64-encoded; the
 * `svix-signature` header holds one or more space-separated entries, each with a version prefix (`v1,`),
 * and any one matching is a valid request. Resend's own page names no timestamp tolerance, so the window
 * is ours (`EMAIL_EVENT_TOLERANCE_SECONDS`).
 *
 * Nothing here logs the body, the address or the secret, and nothing from the body that could name a
 * person (`to`, `from`, `subject`, the bounce text) is returned: an event is ids, a type, a closed reason
 * and a time.
 */

export type ResendEventResult =
  { readonly ok: true; readonly events: readonly EmailProviderEvent[] } | { readonly ok: false };

export interface ResendEventInput {
  /** The endpoint's signing secret (`whsec_...`). */
  readonly secret: string;
  /** Request headers as the HTTP layer holds them. Names are matched in lower case. */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** The body exactly as it arrived. Parsing and re-serialising it would break the signature. */
  readonly rawBody: string;
  readonly now: Date;
  readonly toleranceSeconds?: number;
}

const SECRET_PREFIX = 'whsec_';

/** The key bytes for a secret, or null when it is not in the shape Svix gives. */
export function resendSigningKey(secret: string): Buffer | null {
  if (!secret.startsWith(SECRET_PREFIX)) return null;
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (encoded === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const key = Buffer.from(encoded, 'base64');
  return key.length === 0 ? null : key;
}

function header(headers: ResendEventInput['headers'], name: string): string | null {
  const value = headers[name];
  const single = typeof value === 'string' ? value : value?.[0];
  return typeof single === 'string' && single.length > 0 && single.length < 4096 ? single : null;
}

/** Is any entry of the `svix-signature` header the signature of `signedText` under `key`? */
function signatureMatches(key: Buffer, signedText: string, headerValue: string): boolean {
  const expected = createHmac('sha256', key).update(signedText).digest();
  let matched = false;
  for (const entry of headerValue.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma < 1 || entry.slice(0, comma) !== 'v1') continue;
    const candidate = Buffer.from(entry.slice(comma + 1), 'base64');
    // Every entry is compared, in constant time, so the answer does not depend on which one matched.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected))
      matched = true;
  }
  return matched;
}

export function verifyResendEvents(input: ResendEventInput): ResendEventResult {
  const key = resendSigningKey(input.secret);
  const id = header(input.headers, 'svix-id');
  const timestamp = header(input.headers, 'svix-timestamp');
  const signatures = header(input.headers, 'svix-signature');
  if (key === null || id === null || timestamp === null || signatures === null)
    return { ok: false };

  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false };
  const skew = Math.abs(input.now.getTime() / 1000 - Number(timestamp));
  if (skew > (input.toleranceSeconds ?? EMAIL_EVENT_TOLERANCE_SECONDS)) return { ok: false };

  if (!signatureMatches(key, `${id}.${timestamp}.${input.rawBody}`, signatures)) {
    return { ok: false };
  }
  return { ok: true, events: normalize(id, input.rawBody) };
}

/** What a documented Resend `bounce.subType` means for us. Only what the documentation names is mapped. */
function bounceReason(subType: unknown): EmailBounceReason {
  return subType === 'Suppressed' ? 'blocked' : 'other';
}

function normalize(eventId: string, rawBody: string): EmailProviderEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const body = parsed as Record<string, unknown>;
  const data = body['data'];
  if (typeof data !== 'object' || data === null) return [];
  const fields = data as Record<string, unknown>;

  const emailId = fields['email_id'];
  if (typeof emailId !== 'string' || !/^[A-Za-z0-9._@-]{1,128}$/.test(emailId)) return [];

  const created = typeof body['created_at'] === 'string' ? new Date(body['created_at']) : null;
  const at = created !== null && !Number.isNaN(created.getTime()) ? created : new Date();
  const base = { providerEventId: eventId, providerMessageId: emailId, at };

  switch (body['type']) {
    case 'email.delivered':
      return [{ ...base, type: 'delivered', reason: null }];
    case 'email.complained':
      return [{ ...base, type: 'complained', reason: null }];
    case 'email.suppressed':
      // Resend did not send it: the address is on Resend's own list, which is a permanent refusal for us too.
      return [{ ...base, type: 'bounced', reason: 'blocked' }];
    case 'email.bounced': {
      const bounce = fields['bounce'];
      const detail =
        typeof bounce === 'object' && bounce !== null ? (bounce as Record<string, unknown>) : {};
      // A temporary bounce is the provider's to retry; only a permanent one is ours to act on.
      if (detail['type'] !== 'Permanent') return [];
      return [{ ...base, type: 'bounced', reason: bounceReason(detail['subType']) }];
    }
    default:
      return [];
  }
}
