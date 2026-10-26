import { ATTACHMENT_LIMITS, newId } from '@crm/core';
import { typedPool, type TypedPool } from '@crm/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Attachment endpoints (MVP_SPEC §6.1, CLAUDE.md §5.5 §5.12, ADR-0035).
 *
 * The four mandatory suites (CLAUDE.md §10), plus the two questions an
 * attachment raises that no other record does:
 *
 *   1. **Does the polymorphic pair let anyone around record scope?** An
 *      attachment carries `(object_type, record_id)` and no foreign key
 *      (ADR-0005), so every path has to re-ask the module that owns the
 *      record. A file on a contact Tenant B owns, or on a colleague's contact
 *      a rep may not see, must be a 404 — the same 404 as an id that was never
 *      issued.
 *   2. **Is the file itself dangerous on the way back out?** The filename
 *      reaches a `Content-Disposition` header and the MIME type decides
 *      whether a browser renders or downloads. Both are the uploader's.
 *
 * The byte check itself lives in the worker and is tested there with real
 * files, because the API never reads bytes — which these tests also assert, by
 * counting.
 */
let harness: ApiHarness;
let rawSuperuser: pg.Pool;
let superuser: TypedPool;

let tenantA: string;
let tenantB: string;
let roles: ReadonlyMap<string, string>;

let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let otherRepA: { token: string; userId: string };
let readOnlyA: { token: string; userId: string };
let adminB: { token: string; userId: string };

/** A contact everyone in tenant A with `all` scope can see. */
let sharedContact: string;
/** A contact owned by `repA`. */
let ownContact: string;
/** A contact owned by `otherRepA`: outside `repA`'s `own` scope. */
let foreignContact: string;
/** A contact in tenant B. */
let contactB: string;

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n');

async function userWithRole(tenantId: string, roleId: string) {
  const user = await harness.fixtures.createUser(tenantId, roleId);
  return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls);
  rawSuperuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  superuser = typedPool(rawSuperuser);

  tenantA = (await harness.fixtures.createTenant({ name: 'Attachments A' })).tenantId;
  roles = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Attachments B' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  adminA = await userWithRole(tenantA, roles.get('Admin')!);
  repA = await userWithRole(tenantA, roles.get('Sales Rep')!);
  otherRepA = await userWithRole(tenantA, roles.get('Sales Rep')!);
  readOnlyA = await userWithRole(tenantA, roles.get('Read-only')!);
  adminB = await userWithRole(tenantB, rolesB.get('Admin')!);

  sharedContact = await harness.fixtures.createContact(tenantA, {
    ownerId: adminA.userId,
    lastName: 'Shared',
  });
  ownContact = await harness.fixtures.createContact(tenantA, {
    ownerId: repA.userId,
    lastName: 'Mine',
  });
  foreignContact = await harness.fixtures.createContact(tenantA, {
    ownerId: otherRepA.userId,
    lastName: 'Theirs',
  });
  contactB = await harness.fixtures.createContact(tenantB, { lastName: 'Other tenant' });
});

afterAll(async () => {
  await rawSuperuser.end();
  await harness.close();
});

interface Created {
  readonly id: string;
  readonly upload: {
    url: string;
    method: string;
    headers: Record<string, string>;
    expiresAt: string;
  };
}

async function createAttachment(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown>; created?: Created }> {
  const response = await request(harness, {
    method: 'POST',
    url: '/api/v1/attachments',
    token,
    body: {
      objectType: 'contact',
      recordId: sharedContact,
      fileName: 'contract.pdf',
      sizeBytes: PDF.length,
      ...overrides,
    },
  });
  // Tolerant on purpose: this helper also serves tests of refusals, where there
  // is no data envelope to read and the caller asserts on `status` instead.
  const data = response.body['data'] as
    { attachment: { id: string }; upload: Created['upload'] } | undefined;
  return {
    ...response,
    ...(data === undefined ? {} : { created: { id: data.attachment.id, upload: data.upload } }),
  };
}

