import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { hashOneTimeToken } from '@crm/core';
import {
  dataOf,
  request,
  startApiHarness,
  tokenFromEmail,
  type ApiHarness,
} from '../../testing/harness.js';

/**
 * The four mandatory per-module security suites (CLAUDE.md §10), plus the
 * invitation-specific rules from ADR-0019:
 *   (a) tenant A cannot list, read or act on tenant B's invitations
 *   (b) a user without the `invitation` grant cannot invite or revoke
 *   (c) the token never leaves the API, and no request may name its workspace
 *       or its role
 *   (d) unauthenticated requests get 401
 *
 * Through the real HTTP stack — the same guards, pipes, filter and database
 * roles as production — because every one of those layers is part of what is
 * being asserted.
 */
let harness: ApiHarness;

/** Tenant A: an owner who may invite, and a rep who may not. */
let tenantA: string;
let ownerA: { token: string; userId: string };
let repA: { token: string; userId: string };
let repRoleA: string;
let ownerRoleA: string;

/** Tenant B: a separate company that must never be visible from tenant A. */
let tenantB: string;
let ownerB: { token: string; userId: string };
let repRoleB: string;

let invitationA: { id: string; email: string; token: string };

const PASSWORD = 'correct-horse-battery-staple';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/**
 * The error envelope minus its request id.
 *
 * Two 404s must be indistinguishable, and the request id is the one part that
 * is meant to differ between any two responses (CLAUDE.md §8).
 */
function errorShape(body: Record<string, unknown>): unknown {
  const error = { ...(body['error'] as Record<string, unknown>) };
  delete error['requestId'];
  return error;
}

async function invite(
  token: string,
  roleId: string,
  email = uniqueEmail('target'),
): Promise<{ status: number; body: Record<string, unknown>; email: string }> {
  const response = await request(harness, {
    method: 'POST',
    url: '/api/v1/invitations',
    token,
    body: { email, roleId },
  });
  return { ...response, email };
}

function tokenFor(email: string): string {
  const message = harness.emails.lastTo(email);
  expect(message, `no invitation email to ${email}`).toBeDefined();
  return tokenFromEmail(message!.text);
}

/** Sign up, verify and sign in. Returns the address and a session token. */
async function existingAccount(prefix: string): Promise<{ email: string; token: string }> {
  const email = uniqueEmail(prefix);
  await request(harness, {
    method: 'POST',
    url: '/api/v1/auth/sign-up',
    body: { email, password: PASSWORD, name: 'Somebody Else' },
  });
  await request(harness, {
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    body: { token: tokenFromEmail(harness.emails.lastTo(email)!.text) },
  });
  const signedIn = await request(harness, {
    method: 'POST',
    url: '/api/v1/auth/sign-in',
    body: { email, password: PASSWORD },
  });
  return { email, token: dataOf<{ token: string }>(signedIn).token };
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));

  const seededA = await harness.fixtures.createTenant({ name: 'Acme Jewellers' });
  tenantA = seededA.tenantId;
  const rolesA = await harness.provision(tenantA);
  ownerRoleA = rolesA.get('Owner')!;
  repRoleA = rolesA.get('Sales Rep')!;

  const seededB = await harness.fixtures.createTenant({ name: 'Rival Traders' });
  tenantB = seededB.tenantId;
  const rolesB = await harness.provision(tenantB);
  repRoleB = rolesB.get('Sales Rep')!;

  const owner = await harness.fixtures.createUser(tenantA, ownerRoleA);
  ownerA = { userId: owner.userId, token: await harness.signIn(owner.userId, tenantA) };

  const rep = await harness.fixtures.createUser(tenantA, repRoleA);
  repA = { userId: rep.userId, token: await harness.signIn(rep.userId, tenantA) };

  const bOwner = await harness.fixtures.createUser(tenantB, rolesB.get('Owner')!);
  ownerB = { userId: bOwner.userId, token: await harness.signIn(bOwner.userId, tenantB) };

  const created = await invite(ownerA.token, repRoleA, uniqueEmail('pending-a'));
  invitationA = {
    id: dataOf<{ id: string }>(created).id,
    email: created.email,
    token: tokenFor(created.email),
  };
}, 180_000);

