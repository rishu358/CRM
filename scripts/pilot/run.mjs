#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUSINESSES, SHARED_PASSWORD, staffEmail } from './data/businesses.mjs';
import {
  addCustomer,
  browseLists,
  captureLead,
  checkNotifications,
  completeTasks,
  convertLeads,
  editRecord,
  glanceAtDashboard,
  moveDeals,
  openDeal,
  openMyDay,
  scheduleFollowUps,
  searchAround,
  unexpected,
  workLeads,
  writeNotes,
} from './lib/actions.mjs';
import { Actor } from './lib/actor.mjs';
import { assertPilotDatabase, parseArgs, readEnvFile } from './lib/args.mjs';
import { discover } from './lib/context.mjs';
import { Findings, writeJson } from './lib/findings.mjs';
import {
  assignTask,
  attachBadFiles,
  attachFile,
  conflictBetweenPeople,
  deleteAndRestore,
  exportAndCheck,
  exportRecords,
  importContacts,
  makeMistakes,
  reassignWork,
  waitFor,
} from './lib/flows.mjs';
import { makeGenerator } from './lib/gen.mjs';
import { Api, sleep } from './lib/http.mjs';
import {
  probeAcrossTenants,
  probeGaps,
  probeHiddenFields,
  probeIdempotency,
  probeOrigin,
  probeSessions,
  probeWithinBusiness,
} from './lib/probes.mjs';
import { makeRng } from './lib/prng.mjs';
import { addDays, makeBuilders } from './lib/records.mjs';
import { Metrics } from './lib/stats.mjs';

/**
 * pnpm pilot:run -- --env-file <file>
 *
 * Six simulated weeks of three businesses' daily work, through the real API, as the real roles. See
 * docs/PILOT_SIMULATION.md for what is measured and how to read the output.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const args = parseArgs(process.argv.slice(2), {
  'api-url': 'http://localhost:3011',
  state: resolve(repoRoot, '.pilot/state.json'),
  out: resolve(repoRoot, '.pilot/run-results.json'),
  seed: 'pilot-1',
  weeks: '6',
});
if (!args['env-file']) {
  console.error(
    'Usage: node scripts/pilot/run.mjs --env-file <api env file> [--weeks 6] [--only wholesale|repairs|coaching]',
  );
  process.exit(2);
}
assertPilotDatabase(readEnvFile(args['env-file']));
if (!existsSync(args.state)) {
  console.error(`No state file at ${args.state}. Run pnpm pilot:seed first.`);
  process.exit(2);
}
const state = JSON.parse(readFileSync(args.state, 'utf8'));
const WEEKS = Number(args.weeks);
const metrics = new Metrics();
const findings = new Findings();
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

/** What each business does more or less of in a day, per salesperson. */
const RATES = {
  wholesale: {
    leads: 1.2,
    leadWork: 2,
    convert: 0.5,
    customers: 0.3,
    deals: 1.5,
    dealMoves: 3,
    tasks: 3,
    complete: 3,
    notes: 2,
    searches: 3,
    edits: 2,
    lists: 1.5,
  },
  repairs: {
    leads: 2.5,
    leadWork: 3,
    convert: 1,
    customers: 0.5,
    deals: 3,
    dealMoves: 6,
    tasks: 5,
    complete: 5,
    notes: 3,
    searches: 4,
    edits: 3,
    lists: 2,
  },
  coaching: {
    leads: 5,
    leadWork: 5,
    convert: 1.5,
    customers: 0.5,
    deals: 1,
    dealMoves: 3,
    tasks: 6,
    complete: 5,
    notes: 2,
    searches: 4,
    edits: 2,
    lists: 2,
  },
};

const startDate = new Date().toISOString().slice(0, 10);
const dayOfWeek = new Date(`${startDate}T00:00:00Z`).getUTCDay();
/** The first simulated day is the next Monday on or after today. */
const firstMonday = addDays(startDate, (8 - dayOfWeek) % 7);

/* ---- set up one business ------------------------------------------------------------------- */

