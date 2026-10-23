import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { DomainError, ErrorCode, RateLimitedError, isDomainError } from '@crm/core';
import type { FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import { currentRequestId } from './request-context.js';

/**
 * node-postgres gives up on a request that has waited `connectionTimeoutMillis` for a free
 * connection with exactly this message. It is not a bug in the request or the query: the API is
 * busier than its pool, which at a million records is what a few slow searches look like.
 */
function isPoolExhausted(exception: unknown): boolean {
  return (
    exception instanceof Error && exception.message === 'timeout exceeded when trying to connect'
  );
}

/** How long a client is asked to wait before trying again, in seconds. */
const BUSY_RETRY_AFTER_SECONDS = 2;

/**
 * Turns every thrown error into the `{ error: { code, message, details,
 * requestId } }` envelope (CLAUDE.md §8).
 *
 * An unrecognised error becomes a generic 500. Its details are logged and
 * never returned: stack traces and driver messages describe the schema,
 * the query and sometimes the data, and an error response is the cheapest
 * reconnaissance an attacker can do.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const requestId = currentRequestId();

    if (isDomainError(exception)) {
      this.logDomainError(exception);
      // A refused request says when to come back, in the header and nowhere else: the body must not
      // tell a caller how a limit is sized (CLAUDE.md §5.14).
      if (exception instanceof RateLimitedError && exception.retryAfterSeconds !== undefined) {
        void reply.header('Retry-After', String(exception.retryAfterSeconds));
      }
      void reply.status(exception.httpStatus).send({
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
          requestId,
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      void reply.status(status).send({
        error: {
          code: status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.VALIDATION_FAILED,
          message: exception.message,
          details: [],
          requestId,
        },
      });
      return;
    }

    // Overload is not an unexpected failure. Say so (503 and `Retry-After`) so a client backs off
    // instead of reporting an error or hammering a service that is already behind, and log one line,
    // not a stack trace per request: a flood of identical traces buries the cause.
    if (isPoolExhausted(exception)) {
      this.logger.warn({ code: ErrorCode.SERVICE_BUSY }, 'Database connection pool exhausted');
      void reply
        .status(503)
        .header('Retry-After', String(BUSY_RETRY_AFTER_SECONDS))
        .send({
          error: {
            code: ErrorCode.SERVICE_BUSY,
            message: 'The service is busy. Please try again in a moment.',
            details: [],
            requestId,
          },
        });
      return;
    }

    this.logger.error(
      { err: exception instanceof Error ? exception : new Error(String(exception)) },
      'Unhandled error',
    );
    void reply.status(500).send({
      error: {
        code: ErrorCode.INTERNAL,
        message: 'Something went wrong. Quote the request id if you contact support.',
        details: [],
        requestId,
      },
    });
  }

  /**
   * Authorization failures are logged at warn, not error: they are expected
   * traffic in a working system, but a burst of them is worth alerting on.
   */
  private logDomainError(error: DomainError): void {
    const level =
      error.code === ErrorCode.FORBIDDEN || error.code === ErrorCode.UNAUTHENTICATED
        ? 'warn'
        : 'info';
    this.logger[level]({ code: error.code, status: error.httpStatus }, error.message);
  }
}
