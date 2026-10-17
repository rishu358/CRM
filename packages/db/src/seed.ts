import { generateInvitationToken, hashOneTimeToken, newId, TOKEN_TTL_SECONDS } from '@crm/core';
// From `@better-auth/utils`, not `better-auth`: it is the same scrypt
// implementation the API uses (ADR-0017) without the full package's
// drizzle-orm peer, which would give this workspace a second copy of Drizzle
// and a wall of SQL<unknown> type errors.
import { hashPassword } from '@better-auth/utils/password';
import { eq, sql } from 'drizzle-orm';
import { createDbClient, withTenant } from './client.js';
import { loadDbEnv } from './env.js';
import { loadRootEnvFile } from './load-env.js';
import {
  accounts,
  contacts,
  dealContacts,
  deals,
  exchangeRates,
  pipelineStages,
  pipelines,
} from './schema/index.js';
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
    // Accounts first: contacts point at them, and one account points at
    // another, so the parent/child hierarchy is visible on the first run.
    const parentAccountId = newId();
    const branchAccountId = newId();
    const studioAccountId = newId();

    await tx.insert(accounts).values([
      {
        id: parentAccountId,
        tenantId,
        ownerId,
        name: 'Rajesh Gold House',
        domain: 'rajeshgold.example',
        industry: 'Jewellery retail',
        phone: '+914442220000',
        email: 'hello@rajeshgold.example',
        website: 'https://rajeshgold.example',
        gstin: '29ABCDE1234F1Z5',
        billingAddress: {
          line1: '14 Ranganathan Street',
          city: 'Chennai',
          state: 'Tamil Nadu',
          postalCode: '600017',
          country: 'IN',
        },
        // ₹12,00,00,000 in paise. Minor units, never a float (ADR-0011).
        annualRevenueMinor: 1_200_000_000_00n,
        annualRevenueCurrency: 'INR',
        employeeCount: 48,
        createdBy: ownerId,
        updatedBy: ownerId,
      },
      {
        id: branchAccountId,
        tenantId,
        ownerId,
        name: 'Rajesh Gold House — Kochi',
        domain: 'kochi.rajeshgold.example',
        industry: 'Jewellery retail',
        parentAccountId,
        annualRevenueMinor: 3_40_00_000_00n,
        annualRevenueCurrency: 'INR',
        employeeCount: 11,
        createdBy: ownerId,
        updatedBy: ownerId,
      },
      {
        id: studioAccountId,
        tenantId,
        ownerId: repId,
        name: 'Lotus Design Studio',
        domain: 'lotusdesign.example',
        industry: 'Interior design',
        phone: '+912233445566',
        annualRevenueMinor: 85_00_000_00n,
        annualRevenueCurrency: 'INR',
        employeeCount: 6,
        createdBy: ownerId,
        updatedBy: ownerId,
      },
    ]);

    const samples = [
      ['Anjali', 'Sharma', 'anjali.sharma@example.com', '+919876543210', ownerId, parentAccountId],
      ['Vikram', 'Reddy', 'vikram.reddy@example.com', '+919812345678', ownerId, branchAccountId],
      ['Fatima', 'Khan', 'fatima.khan@example.com', '+919900112233', repId, studioAccountId],
      ['Joseph', 'DSouza', 'joseph.dsouza@example.com', '+919765432100', repId, null],
    ] as const;

    const contactIds = samples.map(() => newId());

    await tx.insert(contacts).values(
      samples.map(([firstName, lastName, email, phone, owner, accountId], index) => ({
        id: contactIds[index]!,
        tenantId,
        ownerId: owner,
        firstName,
        lastName,
        email,
        phone,
        accountId,
        leadSource: 'referral',
        createdBy: ownerId,
        updatedBy: ownerId,
      })),
    );

    // Deals (MVP_SPEC M5): the default pipeline provisioning created, plus a
    // second one, so the pipeline switcher has something to switch between.
    const stageRows = await tx
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, roleIds.defaultPipelineId));
    const stageByName = (name: string): string => {
      const stage = stageRows.find((row) => row.name === name);
      if (!stage) throw new Error(`Seed could not find the "${name}" stage`);
      return stage.id;
    };

    const wholesaleId = newId();
    await tx.insert(pipelines).values({
      id: wholesaleId,
      tenantId,
      name: 'Wholesale',
      position: 10,
      createdBy: ownerId,
      updatedBy: ownerId,
    });
    const wholesaleStages = [
      ['Enquiry', 20, 'open'],
      ['Sampling', 50, 'open'],
      ['Order confirmed', 80, 'open'],
      ['Delivered', 100, 'won'],
      ['Cancelled', 0, 'lost'],
    ] as const;
    const wholesaleStageIds = wholesaleStages.map(() => newId());
    await tx.insert(pipelineStages).values(
      wholesaleStages.map(([name, probability, stageType], index) => ({
        id: wholesaleStageIds[index]!,
        tenantId,
        pipelineId: wholesaleId,
        name,
        position: (index + 1) * 10,
        probability,
        stageType,
        createdBy: ownerId,
        updatedBy: ownerId,
      })),
    );

    const dealId = (): string => newId();
    const showroomDealId = dealId();
    const now = new Date();
    await tx.insert(deals).values([
      {
        id: showroomDealId,
        tenantId,
        ownerId,
        name: 'Showroom fit-out',
        accountId: parentAccountId,
        primaryContactId: contactIds[0]!,
        pipelineId: roleIds.defaultPipelineId,
        stageId: stageByName('New'),
        // ₹8,50,000.00 in paise. Minor units, never a float (ADR-0011).
        amountMinor: 85_000_000n,
        currency: 'INR',
        probability: 10,
        expectedCloseDate: '2026-12-15',
        createdBy: ownerId,
        updatedBy: ownerId,
      },
      {
        id: dealId(),
        tenantId,
        ownerId,
        name: 'Festival collection order',
        accountId: branchAccountId,
        primaryContactId: contactIds[1]!,
        pipelineId: roleIds.defaultPipelineId,
        stageId: stageByName('Qualified'),
        amountMinor: 2_40_00_000_00n,
        currency: 'INR',
        probability: 25,
        expectedCloseDate: '2026-11-20',
        createdBy: ownerId,
        updatedBy: ownerId,
      },
      {
        id: dealId(),
        tenantId,
        ownerId: repId,
        name: 'Studio lighting supply',
        accountId: studioAccountId,
        primaryContactId: contactIds[2]!,
        pipelineId: roleIds.defaultPipelineId,
        stageId: stageByName('Proposal'),
        // A dollar deal, so the board total shows a conversion at work.
        amountMinor: 1_850_000n,
        currency: 'USD',
        probability: 50,
        expectedCloseDate: '2026-11-30',
        createdBy: ownerId,
        updatedBy: ownerId,
      },
      {
        id: dealId(),
        tenantId,
        ownerId: repId,
        name: 'Boutique opening stock',
        pipelineId: roleIds.defaultPipelineId,
        stageId: stageByName('Negotiation'),
        amountMinor: 12_50_000_00n,
        currency: 'INR',
        probability: 75,
        createdBy: ownerId,
        updatedBy: ownerId,
      },
      {
        id: dealId(),
        tenantId,
        ownerId,
        name: 'Anniversary gifting',
        accountId: parentAccountId,
        pipelineId: roleIds.defaultPipelineId,
        stageId: stageByName('Won'),
        amountMinor: 4_00_000_00n,
        currency: 'INR',
        probability: 100,
        closedAt: now,
        createdBy: ownerId,
        updatedBy: ownerId,
      },
      {
        id: dealId(),
        tenantId,
        ownerId,
        name: 'Export sample run',
        pipelineId: wholesaleId,
        stageId: wholesaleStageIds[0]!,
        amountMinor: 3_20_000_00n,
        currency: 'INR',
        probability: 20,
        createdBy: ownerId,
        updatedBy: ownerId,
      },
    ]);

    await tx.insert(dealContacts).values([
      {
        id: newId(),
        tenantId,
        dealId: showroomDealId,
        contactId: contactIds[0]!,
        role: 'Decision maker',
        createdBy: ownerId,
        updatedBy: ownerId,
      },
      {
        id: newId(),
        tenantId,
        dealId: showroomDealId,
        contactId: contactIds[1]!,
        role: 'Influencer',
        createdBy: ownerId,
        updatedBy: ownerId,
      },
    ]);

    // Manual exchange rates into the tenant currency (ADR-0021). Live rates
    // are P1; until then these are what a person would type in.
    await tx.insert(exchangeRates).values([
      {
        id: newId(),
        tenantId,
        fromCurrency: 'USD',
        toCurrency: 'INR',
        rate: '83.250000000000',
        createdBy: ownerId,
        updatedBy: ownerId,
      },
      {
        id: newId(),
        tenantId,
        fromCurrency: 'AED',
        toCurrency: 'INR',
        rate: '22.670000000000',
        createdBy: ownerId,
        updatedBy: ownerId,
      },
    ]);
  });

  // 5. One pending invitation, so the invite flow has something to accept
  //    without a developer having to dig a token out of a log (MVP_SPEC M2).
  //
  //    The token is generated here and printed, never stored: the row holds
  //    only its SHA-256, exactly as in production. That it has to be printed
  //    to be usable is the property working, not a shortcut around it.
  const inviteEmail = `invitee-${suffix}@example.com`;
  const inviteToken = generateInvitationToken(tenantId);

  await withTenant(app.db, { tenantId, userId: ownerId }, (tx) =>
    tx.execute(
      sql`insert into invitations
            (id, tenant_id, email, role_id, token_hash, expires_at, created_by, updated_by)
          values
            (${newId()}, ${tenantId}, ${inviteEmail}, ${repRoleId},
             ${hashOneTimeToken(inviteToken)},
             now() + make_interval(secs => ${TOKEN_TTL_SECONDS.team_invite}),
             ${ownerId}, ${ownerId})`,
    ),
  );

  // 6. Nothing mints a session any more: the demo users have passwords and
  //    sign in at /sign-in like anyone else (MVP_SPEC M1).
  console.warn(`Seeded demo tenant ${tenantId} (slug demo-${suffix})`);
  console.warn('');
  console.warn('Sign in at http://localhost:3000/sign-in with:');
  console.warn(`  Owner      owner-${suffix}@example.com`);
  console.warn(`  Sales rep  rep-${suffix}@example.com`);
  console.warn(`  MFA demo   mfa-${suffix}@example.com`);
  console.warn(`  Password   ${DEMO_PASSWORD}`);
  console.warn('');
  console.warn('A pending invitation is waiting at http://localhost:3000/accept-invite:');
  console.warn(`  Invited    ${inviteEmail}`);
  console.warn(`  Invite     ${inviteToken}`);
  console.warn('');
  console.warn(`  Owner sees every contact, account and deal; the sales rep sees only their own.`);
} finally {
  await Promise.all([app.close(), auth.close()]);
}
