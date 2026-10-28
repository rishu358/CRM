import { isFormKeyShape } from '@crm/core';
import type { PublicFormDefinition } from '@crm/contracts';
import { upstreamPath } from './proxy-path';

/**
 * The web server's one way to read a website lead form's public definition (ADR-0065 5.1).
 *
 * Used by the hosted page (to draw the form) and by `proxy.ts` (to learn which sites may frame it).
 * It talks only to `API_URL`, a fixed origin from configuration, on a path built by `upstreamPath`
 * from a key whose shape is checked first; it sends no credential of any kind, whatever the visitor's
 * request carried (the public route reads none). A key that does not work, a form that is off, an
 * API that is down, a slow answer: all of them are `null`, and the caller shows the same
 * "not available" page for each, which is what the API's own uniform 404 is for.
 */

const TIMEOUT_MS = 4000;

export type PublicFormResult =
  { readonly kind: 'form'; readonly form: PublicFormDefinition } | { readonly kind: 'unavailable' };

export async function fetchPublicForm(options: {
  apiUrl: string;
  key: string;
  clientAddress?: Record<string, string>;
  fetchFn?: typeof fetch;
}): Promise<PublicFormResult> {
  if (!isFormKeyShape(options.key)) return { kind: 'unavailable' };
  const path = upstreamPath(['public', 'forms', options.key]);
  if (path === null) return { kind: 'unavailable' };

  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(new URL(path, options.apiUrl), {
      method: 'GET',
      headers: { ...options.clientAddress },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { kind: 'unavailable' };
    const body = (await response.json()) as { data?: PublicFormDefinition };
    return body.data === undefined ? { kind: 'unavailable' } : { kind: 'form', form: body.data };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** The key out of `/f/<key>` (and nothing after it), or null. */
export function keyFromFormPath(pathname: string): string | null {
  const match = /^\/f\/([^/]+)\/?$/.exec(pathname);
  return match?.[1] ?? null;
}