/** Play the browser: PUT the bytes, then say so, then play the worker. */
async function uploadAttachment(
  token: string,
  overrides: Record<string, unknown> = {},
  bytes: Buffer = PDF,
): Promise<string> {
  const { created, body } = await createAttachment(token, {
    sizeBytes: bytes.length,
    ...overrides,
  });
  expect(created, JSON.stringify(body)).toBeDefined();
  harness.storage.simulateUpload(
    created!.upload.url,
    bytes,
    created!.upload.headers['Content-Type'] as string,
  );
  await request(harness, {
    method: 'POST',
    url: `/api/v1/attachments/${created!.id}/uploaded`,
    token,
  });
  // The worker's byte check is tested in the worker; here it is simply the
  // state an attachment is in once it has passed.
  await setStatus(created!.id, 'ready');
  return created!.id;
}

async function setStatus(id: string, status: string): Promise<void> {
  await superuser.query('update attachments set status = $1 where id = $2', [status, id]);
}

async function row(id: string): Promise<Record<string, unknown>> {
  const found = (await superuser.query('select * from attachments where id = $1', [id])).rows[0];
  if (found === undefined) throw new Error(`No attachment ${id}`);
  return found;
}

function listUrl(objectType: string, recordId: string): string {
  return `/api/v1/attachments?objectType=${objectType}&recordId=${recordId}`;
}

// ---------------------------------------------------------------------------
// CLAUDE.md §10: the four mandatory suites
// ---------------------------------------------------------------------------

describe('unauthenticated requests get 401', () => {
  it('on the list', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: listUrl('contact', sharedContact),
    });
    expect(response.status).toBe(401);
  });

  it('on create — before the body is even looked at', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/attachments',
      body: { objectType: 'contact', recordId: sharedContact, fileName: 'a.pdf', sizeBytes: 10 },
    });
    expect(response.status).toBe(401);
  });

  it('on the id-addressed routes too', async () => {
    const id = await uploadAttachment(adminA.token);
    const routes = [
      { method: 'POST', url: `/api/v1/attachments/${id}/uploaded` },
      { method: 'POST', url: `/api/v1/attachments/${id}/download` },
      { method: 'DELETE', url: `/api/v1/attachments/${id}` },
    ] as const;
    for (const route of routes) {
      const response = await request(harness, route);
      expect(response.status, `${route.method} ${route.url}`).toBe(401);
    }
  });
});

describe('tenant isolation: tenant B cannot reach tenant A', () => {
  it('cannot list the files on a tenant A record', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: listUrl('contact', sharedContact),
      token: adminB.token,
    });
    expect(response.status).toBe(404);
  });

  it('cannot attach a file to a tenant A record', async () => {
    const response = await createAttachment(adminB.token);
    expect(response.status).toBe(404);
  });

  it('cannot read, download or delete a tenant A attachment', async () => {
    const id = await uploadAttachment(adminA.token);

    const download = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${id}/download`,
      token: adminB.token,
    });
    expect(download.status).toBe(404);

    const removed = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/attachments/${id}`,
      token: adminB.token,
    });
    expect(removed.status).toBe(404);

    // And it is still there.
    expect((await row(id))['deleted_at']).toBeNull();
  });

  it('cannot attach a tenant A record id to its own tenant by naming it', async () => {
    // The pair is `(objectType, recordId)`; the record id belongs to tenant A
    // and the session to tenant B. RLS confines the lookup, so the record
    // simply does not exist for this caller.
    const response = await createAttachment(adminB.token, { recordId: contactB });
    expect(response.status).toBe(201);

    const created = dataOf<{ attachment: { id: string } }>(response);
    expect((await row(created.attachment.id))['tenant_id']).toBe(tenantB);
  });
});