async function prepare(business) {
  const record = state.businesses[business.id];
  const rng = makeRng(`${args.seed}/${business.id}/run`);
  const actors = [];
  for (const member of business.staff) {
    const entry = record.staff[member.key];
    const actor = new Actor({
      business,
      member,
      record: entry,
      rng: rng.fork(`actor/${member.key}`),
      metrics,
      baseUrl: args['api-url'],
    });
    if (member.role.startsWith('Junior')) actor.omit = new Set(['Credit limit', 'annualRevenue']);
    else actor.omit = new Set();
    const signedIn = await actor.signIn(SHARED_PASSWORD);
    if (!signedIn.ok) throw new Error(`${actor.name} cannot sign in: ${signedIn.status}`);
    actors.push(actor);
  }
  const owner = actors[0];
  const context = await discover(owner.api);
  const gen = makeGenerator(rng.fork('gen'));
  const builders = makeBuilders({ business, rng: rng.fork('builders'), gen, context });
  return {
    business,
    actors,
    owner,
    context,
    gen,
    builders,
    rng,
    rates: RATES[business.id],
    notes: {},
  };
}

function makeSim(unit, actor, today, week, dow) {
  return {
    business: unit.business,
    context: unit.context,
    builders: unit.builders,
    gen: unit.gen,
    findings,
    metrics,
    ownerApi: unit.owner.api,
    rates: unit.rates,
    rng: actor.rng,
    today,
    week,
    dow,
    mistakes: unit.notes.mistakes,
    ...unit.shared,
  };
}

/* ---- Monday: reload everything and check what each person sees ------------------------------- */

async function mondayReload(unit, week) {
  const raw = {};
  for (const actor of unit.actors) {
    raw[actor.key] = await actor.refresh();
    const sim = makeSim(unit, actor, firstMonday, week, 0);
    scopeAudit(unit, actor, raw[actor.key], sim);
  }
  // Counts must add up across roles: the owner sees everything; the manager sees the team; reps their own.
  const owner = unit.actors.find((actor) => actor.isOwner);
  const manager = unit.actors.find((actor) => actor.isManager);
  const reader = unit.actors.find((actor) => actor.isReadOnly);
  for (const type of ['account', 'contact', 'lead', 'deal']) {
    const ownerRows = raw[owner.key][type];
    const ownerOwn = ownerRows.filter((row) => row.ownerId === owner.userId).length;
    const teamRows = raw[manager.key][type].length;
    if (teamRows + ownerOwn === ownerRows.length)
      findings.pass(`owner-total-equals-team-plus-own-${type}`);
    if (teamRows + ownerOwn !== ownerRows.length) {
      findings.add({
        id: `scope-totals-differ-${type}`,
        severity: 'medium',
        kind: 'defect',
        title: `The owner's ${type} count is not (manager team count + owner's own) - some records are visible to nobody but the owner, or counted twice`,
        detail: `${unit.business.id} week ${week + 1}: owner ${ownerRows.length}, team ${teamRows}, owner-own ${ownerOwn}`,
      });
    }
    if (reader && raw[reader.key][type].length === ownerRows.length)
      findings.pass(`read-only-sees-everything-${type}`);
    if (reader && raw[reader.key][type].length !== ownerRows.length) {
      findings.add({
        id: `read-only-count-differs-${type}`,
        severity: 'medium',
        kind: 'defect',
        title: `A Read-only user (all scope) sees a different number of ${type}s from the owner`,
        detail: `${unit.business.id}: reader ${raw[reader.key][type].length}, owner ${ownerRows.length}`,
      });
    }
  }
  // Dashboards must agree with the lists for the same person.
  await wonCheck(unit, week, raw);
  for (const actor of unit.actors.filter((item) => !item.isReadOnly)) {
    const dashboard = await actor.api.get('dashboard.pipeline', '/dashboard/pipeline');
    if (!dashboard.ok) {
      unexpected(
        makeSim(unit, actor, firstMonday, week, 0),
        actor,
        'dashboard.pipeline',
        dashboard,
      );
      continue;
    }
    const openIds = new Set(unit.context.openStages.map((stage) => stage.id));
    const openDeals = raw[actor.key].deal.filter((deal) => openIds.has(deal.stageId));
    const sum = openDeals.reduce(
      (total, deal) => total + BigInt(deal.amount?.amountMinor ?? '0'),
      0n,
    );
    const dashCount = dashboard.data.open?.count;
    const dashTotal = BigInt(dashboard.data.open?.total?.amountMinor ?? '0');
    if (dashCount === openDeals.length && dashTotal === sum)
      findings.pass('dashboard-pipeline-equals-list');
    if (dashCount !== openDeals.length || dashTotal !== sum) {
      findings.add({
        id: 'dashboard-differs-from-list',
        severity: 'high',
        kind: 'defect',
        title:
          "A person's pipeline dashboard (open deals count and value) differs from the sum of their own deals list",
        detail: `${unit.business.id} ${actor.name} week ${week + 1}: dashboard ${dashCount} deals / ${dashTotal}; list ${openDeals.length} / ${sum}`,
      });
    }
  }
}

