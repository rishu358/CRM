import { DomainError } from '@crm/core';
import type { WorkspaceEntitlements } from '../platform/entitlements-operator.service.js';
import { featureListing, parseArgs, USAGE } from './entitlements-args.js';

/**
 * The entitlements command's logic (`pnpm tenant:entitlements`, ADR-0047), apart from the process it
 * runs in: it takes the operator service and where to print as parameters, so it is tested against a
 * real database without a terminal.
 *
 * Exit codes: 0 done, 1 refused or failed, 2 the command line was wrong.
 */
export interface EntitlementsOperatorPort {
  show(slug: string): Promise<WorkspaceEntitlements>;
  setPlan(slug: string, plan: string): Promise<WorkspaceEntitlements>;
  setOverride(
    slug: string,
    feature: string,
    enabled: boolean,
    reason: string,
  ): Promise<WorkspaceEntitlements>;
  clearOverride(slug: string, feature: string): Promise<WorkspaceEntitlements>;
}

export interface EntitlementsCommandOptions {
  readonly argv: readonly string[];
  /** A function: the application is only started once the command line has been understood. */
  readonly operator: () => Promise<EntitlementsOperatorPort>;
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
}

export async function runEntitlementsCommand(options: EntitlementsCommandOptions): Promise<number> {
  const args = parseArgs(options.argv);
  if (args.kind === 'help') {
    options.print(USAGE);
    return 0;
  }
  if (args.kind === 'error') {
    options.printError(`${args.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.kind === 'features') {
    options.print(featureListing());
    return 0;
  }

  try {
    const operator = await options.operator();
    switch (args.kind) {
      case 'show':
        options.print(present(await operator.show(args.workspace)));
        break;
      case 'plan':
        options.print(present(await operator.setPlan(args.workspace, args.plan)));
        break;
      case 'grant':
      case 'revoke':
        options.print(
          present(
            await operator.setOverride(
              args.workspace,
              args.feature,
              args.kind === 'grant',
              args.reason,
            ),
          ),
        );
        break;
      case 'clear':
        options.print(present(await operator.clearOverride(args.workspace, args.feature)));
        break;
    }
    return 0;
  } catch (error) {
    if (error instanceof DomainError) {
      const details = error.details.map((detail) =>
        `  ${detail.path ?? ''} ${detail.message}`.trimEnd(),
      );
      options.printError([error.message, ...details].join('\n'));
      return 1;
    }
    // Unexpected: say it failed, not what the database said, which may carry a connection string.
    options.printError('The command failed unexpectedly. Nothing was reported as changed.');
    return 1;
  }
}

function present(workspace: WorkspaceEntitlements): string {
  const lines = [
    `${workspace.name} (${workspace.slug})`,
    `  plan: ${workspace.plan}${workspace.planKnown ? '' : '  (not in the catalogue: includes nothing)'}`,
    '  exceptions:',
    ...(workspace.overrides.length === 0
      ? ['    none']
      : workspace.overrides.map(
          (item) => `    ${item.enabled ? 'on ' : 'off'} ${item.feature}  (${item.reason})`,
        )),
    '  effective:',
    ...Object.entries(workspace.effective).map(
      ([feature, on]) => `    ${on ? 'on ' : 'off'} ${feature}`,
    ),
  ];
  return lines.join('\n');
}