afterAll(async () => {
  await harness.close();
});

describe('(d) unauthenticated requests get 401', () => {
  it('rejects listing, inviting and revoking with no credentials', async () => {
    const calls = [
      { method: 'GET', url: '/api/v1/invitations' },
      {
        method: 'POST',
        url: '/api/v1/invitations',
        body: { email: 'intruder@example.com', roleId: repRoleA },
      },
      { method: 'DELETE', url: `/api/v1/invitations/${invitationA.id}` },
    ] as const;

    for (const call of calls) {
      const response = await request(harness, { ...call });
      expect(response.status, `${call.method} ${call.url}`).toBe(401);
    }
  });

  it('rejects a made-up bearer token', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/invitations',
      token: 'not-a-real-session-token-but-long-enough',
    });
    expect(response.status).toBe(401);
  });

  it('returns the error envelope with a request id, and no stack trace', async () => {
    const response = await request(harness, { method: 'GET', url: '/api/v1/invitations' });
    const error = response.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('UNAUTHENTICATED');
    expect(typeof error['requestId']).toBe('string');
    expect(JSON.stringify(response.body)).not.toMatch(/at .*\.ts:/);
  });

  it('still lets an invited stranger read their own link, which has no session', async () => {
    // The acceptance routes are deliberately public: the token is the
    // credential, and the recipient has no account yet (ADR-0019).
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/invitations/accept?token=${encodeURIComponent(invitationA.token)}`,
    });
    expect(response.status).toBe(200);
  });
});

describe('(a) tenant A cannot reach tenant B invitations', () => {
  it('does not list them', async () => {
    const created = await invite(ownerB.token, repRoleB, uniqueEmail('pending-b'));
    expect(created.status).toBe(201);

    const list = await request(harness, {
      method: 'GET',
      url: '/api/v1/invitations?limit=100',
      token: ownerA.token,
    });
    const emails = dataOf<{ email: string }[]>(list).map((row) => row.email);
    expect(emails).toContain(invitationA.email);
    expect(emails).not.toContain(created.email);
  });

  it('cannot revoke one, and the 404 is identical to one for an id that never existed', async () => {
    const created = await invite(ownerB.token, repRoleB, uniqueEmail('revoke-b'));
    const foreignId = dataOf<{ id: string }>(created).id;

    const foreign = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/invitations/${foreignId}`,
      token: ownerA.token,
    });
    const imaginary = await request(harness, {
      method: 'DELETE',
      url: '/api/v1/invitations/0198c0de-0000-7000-8000-000000000000',
      token: ownerA.token,
    });

    expect(foreign.status).toBe(404);
    expect(errorShape(foreign.body)).toEqual(errorShape(imaginary.body));

    // And it really is still pending in tenant B, not quietly revoked.
    const row = await harness.fixtures.invitationRow(foreignId);
    expect(row?.revoked_at).toBeNull();
  });

  it('cannot use a tenant A session to spend a tenant B link', async () => {
    const created = await invite(ownerB.token, repRoleB, uniqueEmail('steal-b'));
    const stolen = tokenFor(created.email);

    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/invitations/accept',
      token: ownerA.token,
      body: { token: stolen },
    });
    expect(response.status).toBe(403);
    expect((response.body['error'] as { code: string }).code).toBe('INVITATION_RECIPIENT_MISMATCH');

    const row = await harness.fixtures.invitationRow(dataOf<{ id: string }>(created).id);
    expect(row?.accepted_at).toBeNull();
  });

  it('cannot invite into another workspace by naming its role', async () => {
    // The role id is real, and it is tenant B's. RLS confines the lookup to
    // the caller's own workspace, so it simply does not exist for them.
    const response = await invite(ownerA.token, repRoleB);
    expect(response.status).toBe(422);
    expect((response.body['error'] as { code: string }).code).toBe('VALIDATION_FAILED');
  });
});