/** "Deals won this month" on the dashboard must equal the won deals the same person's list shows for that month. */
async function wonCheck(unit, week, raw) {
  for (const actor of unit.actors.filter((item) => !item.isReadOnly)) {
    const won = await actor.api.get('dashboard.won', '/dashboard/won');
    if (!won.ok) {
      unexpected(makeSim(unit, actor, firstMonday, week, 0), actor, 'dashboard.won', won);
      continue;
    }
    const { start, end } = won.data.month;
    const wonId = unit.context.wonStage.id;
    const mine = raw[actor.key].deal.filter(
      (deal) =>
        deal.stageId === wonId && deal.closedAt && deal.closedAt >= start && deal.closedAt < end,
    );
    const sum = mine.reduce((total, deal) => total + BigInt(deal.amount?.amountMinor ?? '0'), 0n);
    const shown = won.data.current?.count;
    const shownTotal = BigInt(won.data.current?.total?.amountMinor ?? '0');
    if (shown === mine.length && shownTotal === sum) findings.pass('dashboard-won-equals-list');
    if (shown !== mine.length || shownTotal !== sum) {
      findings.add({
        id: 'dashboard-won-differs-from-list',
        severity: 'high',
        kind: 'defect',
        title:
          'A person\'s "won this month" dashboard figure differs from their won deals in the list',
        detail: `${unit.business.id} ${actor.name} week ${week + 1}: dashboard ${shown} / ${shownTotal}; list ${mine.length} / ${sum}`,
      });
    }
  }
}

function scopeAudit(unit, actor, raw, sim) {
  const teamIds = new Set(
    unit.actors
      .filter(
        (item) => item.isManager || item.role === 'Sales Rep' || item.role.startsWith('Junior'),
      )
      .map((item) => item.userId),
  );
  for (const type of ['account', 'contact', 'lead', 'deal', 'activity']) {
    if (raw[`${type}Error`]) {
      unexpected(sim, actor, `${type}.list-all`, raw[`${type}Error`]);
      continue;
    }
    const rows = raw[type];
    const ownerOf = (row) => (type === 'activity' ? row.assignedTo : row.ownerId);
    if (actor.role === 'Sales Rep' || actor.role.startsWith('Junior')) {
      const foreign = rows.filter((row) => ownerOf(row) !== actor.userId);
      if (foreign.length === 0) findings.pass(`rep-list-only-own-${type}`);
      if (foreign.length > 0)
        findings.add({
          id: `probe-FAIL-own-scope-weekly-${type}`,
          severity: 'high',
          kind: 'security',
          title: `A Sales Rep's ${type} list shows records that belong to someone else`,
          detail: `${unit.business.id} ${actor.name}: ${foreign.length} of ${rows.length}`,
        });
    }
    if (actor.isManager) {
      const outside = rows.filter((row) => !teamIds.has(ownerOf(row)));
      if (outside.length === 0) findings.pass(`manager-list-only-team-${type}`);
      if (outside.length > 0)
        findings.add({
          id: `probe-FAIL-team-scope-weekly-${type}`,
          severity: 'high',
          kind: 'security',
          title: `A Manager's ${type} list shows records from outside the team`,
          detail: `${unit.business.id}: ${outside.length} of ${rows.length}`,
        });
    }
    // Keyset pagination: no row twice.
    const ids = rows.map((row) => row.id);
    if (new Set(ids).size === ids.length) findings.pass(`paging-no-repeats-${type}`);
    if (new Set(ids).size !== ids.length)
      findings.add({
        id: `pagination-duplicates-${type}`,
        severity: 'high',
        kind: 'defect',
        title: `Paging through the ${type} list returned the same record twice`,
        detail: `${unit.business.id} ${actor.name}`,
      });
  }
}

/* ---- one person's day ---------------------------------------------------------------------- */

