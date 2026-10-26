import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import {
  DEFAULT_OUTBOUND_URL_POLICY,
  checkOutboundUrl,
  classifyAddress,
  type AddressDecision,
  type OutboundUrlPolicy,
} from '@crm/core';
import {
  DEFAULT_OUTBOUND_LIMITS,
  OutboundError,
  type OutboundHttp,
  type OutboundLimits,
  type OutboundMethod,
  type OutboundRequest,
  type OutboundResponse,
  type ResolvedAddress,
} from './types.js';

/**
 * The guarded client (CLAUDE.md §5.13, ADR-0040).
 *
 * Four properties, each of which is a way this class of bug has been exploited:
 *
 * 1. **It resolves the name itself and connects to the address it checked.** A check
 *    done on one lookup and a connection made on another is DNS rebinding: the name
 *    answers with a public address for the check and a private one for the connect. Here
 *    there is one lookup per hop, every answer is judged, and the socket is given that
 *    address directly, so there is no second lookup to lie.
 * 2. **Every address of the answer must be allowed**, not just the first. A name that
 *    resolves to a public and a private address is refused, because which one a
 *    connection uses is not ours to bet on.
 * 3. **Redirects are followed by hand.** Each hop is parsed, judged and resolved afresh,
 *    so a public URL that redirects to `http://169.254.169.254/` is refused at the hop,
 *    and credentials are dropped when the origin changes.
 * 4. **Time and size are bounded.** One deadline for the whole exchange, so a server that
 *    trickles bytes cannot hold a worker; a streaming byte cap, so one that never stops
 *    cannot fill memory; no decompression, so a small body cannot expand into a large one.
 *
 * What it deliberately is not: a general HTTP client. No cookies, no keep-alive, no proxy
 * support, no `Set-Cookie` in the result. It fetches a thing and returns it.
 */

export interface GuardedClientOptions {
  readonly urlPolicy?: OutboundUrlPolicy;
  /** Test seam and nothing else: what the name resolves to. Answers are still judged. */
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly limits?: Partial<OutboundLimits>;
  readonly userAgent?: string;
  /**
   * The rule for a resolved address. **Never set in production code**: the public
   * constructor does not accept it, and `@crm/outbound/testing` is the only caller.
   */
  readonly addressRule?: (address: string) => AddressDecision;
}

/** Headers a caller may not set: the client owns the framing and the identity of a request. */
const CLIENT_OWNED = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'te',
  'upgrade',
  'expect',
  'cookie',
  'accept-encoding',
]);

/** What survives a redirect to another origin. Anything else a caller attached stays behind. */
const SAFE_ACROSS_ORIGINS = new Set(['accept', 'accept-language', 'user-agent', 'content-type']);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function defaultResolve(hostname: string): Promise<readonly ResolvedAddress[]> {
  return dns.promises
    .lookup(hostname, { all: true, verbatim: true })
    .then((answers) =>
      answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 })),
    );
}

/** A header value containing one of these could end the header and begin another. */
function hasLineBreakOrNul(value: string): boolean {
  return value.includes('\r') || value.includes('\n') || value.includes('\u0000');
}

function cleanHeaders(input: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input ?? {})) {
    const name = rawName.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new OutboundError('invalid_request', `Invalid header name: ${rawName}`);
    }
    if (hasLineBreakOrNul(value)) {
      throw new OutboundError('invalid_request', `Invalid header value for ${name}`);
    }
    if (CLIENT_OWNED.has(name) || name.startsWith('proxy-')) {
      throw new OutboundError('invalid_request', `Header ${name} is set by the client`);
    }
    out[name] = value;
  }
  return out;
}

/**
 * A `lookup` for `net.connect` that answers with the address already judged, whatever name it
 * is asked about. Node asks with `all: true` when it may try several addresses and without it
 * otherwise; both shapes get the one address, so there is never a second resolution to lie.
 */
