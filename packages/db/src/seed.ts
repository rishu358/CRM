import { generateSessionToken, hashSessionToken, newId } from '@crm/core';
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

loadRootEnvFile();
const env = loadDbEnv();
const app = createDbClient({ connectionString: env.DATABASE_URL });
const auth = createDbClient({ connectionString: env.DATABASE_AUTH_URL ?? env.DATABASE_URL });

const tenantId = newId();
const ownerId = newId();
const repId = newId();
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

  // 3. People, as crm_auth.
  for (const [userId, roleId, name, email] of [
    [ownerId, ownerRoleId, 'Priya Nair', `owner-${suffix}@example.com`],
    [repId, repRoleId, 'Rahul Mehta', `rep-${suffix}@example.com`],
  ] as const) {
    await auth.db.execute(
      sql`insert into users (id, email, name, locale, timezone)
          values (${userId}, ${email}, ${name}, 'en-IN', 'Asia/Kolkata')`,
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

  // 5. A session per demo user, so the web app can be used before the auth
  //    module lands. These are real sessions created the same way the API
  //    creates them — the database stores only the hash — not a back door:
  //    nothing here bypasses a check, it just saves typing a password that no
  //    sign-in flow exists to accept yet.
  const tokens = new Map<string, string>();
  for (const [userId, who] of [
    [ownerId, 'Owner'],
    [repId, 'Sales rep'],
  ] as const) {
    const token = generateSessionToken();
    await auth.db.execute(
      sql`insert into sessions (id, user_id, token_hash, expires_at, active_tenant_id)
          values (${newId()}, ${userId}, ${hashSessionToken(token)}, now() + interval '14 days', ${tenantId})`,
    );
    tokens.set(who, token);
  }

  console.warn(`Seeded demo tenant ${tenantId} (slug demo-${suffix})`);
  console.warn('');
  console.warn('Sign in at http://localhost:3000/sign-in with one of these tokens:');
  for (const [who, token] of tokens) {
    console.warn(`  ${who.padEnd(10)} ${token}`);
  }
  console.warn('');
  console.warn(`  Owner sees every contact; the sales rep sees only their own.`);
} finally {
  await Promise.all([app.close(), auth.close()]);
}
