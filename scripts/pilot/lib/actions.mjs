import { addDays, fill, rupees } from './records.mjs';
import { sleep } from './http.mjs';

/**
 * What a salesperson, manager or owner does in a day. Each action does what the screen would do (the
 * same calls, in the same order), then checks that what came back is what a person would expect.
 * A check that fails becomes a finding; an unexpected HTTP error becomes a finding too.
 *
 * `sim` carries: business, context (pipeline, fields), builders, findings, today (YYYY-MM-DD in
 * simulated time), week, day.
 */

/** Records an unexpected failure once per kind, with one example. */
/** Actions where, in a team, someone else may have changed or taken the record a moment before. */
const COLLISION_ACTIONS = new Set([
  'deal.move',
  'deal.update',
  'deal.delete',
  'lead.update',
  'lead.delete',
  'activity.create',
  'note.create',
  'attachment.create',
  'contact.update',
  'account.update',
  'activity.complete',
]);

export function unexpected(sim, actor, action, response, extra = '') {
  const detailText = JSON.stringify(response.body?.error?.details ?? []);
  const vanished = response.status === 404 || /does not exist/.test(detailText);
  const converted =
    response.code === 'CONFLICT' &&
    /already (been )?converted/i.test(response.body?.error?.message ?? '');
  if (converted) {
    actor.count('collision');
    sim.findings.add({
      id: 'collision-already-converted',
      severity: 'info',
      kind: 'observation',
      title:
        'A converted lead is locked: editing it answers 409 CONFLICT "already converted" (clear message, but a different code from a stale version)',
      detail: `${action}: ${response.body?.error?.message}`,
    });
    return;
  }
  if (response.code === 'VERSION_CONFLICT' || (vanished && COLLISION_ACTIONS.has(action))) {
    // Two people on one record is ordinary in a team; it is counted, not reported as a defect.
    actor.count('collision');
    sim.findings.add({
      id: `collision-${response.code === 'VERSION_CONFLICT' ? 'stale-version' : 'record-gone'}`,
      severity: 'info',
      kind: 'observation',
      title:
        response.code === 'VERSION_CONFLICT'
          ? 'Someone else had changed the record: the second person got 409 VERSION_CONFLICT (as designed)'
          : 'The record had been reassigned or deleted by someone else: the first person got a bare 404 "not found" (or "That record does not exist" on a link) with no hint of why',
      detail:
        `${action}: ${response.status} ${response.body?.error?.message ?? ''} ${detailText}`.slice(
          0,
          240,
        ),
    });
    return;
  }
  sim.findings.add({
    id: `unexpected-${action}-${response.status}-${response.code ?? 'none'}`,
    severity: response.status >= 500 || response.status === 0 ? 'high' : 'medium',
    kind: 'defect',
    title: `${action} failed unexpectedly: HTTP ${response.status} ${response.code ?? ''}`,
    detail:
      `${actor.name} (${sim.business.id}) ${extra} ${JSON.stringify(response.body?.error ?? response.body ?? '').slice(0, 300)}`.trim(),
    where: action,
  });
}

const sameEmail = (a, b) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/**
 * Two people working the same lead (a manager and the rep who owns it) is ordinary. A stale version and
 * "already converted" are both the answer; the second one comes with a different error code, which is noted.
 */
function collision(sim, actor, lead, response) {
  if (response.code === 'VERSION_CONFLICT') {
    actor.count('conflict.lead');
    return true;
  }
  if (
    response.code === 'CONFLICT' &&
    /already (been )?converted/i.test(response.body?.error?.message ?? '')
  ) {
    actor.count('conflict.lead-already-converted');
    actor.track('lead', { id: lead.id, status: 'converted' });
    sim.findings.add({
      id: 'two-conflict-codes',
      severity: 'info',
      kind: 'observation',
      title:
        'A stale edit answers 409 VERSION_CONFLICT, but a change to an already-converted lead answers 409 CONFLICT: a client has to handle both codes',
      detail: String(response.body?.error?.message),
    });
    return true;
  }
  return false;
}

/** Whole number of times something happens today: 1.6 means once, and a 60% chance of twice. */
function times(rng, rate) {
  return Math.floor(rate) + (rng.chance(rate - Math.floor(rate)) ? 1 : 0);
}

