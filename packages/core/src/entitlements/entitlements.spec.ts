import { describe, expect, it } from 'vitest';
import {
  FEATURES,
  FEATURE_DESCRIPTIONS,
  PLANS,
  PLAN_CATALOGUE,
  isFeature,
  isPlan,
  resolveEntitlements,
  type EntitlementInput,
  type Feature,
} from './index.js';

const base: EntitlementInput = { mode: 'multi_tenant', plan: 'free', overrides: [] };

describe('the feature list', () => {
  it('describes every feature, and only features', () => {
    expect(Object.keys(FEATURE_DESCRIPTIONS).sort()).toEqual([...FEATURES].sort());
  });

  it('never makes a data-subject right something a plan can withhold', () => {
    // Access, erasure and the data-rights module belong to the person, not to a price list.
    for (const feature of FEATURES) {
      expect(feature).not.toMatch(/data_rights|erasure|access_request|dsar|privacy/);
    }
  });

  it('knows a feature when it sees one', () => {
    expect(isFeature('exports')).toBe(true);
    expect(isFeature('time_travel')).toBe(false);
    expect(isFeature('constructor')).toBe(false);
  });
});

describe('the plan catalogue', () => {
  it('only names features that exist', () => {
    for (const features of Object.values(PLAN_CATALOGUE)) {
      for (const feature of features) expect(isFeature(feature)).toBe(true);
    }
  });

  it('ships with no difference between plans, so no workspace loses anything', () => {
    for (const plan of PLANS) {
      expect([...(PLAN_CATALOGUE[plan] ?? [])].sort()).toEqual([...FEATURES].sort());
    }
  });

  it('knows its plans and nothing inherited from Object', () => {
    expect(isPlan('free')).toBe(true);
    expect(isPlan('platinum')).toBe(false);
    expect(isPlan('toString')).toBe(false);
  });
});

describe('resolveEntitlements', () => {
  it('gives a plan the features the catalogue lists', () => {
    const entitlements = resolveEntitlements(base);
    for (const feature of FEATURES) expect(entitlements.has(feature)).toBe(true);
  });

  it('lets an override withdraw a feature the plan includes', () => {
    const entitlements = resolveEntitlements({
      ...base,
      overrides: [{ feature: 'exports', enabled: false }],
    });
    expect(entitlements.has('exports')).toBe(false);
    expect(entitlements.has('imports')).toBe(true);
  });

  it('lets an override grant a feature the plan does not include', () => {
    const unknownPlan = resolveEntitlements({
      ...base,
      plan: 'pilot',
      overrides: [{ feature: 'imports', enabled: true }],
    });
    expect(unknownPlan.has('imports')).toBe(true);
    expect(unknownPlan.has('exports')).toBe(false);
  });

  it('fails closed on a plan it does not know', () => {
    for (const plan of ['', 'platinum', 'toString', '__proto__', 'FREE']) {
      const entitlements = resolveEntitlements({ ...base, plan });
      for (const feature of FEATURES) expect(entitlements.has(feature)).toBe(false);
    }
  });

  it('ignores an override for a feature that does not exist', () => {
    const entitlements = resolveEntitlements({
      ...base,
      overrides: [{ feature: 'time_travel', enabled: true }],
    });
    expect(Object.keys(entitlements.snapshot()).sort()).toEqual([...FEATURES].sort());
  });

  it('gives a single-tenant installation everything, whatever the plan or overrides say', () => {
    const entitlements = resolveEntitlements({
      mode: 'single_tenant',
      plan: 'nonsense',
      overrides: FEATURES.map((feature) => ({ feature, enabled: false })),
    });
    for (const feature of FEATURES) expect(entitlements.has(feature)).toBe(true);
  });

  it('hands out a snapshot that cannot be edited to change the answer', () => {
    const entitlements = resolveEntitlements({
      ...base,
      overrides: [{ feature: 'exports', enabled: false }],
    });
    const snapshot = entitlements.snapshot() as Record<Feature, boolean>;
    expect(() => {
      snapshot.exports = true;
    }).toThrow();
    expect(entitlements.has('exports')).toBe(false);
  });
});
