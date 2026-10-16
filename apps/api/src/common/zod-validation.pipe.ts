import { Injectable, type PipeTransform } from '@nestjs/common';
import { ValidationError, type ErrorDetail } from '@crm/core';
import type { ZodType } from 'zod';

/**
 * Validate at the API boundary with Zod (CLAUDE.md §5.6).
 *
 * The schema's own `.strict()` does the rejecting of unknown keys; this pipe
 * only turns a Zod failure into our error envelope. Validation returns the
 * **parsed** value, not the input, so downstream code sees coerced and
 * normalised data (a lowercased email, a number from a query string) rather
 * than whatever arrived on the wire.
 */
export function zodPipe<T>(schema: ZodType<T>): PipeTransform<unknown, T> {
  @Injectable()
  class ZodValidationPipe implements PipeTransform<unknown, T> {
    transform(value: unknown): T {
      const result = schema.safeParse(value);
      if (result.success) return result.data;

      const details: ErrorDetail[] = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      throw new ValidationError(details);
    }
  }

  return new ZodValidationPipe();
}