export function pinnedLookup(
  address: string,
  family: 4 | 6,
): (
  name: string,
  options: unknown,
  callback: (
    error: null,
    address: string | { address: string; family: number }[],
    family?: number,
  ) => void,
) => void {
  return (_name, options, callback) => {
    const wantsAll =
      typeof options === 'object' && options !== null && 'all' in options && options.all === true;
    if (wantsAll) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

interface Target {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
}

export class GuardedOutboundHttp implements OutboundHttp {
  private readonly urlPolicy: OutboundUrlPolicy;
  private readonly resolve: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  private readonly limits: OutboundLimits;
  private readonly userAgent: string;
  private readonly addressRule: (address: string) => AddressDecision;

  constructor(options: GuardedClientOptions = {}) {
    this.urlPolicy = options.urlPolicy ?? DEFAULT_OUTBOUND_URL_POLICY;
    this.resolve = options.resolve ?? defaultResolve;
    this.limits = { ...DEFAULT_OUTBOUND_LIMITS, ...options.limits };
    this.userAgent = options.userAgent ?? 'crm-outbound/1';
    this.addressRule = options.addressRule ?? classifyAddress;
  }

  async request(request: OutboundRequest): Promise<OutboundResponse> {
    const timeoutMs = request.timeoutMs ?? this.limits.timeoutMs;
    const maxBytes = request.maxResponseBytes ?? this.limits.maxResponseBytes;
    const maxRedirects = request.maxRedirects ?? this.limits.maxRedirects;
    const deadline = Date.now() + timeoutMs;

    let method: OutboundMethod = request.method ?? 'GET';
    let headers = cleanHeaders(request.headers);
    let body: Uint8Array | undefined =
      request.body === undefined
        ? undefined
        : typeof request.body === 'string'
          ? new TextEncoder().encode(request.body)
          : request.body;
    if (body !== undefined && body.byteLength > this.limits.maxRequestBytes) {
      throw new OutboundError('invalid_request', 'The request body is too large');
    }

    let current = request.url;
    const redirects: string[] = [];

    for (let hop = 0; ; hop += 1) {
      const target = await this.prepare(current, deadline);
      const response = await this.send(target, method, headers, body, deadline, maxBytes);

      const location = response.headers['location'];
      if (!REDIRECT_STATUSES.has(response.status) || location === undefined) {
        return { ...response, url: target.url.href, redirects };
      }

      if (hop >= maxRedirects) {
        throw new OutboundError('too_many_redirects', `More than ${maxRedirects} redirects`);
      }

      let next: URL;
      try {
        next = new URL(location, target.url);
      } catch {
        throw new OutboundError('blocked', 'The redirect target is not a URL', 'malformed');
      }
      redirects.push(next.href);

      // A hop to another origin must not carry what the caller attached for the first one.
      if (next.origin !== target.url.origin) {
        headers = Object.fromEntries(
          Object.entries(headers).filter(([name]) => SAFE_ACROSS_ORIGINS.has(name)),
        );
      }
      // 303, and 301/302 after a POST, become a GET with no body, as browsers do.
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        method = 'GET';
        body = undefined;
        delete headers['content-type'];
      }
      current = next.href;
    }
  }

  /** Judge the URL, resolve the name once, judge every answer. */
  private async prepare(input: string, deadline: number): Promise<Target> {
    const checked = checkOutboundUrl(input, this.urlPolicy, this.addressRule);
    if (!checked.ok) {
      throw new OutboundError('blocked', `Refused: ${checked.reason}`, checked.reason);
    }
    const url = checked.url;

    if (checked.hostIsAddress) {
      const literal = url.hostname.replace(/^\[|\]$/g, '');
      const decision = this.addressRule(literal);
      if (!decision.allowed) {
        throw new OutboundError('blocked', `Refused: ${decision.reason}`, decision.reason);
      }
      return { url, address: literal, family: decision.family };
    }

    const hostname = url.hostname.replace(/\.$/, '');
    let answers: readonly ResolvedAddress[];
    try {
      answers = await this.withDeadline(this.resolve(hostname), deadline);
    } catch (error) {
      if (error instanceof OutboundError) throw error;
      throw new OutboundError('dns', `Could not resolve ${hostname}`);
    }
    if (answers.length === 0) throw new OutboundError('dns', `${hostname} has no address`);

    for (const answer of answers) {
      const decision = this.addressRule(answer.address);
      if (!decision.allowed) {
        throw new OutboundError(
          'blocked',
          `Refused: ${hostname} resolves to a ${decision.reason} address`,
          'dns_blocked',
        );
      }
    }
    const first = answers[0];
    if (first === undefined) throw new OutboundError('dns', `${hostname} has no address`);
    return { url, address: first.address, family: first.family };
  }

  private withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new OutboundError('timeout', 'Timed out'));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new OutboundError('timeout', 'Timed out')), remaining);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private send(
    target: Target,
    method: OutboundMethod,
    headers: Record<string, string>,
    body: Uint8Array | undefined,
    deadline: number,
    maxBytes: number,
  ): Promise<Omit<OutboundResponse, 'url' | 'redirects'>> {
    const { url, address, family } = target;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new OutboundError('timeout', 'Timed out'));

    const secure = url.protocol === 'https:';
    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const isLiteral = /^[0-9.]+$/.test(hostname) || hostname.includes(':');

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };

      const requestHeaders: Record<string, string | number> = {
        ...headers,
        host: url.host,
        'user-agent': headers['user-agent'] ?? this.userAgent,
        // Identity only: a small compressed body must not be able to expand past the cap.
        'accept-encoding': 'identity',
        connection: 'close',
      };
      if (body !== undefined) requestHeaders['content-length'] = body.byteLength;

      const client = secure ? https : http;
      const req = client.request({
        host: hostname,
        port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method,
        headers: requestHeaders,
        agent: false,
        // The pinned address. Node asks for it with `all: true` on recent versions.
        lookup: pinnedLookup(address, family),
        ...(secure && !isLiteral ? { servername: hostname } : {}),
      });

      const timer = setTimeout(() => {
        req.destroy();
        finish(() => reject(new OutboundError('timeout', 'Timed out')));
      }, remaining);

      req.on('error', (error) =>
        finish(() => reject(new OutboundError('network', `Connection failed: ${error.message}`))),
      );

      req.on('response', (res) => {
        const declared = Number(res.headers['content-length']);
        // A HEAD response describes a body it does not send, so its length is not a size to refuse.
        if (
          method !== 'HEAD' &&
          Number.isFinite(declared) &&
          declared > maxBytes &&
          !REDIRECT_STATUSES.has(res.statusCode ?? 0)
        ) {
          // Settle first: destroying a response emits `aborted`, and the reason this request
          // failed is the size, not the abort we caused.
          finish(() => reject(new OutboundError('too_large', 'The response is too large')));
          res.destroy();
          req.destroy();
          return;
        }

        const flat: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (name === 'set-cookie' || value === undefined) continue;
          flat[name] = Array.isArray(value) ? value.join(', ') : value;
        }
        const status = res.statusCode ?? 0;

        // A redirect's body is not wanted, and is never read.
        if (REDIRECT_STATUSES.has(status) && flat['location'] !== undefined) {
          finish(() => resolve({ status, headers: flat, body: new Uint8Array(0) }));
          res.destroy();
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > maxBytes) {
            finish(() => reject(new OutboundError('too_large', 'The response is too large')));
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(() =>
            resolve({ status, headers: flat, body: new Uint8Array(Buffer.concat(chunks)) }),
          ),
        );
        res.on('error', (error) =>
          finish(() => reject(new OutboundError('network', `Response failed: ${error.message}`))),
        );
        res.on('aborted', () =>
          finish(() => reject(new OutboundError('network', 'The connection was closed early'))),
        );
      });

      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}
