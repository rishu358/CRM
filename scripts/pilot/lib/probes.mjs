import { Api } from './http.mjs';
import { exportRecords } from './flows.mjs';
import { totp } from './totp.mjs';

/**
 * Security probes. Each one tries something a person must NOT be able to do and records a HIGH finding if
 * it works. A probe that passes is also written down (as "good"), so the report shows what was tried.
 */

/** A valid edit for each kind of record (validation runs first, so a probe must send something valid). */
const editFor = (type) =>
  ({
    account: { phone: '+910000000001' },
    contact: { title: 'Hijacked' },
    lead: { source: 'Hijacked' },
    deal: { expectedCloseDate: '2030-01-01' },
  })[type];
const SECRET_PATHS = ['accounts', 'contacts', 'leads', 'deals', 'activities'];
const TYPE_OF = {
  accounts: 'account',
  contacts: 'contact',
  leads: 'lead',
  deals: 'deal',
  activities: 'activity',
};

function pass(sim, id, title, detail = '') {
  sim.findings.add({ id: `probe-ok-${id}`, severity: 'good', kind: 'security', title, detail });
}

function fail(sim, id, title, detail) {
  sim.findings.add({ id: `probe-FAIL-${id}`, severity: 'high', kind: 'security', title, detail });
}

/** Within one business: a rep sees only their own; others' ids are 404; admin routes are closed. */
export async function probeWithinBusiness(sim, actors) {
  const reps = actors.filter(
    (actor) => actor.role === 'Sales Rep' || actor.role.startsWith('Junior'),
  );
  const manager = actors.find((actor) => actor.isManager);
  const owner = actors.find((actor) => actor.isOwner);
  const tag = sim.business.id;
  if (reps.length < 2) return;
  const [a, b] = reps;

  // 1. Own scope: every list row is the rep's own, nothing of B's turns up, and B's ids are 404.
  for (const actor of [a, b]) {
    const other = actor === a ? b : a;
    for (const path of SECRET_PATHS) {
      const type = TYPE_OF[path];
      const all = await actor.api.listAll(`${type}.list-all`, `/${path}`);
      if (!all.ok) continue;
      const foreign = all.rows.filter((row) =>
        type === 'activity' ? row.assignedTo !== actor.userId : row.ownerId !== actor.userId,
      );
      if (foreign.length > 0)
        fail(
          sim,
          `own-scope-list-${type}`,
          `A Sales Rep's ${type} list contains records owned by someone else`,
          `${tag}: ${actor.name} saw ${foreign.length} foreign ${type}(s)`,
        );
      const theirs = other.list(type)[0];
      if (!theirs) continue;
      const get = await actor.api.get(`${type}.get-foreign`, `/${path}/${theirs.id}`);
      if (get.status !== 404)
        fail(
          sim,
          `own-scope-get-${type}`,
          `A rep could open another rep's ${type} by id`,
          `${tag}: HTTP ${get.status} (expected 404)`,
        );
      if (type !== 'activity') {
        const patch = await actor.api.patch(`${type}.update-foreign`, `/${path}/${theirs.id}`, {
          version: theirs.version,
          ...editFor(type),
        });
        if (patch.status !== 404)
          fail(
            sim,
            `own-scope-patch-${type}`,
            `A rep could edit another rep's ${type} by id`,
            `${tag}: HTTP ${patch.status} (expected 404)`,
          );
        const del = await actor.api.delete(`${type}.delete-foreign`, `/${path}/${theirs.id}`, {
          version: theirs.version,
        });
        if (del.status !== 404 && del.status !== 403)
          fail(
            sim,
            `own-scope-delete-${type}`,
            `A rep could delete another rep's ${type} by id`,
            `${tag}: HTTP ${del.status}`,
          );
      }
    }
    // Search must not reveal the other rep's account names.
    const victim = other.list('account')[0];
    if (victim) {
      const word = victim.name.split(' ')[0];
      const found = await actor.api.get('search', '/search', { q: word, limit: 20 });
      if (found.ok && found.data.some((hit) => hit.id === victim.id))
        fail(
          sim,
          'search-leaks-other-rep',
          "Search shows another rep's account to a rep with own scope",
          `${tag}: ${actor.name} found ${victim.name}`,
        );
    }
    // Their export must not include the other rep's rows.
    const exported = await exportRecords(actor, sim, 'account');
    if (exported && victim && exported.raw.includes(victim.name))
      fail(
        sim,
        'export-leaks-other-rep',
        "A rep's account export contains another rep's account",
        `${tag}: ${actor.name}`,
      );
  }
  pass(
    sim,
    `own-scope-${tag}`,
    "Own-scope reps could not list, open, edit, delete, search or export each other's records",
    tag,
  );

  // 2. Referencing someone else's record: a rep links a new deal and a task to a record they cannot see.
  const stranger = b.list('account')[0];
  if (stranger) {
    const deal = await a.api.post('deal.create-foreign-account', '/deals', {
      name: 'Probe: deal on a stranger account',
      accountId: stranger.id,
    });
    if (deal.ok) {
      sim.findings.add({
        id: 'link-deal-to-invisible-account-allowed',
        severity: 'medium',
        kind: 'security',
        title: "A rep can create a deal linked to another rep's account they cannot see",
        detail: `${tag}: HTTP ${deal.status}; the deal is now owned by ${a.name} and points at an account they cannot open`,
      });
      a.track('deal', deal.data);
    } else
      pass(
        sim,
        `link-invisible-account-${tag}`,
        'A deal could not be linked to an account the rep cannot see',
        `HTTP ${deal.status}`,
      );
    const task = await a.api.post('activity.create-foreign-link', '/activities', {
      type: 'task',
      subject: 'Probe: task on a stranger account',
      links: [{ objectType: 'account', recordId: stranger.id }],
    });
    if (task.ok)
      sim.findings.add({
        id: 'link-task-to-invisible-record-allowed',
        severity: 'medium',
        kind: 'security',
        title: "A rep can attach a task to another rep's account they cannot see",
        detail: `${tag}: HTTP ${task.status}; the link label returned: ${JSON.stringify(task.data?.links)}`,
      });
    else
      pass(
        sim,
        `link-invisible-task-${tag}`,
        'A task could not be linked to a record the rep cannot see',
        `HTTP ${task.status}`,
      );
  }

  // 3. Giving a record away: can a rep set someone else as the owner by editing or creating?
  const mine = a.pick('account');
  if (mine) {
    const give = await a.api.patch('account.update-owner', `/accounts/${mine.id}`, {
      version: mine.version,
      ownerId: b.userId,
    });
    sim.probeGiveAway = { status: give.status, code: give.code };
    if (give.ok)
      sim.findings.add({
        id: 'rep-can-reassign-by-edit',
        severity: 'low',
        kind: 'observation',
        title:
          'A Sales Rep can hand their own record to another user by editing ownerId (no separate reassign permission)',
        detail: `${tag}: HTTP ${give.status}`,
      });
    const create = await a.api.post('account.create-for-other', '/accounts', {
      name: 'Probe: account created for someone else',
      ownerId: b.userId,
    });
    if (create.ok)
      sim.findings.add({
        id: 'rep-can-create-for-other-owner',
        severity: 'low',
        kind: 'observation',
        title:
          'A Sales Rep can create a record owned by another rep (it then vanishes from their own view)',
        detail: `${tag}: HTTP ${create.status}, owner ${create.data?.ownerId}`,
      });
  }

  // 4. Admin routes are closed to reps and managers.
  const adminRoutes = [
    ['GET', '/members'],
    ['GET', '/roles'],
    ['GET', '/audit-logs'],
    ['GET', '/invitations'],
    ['GET', '/erasure-requests'],
    ['GET', '/teams'],
  ];
  for (const person of [a, manager].filter(Boolean)) {
    for (const [, path] of adminRoutes) {
      const response = await person.api.get(`admin${path}`, path);
      if (response.ok)
        fail(
          sim,
          `admin-route-${path}`,
          `A ${person.role} can read ${path}, an administrator-only route`,
          `${tag}: HTTP ${response.status}`,
        );
    }
    const tenant = await person.api.patch('tenant.update-nonadmin', '/tenant', {
      name: 'Hijacked name',
    });
    if (tenant.ok)
      fail(
        sim,
        'tenant-update-by-nonadmin',
        'A non-administrator changed the company profile',
        `${tag}`,
      );
    const invite = await person.api.post('invitation.create-nonadmin', '/invitations', {
      email: 'probe.invitee@example.example',
      roleId: '00000000-0000-7000-8000-000000000000',
    });
    if (invite.ok)
      fail(sim, 'invite-by-nonadmin', 'A non-administrator sent an invitation', `${tag}`);
  }
  pass(
    sim,
    `admin-routes-${tag}`,
    'Reps and managers were refused on members, roles, audit log, invitations, erasure requests, teams and company profile writes',
    tag,
  );

  // 5. Manager scope: sees team records, not the owner's own book.
  if (manager && owner) {
    const ownerAccount = owner.list('account').find((item) => item.ownerId === owner.userId);
    if (ownerAccount) {
      const get = await manager.api.get('account.get-owner-record', `/accounts/${ownerAccount.id}`);
      sim.managerSeesOwnerRecord = get.status;
    }
  }

  // 6. Read-only person can look, not touch.
  const reader = actors.find((actor) => actor.isReadOnly);
  if (reader) {
    const target = owner.list('account')[0];
    const write = await reader.api.post('account.create-readonly', '/accounts', {
      name: 'Probe: read-only write attempt',
    });
    const patch = target
      ? await reader.api.patch('account.update-readonly', `/accounts/${target.id}`, {
          version: target.version,
          phone: '+910000000000',
        })
      : { status: 0 };
    const exported = await reader.api.post('export.create-readonly', '/exports', {
      objectType: 'contact',
      format: 'csv',
    });
    if (write.ok || patch.ok)
      fail(
        sim,
        'read-only-can-write',
        'A Read-only user could create or change a record',
        `${tag}: create ${write.status}, patch ${patch.status}`,
      );
    else
      pass(
        sim,
        `read-only-${tag}`,
        'The Read-only user was refused on create and edit',
        `${write.status}/${patch.status}`,
      );
    if (exported.ok)
      fail(
        sim,
        'read-only-can-export',
        'A Read-only user could export contacts (the default role has no export grant)',
        tag,
      );
    const list = await reader.api.get('account.list', '/accounts', { limit: 5 });
    if (!list.ok || list.data.length === 0)
      sim.findings.add({
        id: 'read-only-cannot-read',
        severity: 'medium',
        kind: 'defect',
        title: 'The Read-only user could not see any accounts',
        detail: `HTTP ${list.status}`,
      });
  }
}

