import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  request,
  startApiHarness,
  tokenFromEmail,
  type ApiHarness,
} from '../../testing/harness.js';

/**
 * Team invitations end to end (MVP_SPEC M2).
 *
 * Against the real HTTP stack and a real Postgres with RLS, because what is
 * being checked — that a link is single-use, that a second invitation retires
 * the first, that accepting produces a membership that actually works — is
 * produced by the controller, the service, two database roles and the policies
 * between them.
 *
 * Tokens are read out of the captured email, the same way a recipient reads
 * them out of their inbox: the database only ever holds the hash, and a test
 * that reached into the table instead would keep passing if the mail were
 * never sent.
 */
let harness: ApiHarness;

let tenantId: string;
let ownerToken: string;
let repRoleId: string;

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

async function invite(email: string, roleId = repRoleId, token = ownerToken) {
  return request(harness, {
    method: 'POST',
    url: '/api/v1/invitations',
    token,
    body: { email, roleId },
  });
}

/** The link the recipient was mailed. */
function tokenFor(email: string): string {
  const message = harness.emails.lastTo(email);
  expect(message, `no invitation email to ${email}`).toBeDefined();
  return tokenFromEmail(message!.text);
}

async function accept(body: Record<string, unknown>, token?: string) {
  return request(harness, {
    method: 'POST',
    url: '/api/v1/invitations/accept',
    ...(token === undefined ? {} : { token }),
    body,
  });
}

/** Sign up, verify, and return the address plus a session token. */
async function existingAccount(prefix: string): Promise<{ email: string; token: string }> {
  const email = uniqueEmail(prefix);
  await request(harness, {
    method: 'POST',
    url: '/api/v1/auth/sign-up',
    body: { email, password: PASSWORD, name: 'Existing Person' },
  });
  const verification = harness.emails.lastTo(email);
  await request(harness, {
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    body: { token: tokenFromEmail(verification!.text) },
  });
  const signedIn = await request(harness, {
    method: 'POST',
    url: '/api/v1/auth/sign-in',
    body: { email, password: PASSWORD },
  });
  const data = signedIn.body['data'] as { token: string };
  return { email, token: data.token };
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));

  const seeded = await harness.fixtures.createTenant({ name: 'Acme Jewellers' });
  tenantId = seeded.tenantId;
  const roles = await harness.provision(tenantId);
  repRoleId = roles.get('Sales Rep')!;

  const owner = await harness.fixtures.createUser(tenantId, roles.get('Owner')!);
  ownerToken = await harness.signIn(owner.userId, tenantId);
}, 180_000);

afterAll(async () => {
  await harness.close();
});

describe('inviting', () => {
  it('creates a pending invitation and mails a link', async () => {
    const email = uniqueEmail('invitee');
    const response = await invite(email);

    expect(response.status).toBe(201);
    const data = response.body['data'] as Record<string, unknown>;
    expect(data['email']).toBe(email);
    expect(data['roleName']).toBe('Sales Rep');
    expect(data['invitedByName']).toBe('Test User');

    const message = harness.emails.lastTo(email);
    expect(message?.subject).toContain('Acme Jewellers');
    expect(message?.text).toContain('/accept-invite?token=');
  });

  it('never returns the token, in the response or in the list', async () => {
    const email = uniqueEmail('secret');
    const created = await invite(email);
    const token = tokenFor(email);

    // The exact token, and its secret half, must appear nowhere a second
    // administrator could read it back out.
    const secret = token.slice(token.indexOf('.') + 1);
    expect(JSON.stringify(created.body)).not.toContain(secret);

    const list = await request(harness, {
      method: 'GET',
      url: '/api/v1/invitations',
      token: ownerToken,
    });
    expect(JSON.stringify(list.body)).not.toContain(secret);
    // Nor the digest, which would be just as redeemable if the lookup is by it.
    expect(JSON.stringify(list.body)).not.toMatch(/token|hash/i);
  });

  it('lists pending invitations, newest first', async () => {
    const first = uniqueEmail('listed-a');
    const second = uniqueEmail('listed-b');
    await invite(first);
    await invite(second);

    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/invitations?limit=100',
      token: ownerToken,
    });
    expect(response.status).toBe(200);

    const emails = (response.body['data'] as { email: string }[]).map((row) => row.email);
    expect(emails).toContain(first);
    expect(emails).toContain(second);
    expect(emails.indexOf(second)).toBeLessThan(emails.indexOf(first));
  });

  it('refuses a role from another workspace, as an unknown role', async () => {
    const other = await harness.fixtures.createTenant({ name: 'Rival Traders' });
    const otherRoles = await harness.provision(other.tenantId);

    // Read into a checked local: `invite`'s parameter has a default, so an
    // undefined slipping through here would silently test the wrong role.
    const foreignRoleId = otherRoles.get('Owner');
    expect(foreignRoleId).toBeDefined();

    const response = await invite(uniqueEmail('cross-role'), foreignRoleId);

    expect(response.status).toBe(422);
    const error = response.body['error'] as { code: string; details: { path: string }[] };
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details[0]?.path).toBe('roleId');
  });

  it('rejects a body that tries to name its own workspace or status', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/invitations',
      token: ownerToken,
      body: { email: uniqueEmail('strict'), roleId: repRoleId, tenantId },
    });
    expect(response.status).toBe(422);
  });

  it('retires the previous invitation to the same address', async () => {
    const email = uniqueEmail('resent');
    await invite(email);
    const firstToken = tokenFor(email);

    await invite(email);
    const secondToken = tokenFor(email);
    expect(secondToken).not.toBe(firstToken);

    // The old link is dead the moment the new one exists (MVP_SPEC M2).
    const stale = await request(harness, {
      method: 'GET',
      url: `/api/v1/invitations/accept?token=${encodeURIComponent(firstToken)}`,
    });
    expect(stale.status).toBe(400);

    const fresh = await request(harness, {
      method: 'GET',
      url: `/api/v1/invitations/accept?token=${encodeURIComponent(secondToken)}`,
    });
    expect(fresh.status).toBe(200);

    // And only one row is left pending, not two.
    const list = await request(harness, {
      method: 'GET',
      url: '/api/v1/invitations?limit=100',
      token: ownerToken,
    });
    const matching = (list.body['data'] as { email: string }[]).filter(
      (row) => row.email === email,
    );
    expect(matching).toHaveLength(1);
  });
});

