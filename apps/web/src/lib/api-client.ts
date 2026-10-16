/**
 * The browser's only route to the API (CLAUDE.md §9, ADR-0007).
 *
 * Requests go to this app's `/api/proxy/*` route handler, which attaches the
 * session token server-side from an httpOnly cookie. The token therefore never
 * exists in JavaScript, so script injected into the page cannot read it, and
 * there is no cross-origin cookie to configure.
 *
 * It is a credential-attaching proxy, not a second API: it forwards to the same
 * versioned `/api/v1` the mobile app and public API clients will use, and adds
 * no endpoint of its own.
 */
export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details: readonly { path?: string; message: string }[];
  readonly requestId: string;
  readonly status: number;
}

export class ApiRequestError extends Error {
  constructor(readonly error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
  }

  get status(): number {
    return this.error.status;
  }

  get code(): string {
    return this.error.code;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  // An error response is not guaranteed to be JSON — a proxy or a crash can
  // return HTML — so a parse failure falls back rather than throwing over the
  // top of the error we are trying to report.
  const body: unknown = await response.json().catch(() => null);

  const envelope =
    typeof body === 'object' && body !== null && 'error' in body
      ? ((body as { error: Record<string, unknown> }).error ?? {})
      : {};

  return {
    code: typeof envelope['code'] === 'string' ? envelope['code'] : 'INTERNAL',
    message: typeof envelope['message'] === 'string' ? envelope['message'] : 'Request failed',
    details: Array.isArray(envelope['details'])
      ? (envelope['details'] as { path?: string; message: string }[])
      : [],
    requestId: typeof envelope['requestId'] === 'string' ? envelope['requestId'] : '',
    status: response.status,
  };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await globalThis.fetch(`/api/proxy${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new ApiRequestError(await toApiError(response));
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => call<T>(path, { method: 'GET' }),
  post: <T>(path: string, body: unknown) =>
    call<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    call<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => call<T>(path, { method: 'DELETE' }),
};

export interface ListEnvelope<T> {
  readonly data: T[];
  readonly meta: { nextCursor: string | null; hasMore: boolean };
}

export interface ItemEnvelope<T> {
  readonly data: T;
}