async function guarded(actor, sim, name, fn) {
  try {
    await fn();
  } catch (error) {
    findings.add({
      id: `tooling-exception-${name}`,
      severity: 'info',
      kind: 'observation',
      title: `Simulation script error in ${name} (a tooling problem, not a product finding)`,
      detail: `${actor.name}: ${String(error?.stack ?? error).slice(0, 400)}`,
    });
  }
}

const repeat = async (count, fn) => {
  for (let index = 0; index < count; index += 1) await fn();
};
const times = (rng, rate) => Math.floor(rate) + (rng.chance(rate - Math.floor(rate)) ? 1 : 0);

async function personDay(unit, actor, sim) {
  const { rng } = sim;
  const dow = sim.dow;
  const run = (name, fn) => guarded(actor, sim, name, fn);

  await run('my-day', () => openMyDay(actor, sim));

  if (actor.isReadOnly) {
    await run('lists', () => repeat(2, () => browseLists(actor, sim)));
    await run('dashboard', () => glanceAtDashboard(actor, sim));
    return;
  }

  if (rng.chance(0.4)) await run('dashboard', () => glanceAtDashboard(actor, sim));
  if (rng.chance(0.4)) await run('notifications', () => checkNotifications(actor, sim));

  if (actor.isOwner) {
    await run('owner-lists', () => repeat(2, () => browseLists(actor, sim)));
    await run('search', () => searchAround(actor, sim));
    if (dow === 1 || dow === 3) await run('audit', () => auditLook(unit, actor, sim));
    if (dow === 4 && (sim.week + 1) % 2 === 0)
      await run('export', () => exportAndCheck(actor, sim, 'deal'));
    if (dow === 2 && sim.week === 2)
      await run('team-structure', () => reviewTeam(unit, actor, sim));
    if (dow === 4 && sim.week === WEEKS - 1)
      await run('tenant-export', () => tenantExport(actor, sim));
    return;
  }

  // Sales people: leads first, then the rest of the day.
  await run('lead-capture', () =>
    repeat(times(rng, sim.rates.leads), () => captureLead(actor, sim)),
  );
  await run('lead-work', () => workLeads(actor, sim));
  await run('lead-convert', () => convertLeads(actor, sim));
  await run('customers', () =>
    repeat(times(rng, sim.rates.customers), () => addCustomer(actor, sim)),
  );
  await run('deal-open', () => repeat(times(rng, sim.rates.deals), () => openDeal(actor, sim)));
  await run('deal-move', () => moveDeals(actor, sim));
  await run('followups', () => scheduleFollowUps(actor, sim));
  await run('complete', () => completeTasks(actor, sim));
  await run('notes', () => writeNotes(actor, sim));
  await run('search', () => searchAround(actor, sim));
  await run('edits', () => repeat(times(rng, sim.rates.edits), () => editRecord(actor, sim)));
  await run('lists', () => repeat(times(rng, sim.rates.lists), () => browseLists(actor, sim)));

  if (dow === 2 && rng.chance(0.5)) await run('attach', () => attachFile(actor, sim));
  if (dow === 3 && sim.week % 2 === 0 && !actor.isManager)
    await run('delete-restore', () => deleteAndRestore(actor, sim));
  if (rng.chance(0.6)) await run('mistake', () => makeMistakes(actor, sim));
  if (dow === 4 && sim.week % 2 === 1 && actor.role === 'Sales Rep')
    await run('export', () => exportAndCheck(actor, sim, 'lead'));

  if (actor.isManager) {
    const reps = unit.actors.filter(
      (item) => item.role === 'Sales Rep' || item.role.startsWith('Junior'),
    );
    const rep = rng.pick(reps);
    if (dow === 1 && (sim.week === 1 || sim.week === 3))
      await run('import', () => importContacts(actor, sim));
    if (dow === 2 && sim.week >= 1 && sim.week <= 4)
      await run('reassign', () => reassignWork(actor, sim, rep));
    if (dow === 1 && sim.week >= 1) await run('assign-task', () => assignTask(actor, sim, rep));
    if (dow === 3 && sim.week >= 1)
      await run('conflict', () => conflictBetweenPeople(actor, rep, sim));
    if (dow === 3 && sim.week % 2 === 0)
      await run('delete-restore', () => deleteAndRestore(actor, sim));
    if (dow === 4) await run('export', () => exportAndCheck(actor, sim, 'account'));
    if (dow === 0) await run('leaderboard', () => glanceAtDashboard(actor, sim));
  }
}