describe('revoking', () => {
  it('kills the link and removes it from the list', async () => {
    const email = uniqueEmail('revoked');
    const created = await invite(email);
    const id = (created.body['data'] as { id: string }).id;
    const token = tokenFor(email);

    const revoked = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/invitations/${id}`,
      token: ownerToken,
    });
    expect(revoked.status).toBe(204);

    const preview = await request(harness, {
      method: 'GET',
      url: `/api/v1/invitations/accept?token=${encodeURIComponent(token)}`,
    });
    expect(preview.status).toBe(400);

    const list = await request(harness, {
      method: 'GET',
      url: '/api/v1/invitations?limit=100',
      token: ownerToken,
    });
    const emails = (list.body['data'] as { email: string }[]).map((row) => row.email);
    expect(emails).not.toContain(email);
  });

  it('answers 404 the second time, and for an id that never existed', async () => {
    const email = uniqueEmail('twice');
    const created = await invite(email);
    const id = (created.body['data'] as { id: string }).id;

    await request(harness, {
      method: 'DELETE',
      url: `/api/v1/invitations/${id}`,
      token: ownerToken,
    });
    const again = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/invitations/${id}`,
      token: ownerToken,
    });
    expect(again.status).toBe(404);

    const imaginary = await request(harness, {
      method: 'DELETE',
      url: '/api/v1/invitations/0198c0de-0000-7000-8000-000000000000',
      token: ownerToken,
    });
    expect(imaginary.status).toBe(404);
    expect(errorShape(imaginary.body)).toEqual(errorShape(again.body));
  });
});

describe('accepting with a new account', () => {
  it('creates the account, the membership and a working session', async () => {
    const email = uniqueEmail('newcomer');
    await invite(email);
    const token = tokenFor(email);

    const preview = await request(harness, {
      method: 'GET',
      url: `/api/v1/invitations/accept?token=${encodeURIComponent(token)}`,
    });
    expect(preview.status).toBe(200);
    expect(preview.body['data']).toMatchObject({
      workspaceName: 'Acme Jewellers',
      email,
      roleName: 'Sales Rep',
      requiresAccount: true,
      signedInAs: null,
      canAccept: true,
    });

    const accepted = await accept({ token, name: 'New Comer', password: PASSWORD });
    expect(accepted.status).toBe(200);
    const data = accepted.body['data'] as { tenantId: string; token: string };
    expect(data.tenantId).toBe(tenantId);

    // The session works, in the workspace they were invited to, with the role
    // they were invited with: `own` scope, so creating is allowed.
    const created = await request(harness, {
      method: 'POST',
      url: '/api/v1/contacts',
      token: data.token,
      body: { lastName: 'Sharma' },
    });
    expect(created.status).toBe(201);

    // And not with powers they were not invited with: a Sales Rep cannot invite.
    const escalation = await invite(uniqueEmail('escalated'), repRoleId, data.token);
    expect(escalation.status).toBe(403);
  });

  it('marks the address verified, so they can sign in straight away', async () => {
    const email = uniqueEmail('verified');
    await invite(email);
    await accept({ token: tokenFor(email), name: 'Already Verified', password: PASSWORD });

    const signedIn = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { email, password: PASSWORD },
    });
    expect(signedIn.status).toBe(200);
  });

  it('is single-use', async () => {
    const email = uniqueEmail('once');
    await invite(email);
    const token = tokenFor(email);

    expect((await accept({ token, name: 'First Go', password: PASSWORD })).status).toBe(200);

    const second = await accept({ token, name: 'Second Go', password: PASSWORD });
    expect(second.status).toBe(400);
    expect((second.body['error'] as { code: string }).code).toBe('INVALID_TOKEN');
  });

  it('enforces the password policy', async () => {
    const email = uniqueEmail('weak');
    await invite(email);

    const response = await accept({ token: tokenFor(email), name: 'Weak', password: 'short' });
    expect(response.status).toBe(422);
  });

  it('leaves no account behind when the invitation was revoked first', async () => {
    const email = uniqueEmail('raced');
    const created = await invite(email);
    const token = tokenFor(email);

    await request(harness, {
      method: 'DELETE',
      url: `/api/v1/invitations/${(created.body['data'] as { id: string }).id}`,
      token: ownerToken,
    });

    expect((await accept({ token, name: 'Too Late', password: PASSWORD })).status).toBe(400);

    // The address must still be free to sign up with, which it is only if the
    // half-made user row was cleaned up.
    const signUp = await request(harness, {
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      body: { email, password: PASSWORD, name: 'Fresh Start' },
    });
    expect(signUp.status).toBe(202);
    expect(harness.emails.lastTo(email)?.subject).toContain('Confirm your email');
  });
});

