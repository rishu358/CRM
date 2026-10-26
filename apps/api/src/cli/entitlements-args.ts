import { FEATURES, FEATURE_DESCRIPTIONS, PLANS } from '@crm/core';

/**
 * Arguments of the entitlements command (`pnpm tenant:entitlements`, ADR-0047).
 *
 * Nothing secret is taken here, so everything is an ordinary argument. Every change to a workspace
 * needs `--workspace`, and an exception needs `--reason`: an override nobody can explain is the first
 * one deleted by mistake, or kept for years.
 */
export const USAGE = `Choose a workspace's plan, and switch features on or off for it.

Usage:
  pnpm tenant:entitlements features
  pnpm tenant:entitlements show    --workspace <workspace>
  pnpm tenant:entitlements plan    --workspace <workspace> --plan <plan>
  pnpm tenant:entitlements grant   --workspace <workspace> --feature <feature> --reason "<why>"
  pnpm tenant:entitlements revoke  --workspace <workspace> --feature <feature> --reason "<why>"
  pnpm tenant:entitlements clear   --workspace <workspace> --feature <feature>

  features   List the features and the plans.
  show       A workspace's plan, its exceptions and what it effectively has.
  plan       Move a workspace to a plan.
  grant      Give one workspace a feature, whatever its plan includes.
  revoke     Take a feature away from one workspace, whatever its plan includes.
  clear      Remove an exception, so the plan decides again.

The workspace is named by its id (printed by tenant:create) or by its slug.
A single-tenant installation (DEPLOYMENT_MODE=single_tenant) has every feature on; exceptions there
would do nothing and are refused.
`;

export type ParsedArgs =
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'features' }
  | { readonly kind: 'show'; readonly workspace: string }
  | { readonly kind: 'plan'; readonly workspace: string; readonly plan: string }
  | {
      readonly kind: 'grant' | 'revoke';
      readonly workspace: string;
      readonly feature: string;
      readonly reason: string;
    }
  | { readonly kind: 'clear'; readonly workspace: string; readonly feature: string };

const VALUE_FLAGS = ['--workspace', '--plan', '--feature', '--reason'] as const;

/** Which flags each command needs. */
const REQUIRED: Readonly<Record<string, readonly (typeof VALUE_FLAGS)[number][]>> = {
  features: [],
  show: ['--workspace'],
  plan: ['--workspace', '--plan'],
  grant: ['--workspace', '--feature', '--reason'],
  revoke: ['--workspace', '--feature', '--reason'],
  clear: ['--workspace', '--feature'],
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    return { kind: 'help' };
  }
  const required = REQUIRED[command];
  if (required === undefined) return { kind: 'error', message: `Unknown command: ${command}` };

  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (!(VALUE_FLAGS as readonly string[]).includes(arg)) {
      return { kind: 'error', message: `Unknown argument: ${arg}` };
    }
    if (!required.includes(arg as (typeof VALUE_FLAGS)[number])) {
      return { kind: 'error', message: `${arg} is not used by "${command}"` };
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { kind: 'error', message: `${arg} needs a value` };
    }
    values.set(arg, value);
    index += 1;
  }

  const missing = required.filter((flag) => (values.get(flag) ?? '').trim() === '');
  if (missing.length > 0) return { kind: 'error', message: `Missing ${missing.join(', ')}` };

  const get = (flag: string): string => (values.get(flag) as string).trim();
  switch (command) {
    case 'features':
      return { kind: 'features' };
    case 'show':
      return { kind: 'show', workspace: get('--workspace') };
    case 'plan':
      return { kind: 'plan', workspace: get('--workspace'), plan: get('--plan') };
    case 'clear':
      return { kind: 'clear', workspace: get('--workspace'), feature: get('--feature') };
    default:
      return {
        kind: command as 'grant' | 'revoke',
        workspace: get('--workspace'),
        feature: get('--feature'),
        reason: get('--reason'),
      };
  }
}

/** The features and plans, as the `features` command prints them. */
export function featureListing(): string {
  const width = Math.max(...FEATURES.map((feature) => feature.length));
  const lines = FEATURES.map(
    (feature) => `  ${feature.padEnd(width)}  ${FEATURE_DESCRIPTIONS[feature]}`,
  );
  return ['Features:', ...lines, '', `Plans: ${PLANS.join(', ')}`].join('\n');
}
