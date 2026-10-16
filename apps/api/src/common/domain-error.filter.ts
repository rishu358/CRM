import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { DomainError, ErrorCode, isDomainError } from '@crm/core';
import type { FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import { currentRequestId } from './request-context.js';

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
