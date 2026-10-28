import { Transform } from 'node:stream';
import { PUBLIC_FORM_BODY_MAX_BYTES } from '@crm/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * What is different about the one part of the API a stranger may reach (ADR-0063).
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

      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

      let seen = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          seen += chunk.length;
          (counter as Transform & { receivedEncodedLength?: number }).receivedEncodedLength = seen;
          if (seen > maxBytes) callback(tooLarge());
          else callback(null, chunk);
        },
      });
      // The source's own failure (a client that hangs up) must reach whoever reads the counter.
      payload.on('error', (error) => counter.destroy(error));
      return payload.pipe(counter);
    },
  );
}
