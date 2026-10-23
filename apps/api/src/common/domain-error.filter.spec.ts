import type { ArgumentsHost } from '@nestjs/common';
import { ErrorCode } from '@crm/core';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { DomainErrorFilter } from './domain-error.filter.js';

/**
 * How the API answers when it is overloaded rather than wrong (ADR-0041).
 *
 * Found by the load test: past the pool's capacity the API answered a generic 500 with a stack
 * trace per request. Overload is not an unexpected failure, and a client that is told "500" reports
 * an error where one told "503, retry in two seconds" waits.
 */
function harness() {
  const sent: { status?: number; headers: Record<string, string>; body?: unknown } = {
    headers: {},
  };
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    header(name: string, value: string) {
      sent.headers[name] = value;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const host = { switchToHttp: () => ({ getResponse: () => reply }) } as unknown as ArgumentsHost;
  return { filter: new DomainErrorFilter(logger as unknown as Logger), host, sent, logger };
}

describe('an exhausted connection pool', () => {
  it('is a 503 with Retry-After and a stable code, not a 500', () => {
    const { filter, host, sent } = harness();
    filter.catch(new Error('timeout exceeded when trying to connect'), host);
    expect(sent.status).toBe(503);
    expect(sent.headers['Retry-After']).toBe('2');
    expect((sent.body as { error: { code: string } }).error.code).toBe(ErrorCode.SERVICE_BUSY);
  });

  it('logs one warning, not an error with a stack trace', () => {
    const { filter, host, logger } = harness();
    filter.catch(new Error('timeout exceeded when trying to connect'), host);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('says nothing about the driver, the query or the schema', () => {
    const { filter, host, sent } = harness();
    filter.catch(new Error('timeout exceeded when trying to connect'), host);
    const text = JSON.stringify(sent.body);
    expect(text).not.toMatch(/timeout exceeded|pool|postgres|connect/i);
  });
});

describe('any other unexpected error', () => {
  it('is still a generic 500 with no detail, logged as an error', () => {
    const { filter, host, sent, logger } = harness();
    filter.catch(new Error('relation "contacts" does not exist'), host);
    expect(sent.status).toBe(500);
    expect(JSON.stringify(sent.body)).not.toContain('contacts');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(sent.headers['Retry-After']).toBeUndefined();
  });

  it('does not take a similar message for the pool', () => {
    const { filter, host, sent } = harness();
    filter.catch(new Error('timeout exceeded when trying to connect to the mail server'), host);
    expect(sent.status).toBe(500);
  });
});