const timeOnDay = (sim, rng) =>
  `${sim.today}T${String(rng.int(4, 12)).padStart(2, '0')}:${rng.pick(['00', '15', '30', '45'])}:00.000Z`;

/* ---------------------------------------------------------------------------------------------- */

export async function openMyDay(actor, sim) {
  const response = await actor.api.get('my-day', '/my-day', { date: sim.today });
  if (!response.ok) return unexpected(sim, actor, 'my-day', response);
  actor.myDay = response.data;
  sim.findings.expect(response.data.date === sim.today, {
    id: 'my-day-wrong-date',
    severity: 'medium',
    kind: 'defect',
    title: 'My Day ignored the requested date',
    detail: `asked ${sim.today}, got ${response.data.date}`,
  });
  // Every task shown must be assigned to the viewer (own scope) and be open.
  for (const task of [...response.data.overdue, ...response.data.dueToday]) {
    sim.findings.expect(task.status === 'open', {
      id: 'my-day-shows-closed-task',
      severity: 'medium',
      kind: 'defect',
      title: 'My Day lists a task that is not open',
      detail: `${task.subject} is ${task.status}`,
    });
  }
  const unread = await actor.api.get('notifications.unread', '/notifications/unread-count');
  if (!unread.ok) unexpected(sim, actor, 'notifications.unread', unread);
}

export async function glanceAtDashboard(actor, sim) {
  const pipeline = await actor.api.get('dashboard.pipeline', '/dashboard/pipeline');
  if (!pipeline.ok) return unexpected(sim, actor, 'dashboard.pipeline', pipeline);
  const overdue = await actor.api.get('dashboard.overdue', '/dashboard/overdue-tasks');
  if (!overdue.ok) unexpected(sim, actor, 'dashboard.overdue', overdue);
  if (actor.isManager || actor.isOwner) {
    const board = await actor.api.get('dashboard.leaderboard', '/dashboard/leaderboard');
    if (!board.ok) unexpected(sim, actor, 'dashboard.leaderboard', board);
    const bySource = await actor.api.get('dashboard.leads-by-source', '/dashboard/leads-by-source');
    if (!bySource.ok) unexpected(sim, actor, 'dashboard.leads-by-source', bySource);
  }
}

export async function checkNotifications(actor, sim) {
  const list = await actor.api.get('notifications.list', '/notifications', { limit: 20 });
  if (!list.ok) return unexpected(sim, actor, 'notifications.list', list);
  const unread = list.data.find((item) => item.readAt === null || item.read === false);
  if (unread && sim.rng.chance(0.5)) {
    const read = await actor.api.post('notifications.read', `/notifications/${unread.id}/read`);
    if (!read.ok) unexpected(sim, actor, 'notifications.read', read);
  }
}

/* ---- leads -------------------------------------------------------------------------------- */

export async function captureLead(actor, sim) {
  const built = sim.builders.lead();
  // A careful rep checks for an existing lead first; a busy one does not. Both happen.
  if (sim.rng.chance(0.3) && built.payload.email) {
    const check = await actor.api.post('lead.duplicate-check', '/leads/duplicate-check', {
      email: built.payload.email,
      phone: built.payload.phone,
    });
    if (!check.ok) unexpected(sim, actor, 'lead.duplicate-check', check);
  }
  const response = await actor.api.post('lead.create', '/leads', built.payload);
  if (!response.ok) return unexpected(sim, actor, 'lead.create', response, built.payload.lastName);
  actor.track('lead', response.data);
  actor.count('lead.created');
  verifyEcho(sim, actor, 'lead', built.payload, response.data, [
    'firstName',
    'lastName',
    'company',
    'email',
    'phone',
    'source',
    'status',
  ]);
  sim.findings.expect(response.data.ownerId === actor.userId, {
    id: 'lead-owner-not-creator',
    severity: 'high',
    kind: 'defect',
    title: 'A new lead was not owned by the person who created it',
    detail: `owner ${response.data.ownerId}, creator ${actor.userId}`,
  });
  const back = await actor.api.get('lead.get', `/leads/${response.data.id}`);
  if (back.ok)
    sim.findings.expect(back.data.version === response.data.version, {
      id: 'lead-get-version-differs',
      severity: 'medium',
      kind: 'defect',
      title: 'GET after create shows a different version',
      detail: `${back.data.version} vs ${response.data.version}`,
    });
  await actor.api.post('record-view', '/record-views', {
    objectType: 'lead',
    recordId: response.data.id,
  });
}

