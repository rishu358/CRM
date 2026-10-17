import { describe, expect, it } from 'vitest';
import { dealCreateSchema, dealUpdateSchema } from './deals.js';

/**
 * Schema-level rules for deals. The behaviour built on them — stage
 * transitions, the closed-state rules — is covered in
 * `apps/api/src/modules/deals/deals.spec.ts`.
 */

describe('dealCreateSchema', () => {
  it('accepts a minimal valid deal', () => {
    expect(dealCreateSchema.safeParse({ name: 'Diwali order' }).success).toBe(true);
  });

  it('requires a name that is more than whitespace', () => {
    expect(dealCreateSchema.safeParse({}).success).toBe(false);
    expect(dealCreateSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('rejects unknown keys, including tenantId (CLAUDE.md §5.2, §5.6)', () => {
    expect(dealCreateSchema.safeParse({ name: 'x', tenantId: crypto.randomUUID() }).success).toBe(
      false,
    );
    expect(dealCreateSchema.safeParse({ name: 'x', isWon: true }).success).toBe(false);
  });

  it('does not let a client set closedAt: the stage decides it (ADR-0020)', () => {
    const result = dealCreateSchema.safeParse({ name: 'x', closedAt: '2026-01-01T00:00:00Z' });
    expect(result.success).toBe(false);
  });

  it('takes money as a string of minor units, never a number', () => {
    expect(
      dealCreateSchema.safeParse({ name: 'x', amount: { amountMinor: '150075', currency: 'inr' } }),
    ).toMatchObject({ success: true, data: { amount: { currency: 'INR' } } });
    expect(
      dealCreateSchema.safeParse({ name: 'x', amount: { amountMinor: 150075, currency: 'INR' } })
        .success,
    ).toBe(false);
    expect(
      dealCreateSchema.safeParse({ name: 'x', amount: { amountMinor: '-5', currency: 'INR' } })
        .success,
    ).toBe(false);
    expect(
      dealCreateSchema.safeParse({ name: 'x', amount: { amountMinor: '15.5', currency: 'INR' } })
        .success,
    ).toBe(false);
  });

  it('bounds probability to whole percent', () => {
    for (const probability of [-1, 101, 12.5]) {
      expect(dealCreateSchema.safeParse({ name: 'x', probability }).success, `${probability}`).toBe(
        false,
      );
    }
    expect(dealCreateSchema.safeParse({ name: 'x', probability: 40 }).success).toBe(true);
  });

  it('wants a calendar date, not a timestamp', () => {
    expect(dealCreateSchema.safeParse({ name: 'x', expectedCloseDate: '2026-12-31' }).success).toBe(
      true,
    );
    expect(
      dealCreateSchema.safeParse({ name: 'x', expectedCloseDate: '2026-12-31T10:00:00Z' }).success,
    ).toBe(false);
    expect(dealCreateSchema.safeParse({ name: 'x', expectedCloseDate: '31/12/2026' }).success).toBe(
      false,
    );
  });

  it('refuses a blank lost reason rather than storing one', () => {
    expect(dealCreateSchema.safeParse({ name: 'x', lostReason: '   ' }).success).toBe(false);
  });

  it('caps the people on a deal', () => {
    const contacts = Array.from({ length: 51 }, () => ({ contactId: crypto.randomUUID() }));
    expect(dealCreateSchema.safeParse({ name: 'x', contacts }).success).toBe(false);
  });
});

describe('dealUpdateSchema', () => {
  it('requires the version, so a drag cannot be last-write-wins', () => {
    expect(dealUpdateSchema.safeParse({ stageId: crypto.randomUUID() }).success).toBe(false);
    expect(dealUpdateSchema.safeParse({ stageId: crypto.randomUUID(), version: 1 }).success).toBe(
      true,
    );
  });

  it('coerces a version that arrives as a string', () => {
    expect(dealUpdateSchema.parse({ version: '3' }).version).toBe(3);
  });
});
