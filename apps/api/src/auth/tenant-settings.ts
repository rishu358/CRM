/**
 * Reading tenant settings out of `tenants.settings jsonb`.
 *
 * Settings are data, not columns, because a workspace preference should not
 * cost a migration. The price is that everything in there is `unknown` until
 * something narrows it, and a flag that silently reads as `undefined` would
 * turn "MFA is required" into "MFA is optional" — a security control failing
 * open. So the narrowing lives here, in one place, with the default stated.
 */
export const MFA_REQUIRED_KEY = 'mfaRequired';

/**
 * Whether this workspace requires a second factor (MVP_SPEC M1 acceptance).
 *
 * Defaults to `false`: a workspace that has never configured anything does
 * not require MFA. Only an explicit `true` turns it on — a string `"true"`,
 * a `1`, or a typo'd key does not, because a setting that is almost right
 * should fail in the direction that is visible to an administrator rather
 * than one that quietly locks out their whole team.
 */
export function mfaRequiredFor(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false;
  return (settings as Record<string, unknown>)[MFA_REQUIRED_KEY] === true;
}