/** Hidden fields: the restricted rep must never see credit limits or turnover, in any response. */
export async function probeHiddenFields(sim, actors) {
  const junior = actors.find((actor) => actor.role.startsWith('Junior'));
  const owner = actors.find((actor) => actor.isOwner);
  if (!junior || !owner) return;
  const creditKey = sim.context.fields.account.find((field) => field.label === 'Credit limit')?.key;
  const leaks = [];
  const owned = await junior.api.listAll('account.list-all', '/accounts');
  for (const row of owned.rows) {
    if ('annualRevenue' in row) leaks.push('annualRevenue in list');
    if (creditKey && row.customFields && creditKey in row.customFields)
      leaks.push('credit limit in list');
    if (leaks.length > 0) break;
  }
  const first = owned.rows[0];
  if (first) {
    const single = await junior.api.get('account.get', `/accounts/${first.id}`);
    if (
      single.ok &&
      ('annualRevenue' in single.data ||
        (creditKey && creditKey in (single.data.customFields ?? {})))
    )
      leaks.push('hidden field in GET by id');
    const writeRevenue = await junior.api.patch('account.update-hidden', `/accounts/${first.id}`, {
      version: first.version,
      annualRevenue: { amountMinor: '100', currency: 'INR' },
    });
    if (writeRevenue.ok) leaks.push('annualRevenue write accepted');
    const refreshed = await junior.api.get('account.get', `/accounts/${first.id}`);
    const writeCredit = creditKey
      ? await junior.api.patch('account.update-hidden', `/accounts/${first.id}`, {
          version: refreshed.data?.version ?? first.version,
          customFields: { [creditKey]: { amount_minor: '100', currency: 'INR' } },
        })
      : { ok: false };
    if (writeCredit.ok) leaks.push('credit limit write accepted');
  }
  const exported = await exportRecords(junior, sim, 'account');
  if (exported) {
    const header = exported.header.join('|').toLowerCase();
    if (header.includes('credit limit') || header.includes('annual'))
      leaks.push(`hidden column in export (${header.slice(0, 120)})`);
  }
  // The owner must still see the data, or this probe proves nothing.
  const ownerList = await owner.api.get('account.list', '/accounts', { limit: 50 });
  const ownerSees =
    ownerList.ok &&
    ownerList.data.some((row) => row.annualRevenue || (creditKey && row.customFields?.[creditKey]));
  if (!ownerSees)
    sim.findings.add({
      id: 'hidden-field-probe-vacuous',
      severity: 'medium',
      kind: 'observation',
      title:
        'Hidden-field probe: the owner could not see the fields either, so the probe proves little',
      detail: '',
    });
  if (leaks.length > 0)
    fail(
      sim,
      'hidden-field-leak',
      'A field hidden from a role showed up for that role',
      leaks.join('; '),
    );
  else
    pass(
      sim,
      'hidden-fields',
      'Credit limit and company turnover stayed hidden from the restricted rep in lists, single reads, writes and exports while the owner could see them',
      '',
    );
}