export async function workLeads(actor, sim) {
  const rng = sim.rng;
  const open = actor
    .list('lead')
    .filter((lead) => lead.status !== 'converted' && lead.status !== 'unqualified');
  const count = Math.min(open.length, times(rng, sim.rates.leadWork));
  for (const lead of rng.shuffle(open).slice(0, count)) {
    const next =
      {
        new: 'contacted',
        contacted: rng.chance(0.75) ? 'qualified' : 'unqualified',
        qualified: 'qualified',
      }[lead.status] ?? lead.status;
    if (next !== lead.status) {
      const response = await actor.api.patch('lead.update', `/leads/${lead.id}`, {
        version: lead.version,
        status: next,
      });
      if (!response.ok) {
        if (collision(sim, actor, lead, response)) continue;
        unexpected(sim, actor, 'lead.update', response);
        continue;
      }
      sim.findings.expect(
        response.data.status === next && response.data.version === lead.version + 1,
        {
          id: 'lead-update-result-wrong',
          severity: 'high',
          kind: 'defect',
          title: 'Lead status change not reflected correctly',
          detail: `wanted ${next} v${lead.version + 1}, got ${response.data.status} v${response.data.version}`,
        },
      );
      actor.track('lead', response.data);
    }
    // A call to the lead goes in as an activity linked to it.
    const call = sim.builders.activity({
      type: 'call',
      subjectVars: { contact: lead.name, account: lead.company ?? lead.name },
      links: [{ objectType: 'lead', recordId: lead.id }],
      dueAt: timeOnDay(sim, rng),
      assignedTo: actor.userId,
    });
    call.status = 'completed';
    const logged = await actor.api.post('activity.create', '/activities', call);
    if (logged.ok) {
      actor.track('activity', logged.data);
      sim.findings.expect(logged.data.status === 'completed' && logged.data.completedAt, {
        id: 'activity-created-completed-no-completedat',
        severity: 'low',
        kind: 'defect',
        title: 'An activity created as completed has no completion time',
        detail: JSON.stringify({
          status: logged.data.status,
          completedAt: logged.data.completedAt,
        }),
      });
    } else unexpected(sim, actor, 'activity.create', logged);
  }
}

