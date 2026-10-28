/**
 * The Content Security Policy the web app sends (CLAUDE.md §5, MVP_SPEC §8, ADR-0040).
 *
 * A CSP is the second lock on cross-site scripting: the first is that nothing renders
 * untrusted markup unescaped (and what must be rendered, an activity's body, is
 * sanitised on the way in and out), the second is that even a script that got into
 * the page would not be allowed to run. So:
 *
 * - **Scripts run only if they carry this request's nonce**, or were loaded by one that
 *   did (`strict-dynamic`). There is no `unsafe-inline` for scripts, and no allowlist of
 *   hosts a script may come from, which is the part of older policies attackers walked
 *   through.
 * - **Styles** are the app's own stylesheet plus nonced inline `<style>`; the one
 *   concession is `style-src-attr 'unsafe-inline'`, because a server-rendered
 *   `style="width: 40%"` (the dashboard's bars) is an attribute, and an attribute cannot
 *   run script. Elements stay locked.
 * - **Connections** go to this origin, and to the object store the browser uploads files
 *   to with a presigned URL (CLAUDE.md §5.12): the only other place the browser talks to.
 * - Nothing may frame the app, embed an object, change `<base>`, or post a form anywhere
 *   else.
 *
 * Pure, so the shape of the policy can be tested without a browser; `proxy.ts` supplies
 * the nonce and the environment.
 */

export interface CspOptions {
  /** Fresh for every request: a nonce that repeats is an allowlist of one. */
  readonly nonce: string;
  /** React and the dev server need `eval` and a websocket; a production build needs neither. */
  readonly development: boolean;
  /** Only upgrade insecure requests when this one was secure, or a plain-http deployment breaks. */
  readonly https: boolean;
  /** Origins the browser may connect to besides this one: the object store's public address. */
  readonly connectOrigins: readonly string[];
  /**
   * Origins images may load from besides this one: the host of a configured logo or favicon
   * (ADR-0045). Nothing else is added to `img-src`, so one typo cannot open it to the internet.
   */
  readonly imgOrigins: readonly string[];
  /**
   * Origins that may frame this page. Only the hosted lead-form page ever passes any (ADR-0063 5.1),
   * from the form's own allowed origins; every other page leaves it out and nothing may frame it.
   * Each entry must be an origin (`originOf`), so one typo cannot put a path or a wildcard in a header.
   */
  readonly frameAncestors?: readonly string[] | undefined;
}

/** An origin, or null if the text is not an http(s) URL. Anything else never reaches a header. */
export function originOf(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

function frameAncestorsDirective(origins: readonly string[] | undefined): string {
  const allowed = [...new Set(origins ?? [])].filter((origin) => originOf(origin) === origin);
  return allowed.length === 0 ? "frame-ancestors 'none'" : `frame-ancestors ${allowed.join(' ')}`;
}

export function buildCsp(options: CspOptions): string {
  // A nonce is base64; refusing anything else keeps a header from being split by one.
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(options.nonce)) {
    throw new Error('A CSP nonce must be at least 16 characters of base64');
  }
  const nonce = `'nonce-${options.nonce}'`;

  const connect = ["'self'", ...new Set(options.connectOrigins)];
  if (options.development) connect.push('ws:', 'wss:');

  const directives: string[] = [
    "default-src 'self'",
    `script-src 'self' ${nonce} 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ''}`,
    // In development the dev server injects style tags it does not nonce.
    options.development ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' ${nonce}`,
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob:${[...new Set(options.imgOrigins)].map((origin) => ` ${origin}`).join('')}`,
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    frameAncestorsDirective(options.frameAncestors),
  ];
  if (options.https) directives.push('upgrade-insecure-requests');

  return directives.join('; ');
}
