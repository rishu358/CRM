import { isUnsubscribeTokenShape } from '@crm/core';
import type { EmailUnsubscribePage } from '@crm/contracts';
import { upstreamPath } from './proxy-path';

/**
 * The web server's two ways to reach the unsubscribe link's API address (ADR-0076): ask whose email it is, and
 * do it.
 *
 * Used by the hosted page (`/u/<token>`) and its confirm handler. It talks only to `API_URL`, a fixed origin
 * from configuration, on a path built by `upstreamPath` from a token whose shape is checked first; it sends no
 * credential of any kind, whatever the visitor's request carried (the public route reads none). A token that
 * does not work, an email that is gone, an API that is down: asking answers `invalid` for each, which is what the
 * API's own uniform 404 is for.
 */

const TIMEOUT_MS = 4000;

export type UnsubscribePageResult =
  { readonly kind: 'ask'; readonly companyName: string } | { readonly kind: 'invalid' };

/** `busy` is "try again": a limit was reached or the API did not answer. It never says why. */
export type UnsubscribeOutcome = 'done' | 'invalid' | 'busy';

interface Options {
  apiUrl: string;
  token: string;
  clientAddress?: Record<string, string>;
  fetchFn?: typeof fetch;
}

export async function fetchUnsubscribePage(options: Options): Promise<UnsubscribePageResult> {
  const url = addressOf(options);
  if (url === null) return { kind: 'invalid' };
  try {
    const response = await (options.fetchFn ?? fetch)(url, {
      method: 'GET',
      headers: { ...options.clientAddress },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { kind: 'invalid' };
    const body = (await response.json()) as { data?: Partial<EmailUnsubscribePage> };
    const name = body.data?.companyName;
    return typeof name === 'string' && name !== ''
      ? { kind: 'ask', companyName: name }
      : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * Do it, the way a mail program's own button does (RFC 8058): a form post with the one fixed phrase. The API
 * reads nothing of the body.
 */
export async function submitUnsubscribe(options: Options): Promise<UnsubscribeOutcome> {
  const url = addressOf(options);
  if (url === null) return 'invalid';
  try {
    const response = await (options.fetchFn ?? fetch)(url, {
      method: 'POST',
      headers: {
        ...options.clientAddress,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'List-Unsubscribe=One-Click',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 204) return 'done';
    return response.status === 404 ? 'invalid' : 'busy';
  } catch {
    return 'busy';
  }
}

function addressOf(options: Options): URL | null {
  if (!isUnsubscribeTokenShape(options.token)) return null;
  const path = upstreamPath(['public', 'email-unsubscribe', options.token]);
  return path === null ? null : new URL(path, options.apiUrl);
}
