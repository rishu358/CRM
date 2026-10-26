#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUSINESSES, SHARED_PASSWORD, staffEmail } from './data/businesses.mjs';
import { assertPilotDatabase, parseArgs, readEnvFile } from './lib/args.mjs';
import { discover } from './lib/context.mjs';
import { Findings, writeJson } from './lib/findings.mjs';
import { makeGenerator } from './lib/gen.mjs';
import { Api, sleep } from './lib/http.mjs';
import { findInvitationToken, logSize } from './lib/mail.mjs';
import { makeRng } from './lib/prng.mjs';
import { addDays, makeBuilders } from './lib/records.mjs';
import { Metrics } from './lib/stats.mjs';
import { totp } from './lib/totp.mjs';

/**
 * pnpm pilot:seed -- --env-file <file> --mail-log <api log>
 *
 * Builds the three fictional pilot businesses through the real API: each is its own workspace (tenant),
 * created with the repository's own `tenant:create` command; every other person is invited and accepts
 * the way a real invitee does; custom fields, a team and a restricted role are set up as an
 * administrator would; then each person creates their own book of accounts, contacts, leads, deals,
 * tasks and notes. Nothing is written to the database except through the API (and the one create-workspace command).
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const args = parseArgs(process.argv.slice(2), {
  'api-url': 'http://localhost:3011',
  state: resolve(repoRoot, '.pilot/state.json'),
  out: resolve(repoRoot, '.pilot/seed-results.json'),
  seed: 'pilot-1',
});

if (!args['env-file'] || !args['mail-log']) {
  console.error(
    'Usage: node scripts/pilot/seed.mjs --env-file <api env file> --mail-log <api log file> [--only wholesale|repairs|coaching] [--api-url http://localhost:3011]',
  );
  process.exit(2);
}
assertPilotDatabase(readEnvFile(args['env-file']));
console.log('Database check passed: every database URL in the env file ends in /crm_pilot.');

const metrics = new Metrics();
const findings = new Findings();
const state = existsSync(args.state)
  ? JSON.parse(readFileSync(args.state, 'utf8'))
  : { businesses: {} };
const saveState = () => {
  mkdirSync(dirname(args.state), { recursive: true });
  writeFileSync(args.state, `${JSON.stringify(state, null, 2)}\n`);
};

const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

function must(response, what) {
  if (!response.ok) {
    throw new Error(
      `${what} failed: HTTP ${response.status} ${response.code ?? ''} ${JSON.stringify(response.body?.error?.details ?? response.body ?? '').slice(0, 300)}`,
    );
  }
  return response.data;
}

function createWorkspace(business) {
  const owner = business.staff[0];
  const result = spawnSync(
    process.execPath,
    [
      '--env-file',
      args['env-file'],
      'apps/api/dist/cli/create-workspace-main.js',
      '--password-stdin',
      '--workspace',
      business.tenantName,
      '--owner-email',
      staffEmail(business, owner),
      '--owner-name',
      owner.name,
    ],
    { cwd: repoRoot, input: `${SHARED_PASSWORD}\n`, encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(`create-workspace failed: ${result.stderr || result.stdout}`);
  log(`created workspace "${business.tenantName}"`);
}

async function ensureFields(owner, business) {
  const existing = await discover(owner);
  for (const [objectType, definitions] of Object.entries(business.fields)) {
    for (const definition of definitions) {
      if (existing.fields[objectType].some((field) => field.label === definition.label)) continue;
      const body = { objectType, label: definition.label, type: definition.type };
      if (definition.options)
        body.options = definition.options.map((option) => ({ label: option.label }));
      must(await owner.post('field.create', '/fields', body), `create field ${definition.label}`);
    }
  }
}

async function inviteAndAccept(owner, business, member, roleIdByName) {
  const email = staffEmail(business, member);
  const roleId = roleIdByName.get(member.role);
  if (!roleId) throw new Error(`no role named ${member.role}`);
  const offset = logSize(args['mail-log']);
  const invited = await owner.post('invitation.create', '/invitations', { email, roleId });
  must(invited, `invite ${email}`);
  const token = await findInvitationToken(args['mail-log'], email, { fromOffset: offset });
  if (!token) {
    findings.add({
      id: 'invite-link-missing-from-log',
      severity: 'high',
      kind: 'defect',
      title: 'Invitation e-mail was not produced',
      detail: email,
    });
    throw new Error(`no invitation link found in the mail log for ${email}`);
  }
  const preview = await owner.get('invitation.preview', '/invitations/accept', { token });
  findings.expect(preview.ok && preview.data?.requiresAccount === true, {
    id: 'invite-preview-unexpected',
    severity: 'low',
    kind: 'defect',
    title: 'Invitation preview did not say a new account is needed',
    detail: JSON.stringify(preview.body).slice(0, 200),
  });
  const stranger = new Api({ baseUrl: args['api-url'], metrics, who: `invitee ${email}` });
  const accepted = await stranger.post('invitation.accept', '/invitations/accept', {
    token,
    name: member.name,
    password: SHARED_PASSWORD,
  });
  must(accepted, `accept invitation for ${email}`);
}

async function enrolMfa(business, member, record) {
  const api = new Api({ baseUrl: args['api-url'], metrics, who: member.name });
  const signedIn = await api.signIn(record.email, SHARED_PASSWORD);
  if (!signedIn.ok)
    throw new Error(`cannot sign in ${record.email} to enrol MFA: ${signedIn.status}`);
  const enrolment = must(await api.post('mfa.enroll', '/auth/mfa/enroll'), 'mfa enrol');
  // An authenticator app takes its key from the QR code (the otpauth link), not from the typed-in key the
  // page shows: see the finding about the setup key in docs/PILOT_SIMULATION.md.
  const appSecret = new URL(enrolment.otpauthUrl).searchParams.get('secret');
  must(
    await api.post('mfa.activate', '/auth/mfa/activate', { code: totp(appSecret) }),
    'mfa activate',
  );
  record.totpSecret = appSecret;
  record.displayedKey = enrolment.secret;
  record.backupCodes = enrolment.backupCodes;
}

async function restrictRole(owner, business, context) {
  const hidden = business.hiddenFromJunior;
  if (!hidden) return;
  const roles = must(await owner.get('roles.list', '/roles'), 'list roles');
  const salesRep = roles.find((role) => role.name === 'Sales Rep');
  const name = business.staff.find((member) => member.role.startsWith('Junior'))?.role;
  if (!name) return;
  let role = roles.find((item) => item.name === name);
  if (!role)
    role = must(
      await owner.post('role.create', '/roles', {
        name,
        description: 'Sales rep who may not see credit limits or company turnover',
        copyFromRoleId: salesRep.id,
      }),
      'create role',
    );
  const fieldRules = [
    { objectType: 'account', fieldKey: 'annual_revenue', access: 'hidden' },
    ...hidden.account.map((label) => ({
      objectType: 'account',
      fieldKey: context.fields.account.find((field) => field.label === label).key,
      access: 'hidden',
    })),
  ];
  const preview = must(
    await owner.post('role.preview', `/roles/${role.id}/permissions/preview`, {
      grants: [],
      fieldRules,
    }),
    'preview role change',
  );
  const digest = preview.digest ?? preview.expectedDigest ?? preview.currentDigest;
  must(
    await owner.patch('role.apply', `/roles/${role.id}/permissions`, {
      grants: [],
      fieldRules,
      expectedDigest: digest,
    }),
    'apply role change',
  );
  log(`role "${name}" now hides credit limit and turnover`);
}

async function loadBook(api, business, builders, context, share, today, rng, omit) {
  const counts = { accounts: 0, contacts: 0, leads: 0, deals: 0, activities: 0, notes: 0 };
  const accounts = [];
  const contacts = [];
  const deals = [];
  const unexpected = (what, response) => {
    findings.add({
      id: `seed-unexpected-${what}-${response.status}-${response.code ?? 'none'}`,
      severity: response.status >= 500 ? 'high' : 'medium',
      kind: 'defect',
      title: `Seeding ${what} was refused (HTTP ${response.status} ${response.code ?? ''})`,
      detail: JSON.stringify(response.body?.error ?? response.body).slice(0, 300),
    });
  };

  for (let index = 0; index < share.accounts; index += 1) {
    const built = builders.account({ omit });
    const response = await api.post('account.create', '/accounts', built.payload);
    if (!response.ok) {
      unexpected('account', response);
      continue;
    }
    counts.accounts += 1;
    accounts.push({ id: response.data.id, name: built.payload.name, kind: built.accountKind });
  }

  // Contacts: most belong to an account, a few stand alone.
  for (let index = 0; index < share.contacts; index += 1) {
    const account =
      accounts.length > 0 && rng.chance(0.9) ? accounts[index % accounts.length] : null;
    const built = builders.contact({
      accountId: account?.id ?? null,
      accountName: account?.name ?? null,
      lastName:
        business.id === 'coaching' && account?.kind === 'family'
          ? account.name.split(' ')[0]
          : undefined,
    });
    const response = await api.post('contact.create', '/contacts', built.payload);
    if (!response.ok) {
      unexpected('contact', response);
      continue;
    }
    counts.contacts += 1;
    contacts.push({
      id: response.data.id,
      accountId: account?.id ?? null,
      accountName: account?.name ?? null,
      name: `${built.payload.firstName} ${built.payload.lastName}`,
    });
  }

  for (let index = 0; index < share.leads; index += 1) {
    const built = builders.lead();
    const response = await api.post('lead.create', '/leads', built.payload);
    if (!response.ok) unexpected('lead', response);
    else counts.leads += 1;
  }

  const stageWeights = [
    [context.openStages[0], 3],
    [context.openStages[1], 3],
    [context.openStages[2], 2],
    [context.openStages[3], 2],
    [context.wonStage, 2],
    [context.lostStage, 1],
  ];
  for (let index = 0; index < share.deals && accounts.length > 0; index += 1) {
    const account = accounts[rng.int(0, accounts.length - 1)];
    const contact = contacts.find((item) => item.accountId === account.id);
    const target = rng.weighted(stageWeights);
    const startStage = target.stageType === 'open' ? target : context.openStages[0];
    const built = builders.deal({
      accountId: account.id,
      accountName: account.name,
      contactId: contact?.id ?? null,
      stageId: startStage.id,
      today,
    });
    const response = await api.post('deal.create', '/deals', built.payload);
    if (!response.ok) {
      unexpected('deal', response);
      continue;
    }
    counts.deals += 1;
    deals.push({
      id: response.data.id,
      accountId: account.id,
      accountName: account.name,
      contactName: contact?.name ?? 'the customer',
    });
    if (target.stageType !== 'open') {
      const body = { version: response.data.version, stageId: target.id };
      if (target.stageType === 'lost') body.lostReason = rng.pick(business.lostReasons);
      const moved = await api.patch('deal.move', `/deals/${response.data.id}`, body);
      if (!moved.ok) unexpected('deal-close', moved);
    }
  }

  const linkable = () => {
    const pool = [];
    if (deals.length > 0)
      pool.push(() => {
        const deal = rng.pick(deals);
        return {
          links: [{ objectType: 'deal', recordId: deal.id }],
          vars: {
            account: deal.accountName,
            contact: deal.contactName,
            product: rng.pick(business.products),
          },
        };
      });
    if (accounts.length > 0)
      pool.push(() => {
        const account = rng.pick(accounts);
        const contact = contacts.find((item) => item.accountId === account.id);
        return {
          links: [{ objectType: 'account', recordId: account.id }],
          vars: {
            account: account.name,
            contact: contact?.name ?? 'the owner',
            product: rng.pick(business.products),
          },
        };
      });
    return pool.length === 0 ? null : rng.pick(pool)();
  };

  for (let index = 0; index < share.tasks; index += 1) {
    const target = linkable();
    if (!target) break;
    const dueAt = `${addDays(today, rng.int(-14, 21))}T${String(rng.int(4, 12)).padStart(2, '0')}:30:00.000Z`;
    const built = builders.activity({
      type: rng.weighted([
        ['task', 6],
        ['call', 3],
        ['meeting', 1],
      ]),
      subjectVars: target.vars,
      links: target.links,
      dueAt,
    });
    const response = await api.post('activity.create', '/activities', built);
    if (!response.ok) {
      unexpected('activity', response);
      continue;
    }
    counts.activities += 1;
    if (new Date(dueAt) < new Date(`${today}T00:00:00Z`) && rng.chance(0.6)) {
      await api.patch('activity.complete', `/activities/${response.data.id}`, {
        version: response.data.version,
        status: 'completed',
      });
    }
  }

  for (let index = 0; index < share.notes; index += 1) {
    const target = linkable();
    if (!target) break;
    const response = await api.post(
      'note.create',
      '/activities',
      builders.note({ vars: target.vars, links: target.links }),
    );
    if (!response.ok) unexpected('note', response);
    else counts.notes += 1;
  }
  return counts;
}

async function seedBusiness(business) {
  const record = (state.businesses[business.id] ??= { tenantName: business.tenantName, staff: {} });
  const ownerMember = business.staff[0];
  const ownerEmail = staffEmail(business, ownerMember);
  let owner = new Api({ baseUrl: args['api-url'], metrics, who: ownerMember.name });
  let signedIn = await owner.signIn(ownerEmail, SHARED_PASSWORD);
  if (!signedIn.ok) {
    createWorkspace(business);
    owner = new Api({ baseUrl: args['api-url'], metrics, who: ownerMember.name });
    signedIn = await owner.signIn(ownerEmail, SHARED_PASSWORD);
    if (!signedIn.ok) throw new Error(`owner cannot sign in after creation: ${signedIn.status}`);
  }
  record.tenantId = owner.tenantId;
  record.staff.owner = {
    ...(record.staff.owner ?? {}),
    email: ownerEmail,
    userId: owner.userId,
    name: ownerMember.name,
    role: ownerMember.role,
  };

  const existingAccounts = await owner.get('account.list', '/accounts', { limit: 1 });
  if (existingAccounts.ok && existingAccounts.data.length > 0) {
    log(`${business.id}: already has data, leaving it alone`);
    return;
  }

  // Setup the way an owner would: profile, custom fields, team, people.
  must(
    await owner.patch('tenant.update', '/tenant', { industry: business.industry }),
    'set industry',
  );
  await ensureFields(owner, business);
  const roles = must(await owner.get('roles.list', '/roles'), 'list roles');
  const invitable = must(
    await owner.get('invitation.roles', '/invitations/roles'),
    'list invitable roles',
  );
  const roleIdByName = new Map([...roles, ...invitable].map((role) => [role.name, role.id]));
  let context = await discover(owner);
  await restrictRole(owner, business, context);
  const rolesAfter = must(await owner.get('roles.list', '/roles'), 'list roles again');
  rolesAfter.forEach((role) => roleIdByName.set(role.name, role.id));

  const members = must(await owner.get('members.list', '/members', { limit: 200 }), 'list members');
  for (const member of business.staff.slice(1)) {
    const email = staffEmail(business, member);
    if (!members.some((item) => item.email === email)) {
      await inviteAndAccept(owner, business, member, roleIdByName);
      log(`${business.id}: ${member.name} joined as ${member.role}`);
    }
  }
  const joined = must(
    await owner.get('members.list', '/members', { limit: 200 }),
    'list members after invites',
  );

  const teams = must(await owner.get('teams.list', '/teams'), 'list teams');
  const team =
    teams[0] ??
    must(await owner.post('team.create', '/teams', { name: 'Sales team' }), 'create team');
  const teamUserIds = business.staff
    .filter(
      (member) =>
        ['Manager', 'Sales Rep'].includes(member.role) || member.role.startsWith('Junior'),
    )
    .map((member) => joined.find((item) => item.email === staffEmail(business, member))?.userId)
    .filter(Boolean);
  must(
    await owner.patch('team.members', `/teams/${team.id}/members`, { userIds: teamUserIds }),
    'set team members',
  );

  must(await owner.post('onboarding.complete', '/onboarding/complete'), 'complete onboarding');

  for (const member of business.staff.slice(1)) {
    const email = staffEmail(business, member);
    const joinedMember = joined.find((item) => item.email === email);
    record.staff[member.key] = {
      ...(record.staff[member.key] ?? {}),
      email,
      userId: joinedMember?.userId,
      name: member.name,
      role: member.role,
    };
  }
  for (const member of business.staff.filter((item) => item.mfa)) {
    await enrolMfa(business, member, record.staff[member.key]);
    log(`${business.id}: ${member.name} now signs in with a one-time code`);
  }
  saveState();

  // Each seller builds their own book, as themselves.
  context = await discover(owner);
  const sellers = [
    ...business.staff.filter(
      (member) =>
        ['Manager', 'Sales Rep'].includes(member.role) || member.role.startsWith('Junior'),
    ),
    ownerMember,
  ];
  const rng = makeRng(`${args.seed}/${business.id}/seed`);
  const gen = makeGenerator(rng.fork('gen'));
  const builders = makeBuilders({ business, rng: rng.fork('builders'), gen, context });
  const today = new Date().toISOString().slice(0, 10);
  const weights = sellers.map((member) =>
    member.key === 'owner' ? 0.5 : member.role === 'Manager' ? 0.8 : 1,
  );
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const totals = { accounts: 0, contacts: 0, leads: 0, deals: 0, activities: 0, notes: 0 };
  for (const [index, member] of sellers.entries()) {
    const api = new Api({ baseUrl: args['api-url'], metrics, who: member.name });
    const entry = record.staff[member.key];
    const ok = await api.signIn(entry.email, SHARED_PASSWORD, { totpSecret: entry.totpSecret });
    if (!ok.ok) throw new Error(`cannot sign in ${entry.email}: ${ok.status}`);
    const fraction = weights[index] / totalWeight;
    const share = Object.fromEntries(
      Object.entries(business.sizes).map(([name, size]) => [name, Math.round(size * fraction)]),
    );
    const omit = new Set(member.role.startsWith('Junior') ? ['Credit limit', 'annualRevenue'] : []);
    const counts = await loadBook(
      api,
      business,
      builders,
      context,
      share,
      today,
      rng.fork(`book/${member.key}`),
      omit,
    );
    for (const [name, value] of Object.entries(counts)) totals[name] += value;
    log(`${business.id}: ${member.name} created ${JSON.stringify(counts)}`);
  }
  record.seeded = totals;
  saveState();
}

const only = args.only;
const started = Date.now();
for (const business of BUSINESSES) {
  if (only && only !== business.id) continue;
  log(`--- ${business.tenantName}`);
  await seedBusiness(business);
}
await sleep(500);
writeJson(args.out, {
  seconds: Math.round((Date.now() - started) / 1000),
  requests: metrics.total,
  overall: metrics.overall(),
  latency: metrics.summary(),
  errors: metrics.errorCounts(),
  serverErrors: metrics.serverErrors,
  findings: findings.list(),
  seeded: Object.fromEntries(
    Object.entries(state.businesses).map(([id, value]) => [id, value.seeded]),
  ),
});
log(
  `done in ${Math.round((Date.now() - started) / 1000)} s, ${metrics.total} requests, ${metrics.serverErrors.length} server errors`,
);
console.log('\nSign-in details (fake, local only). Password for everyone:', SHARED_PASSWORD);
for (const business of BUSINESSES) {
  if (only && only !== business.id) continue;
  console.log(`  ${business.tenantName}`);
  for (const member of business.staff)
    console.log(
      `    ${member.role.padEnd(30)} ${staffEmail(business, member)}${member.mfa ? '   (uses a one-time code; secret in the state file)' : ''}`,
    );
}