export async function convertLeads(actor, sim) {
  const rng = sim.rng;
  const ready = actor.list('lead').filter((lead) => lead.status === 'qualified');
  const count = Math.min(ready.length, times(rng, sim.rates.convert));
  for (const lead of rng.shuffle(ready).slice(0, count)) {
    const matches = await actor.api.get(
      'lead.conversion-matches',
      `/leads/${lead.id}/conversion-matches`,
    );
    if (!matches.ok) {
      unexpected(sim, actor, 'lead.conversion-matches', matches);
      continue;
    }
    const withDeal = rng.chance(0.7);
    const [low, high] = sim.business.amountRupees;
    const body = {
      version: lead.version,
      contact: { mode: 'create' },
      account: lead.company ? { mode: 'create' } : { mode: 'none' },
      deal: withDeal
        ? {
            name: `${sim.business.id === 'coaching' ? 'Enrolment' : 'First order'} - ${lead.company ?? lead.name}`,
            amount: rupees(Math.round(rng.int(low, Math.min(high, low * 6)) / 100) * 100),
            expectedCloseDate: addDays(sim.today, rng.int(5, 40)),
          }
        : null,
      acknowledgeDuplicates: false,
    };
    const matchList = matches.data ?? [];
    if (matchList.length > 0) {
      const contactMatch = matchList.find((item) => item.objectType === 'contact');
      const accountMatch = matchList.find((item) => item.objectType === 'account');
      if (contactMatch) body.contact = { mode: 'link', contactId: contactMatch.id };
      if (accountMatch && lead.company) body.account = { mode: 'link', accountId: accountMatch.id };
      actor.count('convert.linked-to-existing');
    }
    let response = await actor.api.post('lead.convert', `/leads/${lead.id}/convert`, body);
    if (!response.ok && response.code && /DUPLICATE/i.test(response.code)) {
      actor.count('convert.duplicate-warning');
      response = await actor.api.post('lead.convert-ack', `/leads/${lead.id}/convert`, {
        ...body,
        acknowledgeDuplicates: true,
      });
    }
    if (!response.ok) {
      if (!collision(sim, actor, lead, response))
        unexpected(sim, actor, 'lead.convert', response, lead.name);
      continue;
    }
    const result = response.data;
    actor.count('lead.converted');
    sim.findings.expect(result.lead.status === 'converted' && result.contact?.id, {
      id: 'convert-result-wrong',
      severity: 'high',
      kind: 'defect',
      title: 'Lead conversion result is missing the converted status or contact',
      detail: JSON.stringify(result).slice(0, 300),
    });
    sim.findings.expect(!withDeal || result.deal?.id, {
      id: 'convert-no-deal',
      severity: 'high',
      kind: 'defect',
      title: 'Conversion asked for a deal but none came back',
      detail: JSON.stringify(result).slice(0, 300),
    });
    actor.track('lead', { ...result.lead, status: 'converted' });
    // The new records must be reachable, by the person who converted.
    const contact = await actor.api.get('contact.get', `/contacts/${result.contact.id}`);
    if (!contact.ok) unexpected(sim, actor, 'contact.get-after-convert', contact);
    else actor.track('contact', contact.data);
    if (result.account?.id) {
      const account = await actor.api.get('account.get', `/accounts/${result.account.id}`);
      if (account.ok) actor.track('account', account.data);
      else unexpected(sim, actor, 'account.get-after-convert', account);
    }
    if (result.deal?.id) {
      const deal = await actor.api.get('deal.get', `/deals/${result.deal.id}`);
      if (deal.ok) {
        actor.track('deal', deal.data);
        sim.findings.expect(deal.data.stageId === sim.context.openStages[0].id, {
          id: 'convert-deal-not-first-stage',
          severity: 'low',
          kind: 'observation',
          title: 'A deal made by conversion starts in a stage other than the first',
          detail: String(deal.data.stageId),
        });
      } else unexpected(sim, actor, 'deal.get-after-convert', deal);
    }
    // Converting twice must not work.
    if (rng.chance(0.1)) {
      const again = await actor.api.post('lead.convert-again', `/leads/${lead.id}/convert`, {
        ...body,
        version: result.lead.version,
      });
      sim.findings.expect(!again.ok, {
        id: 'convert-twice-allowed',
        severity: 'high',
        kind: 'defect',
        title: 'A converted lead could be converted a second time',
        detail: `HTTP ${again.status}`,
      });
    }
  }
}

/* ---- accounts, contacts ------------------------------------------------------------------- */

export async function addCustomer(actor, sim) {
  const built = sim.builders.account({ omit: actor.omit });
  const response = await actor.api.post('account.create', '/accounts', built.payload);
  if (!response.ok) return unexpected(sim, actor, 'account.create', response, built.payload.name);
  actor.track('account', response.data);
  actor.count('account.created');
  verifyEcho(sim, actor, 'account', built.payload, response.data, [
    'name',
    'phone',
    'email',
    'gstin',
    'domain',
  ]);
  const people = 1 + (sim.rng.chance(0.4) ? 1 : 0);
  for (let index = 0; index < people; index += 1) {
    const contact = sim.builders.contact({
      accountId: response.data.id,
      accountName: built.payload.name,
    });
    const created = await actor.api.post('contact.create', '/contacts', contact.payload);
    if (created.ok) {
      actor.track('contact', created.data);
      actor.count('contact.created');
    } else unexpected(sim, actor, 'contact.create', created);
  }
}

