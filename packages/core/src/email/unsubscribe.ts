/**
 * The unsubscribe link every email carries (ADR-0076): its shape and its addresses.
 *
 * Pure and safe for the browser (no `node:crypto`): the signing lives in `unsubscribe-token.ts`, which is a
 * subpath of its own. The shape is here so the API can refuse a made-up value before anything else, and so the
 * worker and the web page build the same address from the same rule.
 */

/**
 * A token is `v1.<email id>.<signature>`: the id of the email it was put in, and a 256-bit HMAC of that id.
 * It names an email, never a person's address, and carries no company id.
 */
export const UNSUBSCRIBE_TOKEN_PATTERN =
  /^v1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;

export function isUnsubscribeTokenShape(value: unknown): value is string {
  return typeof value === 'string' && UNSUBSCRIBE_TOKEN_PATTERN.test(value);
}

/** The email id inside a token of the right shape. It is not proof of anything until the signature is checked. */
export function unsubscribeEmailIdOf(token: string): string | null {
  return isUnsubscribeTokenShape(token) ? (token.split('.')[1] ?? null) : null;
}

/** The page a person opens: `<web origin>/u/<token>`. */
export function unsubscribePageUrl(webOrigin: string, token: string): string {
  return new URL(`/u/${token}`, webOrigin).href;
}

/**
 * The address a mail program posts to when its own "unsubscribe" button is used (RFC 8058): the API's, because
 * the post is made by a mail program, not by a browser on our page.
 */
export function unsubscribeOneClickUrl(apiOrigin: string, token: string): string {
  return new URL(`/api/v1/public/email-unsubscribe/${token}`, apiOrigin).href;
}
