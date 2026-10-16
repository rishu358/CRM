import { newId } from '@crm/core';
// From `@better-auth/utils`, not `better-auth`: it is the same scrypt
// implementation the API uses (ADR-0017) without the full package's
// drizzle-orm peer, which would give this workspace a second copy of Drizzle
// and a wall of SQL<unknown> type errors.
import { hashPassword } from '@better-auth/utils/password';
import { sql } from 'drizzle-orm';
import { createDbClient, withTenant } from './client.js';
import { loadDbEnv } from './env.js';
import { loadRootEnvFile } from './load-env.js';
import { contacts } from './schema/index.js';
import { FOUNDING_ROLE_NAME, provisionTenantDefaults } from './seed/index.js';

/**
 * Demo tenant with sample data: `pnpm db:seed`.
 *
 * Deliberately uses the same role split as production rather than a superuser,
 * so the seed exercises the policies instead of sidestepping them. If seeding
 * breaks, a policy is wrong — which is exactly what we want to find out here
 * rather than in an incident.
 *
 * Creating a tenant row is the one step the API role cannot do; that runs as
 * crm_auth, the same role signup uses.
 */

/**
 * The demo password, printed on every seed.
 *
 * Not a secret and not meant to be one: this seeds a throwaway local tenant
 * with invented people in it. It is a constant rather than generated so the
 * README, the E2E suite and a developer's muscle memory all agree.
 */
const DEMO_PASSWORD = 'demo-password-not-for-production';

loadRootEnvFile();
const env = loadDbEnv();
const app = createDbClient({ connectionString: env.DATABASE_URL });
const auth = createDbClient({ connectionString: env.DATABASE_AUTH_URL ?? env.DATABASE_URL });

const tenantId = newId();
const ownerId = newId();
const repId = newId();
/**
 * A third demo user, for exercising MFA enrolment.
 *
 * Separate from the other two on purpose: enrolling a second factor changes
 * how that account signs in, so a test that does it to the owner and then
 * fails before cleaning up leaves every later sign-in facing an unexpected
 * challenge. One account whose sign-in may change, and two whose never does.
 */
const mfaUserId = newId();
const suffix = tenantId.replaceAll('-', '').slice(-8);

try {
  // 1. The tenant itself, as crm_auth.
  await auth.db.execute(
    sql`insert into tenants (id, name, slug, plan, default_currency, timezone, locale)
        values (${tenantId}, ${'Demo Jewellers'}, ${`demo-${suffix}`}, 'free', 'INR', 'Asia/Kolkata', 'en-IN')`,
  );

  // 2. Roles, grants and field metadata, as the API role inside tenant context.
  const roleIds = await withTenant(app.db, { tenantId, userId: null }, (tx) =>
    provisionTenantDefaults(tx, tenantId, null),
  );
  const ownerRoleId = roleIds.roleIdsByName.get(FOUNDING_ROLE_NAME);
  const repRoleId = roleIds.roleIdsByName.get('Sales Rep');
  if (!ownerRoleId || !repRoleId) throw new Error('Seed could not resolve the default roles');

  // 3. People, as crm_auth — with real, already-verified credentials, so the
  //    demo signs in through the same flow a customer does. The password is
  //    hashed by the same function the API uses (ADR-0017); a second
  //    implementation here would be one more thing that can quietly disagree.
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  for (const [userId, roleId, name, email] of [
    [ownerId, ownerRoleId, 'Priya Nair', `owner-${suffix}@example.com`],
    [repId, repRoleId, 'Rahul Mehta', `rep-${suffix}@example.com`],
    [mfaUserId, repRoleId, 'Meera Iyer', `mfa-${suffix}@example.com`],
  ] as const) {
    await auth.db.execute(
      sql`insert into users (id, email, name, locale, timezone, email_verified_at)
          values (${userId}, ${email}, ${name}, 'en-IN', 'Asia/Kolkata', now())`,
    );
    await auth.db.execute(
      sql`insert into auth_accounts (id, user_id, provider_id, account_id, password_hash)
          values (${newId()}, ${userId}, 'credential', ${email}, ${passwordHash})`,
    );
    await auth.db.execute(
      sql`insert into memberships (id, tenant_id, user_id, role_id, status, joined_at)
          values (${newId()}, ${tenantId}, ${userId}, ${roleId}, 'active', now())`,
    );
  }

  // 4. Sample records, split between the two owners so that `own` scope is
  //    visibly different from `all` the moment you sign in as each.
  await withTenant(app.db, { tenantId, userId: ownerId }, async (tx) => {
    const samples = [
      ['Anjali', 'Sharma', 'anjali.sharma@example.com', '+919876543210', ownerId],
      ['Vikram', 'Reddy', 'vikram.reddy@example.com', '+919812345678', ownerId],
      ['Fatima', 'Khan', 'fatima.khan@example.com', '+919900112233', repId],
      ['Joseph', 'DSouza', 'joseph.dsouza@example.com', '+919765432100', repId],
    ] as const;

    await tx.insert(contacts).values(
      samples.map(([firstName, lastName, email, phone, owner]) => ({
        id: newId(),
        tenantId,
        ownerId: owner,
        firstName,
        lastName,
        email,
        phone,
        leadSource: 'referral',
        createdBy: ownerId,
        updatedBy: ownerId,
      })),
    );
  });

  // 5. Nothing mints a session any more: the demo users have passwords and
  //    sign in at /sign-in like anyone else (MVP_SPEC M1).
  console.warn(`Seeded demo tenant ${tenantId} (slug demo-${suffix})`);
  console.warn('');
  console.warn('Sign in at http://localhost:3000/sign-in with:');
  console.warn(`  Owner      owner-${suffix}@example.com`);
  console.warn(`  Sales rep  rep-${suffix}@example.com`);
  console.warn(`  MFA demo   mfa-${suffix}@example.com`);
  console.warn(`  Password   ${DEMO_PASSWORD}`);
  console.warn('');
  console.warn(`  Owner sees every contact; the sales rep sees only their own.`);
} finally {
  await Promise.all([app.close(), auth.close()]);
}