describe('accepting with an account that already exists', () => {
  it('refuses to sign anybody in from the link, and says to sign in', async () => {
    const { email } = await existingAccount('member');
    await invite(email);

    const response = await accept({ token: tokenFor(email) });
    expect(response.status).toBe(401);
    expect((response.body['error'] as { code: string }).code).toBe('INVITATION_SIGN_IN_REQUIRED');
  });

  it('joins the workspace when the recipient accepts from their own session', async () => {
    const account = await existingAccount('joiner');
    await invite(account.email);
    const token = tokenFor(account.email);

    const preview = await request(harness, {
      method: 'GET',
      url: `/api/v1/invitations/accept?token=${encodeURIComponent(token)}`,
      token: account.token,
    });
    expect(preview.body['data']).toMatchObject({
      requiresAccount: false,
      signedInAs: account.email,
      canAccept: true,
    });

    const accepted = await accept({ token }, account.token);
    expect(accepted.status).toBe(200);
    // No session is issued: they already had one (ADR-0019).
    expect((accepted.body['data'] as { token?: string }).token).toBeUndefined();

    // The session now acts in the workspace they just joined.
    const contacts = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?limit=1',
      token: account.token,
      tenantId,
    });
    expect(contacts.status).toBe(200);
  });

  it('refuses a name and password from somebody who already has an account', async () => {
    const account = await existingAccount('nopassword');
    await invite(account.email);

    const response = await accept(
      { token: tokenFor(account.email), name: 'Imposter', password: PASSWORD },
      account.token,
    );
    expect(response.status).toBe(422);
  });
});

describe('an invited-but-unaccepted membership cannot act', () => {
  it('is refused by the actor resolver, as ActorService already promised', async () => {
    // Not a new rule — `ActorService` has always required `status = 'active'`.
    // Asserted here because invitations are the first thing in the product
    // that can leave a membership in any other state.
    const other = await harness.fixtures.createTenant({ name: 'Pending Co' });
    const roles = await harness.provision(other.tenantId);
    const user = await harness.fixtures.createUser(other.tenantId, roles.get('Owner')!);
    const token = await harness.signIn(user.userId, other.tenantId);

    await harness.fixtures.setMembershipStatus(other.tenantId, user.userId, 'invited');

    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts',
      token,
      tenantId: other.tenantId,
    });
    expect(response.status).toBe(403);
  });
});

describe('audit and events', () => {
  it('records the invitation, the acceptance and the revocation', async () => {
    const invited = uniqueEmail('audited');
    const created = await invite(invited);
    const invitationId = (created.body['data'] as { id: string }).id;
    await accept({ token: tokenFor(invited), name: 'Audited', password: PASSWORD });

    const revokedEmail = uniqueEmail('audited-revoked');
    const toRevoke = await invite(revokedEmail);
    await request(harness, {
      method: 'DELETE',
      url: `/api/v1/invitations/${(toRevoke.body['data'] as { id: string }).id}`,
      token: ownerToken,
    });

    const entries = await harness.fixtures.auditEntries(tenantId, 'invitation');
    const actions = entries.filter((row) => row.recordId === invitationId).map((r) => r.action);
    expect(actions).toContain('create');
    expect(actions).toContain('update');
    expect(entries.some((row) => row.action === 'delete')).toBe(true);

    const events = await harness.fixtures.outboxEventTypes(tenantId);
    expect(events).toContain('invitation.created.v1');
    expect(events).toContain('invitation.accepted.v1');
    expect(events).toContain('invitation.revoked.v1');
    expect(events).toContain('membership.created.v1');
  });
});