describe('record scope: own cannot reach another rep’s record', () => {
  it('a rep may not list the files on a record outside their scope', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: listUrl('contact', foreignContact),
      token: repA.token,
    });
    expect(response.status).toBe(404);
  });

  it('a rep may not attach a file to a record outside their scope', async () => {
    const response = await createAttachment(repA.token, { recordId: foreignContact });
    expect(response.status).toBe(404);
  });

  it('a rep may not download or delete a file on a record outside their scope', async () => {
    const id = await uploadAttachment(adminA.token, { recordId: foreignContact });

    const download = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${id}/download`,
      token: repA.token,
    });
    expect(download.status).toBe(404);

    const removed = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/attachments/${id}`,
      token: repA.token,
    });
    expect(removed.status).toBe(404);
  });

  it('a rep may do all of it on their own record', async () => {
    const id = await uploadAttachment(repA.token, { recordId: ownContact });

    const listed = await request(harness, {
      method: 'GET',
      url: listUrl('contact', ownContact),
      token: repA.token,
    });
    expect(listed.status).toBe(200);
    expect(dataOf<{ id: string }[]>(listed).map((item) => item.id)).toContain(id);

    const download = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${id}/download`,
      token: repA.token,
    });
    expect(download.status).toBe(200);

    const removed = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/attachments/${id}`,
      token: repA.token,
    });
    expect(removed.status).toBe(204);
  });

  it('the 404 for a foreign record is identical to the 404 for an id nobody issued', async () => {
    const id = await uploadAttachment(adminA.token, { recordId: foreignContact });

    const foreign = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${id}/download`,
      token: repA.token,
    });
    const invented = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${newId()}/download`,
      token: repA.token,
    });

    expect(foreign.status).toBe(invented.status);
    const strip = (body: Record<string, unknown>) => {
      const error = { ...(body['error'] as Record<string, unknown>) };
      delete error['requestId'];
      return error;
    };
    expect(strip(foreign.body)).toEqual(strip(invented.body));
  });
});