async function auditLook(unit, actor, sim) {
  const first = await actor.api.get('audit.list', '/audit-logs', { limit: 50 });
  if (!first.ok) return unexpected(sim, actor, 'audit.list', first);
  sim.findings.expect(first.data.length > 0, {
    id: 'audit-empty',
    severity: 'high',
    kind: 'defect',
    title: 'The audit log is empty after a day of work',
    detail: unit.business.id,
  });
  const someone = unit.actors.find((item) => item.isManager);
  const byPerson = await actor.api.get('audit.list-filtered', '/audit-logs', {
    actorId: someone.userId,
    objectType: 'deal',
    limit: 20,
  });
  if (!byPerson.ok) return unexpected(sim, actor, 'audit.list-filtered', byPerson);
  sim.findings.expect(
    byPerson.data.every((entry) => entry.actorId === someone.userId),
    {
      id: 'audit-filter-wrong-rows',
      severity: 'high',
      kind: 'defect',
      title: 'Filtering the audit log by person returned entries by other people',
      detail: unit.business.id,
    },
  );
  // Audit rows are append-only and show who changed what.
  const sample = first.data[0];
  sim.findings.expect(sample.actorName !== undefined && sample.action && sample.occurredAt, {
    id: 'audit-entry-incomplete',
    severity: 'medium',
    kind: 'defect',
    title: 'An audit entry lacks who, what or when',
    detail: JSON.stringify(sample).slice(0, 200),
  });
}

async function reviewTeam(unit, actor, sim) {
  const members = await actor.api.get('members.list', '/members', { limit: 100 });
  if (!members.ok) return unexpected(sim, actor, 'members.list', members);
  const roles = await actor.api.get('roles.list', '/roles');
  if (!roles.ok) return unexpected(sim, actor, 'roles.list', roles);
  const reps = unit.actors.find((item) => item.role === 'Sales Rep');
  if (reps) {
    const reach = await actor.api.get('access.member', `/access/members/${reps.userId}`);
    if (!reach.ok) unexpected(sim, actor, 'access.member', reach);
  }
}

async function tenantExport(actor, sim) {
  const created = await actor.api.post('data-export.create', '/data-exports', {
    kind: 'tenant',
    format: 'json',
  });
  if (!created.ok) return unexpected(sim, actor, 'data-export.create', created);
  const job = await waitFor(
    async () => (await actor.api.get('data-export.poll', `/data-exports/${created.data.id}`)).data,
    (value) => value && ['completed', 'failed'].includes(value.status),
    { timeoutMs: 120000, everyMs: 1000 },
  );
  sim.findings.expect(job?.status === 'completed', {
    id: 'tenant-export-failed',
    severity: 'high',
    kind: 'defect',
    title: `The whole-company export did not complete (${job?.status})`,
    detail: String(job?.failureReason ?? ''),
  });
  if (job?.status === 'completed') {
    const link = await actor.api.post(
      'data-export.download-link',
      `/data-exports/${created.data.id}/download`,
    );
    sim.tenantExport = { rows: job.rowCount, bytes: job.sizeBytes, link: link.ok };
  }
}

/* ---- the run ------------------------------------------------------------------------------- */

async function measureSearchLag(unit) {
  const lags = [];
  for (let sample = 0; sample < 3; sample += 1) {
    const word = `Zq${Math.random().toString(36).slice(2, 8)}`;
    const created = await unit.owner.api.post('account.create', '/accounts', {
      name: `${word} Lagtest Traders`,
    });
    if (!created.ok) continue;
    const started = performance.now();
    let found = false;
    while (performance.now() - started < 30000) {
      const result = await unit.owner.api.get('search.lag-poll', '/search', { q: word, limit: 5 });
      if (result.ok && result.data.some((hit) => hit.id === created.data.id)) {
        found = true;
        break;
      }
      await sleep(250);
    }
    lags.push(found ? Math.round(performance.now() - started) : null);
  }
  return lags;
}