export async function editRecord(actor, sim) {
  const rng = sim.rng;
  const type = rng.weighted([
    ['account', 3],
    ['contact', 4],
    ['lead', 2],
    ['deal', 3],
  ]);
  const record = actor.pick(type);
  if (!record) return;
  const body = { version: record.version };
  if (type === 'account') body.phone = sim.gen.phone();
  if (type === 'contact')
    body.title = rng.pick(['Owner', 'Director', 'Accounts head', 'Admin', 'Partner']);
  if (type === 'lead') body.source = rng.weighted(sim.business.leadSources);
  if (type === 'deal') body.expectedCloseDate = addDays(sim.today, rng.int(2, 70));
  const response = await actor.api.patch(`${type}.update`, `/${type}s/${record.id}`, body);
  if (!response.ok) {
    if (response.code === 'VERSION_CONFLICT') {
      actor.count(`conflict.${type}`);
      sim.findings.add({
        id: 'edit-conflict-unplanned',
        severity: 'info',
        kind: 'observation',
        title: 'A normal edit hit a version conflict (someone else changed the record)',
        detail: `${type} ${record.id}`,
      });
      const fresh = await actor.api.get(`${type}.get`, `/${type}s/${record.id}`);
      if (fresh.ok) actor.track(type, fresh.data);
    } else unexpected(sim, actor, `${type}.update`, response);
    return;
  }
  actor.track(type, response.data);
  sim.findings.expect(response.data.version === record.version + 1, {
    id: `${type}-version-not-incremented`,
    severity: 'high',
    kind: 'defect',
    title: `A ${type} edit did not raise the version by one`,
    detail: `${record.version} -> ${response.data.version}`,
  });
  if (type === 'account')
    sim.findings.expect(response.data.phone === body.phone, {
      id: 'account-edit-not-saved',
      severity: 'high',
      kind: 'defect',
      title: 'An edited account phone number was not saved',
      detail: `${response.data.phone} vs ${body.phone}`,
    });
}

/* ---- deals -------------------------------------------------------------------------------- */

export async function openDeal(actor, sim) {
  const account = actor.pick('account');
  if (!account) return;
  const contact = actor.pick('contact', (item) => item.accountId === account.id);
  const built = sim.builders.deal({
    accountId: account.id,
    accountName: account.name,
    contactId: contact?.id ?? null,
    stageId: sim.context.openStages[0].id,
    today: sim.today,
  });
  const response = await actor.api.post('deal.create', '/deals', built.payload);
  if (!response.ok) return unexpected(sim, actor, 'deal.create', response, built.payload.name);
  actor.track('deal', response.data);
  actor.count('deal.created');
  verifyEcho(sim, actor, 'deal', built.payload, response.data, [
    'name',
    'accountId',
    'stageId',
    'expectedCloseDate',
  ]);
  sim.findings.expect(response.data.amount?.amountMinor === built.payload.amount.amountMinor, {
    id: 'deal-amount-changed',
    severity: 'high',
    kind: 'defect',
    title: 'A deal amount came back different from what was entered',
    detail: JSON.stringify([built.payload.amount, response.data.amount]),
  });
  sim.findings.expect(response.data.probability === sim.context.openStages[0].probability, {
    id: 'deal-initial-probability',
    severity: 'low',
    kind: 'observation',
    title: 'A new deal does not take the first stage probability',
    detail: `${response.data.probability} vs ${sim.context.openStages[0].probability}`,
  });
}

export async function moveDeals(actor, sim) {
  const rng = sim.rng;
  const stages = sim.context.stages;
  const order = sim.context.openStages;
  const open = actor
    .list('deal')
    .filter((deal) => !deal.closedAt && order.some((stage) => stage.id === deal.stageId));
  const count = Math.min(open.length, times(rng, sim.rates.dealMoves));
  for (const deal of rng.shuffle(open).slice(0, count)) {
    const index = order.findIndex((stage) => stage.id === deal.stageId);
    let target;
    let lostReason;
    if (index === order.length - 1) {
      if (rng.chance(0.55)) target = sim.context.wonStage;
      else {
        target = sim.context.lostStage;
        lostReason = rng.pick(sim.business.lostReasons);
      }
    } else if (rng.chance(0.07)) {
      target = sim.context.lostStage;
      lostReason = rng.pick(sim.business.lostReasons);
    } else {
      target = order[Math.min(order.length - 1, index + (rng.chance(0.25) ? 2 : 1))];
    }
    const body = { version: deal.version, stageId: target.id };
    if (lostReason) body.lostReason = lostReason;
    const response = await actor.api.patch('deal.move', `/deals/${deal.id}`, body);
    if (!response.ok) {
      if (response.code === 'VERSION_CONFLICT') {
        actor.count('conflict.deal');
        const fresh = await actor.api.get('deal.get', `/deals/${deal.id}`);
        if (fresh.ok) actor.track('deal', fresh.data);
      } else unexpected(sim, actor, 'deal.move', response, `${deal.name} -> ${target.name}`);
      continue;
    }
    actor.track('deal', response.data);
    actor.count('deal.moved');
    sim.findings.expect(response.data.stageId === target.id, {
      id: 'deal-move-not-applied',
      severity: 'high',
      kind: 'defect',
      title: 'Deal stage change was not applied',
      detail: `${target.name}`,
    });
    if (target.stageType === 'won') {
      actor.count('deal.won');
      sim.findings.expect(response.data.closedAt && response.data.probability === 100, {
        id: 'won-deal-not-closed',
        severity: 'high',
        kind: 'defect',
        title: 'A deal moved to Won has no closing time or probability 100',
        detail: JSON.stringify({
          closedAt: response.data.closedAt,
          probability: response.data.probability,
        }),
      });
    }
    if (target.stageType === 'lost') {
      actor.count('deal.lost');
      sim.findings.expect(
        response.data.closedAt && response.data.probability === 0 && response.data.lostReason,
        {
          id: 'lost-deal-not-closed',
          severity: 'high',
          kind: 'defect',
          title: 'A deal moved to Lost lacks closing time, probability 0 or reason',
          detail: JSON.stringify({
            closedAt: response.data.closedAt,
            probability: response.data.probability,
            lostReason: response.data.lostReason,
          }),
        },
      );
    }
    if (target.stageType === 'open') {
      sim.findings.expect(response.data.probability === target.probability, {
        id: 'move-probability-not-from-stage',
        severity: 'low',
        kind: 'observation',
        title: 'Moving a deal to an open stage did not set the stage probability',
        detail: `${response.data.probability} vs ${target.probability}`,
      });
    }
    await actor.api.post('record-view', '/record-views', { objectType: 'deal', recordId: deal.id });
  }
  void stages;
}

