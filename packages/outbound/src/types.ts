import type { BlockReason, UrlRefusal } from '@crm/core';

/**
 * The one way this system makes a request to an address somebody else chose
 * (CLAUDE.md §5.13, ADR-0040).
 *
 * Webhooks, URL previews and anything like them go through `OutboundHttp`, never
 * through `fetch`. The implementation refuses private, loopback, link-local and
 * metadata addresses, resolves the name itself and connects to the address it
 * checked, follows redirects one hop at a time re-checking each, and bounds time and
 * size. A source-scanning test fails the build if a raw network call appears elsewhere.
 */

export type OutboundMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface OutboundRequest {
  readonly url: string;
  readonly method?: OutboundMethod;
  /**
   * Headers to send. `Host`, `Cookie`, `Content-Length`, `Transfer-Encoding`,
   * `Connection` and `Proxy-*` are the client's to set and are refused here.
   */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
}

export interface OutboundResponse {
  readonly status: number;
  /** Lowercase names. `Set-Cookie` is never returned: nothing here keeps a session. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** Where the response actually came from, after any redirects. */
  readonly url: string;
  readonly redirects: readonly string[];
}

export interface OutboundHttp {
  request(request: OutboundRequest): Promise<OutboundResponse>;
}

export type OutboundErrorCode =
  | 'blocked'
  | 'timeout'
  | 'too_large'
  | 'too_many_redirects'
  | 'invalid_request'
  | 'dns'
  | 'network';

export class OutboundError extends Error {
  constructor(
    readonly code: OutboundErrorCode,
    message: string,
    /** For `blocked`: why, in the vocabulary of the rules, so it can be logged and counted. */
    readonly reason?: UrlRefusal | BlockReason | 'dns_blocked',
  ) {
    super(message);
    this.name = 'OutboundError';
  }
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface OutboundLimits {
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRequestBytes: number;
  readonly maxRedirects: number;
}

export const DEFAULT_OUTBOUND_LIMITS: OutboundLimits = {
  timeoutMs: 10_000,
  maxResponseBytes: 1_048_576,
  maxRequestBytes: 1_048_576,
  maxRedirects: 3,
};