async function burst(units) {
  // Everyone at once: each person fires a handful of reads in parallel, the way the Monday morning rush looks.
  const burstMetrics = new Metrics();
  const apis = [];
  for (const unit of units) {
    for (const actor of unit.actors) {
      const api = new Api({
        baseUrl: args['api-url'],
        metrics: burstMetrics,
        who: `burst/${actor.name}`,
      });
      api.cookie = actor.api.cookie;
      apis.push({ api, actor });
    }
  }
  const started = performance.now();
  await Promise.all(
    apis.map(async ({ api, actor }) => {
      for (let round = 0; round < 6; round += 1) {
        await api.get('burst.my-day', '/my-day');
        await api.get('burst.accounts-list', '/accounts', { limit: 50, sort: '-created_at' });
        await api.get('burst.deals-list', '/deals', { limit: 50 });
        await api.get('burst.search', '/search', {
          q: actor.name.split(' ')[1].slice(0, 4),
          limit: 10,
        });
        await api.get('burst.dashboard', '/dashboard/pipeline');
      }
    }),
  );
  return {
    seconds: (performance.now() - started) / 1000,
    users: apis.length,
    summary: burstMetrics.summary(),
    errors: burstMetrics.errorCounts(),
    total: burstMetrics.total,
  };
}

/** A task that falls due a minute from now, with a reminder: checked again at the end of the run. */
async function guardedStart(unit) {
  const rep = unit.actors.find((actor) => actor.role === 'Sales Rep');
  const due = new Date(Date.now() + 90 * 1000).toISOString();
  const response = await rep.api.post('activity.create-reminder', '/activities', {
    type: 'task',
    subject: 'Reminder probe: call back',
    dueAt: due,
    reminderMinutesBefore: 1,
    assignedTo: rep.userId,
  });
  unit.notes.reminderTask = response.ok
    ? { id: response.data.id, dueAt: due, rep: rep.name }
    : { error: response.status };
}

async function reminderOutcome(unit) {
  const task = unit.notes.reminderTask;
  const rep = unit.actors.find((actor) => actor.name === task?.rep);
  if (!task?.id || !rep) return;
  const list = await rep.api.get('notifications.list', '/notifications', { limit: 100 });
  if (!list.ok) return;
  const types = {};
  for (const item of list.data) types[item.type] = (types[item.type] ?? 0) + 1;
  // If the simulated person already completed the task (it falls due on today's list), no reminder is owed.
  const task2 = await rep.api.get('activity.get', `/activities/${task.id}`);
  const completedFirst = task2.ok && task2.data.status !== 'open';
  unit.notes.reminderTaskCompletedBeforeDue = completedFirst;
  const hit = list.data.find(
    (item) => item.type === 'activity.due' && JSON.stringify(item.payload).includes(task.id),
  );
  unit.notes.notificationTypes = types;
  unit.notes.reminderArrived = Boolean(hit);
  findings.expect(Boolean(hit) || completedFirst, {
    id: 'reminder-not-delivered',
    severity: 'high',
    kind: 'defect',
    title: 'A task with a reminder fell due but no "due" notification arrived',
    detail: `${unit.business.id}: due ${task.dueAt}, checked at the end of the run; types seen ${JSON.stringify(types)}`,
  });
}

const only = args.only;
const chosen = BUSINESSES.filter((business) => !only || business.id === only);
const startedAt = Date.now();
log(`preparing ${chosen.length} business(es); simulated weeks start Monday ${firstMonday}`);
const units = [];
for (const business of chosen) {
  const unit = await prepare(business);
  unit.shared = {};
  unit.notes.mistakes = {};
  units.push(unit);
  const counts = {};
  for (const type of ['account', 'contact', 'lead', 'deal']) {
    const result = await unit.owner.api.listAll(`${type}.list-all`, `/${type}s`);
    counts[type] = result.rows.length;
  }
  unit.notes.before = counts;
  await guardedStart(unit);
  log(
    `${business.id}: signed in ${unit.actors.length} people; starting records ${JSON.stringify(counts)}`,
  );
}