/* ---- follow-ups ----------------------------------------------------------------------------- */

export async function scheduleFollowUps(actor, sim) {
  const rng = sim.rng;
  const count = times(rng, sim.rates.tasks);
  for (let index = 0; index < count; index += 1) {
    const kind = rng.pick(['deal', 'account', 'contact']);
    const record = actor.pick(kind);
    if (!record) continue;
    const vars = {
      contact: record.name ?? 'the customer',
      account: record.name ?? 'the customer',
      product: rng.pick(sim.business.products),
    };
    if (kind === 'deal') {
      const account = actor.book.account.get(record.accountId);
      vars.account = account?.name ?? 'the customer';
      vars.contact = actor.book.contact.get(record.primaryContactId)?.name ?? 'the customer';
    }
    const built = sim.builders.activity({
      type: rng.weighted([
        ['task', 6],
        ['call', 3],
        ['meeting', 1],
      ]),
      subjectVars: vars,
      links: [{ objectType: kind, recordId: record.id }],
      dueAt: `${addDays(sim.today, rng.int(0, 10))}T${String(rng.int(4, 12)).padStart(2, '0')}:30:00.000Z`,
      assignedTo: actor.userId,
    });
    const response = await actor.api.post('activity.create', '/activities', built);
    if (!response.ok) {
      unexpected(sim, actor, 'activity.create', response);
      continue;
    }
    actor.track('activity', response.data);
    actor.count('task.created');
  }
}

export async function completeTasks(actor, sim) {
  const rng = sim.rng;
  const due = [...(actor.myDay?.overdue ?? []), ...(actor.myDay?.dueToday ?? [])];
  const count = Math.min(due.length, times(rng, sim.rates.complete));
  for (const task of rng.shuffle(due).slice(0, count)) {
    const response = await actor.api.patch('activity.complete', `/activities/${task.id}`, {
      version: task.version,
      status: 'completed',
    });
    if (!response.ok) {
      if (response.code === 'VERSION_CONFLICT') actor.count('conflict.activity');
      else unexpected(sim, actor, 'activity.complete', response);
      continue;
    }
    actor.count('task.completed');
    actor.track('activity', response.data);
    sim.findings.expect(response.data.status === 'completed' && response.data.completedAt, {
      id: 'complete-task-no-completedat',
      severity: 'medium',
      kind: 'defect',
      title: 'Completing a task did not record when',
      detail: JSON.stringify({
        status: response.data.status,
        completedAt: response.data.completedAt,
      }),
    });
    // Having done it, they often line up the next step.
    if (rng.chance(0.4)) {
      const link = task.links?.[0];
      if (link) {
        const next = sim.builders.activity({
          type: 'task',
          subjectVars: { contact: link.label, account: link.label },
          links: [{ objectType: link.objectType, recordId: link.recordId }],
          dueAt: `${addDays(sim.today, rng.int(1, 7))}T09:30:00.000Z`,
          assignedTo: actor.userId,
        });
        const created = await actor.api.post('activity.create', '/activities', next);
        if (created.ok) actor.track('activity', created.data);
        else unexpected(sim, actor, 'activity.create', created);
      }
    }
  }
}