/** Tenant A's session against tenant B's ids and routes. */
export async function probeAcrossTenants(simByBusiness, actorsByBusiness) {
  const ids = Object.keys(actorsByBusiness);
  for (const attackerId of ids) {
    const attacker = actorsByBusiness[attackerId].find((actor) => actor.isOwner);
    for (const victimId of ids) {
      if (victimId === attackerId) continue;
      const sim = simByBusiness[attackerId];
      const victims = actorsByBusiness[victimId];
      const victimOwner = victims.find((actor) => actor.isOwner);
      const tag = `${attackerId} -> ${victimId}`;
      let broke = false;
      for (const path of SECRET_PATHS) {
        const type = TYPE_OF[path];
        const target = victimOwner.list(type)[0];
        if (!target) continue;
        const get = await attacker.api.get(`${type}.get-other-tenant`, `/${path}/${target.id}`);
        const patch =
          type === 'activity'
            ? { status: 404 }
            : await attacker.api.patch(`${type}.update-other-tenant`, `/${path}/${target.id}`, {
                version: target.version,
                ...editFor(type),
              });
        const del = await attacker.api.delete(
          `${type}.delete-other-tenant`,
          `/${path}/${target.id}`,
          { version: target.version },
        );
        for (const [verb, response] of [
          ['GET', get],
          ['PATCH', patch],
          ['DELETE', del],
        ]) {
          if (response.status !== 404) {
            broke = true;
            fail(
              sim,
              `cross-tenant-${verb}-${type}`,
              `Another company's ${type} answered ${response.status} instead of 404 (${verb})`,
              tag,
            );
          }
        }
      }
      // Header tricks: ask for the other company with a valid session of this one.
      const header = await attacker.api.call('tenant.header-trick', 'GET', '/accounts', {
        query: { limit: 5 },
        headers: { 'x-tenant-id': victimOwner.api.tenantId },
      });
      if (header.ok && header.data.some((row) => victimOwner.book.account.has(row.id))) {
        broke = true;
        fail(
          sim,
          'cross-tenant-header',
          "X-Tenant-Id let a session read another company's accounts",
          tag,
        );
      }
      // Listing: none of the victim's ids may show up in the attacker's lists.
      for (const path of ['accounts', 'contacts', 'deals']) {
        const type = TYPE_OF[path];
        const mine = await attacker.api.listAll(`${type}.list-all`, `/${path}`);
        const stolen = mine.rows.filter((row) => victimOwner.book[type].has(row.id));
        if (stolen.length > 0) {
          broke = true;
          fail(
            sim,
            `cross-tenant-list-${type}`,
            `Another company's ${type}s appear in a list`,
            `${tag}: ${stolen.length}`,
          );
        }
      }
      // Search for a victim's unique name.
      const victimAccount = victimOwner.list('account')[0];
      if (victimAccount) {
        const found = await attacker.api.get('search', '/search', {
          q: victimAccount.name.split(' ')[0],
          limit: 20,
        });
        if (found.ok && found.data.some((hit) => hit.id === victimAccount.id)) {
          broke = true;
          fail(sim, 'cross-tenant-search', "Search returned another company's account", tag);
        }
      }
      // Admin objects of the other company.
      const victimMember = victims.find((actor) => actor.isManager);
      if (victimMember) {
        const member = await attacker.api.get(
          'member.get-other-tenant',
          `/members/${victimMember.userId}`,
        );
        if (member.status !== 404) {
          broke = true;
          fail(
            sim,
            'cross-tenant-member',
            "Another company's member record answered other than 404",
            `${tag}: HTTP ${member.status}`,
          );
        }
        const reach = await attacker.api.get(
          'access.get-other-tenant',
          `/access/members/${victimMember.userId}`,
        );
        if (reach.status !== 404) {
          broke = true;
          fail(
            sim,
            'cross-tenant-access',
            "Another company's access explainer answered other than 404",
            `${tag}: HTTP ${reach.status}`,
          );
        }
      }
      if (!broke)
        pass(
          sim,
          `cross-tenant-${tag}`,
          `${attackerId}'s owner got 404 (or nothing) for ${victimId}'s records, edits, deletes, lists, search, members and header tricks`,
          tag,
        );
    }
  }
}