describe('(b) a user without the invitation grant cannot invite or revoke', () => {
  it('refuses the list, the invite and the revocation with 403', async () => {
    const list = await request(harness, {
      method: 'GET',
      url: '/api/v1/invitations',
      token: repA.token,
    });
    expect(list.status).toBe(403);

    const created = await invite(repA.token, repRoleA);
    expect(created.status).toBe(403);

    const revoked = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/invitations/${invitationA.id}`,
      token: repA.token,
    });
    expect(revoked.status).toBe(403);

    // Nothing happened: the invitation they tried to revoke is still pending.
    const row = await harness.fixtures.invitationRow(invitationA.id);
    expect(row?.revoked_at).toBeNull();
  });

  it('does not grant it to a Manager either, in a freshly provisioned workspace', async () => {
    // Proved behaviourally rather than by reading grant rows, so that a
    // seeding change that quietly widened the default roles fails here.
    const seeded = await harness.fixtures.createTenant({ name: 'Managed Co' });
    const roles = await harness.provision(seeded.tenantId);
    const manager = await harness.fixtures.createUser(seeded.tenantId, roles.get('Manager')!);
    const token = await harness.signIn(manager.userId, seeded.tenantId);

    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/invitations',
      token,
      body: { email: uniqueEmail('managed'), roleId: roles.get('Sales Rep')! },
    });
    expect(response.status).toBe(403);
  });
});

describe('(c) the token never leaves the API, and no body may name a workspace or role', () => {
  it('keeps the secret and its digest out of every response', async () => {
    const created = await invite(ownerA.token, repRoleA, uniqueEmail('leak'));
    const token = tokenFor(created.email);
    const secret = token.slice(token.indexOf('.') + 1);
    const digest = hashOneTimeToken(token);

    const surfaces = [
      created.body,
      (
        await request(harness, {
          method: 'GET',
          url: '/api/v1/invitations?limit=100',
          token: ownerA.token,
        })
      ).body,
      (
        await request(harness, {
          method: 'GET',
          url: `/api/v1/invitations/accept?token=${encodeURIComponent(token)}`,
        })
      ).body,
    ];

    for (const surface of surfaces) {
      const serialized = JSON.stringify(surface);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(digest);
    }
  });

  it('rejects an accept body that names a workspace, a role or a status', async () => {
    for (const extra of [{ tenantId: tenantB }, { roleId: repRoleA }, { status: 'active' }]) {
      const response = await request(harness, {
        method: 'POST',
        url: '/api/v1/invitations/accept',
        body: { token: invitationA.token, ...extra },
      });
      expect(response.status, JSON.stringify(extra)).toBe(422);
    }
  });

  it('cannot be pointed at another workspace by editing the token prefix', async () => {
    // The prefix is a routing hint, never an authorization (ADR-0019): swapped
    // for tenant B's id, the digest matches nothing inside tenant B.
    const secret = invitationA.token.slice(invitationA.token.indexOf('.') + 1);

    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/invitations/accept?token=${encodeURIComponent(`${tenantB}.${secret}`)}`,
    });
    expect(response.status).toBe(400);

    // The real link still works afterwards: a failed attempt consumes nothing.
    const genuine = await request(harness, {
      method: 'GET',
      url: `/api/v1/invitations/accept?token=${encodeURIComponent(invitationA.token)}`,
    });
    expect(genuine.status).toBe(200);
  });

  it('refuses a token whose prefix is not a workspace id at all', async () => {
    for (const bad of [
      'not-a-uuid.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      `${tenantA}.short`,
    ]) {
      const response = await request(harness, {
        method: 'POST',
        url: '/api/v1/invitations/accept',
        body: { token: bad, name: 'Prober', password: PASSWORD },
      });
      // Either the contract refuses it or the service does; what matters is
      // that nothing reaches `SET LOCAL app.tenant_id`.
      expect([400, 422]).toContain(response.status);
    }
  });
});

