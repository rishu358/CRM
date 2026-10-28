import type { DeploymentMode } from '../deployment/index.js';

/**
 * Entitlements: which features a workspace has (ADR-0047, building on ADR-0010).
 *
 * One question, asked everywhere the same way: `entitlements.has(feature)`. No plan name appears in
 * business logic (CLAUDE.md §6; a lint rule rejects comparing a `plan`), so a change of packaging is a
 * change to the data in this file or to a workspace's overrides, never to the places that ask.
 *
 * Pure rules: no database and no clock, so the API, the operator command and the tests share one
 * definition. How the answer is stored and enforced is the API's business.
 */

/**
 * Every feature that can be switched on or off for a workspace. Declaring a feature is a promise that
 * the API enforces it, so a name is added here in the change that adds its check, never before.
 *
 * Rights the law gives a person over their own data (access, export of one's own data, erasure, the
 * data-rights module) are **never** features and never will be: a plan must not be able to withhold
 * them. A test keeps the list honest.
 */
export const FEATURES = ['imports', 'exports', 'web_forms'] as const;
export type Feature = (typeof FEATURES)[number];

export function isFeature(value: string): value is Feature {
  return (FEATURES as readonly string[]).includes(value);
}

/** What each feature is, for the operator command and the generated documentation. */
export const FEATURE_DESCRIPTIONS: Readonly<Record<Feature, string>> = {
  imports: 'Importing records from a CSV file (MVP_SPEC M8).',
  exports: 'Exporting records to a CSV file (MVP_SPEC M8). Not the data-rights export of a person.',
  web_forms: 'Website lead forms that turn a submission into a lead (ADR-0063).',
};

/**
 * The plan catalogue: which features each plan includes. **Data, not logic.**
 *
 * The pricing model is an open question for the founder (MVP_SPEC §14), so this ships with no
 * differences between plans: every plan includes every feature, and nothing changes for any workspace
 * until someone decides what a plan is. When they do, this table is the only thing that edits.
 */
export const PLAN_CATALOGUE: Readonly<Record<string, readonly Feature[]>> = {
  free: ['imports', 'exports', 'web_forms'],
  pro: ['imports', 'exports', 'web_forms'],
  enterprise: ['imports', 'exports', 'web_forms'],
};

export const PLANS: readonly string[] = Object.keys(PLAN_CATALOGUE);

export function isPlan(value: string): boolean {
  return Object.hasOwn(PLAN_CATALOGUE, value);
}

/**
 * A feature switched on or off for one workspace, whatever its plan includes: a pilot given a feature
 * early, a customer who has had one withdrawn. The operator writes these; a workspace never can.
 */
export interface EntitlementOverride {
  readonly feature: string;
  readonly enabled: boolean;
}

export interface EntitlementInput {
  readonly mode: DeploymentMode;
  /** The workspace's `plan`, as stored. A value the catalogue does not know includes nothing. */
  readonly plan: string;
  readonly overrides: readonly EntitlementOverride[];
}

export interface Entitlements {
  has(feature: Feature): boolean;
  /** Every feature and whether it is on, for screens that adapt and for the operator's view. */
  snapshot(): Readonly<Record<Feature, boolean>>;
}

/**
 * The answer for one workspace.
 *
 * - A single-tenant installation has every feature: the operator owns it, there is nothing to sell
 *   and nobody to withhold from, and plans and overrides are not consulted.
 * - Otherwise the plan's features, then each override on top (an override may switch a feature on or
 *   off). A plan the catalogue does not know includes nothing: default deny (CLAUDE.md §5.3), so a
 *   mistyped plan fails closed rather than open.
 * - An override for a feature that no longer exists is ignored.
 */
export function resolveEntitlements(input: EntitlementInput): Entitlements {
  const state = {} as Record<Feature, boolean>;

  if (input.mode === 'single_tenant') {
    for (const feature of FEATURES) state[feature] = true;
  } else {
    const included = Object.hasOwn(PLAN_CATALOGUE, input.plan)
      ? (PLAN_CATALOGUE[input.plan] ?? [])
      : [];
    for (const feature of FEATURES) state[feature] = included.includes(feature);
    for (const override of input.overrides) {
      if (isFeature(override.feature)) state[override.feature] = override.enabled;
    }
  }

  const frozen = Object.freeze({ ...state });
  return {
    has: (feature) => frozen[feature],
    snapshot: () => frozen,
  };
}