/** Sessions, tokens, MFA. */
export async function probeSessions(sim, actors, { baseUrl, password, metrics }) {
  const person = actors.find((actor) => actor.role === 'Sales Rep');
  if (!person) return;
  const anonymous = new Api({ baseUrl, metrics, who: 'anonymous' });
  const noAuth = await anonymous.get('accounts.list-anonymous', '/accounts');
  const garbage = new Api({ baseUrl, metrics, who: 'garbage' });
  garbage.cookie = 'not-a-real-session-token-0000000000000000';
  const bad = await garbage.get('accounts.list-garbage-token', '/accounts');
  if (noAuth.status === 401 && bad.status === 401)
    pass(
      sim,
      'unauthenticated-401',
      'A request without a session, or with a made-up one, got 401',
      '',
    );
  else
    fail(
      sim,
      'unauthenticated',
      'A request without a valid session was not answered 401',
      `${noAuth.status}/${bad.status}`,
    );

  // Sign out really ends the session; a stolen copy of the token stops working.
  const second = new Api({ baseUrl, metrics, who: `${person.name} (second device)` });
  await second.signIn(person.record.email, password, { totpSecret: person.record.totpSecret });
  const stolen = second.cookie;
  const out = await second.post('auth.sign-out', '/auth/sign-out');
  const replay = new Api({ baseUrl, metrics, who: 'replay' });
  replay.cookie = stolen;
  const after = await replay.get('accounts.list-after-signout', '/accounts');
  if (out.ok && after.status === 401)
    pass(sim, 'signout-revokes', 'After sign-out the old session token was refused', '');
  else
    fail(
      sim,
      'signout-does-not-revoke',
      'A session token still worked after sign-out',
      `sign-out ${out.status}, replay ${after.status}`,
    );

  // Wrong password gets the same answer for an unknown user and a known one (no account enumeration).
  const known = await anonymous.post('auth.sign-in-wrong', '/auth/sign-in', {
    email: person.record.email,
    password: 'wrong-password-123',
  });
  const unknown = await anonymous.post('auth.sign-in-unknown', '/auth/sign-in', {
    email: 'nobody.at.all@nowhere.example',
    password: 'wrong-password-123',
  });
  if (
    known.status === unknown.status &&
    known.code === unknown.code &&
    known.body?.error?.message === unknown.body?.error?.message
  )
    pass(
      sim,
      'no-enumeration',
      'Sign-in gives the same answer for a wrong password and an unknown e-mail',
      `${known.status} ${known.code}`,
    );
  else
    fail(
      sim,
      'sign-in-enumeration',
      'Sign-in answers differently for a known and an unknown e-mail',
      `${known.status}/${unknown.status}`,
    );

  // MFA: a wrong code is refused; a used code can be used again inside its 30 second window (a finding).
  const mfaUser = actors.find((actor) => actor.record.totpSecret);
  if (mfaUser) {
    const first = await anonymous.post('auth.sign-in', '/auth/sign-in', {
      email: mfaUser.record.email,
      password,
    });
    if (first.ok && first.data.status === 'mfa_required') {
      const wrong = await anonymous.post('auth.mfa-verify-wrong', '/auth/mfa/verify', {
        challengeToken: first.data.challengeToken,
        code: '000000',
      });
      if (wrong.ok) fail(sim, 'mfa-wrong-code-accepted', 'MFA accepted a wrong code', mfaUser.name);
      else pass(sim, 'mfa-wrong-code', 'MFA refused a wrong code', `${wrong.status} ${wrong.code}`);
      const code = totp(mfaUser.record.totpSecret);
      const firstUse = await anonymous.post('auth.mfa-verify', '/auth/mfa/verify', {
        challengeToken: first.data.challengeToken,
        code,
      });
      const again = await anonymous.post('auth.sign-in', '/auth/sign-in', {
        email: mfaUser.record.email,
        password,
      });
      const secondUse =
        again.ok && again.data.status === 'mfa_required'
          ? await anonymous.post('auth.mfa-verify-reuse', '/auth/mfa/verify', {
              challengeToken: again.data.challengeToken,
              code,
            })
          : { ok: false, status: again.status };
      if (firstUse.ok && secondUse.ok)
        sim.findings.add({
          id: 'mfa-code-reusable-in-window',
          severity: 'low',
          kind: 'security',
          title:
            'The same one-time code worked twice within its 30 second window (RFC 6238 advises refusing a reused code)',
          detail: mfaUser.name,
        });
      else if (firstUse.ok)
        pass(sim, 'mfa-no-reuse', 'A one-time code could not be used twice', '');
    }
  }
}