const weekSummaries = [];
for (let week = 0; week < WEEKS; week += 1) {
  const before = metrics.total;
  await Promise.all(
    units.map(async (unit) => {
      await mondayReload(unit, week);
      for (let dow = 0; dow < 5; dow += 1) {
        const today = addDays(firstMonday, week * 7 + dow);
        for (const actor of unit.actors) {
          const sim = makeSim(unit, actor, today, week, dow);
          await personDay(unit, actor, sim);
          unit.shared.mistakes = sim.mistakes;
          for (const key of [
            'staleExample',
            'invalidExample',
            'duplicateContact',
            'importResult',
            'errorFileSample',
            'reassignNotice',
            'tenantExport',
            'probeGiveAway',
            'backdating',
            'importTargets',
            'importMatchFields',
          ]) {
            if (sim[key] !== undefined) unit.notes[key] = sim[key];
          }
        }
      }
    }),
  );
  weekSummaries.push({
    week: week + 1,
    requests: metrics.total - before,
    serverErrors: metrics.serverErrors.length,
  });
  log(
    `week ${week + 1} done: ${metrics.total - before} requests, ${metrics.serverErrors.length} server errors so far, ${findings.list().filter((item) => item.severity === 'high').length} high findings`,
  );
}

log('security probes');
const simByBusiness = {};
const actorsByBusiness = {};
for (const unit of units) {
  const actor = unit.owner;
  const sim = makeSim(unit, actor, addDays(firstMonday, WEEKS * 7), WEEKS, 0);
  simByBusiness[unit.business.id] = sim;
  actorsByBusiness[unit.business.id] = unit.actors;
  await guarded(actor, sim, 'probe-within', () => probeWithinBusiness(sim, unit.actors));
  await guarded(actor, sim, 'probe-hidden', () => probeHiddenFields(sim, unit.actors));
  await guarded(actor, sim, 'probe-sessions', () =>
    probeSessions(sim, unit.actors, {
      baseUrl: args['api-url'],
      password: SHARED_PASSWORD,
      metrics,
    }),
  );
  await guarded(actor, sim, 'probe-origin', () =>
    probeOrigin(
      sim,
      unit.actors.find((item) => item.role === 'Sales Rep'),
    ),
  );
  await guarded(actor, sim, 'probe-idempotency', () =>
    probeIdempotency(
      sim,
      unit.actors.find((item) => item.role === 'Sales Rep'),
    ),
  );
  await guarded(actor, sim, 'probe-gaps', () => probeGaps(sim, unit.owner));
  await guarded(actor, sim, 'probe-attachments', () =>
    attachBadFiles(
      unit.actors.find((item) => item.role === 'Sales Rep'),
      sim,
    ),
  );
}
if (units.length > 1)
  await guarded(units[0].owner, simByBusiness[units[0].business.id], 'probe-tenants', () =>
    probeAcrossTenants(simByBusiness, actorsByBusiness),
  );

for (const unit of units) await reminderOutcome(unit);
log('search lag and a burst of everyone at once');
const searchLag = {};
for (const unit of units) searchLag[unit.business.id] = await measureSearchLag(unit);
const burstResult = await burst(units);

const finalCounts = {};
for (const unit of units) {
  const counts = {};
  for (const type of ['account', 'contact', 'lead', 'deal']) {
    const result = await unit.owner.api.listAll(`${type}.list-all`, `/${type}s`);
    counts[type] = result.rows.length;
  }
  finalCounts[unit.business.id] = { before: unit.notes.before, after: counts };
}

const results = {
  startedAt: new Date(startedAt).toISOString(),
  seconds: Math.round((Date.now() - startedAt) / 1000),
  weeks: WEEKS,
  firstMonday,
  requests: metrics.total,
  overall: metrics.overall(),
  latency: metrics.summary(),
  errors: metrics.errorCounts(),
  rateLimited: metrics.rateLimited,
  serverErrors: metrics.serverErrors,
  weekSummaries,
  finalCounts,
  actorCounts: Object.fromEntries(
    units.map((unit) => [
      unit.business.id,
      Object.fromEntries(unit.actors.map((actor) => [actor.name, actor.counts])),
    ]),
  ),
  notes: Object.fromEntries(units.map((unit) => [unit.business.id, unit.notes])),
  searchLag,
  burst: burstResult,
  checksPassed: Object.fromEntries(findings.passes),
  slowRequests: metrics.slow,
  findings: findings.list(),
};
writeJson(args.out, results);
log(
  `finished in ${results.seconds} s: ${metrics.total} requests, ${metrics.serverErrors.length} server errors, ${findings.list().length} findings. Results: ${args.out}`,
);
void staffEmail;
void exportRecords;