export async function writeNotes(actor, sim) {
  const rng = sim.rng;
  const count = times(rng, sim.rates.notes);
  for (let index = 0; index < count; index += 1) {
    const kind = rng.pick(['deal', 'account', 'contact', 'lead']);
    const record = actor.pick(kind);
    if (!record) continue;
    const vars = {
      contact: record.name ?? 'the customer',
      account: record.name ?? 'the customer',
      product: rng.pick(sim.business.products),
    };
    const built = sim.builders.note({ vars, links: [{ objectType: kind, recordId: record.id }] });
    const response = await actor.api.post('note.create', '/activities', built);
    if (!response.ok) unexpected(sim, actor, 'note.create', response);
    else actor.count('note.created');
    // A person who just wrote a note sees it on the record's timeline/list of activities.
    if (response.ok && rng.chance(0.25)) {
      const list = await actor.api.get('activity.list-for-record', '/activities', {
        objectType: kind,
        recordId: record.id,
        limit: 20,
      });
      if (list.ok)
        sim.findings.expect(
          list.data.some((item) => item.id === response.data.id),
          {
            id: 'note-missing-from-record',
            severity: 'high',
            kind: 'defect',
            title: 'A note just written does not show in the record activity list',
            detail: `${kind} ${record.id}`,
          },
        );
      else unexpected(sim, actor, 'activity.list-for-record', list);
    }
  }
}

/* ---- finding things --------------------------------------------------------------------------- */

export async function searchAround(actor, sim) {
  const rng = sim.rng;
  const count = times(rng, sim.rates.searches);
  for (let index = 0; index < count; index += 1) {
    const kind = rng.pick(['account', 'contact', 'lead']);
    const record = actor.pick(kind);
    if (!record) continue;
    let query;
    const mode = rng.pick(['name', 'name', 'email', 'phone', 'partial']);
    if (mode === 'email' && record.email) query = record.email.split('@')[0].split('.')[0];
    else if (mode === 'phone' && record.phone) query = record.phone.slice(-6);
    else if (mode === 'partial' && record.name) query = record.name.split(' ')[0].slice(0, 4);
    else query = (record.name ?? record.company ?? '').split(' ')[0];
    if (!query || query.length < 2) continue;
    const response = await actor.api.get('search', '/search', { q: query, limit: 10 });
    if (!response.ok) {
      unexpected(sim, actor, 'search', response, query);
      continue;
    }
    actor.count('search');
    sim.searched = (sim.searched ?? 0) + 1;
    // Anything shown must open for the same person (no result they cannot read).
    for (const hit of response.data.slice(0, 3)) {
      if (!['account', 'contact', 'lead', 'deal'].includes(hit.objectType)) continue;
      const opened = await actor.api.get(`${hit.objectType}.get`, `/${hit.objectType}s/${hit.id}`);
      sim.findings.expect(opened.ok, {
        id: 'search-hit-not-openable',
        severity: 'high',
        kind: 'security',
        title: 'A search result could not be opened by the person who searched',
        detail: `${hit.objectType} ${hit.id}: HTTP ${opened.status}`,
      });
    }
    // An account's first word is an invented name, so searching it should find that account (once it has had time to be indexed).
    if (
      mode === 'name' &&
      kind === 'account' &&
      record.createdAt &&
      Date.now() - new Date(record.createdAt).getTime() > 120000 &&
      !response.data.some((hit) => hit.id === record.id) &&
      response.data.length < 10
    ) {
      sim.findings.add({
        id: 'search-misses-known-account',
        severity: 'medium',
        kind: 'defect',
        title:
          'Searching for the first word of an existing account name does not find that account',
        detail: `${actor.name} searched "${query}"; wanted ${record.id}; got ${response.data.length} result(s)`,
      });
    }
    if (mode === 'name' && response.data.length === 0) {
      sim.findings.add({
        id: 'search-misses-known-record',
        severity: 'medium',
        kind: 'defect',
        title: 'Searching for the first word of a known record name found nothing',
        detail: `${actor.name} searched "${query}" for ${kind} ${record.id}`,
      });
    }
    if (rng.chance(0.5) && response.data[0]) {
      const hit = response.data[0];
      if (['account', 'contact', 'lead', 'deal'].includes(hit.objectType))
        await actor.api.post('record-view', '/record-views', {
          objectType: hit.objectType,
          recordId: hit.id,
        });
    }
  }
}