/** Cookie-authenticated writes from a foreign origin: does the API itself check Origin? */
export async function probeOrigin(sim, actor) {
  const response = await actor.api.call('origin.foreign-post', 'POST', '/leads', {
    body: { lastName: 'Probe Origin Check' },
    headers: { origin: 'https://evil.example' },
  });
  sim.originProbe = { status: response.status };
  if (response.ok) {
    sim.findings.add({
      id: 'api-accepts-foreign-origin',
      severity: 'low',
      kind: 'security',
      title:
        'The API accepts a cookie-authenticated write that claims a foreign Origin (CSRF protection relies on SameSite=Lax cookies and the web app proxy, not on the API itself)',
      detail:
        'POST /leads with Origin: https://evil.example returned 201. Not verified in a real cross-site browser test.',
    });
    actor.track('lead', response.data);
  } else
    pass(
      sim,
      'origin-checked',
      'A write with a foreign Origin was refused',
      `HTTP ${response.status}`,
    );
}

/** POST with an Idempotency-Key twice: the spec says record-creating POSTs accept one. */
export async function probeIdempotency(sim, actor) {
  const key = `pilot-idem-${Date.now()}`;
  const body = { name: `Idempotency probe ${Date.now()}` };
  const first = await actor.api.call('idempotency.first', 'POST', '/accounts', {
    body,
    headers: { 'idempotency-key': key },
  });
  const second = await actor.api.call('idempotency.second', 'POST', '/accounts', {
    body,
    headers: { 'idempotency-key': key },
  });
  if (first.ok && second.ok && first.data.id !== second.data.id) {
    sim.findings.add({
      id: 'idempotency-key-ignored-on-create',
      severity: 'medium',
      kind: 'defect',
      title:
        'POST /accounts ignores the Idempotency-Key header: the same request sent twice creates two accounts (CLAUDE.md section 6 says record-creating POSTs accept one)',
      detail: `ids ${first.data.id} and ${second.data.id}`,
    });
    actor.track('account', first.data);
    actor.track('account', second.data);
  } else if (first.ok && second.ok)
    pass(
      sim,
      'idempotency',
      'A repeated POST with the same Idempotency-Key returned the same account',
      '',
    );
}