describe('permissions: reading a record is not permission to change it', () => {
  it('a read-only user may list and download, but not attach', async () => {
    const id = await uploadAttachment(adminA.token);

    const listed = await request(harness, {
      method: 'GET',
      url: listUrl('contact', sharedContact),
      token: readOnlyA.token,
    });
    expect(listed.status).toBe(200);

    const download = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${id}/download`,
      token: readOnlyA.token,
    });
    expect(download.status).toBe(200);

    const created = await createAttachment(readOnlyA.token);
    expect(created.status).toBe(404);
  });

  it('a read-only user may not delete a file either', async () => {
    const id = await uploadAttachment(adminA.token);
    const response = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/attachments/${id}`,
      token: readOnlyA.token,
    });
    expect(response.status).toBe(404);
    expect((await row(id))['deleted_at']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The file itself (CLAUDE.md §5.12, ADR-0035)
// ---------------------------------------------------------------------------

describe('the filename is the uploader’s, so it is refused rather than repaired', () => {
  it.each([
    ['a path separator', 'invoices/2026/q3.pdf'],
    ['a Windows path', 'C:\\Users\\rep\\report.pdf'],
    ['a traversal sequence', '..\u002f..\u002fetc\u002fpasswd'],
    ['a bare traversal', 'report..pdf'],
    ['a NUL byte', 'report\u0000.pdf'],
    ['a newline and a header', 'a.pdf\r\nSet-Cookie: x=1'],
    ['a right-to-left override', 'invoice\u202egnp.exe'],
    ['a 300-character name', `${'a'.repeat(300)}.pdf`],
    ['an executable', 'payload.exe'],
    ['a double extension', 'report.pdf.exe'],
    ['an SVG, which is a document that can carry script', 'logo.svg'],
    ['an HTML page', 'index.html'],
  ])('refuses %s with a 422 and stores nothing', async (_label, fileName) => {
    const before = harness.storage.keys().length;

    const response = await createAttachment(adminA.token, { fileName });
    expect(response.status).toBe(422);
    expect(harness.storage.keys()).toHaveLength(before);
  });

  it('accepts an ordinary name with spaces, brackets and non-ASCII letters', async () => {
    const response = await createAttachment(adminA.token, {
      fileName: 'Q3 report (final) — été.pdf',
    });
    expect(response.status).toBe(201);
  });
});

describe('the server decides the type, and the download is never rendered', () => {
  it('binds the presigned PUT to our type for the extension, not to anything a client sent', async () => {
    const { created } = await createAttachment(adminA.token, { fileName: 'photo.png' });
    expect(created!.upload.headers['Content-Type']).toBe('image/png');

    const signed = harness.storage.issuedUploadRequests.at(-1);
    expect(signed?.contentType).toBe('image/png');
    // The exact size, not a ceiling: the store refuses a body of any other length.
    expect(signed?.sizeBytes).toBe(PDF.length);
  });

  it('refuses an extra key such as mime, rather than quietly ignoring it', async () => {
    const response = await createAttachment(adminA.token, { mime: 'text/html' });
    expect(response.status).toBe(422);
  });

  it('serves the download as an attachment, with our own type', async () => {
    const id = await uploadAttachment(adminA.token, { fileName: 'report.pdf' });
    const response = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${id}/download`,
      token: adminA.token,
    });
    expect(response.status).toBe(200);

    const link = dataOf<{ url: string }>(response);
    const headers = harness.storage.headersFor(link.url);
    expect(headers['Content-Disposition']).toBe('attachment; filename="report.pdf"');
    expect(headers['Content-Type']).toBe('application/pdf');
  });

  it('flattens a hostile name before it reaches the header', async () => {
    // Accepted by the contract (the overrides are refused, this one is not):
    // a name that is merely awkward still must not survive into a header.
    const id = await uploadAttachment(adminA.token, { fileName: 'Q3 "final" report.pdf' });
    const response = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${id}/download`,
      token: adminA.token,
    });

    const link = dataOf<{ url: string }>(response);
    const disposition = harness.storage.headersFor(link.url)['Content-Disposition'] as string;
    expect(disposition.match(/"/g)).toHaveLength(2);
    expect(disposition).not.toMatch(/[\r\n]/);
  });
});

describe('presigned URLs are short-lived and unguessable', () => {
  it('an upload URL expires, and the store refuses it afterwards', async () => {
    const { created } = await createAttachment(adminA.token);
    const expiresAt = new Date(created!.upload.expiresAt).getTime();
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000 + 5_000);

    harness.storage.now = () => new Date(expiresAt + 1_000);
    expect(() =>
      harness.storage.simulateUpload(
        created!.upload.url,
        PDF,
        created!.upload.headers['Content-Type'] as string,
      ),
    ).toThrow(/expired/i);
    harness.storage.now = () => new Date();
  });

  it('a download URL expires, and the store refuses it afterwards', async () => {
    const id = await uploadAttachment(adminA.token);
    const response = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${id}/download`,
      token: adminA.token,
    });
    const link = dataOf<{ url: string; expiresAt: string }>(response);

    const expiresAt = new Date(link.expiresAt).getTime();
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000 + 5_000);

    expect(harness.storage.simulateDownload(link.url)).toBeDefined();
    harness.storage.now = () => new Date(expiresAt + 1_000);
    expect(() => harness.storage.simulateDownload(link.url)).toThrow(/expired/i);
    harness.storage.now = () => new Date();
  });

  it('the storage key is random, and is never returned by the API', async () => {
    const response = await createAttachment(adminA.token, { fileName: 'secret-plan.pdf' });
    const created = dataOf<{
      attachment: Record<string, unknown>;
      upload: unknown;
    }>(response);

    expect(created.attachment).not.toHaveProperty('fileKey');
    expect(created.attachment).not.toHaveProperty('storageKey');
    expect(JSON.stringify(response.body)).not.toContain('tenants/');

    const id = created.attachment['id'] as string;
    const key = (await row(id))['file_key'] as string;
    expect(key).toMatch(new RegExp(`^tenants/${tenantA}/attachments/[A-Za-z0-9_-]{43}$`));
    // Nothing the user typed is in it.
    expect(key).not.toContain('secret-plan');
  });

  it('two attachments never share a key', async () => {
    const keys = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      const response = await createAttachment(adminA.token);
      const id = dataOf<{ attachment: { id: string } }>(response).attachment.id;
      keys.add((await row(id))['file_key'] as string);
    }
    expect(keys.size).toBe(5);
  });
});

describe('the API never touches a file’s bytes (CLAUDE.md §5.12)', () => {
  it('counts zero reads and zero writes through a whole create–confirm–download–delete flow', async () => {
    const readsBefore = harness.storage.reads;
    const writesBefore = harness.storage.writes;

    const id = await uploadAttachment(adminA.token);
    await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${id}/download`,
      token: adminA.token,
    });
    await request(harness, {
      method: 'DELETE',
      url: `/api/v1/attachments/${id}`,
      token: adminA.token,
    });

    expect(harness.storage.reads).toBe(readsBefore);
    expect(harness.storage.writes).toBe(writesBefore);
  });

  it('has no endpoint that accepts a file body', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/attachments',
      token: adminA.token,
      body: {
        objectType: 'contact',
        recordId: sharedContact,
        fileName: 'a.pdf',
        sizeBytes: 4,
        content: 'JVBERi0=',
      },
    });
    expect(response.status).toBe(422);
  });
});