describe('acceptance identity (ADR-0019)', () => {
  it('refuses somebody signed in as a different address, and leaves the link usable', async () => {
    const recipient = await existingAccount('recipient');
    const bystander = await existingAccount('bystander');

    const created = await invite(ownerA.token, repRoleA, recipient.email);
    const token = tokenFor(recipient.email);

    const wrongPerson = await request(harness, {
      method: 'POST',
      url: '/api/v1/invitations/accept',
      token: bystander.token,
      body: { token },
    });
    expect(wrongPerson.status).toBe(403);
    expect((wrongPerson.body['error'] as { code: string }).code).toBe(
      'INVITATION_RECIPIENT_MISMATCH',
    );

    // The bystander joined nothing.
    const bystanderMe = await request(harness, {
      method: 'GET',
      url: '/api/v1/auth/me',
      token: bystander.token,
    });
    const memberships = dataOf<{ memberships: { tenantId: string }[] }>(bystanderMe).memberships;
    expect(memberships.map((row) => row.tenantId)).not.toContain(tenantA);

    // The real recipient can still use it.
    const accepted = await request(harness, {
      method: 'POST',
      url: '/api/v1/invitations/accept',
      token: recipient.token,
      body: { token },
    });
    expect(accepted.status).toBe(200);
    expect(created.status).toBe(201);
  });

  it('never issues a session from a link when the address already has an account', async () => {
    const account = await existingAccount('mfa-shaped');
    const created = await invite(ownerA.token, repRoleA, account.email);
    expect(created.status).toBe(201);

    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/invitations/accept',
      body: { token: tokenFor(account.email), name: 'Imposter', password: 'another-long-password' },
    });

    // 401 and no token: an emailed link must not walk past a second factor
    // the account's owner enrolled.
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain('token');
  });

  it('confers only the invited role, whatever the recipient asks for', async () => {
    const email = uniqueEmail('role-bound');
    await invite(ownerA.token, repRoleA, email);

    const accepted = await request(harness, {
      method: 'POST',
      url: '/api/v1/invitations/accept',
      body: { token: tokenFor(email), name: 'Bound Rep', password: PASSWORD },
    });
    expect(accepted.status).toBe(200);
    const session = dataOf<{ token: string }>(accepted).token;

    // Sales Rep: may create a contact, may not invite anybody.
    expect(
      (
        await request(harness, {
          method: 'POST',
          url: '/api/v1/contacts',
          token: session,
          body: { lastName: 'Rao' },
        })
      ).status,
    ).toBe(201);

    expect((await invite(session, ownerRoleA)).status).toBe(403);
  });

  it('refuses an expired link', async () => {
    const email = uniqueEmail('expired');
    const created = await invite(ownerA.token, repRoleA, email);
    await harness.fixtures.expireInvitation(dataOf<{ id: string }>(created).id);

    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/invitations/accept',
      body: { token: tokenFor(email), name: 'Too Slow', password: PASSWORD },
    });
    expect(response.status).toBe(400);
    expect((response.body['error'] as { code: string }).code).toBe('INVALID_TOKEN');
  });

  it('does not let an invitation re-role somebody who is already a member', async () => {
    const email = uniqueEmail('already-in');
    await invite(ownerA.token, repRoleA, email);
    const first = await request(harness, {
      method: 'POST',
      url: '/api/v1/invitations/accept',
      body: { token: tokenFor(email), name: 'Already In', password: PASSWORD },
    });
    const session = dataOf<{ token: string }>(first).token;

    // Invited again, this time as Owner. Accepting must not promote them.
    await invite(ownerA.token, ownerRoleA, email);
    const second = await request(harness, {
      method: 'POST',
      url: '/api/v1/invitations/accept',
      token: session,
      body: { token: tokenFor(email) },
    });
    expect(second.status).toBe(200);

    expect((await invite(session, repRoleA)).status).toBe(403);
  });

  it('is not a way around a suspension', async () => {
    const email = uniqueEmail('suspended');
    await invite(ownerA.token, repRoleA, email);
    const joined = await request(harness, {
      method: 'POST',
      url: '/api/v1/invitations/accept',
      body: { token: tokenFor(email), name: 'Suspended Soon', password: PASSWORD },
    });
    const session = dataOf<{ token: string }>(joined).token;

    const me = await request(harness, { method: 'GET', url: '/api/v1/auth/me', token: session });
    const userId = dataOf<{ id: string }>(me).id;
    await harness.fixtures.setMembershipStatus(tenantA, userId, 'suspended');

    await invite(ownerA.token, ownerRoleA, email);
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/invitations/accept',
      token: session,
      body: { token: tokenFor(email) },
    });
    expect(response.status).toBe(409);
  });
});