export async function browseLists(actor, sim) {
  const rng = sim.rng;
  const type = rng.pick(['accounts', 'contacts', 'leads', 'deals']);
  const sort = {
    accounts: '-created_at',
    contacts: 'last_name',
    leads: '-created_at',
    deals: '-created_at',
  }[type];
  const first = await actor.api.get(`${type}.list`, `/${type}`, { limit: 50, sort });
  if (!first.ok) return unexpected(sim, actor, `${type}.list`, first, `sort ${sort}`);
  if (['accounts', 'contacts', 'leads'].includes(type) && rng.chance(0.3)) {
    const known = actor.pick(
      type.slice(0, -1),
      (item) => item.createdAt && Date.now() - new Date(item.createdAt).getTime() > 120000,
    );
    const word = (type === 'accounts' ? known?.name : (known?.company ?? known?.name))?.split(
      ' ',
    )[0];
    if (known && word && word.length >= 3) {
      const found = await actor.api.get(`${type}.list-q`, `/${type}`, { q: word, limit: 50 });
      if (!found.ok) unexpected(sim, actor, `${type}.list-q`, found, word);
      else if (type === 'accounts' && !found.data.some((row) => row.id === known.id)) {
        sim.findings.add({
          id: 'list-q-misses-known-account',
          severity: 'medium',
          kind: 'defect',
          title:
            'The search box above the accounts list does not find an existing account by its first word',
          detail: `${actor.name} q=${word}; wanted ${known.id}`,
        });
      }
    }
  }
  if (type === 'leads') {
    const filtered = await actor.api.get('leads.list-filtered', '/leads', {
      filter: 'status:eq:new',
      limit: 50,
    });
    if (!filtered.ok) unexpected(sim, actor, 'leads.list-filtered', filtered);
    else
      sim.findings.expect(
        filtered.data.every((lead) => lead.status === 'new'),
        {
          id: 'list-filter-wrong-rows',
          severity: 'high',
          kind: 'defect',
          title: 'A list filter returned rows that do not match it',
          detail: 'status:eq:new',
        },
      );
  }
  if (type === 'deals' && rng.chance(0.5)) {
    const board = await actor.api.get('deals.board', '/deals/board');
    if (!board.ok) unexpected(sim, actor, 'deals.board', board);
  }
  if (rng.chance(0.5) && first.data[0]) {
    const one = await actor.api.get(`${type.slice(0, -1)}.get`, `/${type}/${first.data[0].id}`);
    if (!one.ok) unexpected(sim, actor, `${type.slice(0, -1)}.get`, one);
  }
}

/* ---- checks shared by actions --------------------------------------------------------------- */

/** JSON with sorted keys, so two objects with the same content compare equal whatever their key order. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** What was sent must come back as sent (apart from lower-cased e-mail, upper-cased GSTIN). */
export function verifyEcho(sim, actor, type, sent, got, keys) {
  sim.findings.pass(`saved-${type}-comes-back-as-sent`);
  for (const key of keys) {
    if (sent[key] === undefined || sent[key] === null) continue;
    const a = key === 'email' ? String(sent[key]).toLowerCase() : sent[key];
    if (a !== got[key]) {
      sim.findings.add({
        id: `echo-mismatch-${type}-${key}`,
        severity: 'high',
        kind: 'defect',
        title: `A ${type} came back with a different ${key} from what was saved`,
        detail: `sent ${JSON.stringify(sent[key])}, got ${JSON.stringify(got[key])}`,
      });
    }
  }
  const sentCustom = sent.customFields ?? {};
  for (const [key, value] of Object.entries(sentCustom)) {
    if (stable(got.customFields?.[key]) !== stable(value)) {
      sim.findings.add({
        id: `echo-mismatch-${type}-custom`,
        severity: 'high',
        kind: 'defect',
        title: `A ${type} custom field came back different from what was saved`,
        detail: `${key}: sent ${JSON.stringify(value)}, got ${JSON.stringify(got.customFields?.[key])}`,
      });
    }
  }
}

export { fill, sameEmail, sleep, times };