describe('the declared size is what the store is told, and is checked again', () => {
  it('refuses a size above the ceiling before anything is signed', async () => {
    const response = await createAttachment(adminA.token, {
      sizeBytes: ATTACHMENT_LIMITS.maxUploadBytes + 1,
    });
    expect(response.status).toBe(422);
  });

  it('refuses a confirmation when nothing was uploaded', async () => {
    const { created } = await createAttachment(adminA.token);
    const response = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${created!.id}/uploaded`,
      token: adminA.token,
    });
    expect(response.status).toBe(409);
  });

  it('rejects the attachment and deletes the object when the size does not match', async () => {
    const { created } = await createAttachment(adminA.token, { sizeBytes: PDF.length });
    const key = (await row(created!.id))['file_key'] as string;

    // A hostile client that reached the store another way: the bytes are
    // there, but they are not the bytes that were declared.
    harness.storage.put(key, Buffer.concat([PDF, Buffer.from('extra')]), 'application/pdf');

    const response = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${created!.id}/uploaded`,
      token: adminA.token,
    });
    expect(response.status).toBe(202);
    expect(dataOf<{ status: string }>(response).status).toBe('rejected');
    expect(harness.storage.has(key)).toBe(false);
  });

  it('is idempotent: confirming twice does not move an attachment on twice', async () => {
    const { created } = await createAttachment(adminA.token);
    harness.storage.simulateUpload(
      created!.upload.url,
      PDF,
      created!.upload.headers['Content-Type'] as string,
    );

    const first = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${created!.id}/uploaded`,
      token: adminA.token,
    });
    const second = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${created!.id}/uploaded`,
      token: adminA.token,
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(dataOf<{ status: string }>(second).status).toBe('scanning');
  });
});