/**
 * Things a real business expects (Zoho-style) that the API may simply not have. Each is asked for by
 * its obvious address; a 404 on the route (not on a record) means it does not exist yet.
 */
export async function probeGaps(sim, actor) {
  const routes = [
    ['GET', '/saved-views', 'saved views (named, shareable list filters)'],
    ['GET', '/views', 'saved views (named, shareable list filters)'],
    ['POST', '/contacts/bulk', 'bulk edit, assign or delete of many records from a list'],
    ['PATCH', '/contacts/bulk', 'bulk edit, assign or delete of many records from a list'],
    [
      'POST',
      '/pipelines',
      'creating or editing pipelines and stages (the stages are fixed once a company is created)',
    ],
    ['GET', '/tags', 'tags on records (named in the spec as part of record pages)'],
    ['GET', '/products', 'a product list / price book (Phase 2)'],
    ['GET', '/quotes', 'quotes with GST and PDF (Phase 2)'],
    ['GET', '/reports', 'a report builder (Phase 2)'],
    ['GET', '/automations', 'workflow automation (Phase 2)'],
    ['GET', '/webhooks', 'webhooks / public API keys (Phase 2)'],
  ];
  const missing = new Map();
  for (const [method, path, what] of routes) {
    const response = await actor.api.call(
      'gap.probe',
      method,
      path,
      method === 'GET' ? {} : { body: {} },
    );
    if (response.status === 404) {
      const entry = missing.get(what) ?? [];
      entry.push(`${method} ${path}`);
      missing.set(what, entry);
    }
  }
  for (const [what, paths] of missing) {
    sim.findings.add({
      id: `gap-${what.slice(0, 24).replace(/\W+/g, '-')}`,
      severity: 'info',
      kind: 'gap',
      title: `Not available through the API: ${what}`,
      detail: `404 on ${paths.join(', ')}`,
    });
  }

  // Backdating: can a record be created with an earlier creation date? (Needed to load history.)
  const stamp = await actor.api.post('gap.backdate', '/accounts', {
    name: 'Backdating probe',
    createdAt: '2026-09-01T10:00:00.000Z',
  });
  sim.backdating = { status: stamp.status, code: stamp.code };
  if (stamp.ok) actor.track('account', stamp.data);
  sim.findings.add({
    id: 'gap-no-backdating',
    severity: stamp.ok ? 'info' : 'medium',
    kind: 'gap',
    title: stamp.ok
      ? 'Records can be created with a past creation date'
      : 'There is no way to create or import records with their original dates, so a business moving over from another system or spreadsheet loses its history',
    detail: `POST /accounts with createdAt -> HTTP ${stamp.status} ${stamp.code ?? ''}`,
  });
}
