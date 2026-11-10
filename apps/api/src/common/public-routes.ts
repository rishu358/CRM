import { Readable, Transform } from 'node:stream';
import { EMAIL_EVENT_BODY_MAX_BYTES, PUBLIC_FORM_BODY_MAX_BYTES } from '@crm/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * What is different about the one part of the API a stranger may reach (ADR-0065).
 *
 * Everything else sits behind the session guard. The routes under this prefix are the deliberate,
 * narrowly defined exception to "unauthenticated requests get 401" (CLAUDE.md §10(d)), so the things
 * that must be true of them and of nothing else live here, in one place: how big a body may be before
 * it is read, and that the browser's cross-origin approval is never given.
 */
export const PUBLIC_API_PREFIX = '/api/v1/public/';

/** Is this request for one of the public routes? Judged on the path only, never the query. */
export function isPublicApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path.startsWith(PUBLIC_API_PREFIX);
}

/**
 * The part of the public prefix the mail service calls (ADR-0075). Its bodies are the provider's, signed over
 * their exact bytes, so they are larger than a contact form's (a batch is possible) and are kept raw.
 */
export const EMAIL_EVENTS_PREFIX = `${PUBLIC_API_PREFIX}email-events/`;

export function isEmailEventsPath(url: string): boolean {
  return (url.split('?')[0] ?? '').startsWith(EMAIL_EVENTS_PREFIX);
}

/** How big a public body may be: a form's, or (only on the events address) the larger one a provider needs. */
function bodyLimitFor(url: string, formLimit: number): number {
  return isEmailEventsPath(url) ? EMAIL_EVENT_BODY_MAX_BYTES : formLimit;
}

/** Fastify's own code for a body over the limit, so the error filter answers it as it does a parser's. */
const BODY_TOO_LARGE = { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE' } as const;

function tooLarge(): Error {
  return Object.assign(new Error('Request body is too large'), BODY_TOO_LARGE);
}

/**
 * Cap the body of a public request before anything reads it: a declared length over the cap is refused
 * outright, and a body that lies about its length (or has none, chunked) is cut off as it passes the cap.
 * The global limit is 2 MB, which is right for the authenticated API and far too much for a contact form.
 */
export function limitPublicBodies(
  instance: FastifyInstance,
  maxBytes: number = PUBLIC_FORM_BODY_MAX_BYTES,
): void {
  instance.addHook(
    'preParsing',
    async (request: FastifyRequest, _reply: FastifyReply, payload: NodeJS.ReadableStream) => {
      if (!isPublicApiPath(request.url)) return payload;

      const limit = bodyLimitFor(request.url, maxBytes);
      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) throw tooLarge();

      let seen = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          seen += chunk.length;
          (counter as Transform & { receivedEncodedLength?: number }).receivedEncodedLength = seen;
          if (seen > limit) callback(tooLarge());
          else callback(null, chunk);
        },
      });
      // The source's own failure (a client that hangs up) must reach whoever reads the counter.
      payload.on('error', (error: Error) => counter.destroy(error));
      return payload.pipe(counter);
    },
  );
}

/** The exact bytes of a request on the events address, as text, kept for the signature check. */
const RAW_BODIES = new WeakMap<object, string>();

export function rawBodyOf(request: FastifyRequest): string | null {
  return RAW_BODIES.get(request) ?? null;
}

/**
 * Keep the raw body of a request to the events address (ADR-0075).
 *
 * A signature is over the bytes the provider sent: parsing the JSON and writing it out again would change
 * them, so the check needs the original. This reads the (already capped) stream into memory, remembers it,
 * and hands the parser a fresh stream of the same bytes. It does this for the events address and nothing
 * else, so no other route's body is ever buffered twice.
 */
export function captureRawBody(instance: FastifyInstance): void {
  instance.addHook(
    'preParsing',
    async (request: FastifyRequest, _reply: FastifyReply, payload: NodeJS.ReadableStream) => {
      if (!isEmailEventsPath(request.url)) return payload;

      const chunks: Buffer[] = [];
      for await (const chunk of payload) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const body = Buffer.concat(chunks);
      RAW_BODIES.set(request, body.toString('utf8'));

      const replay = Readable.from([body]);
      (replay as Readable & { receivedEncodedLength?: number }).receivedEncodedLength = body.length;
      return replay;
    },
  );
}