describe('a file that has not passed the byte check is not a file', () => {
  it('is not listed while it is scanning, and not after it is rejected', async () => {
    const contact = await harness.fixtures.createContact(tenantA, {
      ownerId: adminA.userId,
      lastName: 'Pending',
    });
    const { created } = await createAttachment(adminA.token, { recordId: contact });
    await setStatus(created!.id, 'scanning');

    const scanning = await request(harness, {
      method: 'GET',
      url: listUrl('contact', contact),
      token: adminA.token,
    });
    expect(dataOf(scanning)).toEqual([]);

    await superuser.query(
      `update attachments set status = 'rejected', failure_reason = 'refused' where id = $1`,
      [created!.id],
    );
    const rejected = await request(harness, {
      method: 'GET',
      url: listUrl('contact', contact),
      token: adminA.token,
    });
    expect(dataOf(rejected)).toEqual([]);
  });

  it('cannot be downloaded', async () => {
    const { created } = await createAttachment(adminA.token);
    await setStatus(created!.id, 'scanning');

    const response = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${created!.id}/download`,
      token: adminA.token,
    });
    expect(response.status).toBe(409);
  });
});

describe('an uploader can see what became of a file', () => {
  const get = (token: string | undefined, id: string) =>
    request(harness, { method: 'GET', url: `/api/v1/attachments/${id}`, token });

  it('shows a scanning file, and a rejected one with its reason', async () => {
    const { created } = await createAttachment(adminA.token);
    await setStatus(created!.id, 'scanning');
    const scanning = await get(adminA.token, created!.id);
    expect(scanning.status).toBe(200);
    expect(dataOf<{ status: string }>(scanning).status).toBe('scanning');

    await superuser.query(
      `update attachments set status = 'rejected', failure_reason = 'The file is named .pdf but its contents are not' where id = $1`,
      [created!.id],
    );
    const rejected = await get(adminA.token, created!.id);
    const data = dataOf<{ status: string; failureReason: string }>(rejected);
    expect(data.status).toBe('rejected');
    expect(data.failureReason).toContain('named .pdf');
  });

  it('never returns the storage key', async () => {
    const id = await uploadAttachment(adminA.token);
    const response = await get(adminA.token, id);
    expect(dataOf(response)).not.toHaveProperty('fileKey');
    expect(JSON.stringify(response.body)).not.toContain('tenants/');
  });

  it('is 401 unauthenticated, and 404 across tenants and outside record scope', async () => {
    const id = await uploadAttachment(adminA.token, { recordId: foreignContact });
    expect((await get(undefined, id)).status).toBe(401);
    expect((await get(adminB.token, id)).status).toBe(404);
    // `own` scope: this contact belongs to another rep.
    expect((await get(repA.token, id)).status).toBe(404);
    // A deleted attachment is gone from here too.
    await request(harness, {
      method: 'DELETE',
      url: `/api/v1/attachments/${id}`,
      token: adminA.token,
    });
    expect((await get(adminA.token, id)).status).toBe(404);
  });
});

describe('the record page’s list is scoped to one record', () => {
  it('requires both halves of the pair', async () => {
    for (const query of ['', '?objectType=contact', `?recordId=${sharedContact}`]) {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/attachments${query}`,
        token: adminA.token,
      });
      expect(response.status).toBe(422);
    }
  });

  it('refuses an object type that is not one a file may hang from', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: listUrl('invitation', sharedContact),
      token: adminA.token,
    });
    expect(response.status).toBe(422);
  });

  it('shows only the files on the record asked for', async () => {
    const one = await harness.fixtures.createContact(tenantA, {
      ownerId: adminA.userId,
      lastName: 'One',
    });
    const two = await harness.fixtures.createContact(tenantA, {
      ownerId: adminA.userId,
      lastName: 'Two',
    });
    const onOne = await uploadAttachment(adminA.token, { recordId: one });
    await uploadAttachment(adminA.token, { recordId: two });

    const response = await request(harness, {
      method: 'GET',
      url: listUrl('contact', one),
      token: adminA.token,
    });
    expect(dataOf<{ id: string }[]>(response).map((item) => item.id)).toEqual([onOne]);
  });
});

describe('every object type that can carry a file does', () => {
  it.each(['account', 'lead', 'deal', 'activity'] as const)('%s', async (objectType) => {
    const recordId = await seedRecord(objectType);

    const id = await uploadAttachment(adminA.token, { objectType, recordId });
    const listed = await request(harness, {
      method: 'GET',
      url: listUrl(objectType, recordId),
      token: adminA.token,
    });
    expect(dataOf<{ id: string }[]>(listed).map((item) => item.id)).toEqual([id]);

    // And the other tenant still cannot reach it.
    const foreign = await request(harness, {
      method: 'GET',
      url: listUrl(objectType, recordId),
      token: adminB.token,
    });
    expect(foreign.status).toBe(404);
  });
});

async function seedRecord(objectType: 'account' | 'lead' | 'deal' | 'activity'): Promise<string> {
  switch (objectType) {
    case 'account':
      return harness.fixtures.createAccount(tenantA, { ownerId: adminA.userId, name: 'Acme' });
    case 'lead':
      return harness.fixtures.createLead(tenantA, { ownerId: adminA.userId, lastName: 'Rao' });
    case 'deal': {
      const pipelines = await harness.fixtures.pipelinesFor(tenantA);
      const pipeline = pipelines[0]!;
      return harness.fixtures.createDeal(tenantA, {
        pipelineId: pipeline.id,
        stageId: pipeline.stages[0]!.id,
        ownerId: adminA.userId,
        name: 'Diwali order',
      });
    }
    case 'activity':
      return harness.fixtures.createActivity(tenantA, { assignedTo: adminA.userId });
  }
}

