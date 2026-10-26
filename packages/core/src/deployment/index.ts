/**
 * Deployment modes (ADR-0046, CLAUDE.md §13.7).
 *
 * The same code runs as a product that anyone can sign up to (`multi_tenant`), or as one company's
 * own installation (`single_tenant`). The mode decides **who may create a workspace**, and nothing
 * else. It never decides how data is read or written: row-level security is on in both, every
 * request carries a tenant, and a single-tenant installation is simply one tenant. There is no second
 * code path for data access, so there is no mode in which isolation is "off because it is only one
 * company".
 *
 * Pure rules, so the API, the setup command and the web app share one definition.
 */
export const DEPLOYMENT_MODES = ['multi_tenant', 'single_tenant'] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

/**
 * Whether a stranger may create an account and a workspace of their own, by the public sign-up
 * form or by signing in with Google for the first time. In a single-tenant installation nobody
 * creates workspaces by themselves: the operator creates the one workspace with the setup command,
 * and people join it by invitation.
 */
export function publicSignUpOpen(mode: DeploymentMode): boolean {
  return mode === 'multi_tenant';
}

/**
 * Whether the operator's setup command may create another workspace. A multi-tenant installation
 * is a product and always may. A single-tenant one holds exactly one, so the command refuses once
 * it exists: a second workspace there would be a different product from the one that was installed.
 */
export function mayCreateWorkspace(mode: DeploymentMode, existingWorkspaces: number): boolean {
  return mode === 'multi_tenant' || existingWorkspaces === 0;
}