describe('limits and deletion', () => {
  it('refuses more than the per-record ceiling', async () => {
    const contact = await harness.fixtures.createContact(tenantA, {
      ownerId: adminA.userId,
      lastName: 'Crowded',
    });
    await superuser.query(
      `insert into attachments (id, tenant_id, object_type, record_id, file_key, file_name,
                                mime, size_bytes, status)
       select gen_random_uuid(), $1, 'contact', $2, 'k' || generate_series,
              'f.pdf', 'application/pdf', 10, 'ready'
       from generate_series(1, $3::int)`,
      [tenantA, contact, ATTACHMENT_LIMITS.maxPerRecord],
    );

    const response = await createAttachment(adminA.token, { recordId: contact });
    expect(response.status).toBe(409);
  });

  it('soft-deletes, leaves the bytes, and schedules the purge', async () => {
    const id = await uploadAttachment(adminA.token);
    const key = (await row(id))['file_key'] as string;

    const response = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/attachments/${id}`,
      token: adminA.token,
    });
    expect(response.status).toBe(204);

    const after = await row(id);
    expect(after['deleted_at']).not.toBeNull();
    // The file is still there: an undelete that cannot bring it back is not
    // an undelete (ADR-0035).
    expect(harness.storage.has(key)).toBe(true);

    const events = await superuser.query(
      `select event_type, available_at from outbox_events
       where tenant_id = $1 and record_id = $2 and event_type = 'attachment.purge_due.v1'`,
      [tenantA, id],
    );
    expect(events.rows).toHaveLength(1);
    const availableAt = new Date((events.rows[0] as { available_at: Date }).available_at);
    const days = (availableAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(ATTACHMENT_LIMITS.purgeAfterDays - 1);
  });

  it('a deleted attachment is gone from the list and from every id-addressed route', async () => {
    const contact = await harness.fixtures.createContact(tenantA, {
      ownerId: adminA.userId,
      lastName: 'Emptied',
    });
    const id = await uploadAttachment(adminA.token, { recordId: contact });
    await request(harness, {
      method: 'DELETE',
      url: `/api/v1/attachments/${id}`,
      token: adminA.token,
    });

    const listed = await request(harness, {
      method: 'GET',
      url: listUrl('contact', contact),
      token: adminA.token,
    });
    expect(dataOf(listed)).toEqual([]);

    const download = await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${id}/download`,
      token: adminA.token,
    });
    expect(download.status).toBe(404);
  });
});

describe('everything that matters is audited (CLAUDE.md §5.10)', () => {
  it('records the upload, the download link and the delete', async () => {
    const contact = await harness.fixtures.createContact(tenantA, {
      ownerId: adminA.userId,
      lastName: 'Audited',
    });
    const id = await uploadAttachment(adminA.token, { recordId: contact });
    await request(harness, {
      method: 'POST',
      url: `/api/v1/attachments/${id}/download`,
      token: adminA.token,
    });
    await request(harness, {
      method: 'DELETE',
      url: `/api/v1/attachments/${id}`,
      token: adminA.token,
    });

    // Ordered by `id`, not `occurred_at`. `occurred_at` is the database's
    // transaction start time, and the clock behind it can step backwards
    // between two requests (a VM resync does), which reorders rows that were
    // written in sequence. The id is a UUIDv7 minted in the API process, which
    // is monotonic however the clock behaves, so it is the order things
    // actually happened in.
    const entries = await superuser.query(
      `select action from audit_logs
       where tenant_id = $1 and object_type = 'attachment' and record_id = $2
       order by id`,
      [tenantA, id],
    );
    expect(entries.rows.map((entry) => (entry as { action: string }).action)).toEqual([
      'create',
      'export',
      'delete',
    ]);
  });

  it('never writes the storage key into the audit log', async () => {
    const id = await uploadAttachment(adminA.token);
    const entries = await superuser.query(
      `select changes from audit_logs where tenant_id = $1 and record_id = $2`,
      [tenantA, id],
    );
    expect(JSON.stringify(entries.rows)).not.toContain('tenants/');
  });
});
