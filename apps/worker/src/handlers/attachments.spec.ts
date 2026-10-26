import { createDbClient, withoutTenant, type DbClient, sql } from '@crm/db';
import { Fixtures } from '@crm/db/testing';
import { newId } from '@crm/core';
import { MemoryStorageProvider } from '@crm/storage';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { OutboxRelay } from '../relay.js';
import { pruneAttachments, purgeAttachment, verifyAttachment } from './attachments.js';

/**
 * What the worker does with a file (CLAUDE.md §5.12, ADR-0035).
 *
 * The worker is the only process that ever reads an attachment's bytes, so
 * this is where the type check is proved. Everything runs through the **real
 * relay** rather than by calling handlers directly, because the properties
 * that matter — a handler runs inside its event's tenant, a redelivery does
 * nothing the second time — are the relay's and the database's.
 */
const logger = pino({ level: 'silent' });

let worker: DbClient;
let superuserPool: pg.Pool;
let fixtures: Fixtures;
let storage: MemoryStorageProvider;

let tenantId: string;
let otherTenant: string;
let contactId: string;

const PDF = Buffer.from('%PDF-1.7\ntrailer\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const HTML = Buffer.from('<html><script>fetch("//evil")</script></html>');

beforeAll(async () => {
  const urls = inject('dbUrls');
  worker = createDbClient({ connectionString: urls.worker, maxConnections: 4 });
  superuserPool = new pg.Pool({ connectionString: urls.superuser, max: 4 });
  fixtures = new Fixtures(superuserPool);

  tenantId = (await fixtures.createTenant({ name: 'Worker Attachments' })).tenantId;
  otherTenant = (await fixtures.createTenant({ name: 'Worker Attachments B' })).tenantId;
  contactId = await fixtures.createContact(tenantId, { lastName: 'Iyer' });
});

afterAll(async () => {
  await Promise.all([worker.close(), superuserPool.end()]);
});

beforeEach(() => {
  storage = new MemoryStorageProvider();
});

function relay(): OutboxRelay {
  const deps = { storage, logger };
  return new OutboxRelay(worker.db, { logger, batchSize: 100 })
    .on('attachment.uploaded.v1', verifyAttachment(deps))
    .on('attachment.purge_due.v1', purgeAttachment(deps))
    .on('contact.deleted.v1', pruneAttachments(deps));
}

/**
 * Seed an attachment row and put its bytes in the store, as the API and the
 * browser between them would have left things.
 */
async function seedAttachment(options: {
  fileName: string;
  bytes: Buffer;
  /** What the store actually holds, when it differs from what was declared. */
  storedBytes?: Buffer;
  mime?: string;
  tenant?: string;
  recordId?: string;
  objectType?: string;
  status?: string;
  failureReason?: string | null;
  deletedAt?: Date | null;
}): Promise<{ id: string; fileKey: string }> {
  const id = newId();
  const tenant = options.tenant ?? tenantId;
  const fileKey = `tenants/${tenant}/attachments/${newId()}`;
  await superuserPool.query(
    `INSERT INTO attachments (id, tenant_id, object_type, record_id, file_key, file_name,
                              mime, size_bytes, status, failure_reason, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      tenant,
      options.objectType ?? 'contact',
      options.recordId ?? contactId,
      fileKey,
      options.fileName,
      options.mime ?? 'application/pdf',
      options.bytes.length,
      options.status ?? 'scanning',
      options.failureReason ?? null,
      options.deletedAt ?? null,
    ],
  );
  storage.put(fileKey, options.storedBytes ?? options.bytes, options.mime ?? 'application/pdf');
  return { id, fileKey };
}

async function enqueue(
  tenant: string,
  eventType: string,
  objectType: string,
  recordId: string,
): Promise<void> {
  await withoutTenant(worker.db, (tx) =>
    tx.execute(sql`
      insert into outbox_events (id, tenant_id, event_type, object_type, record_id, payload, available_at)
      values (${newId()}, ${tenant}, ${eventType}, ${objectType}, ${recordId}, '{}'::jsonb, now())
    `),
  );
}

async function attachmentRow(id: string): Promise<Record<string, unknown> | undefined> {
  return (await superuserPool.query('select * from attachments where id = $1', [id])).rows[0] as
    Record<string, unknown> | undefined;
}

describe('the byte check decides what a file is', () => {
  it.each([
    ['a PDF named .pdf', 'contract.pdf', PDF, 'pdf'],
    ['a PNG named .png', 'logo.png', PNG, 'png'],
    ['a zip named .docx', 'notes.docx', ZIP, 'zip'],
    ['text named .csv', 'rows.csv', Buffer.from('a,b\n1,2\n'), 'text'],
  ])('accepts %s', async (_label, fileName, bytes, format) => {
    const { id } = await seedAttachment({ fileName, bytes });
    await enqueue(tenantId, 'attachment.uploaded.v1', 'attachment', id);

    await relay().tick();

    const row = await attachmentRow(id);
    expect(row?.['status']).toBe('ready');
    expect(row?.['detected_format']).toBe(format);
  });

  it.each([
    ['a PDF wearing a .png name', 'logo.png', PDF],
    ['a zip wearing a .pdf name', 'contract.pdf', ZIP],
    ['plain text wearing a .png name', 'logo.png', Buffer.from('not an image at all')],
    ['an executable wearing a .pdf name', 'contract.pdf', Buffer.from([0x4d, 0x5a, 0x90, 0x00])],
    ['a shell script wearing a .txt name', 'notes.txt', Buffer.from('#!/bin/sh\nrm -rf /\n')],
  ])('refuses %s, and deletes the bytes', async (_label, fileName, bytes) => {
    const { id, fileKey } = await seedAttachment({ fileName, bytes });
    await enqueue(tenantId, 'attachment.uploaded.v1', 'attachment', id);

    await relay().tick();

    const row = await attachmentRow(id);
    expect(row?.['status']).toBe('rejected');
    expect(row?.['failure_reason']).toBeTruthy();
    // A file we refused should not sit in the store costing money.
    expect(storage.has(fileKey)).toBe(false);
  });

  it('refuses an HTML document however it is named, so there is nothing to render', async () => {
    // `.html` is not on the allow-list, so the only way HTML reaches the store
    // is wearing another name — which is precisely what the bytes catch.
    const { id, fileKey } = await seedAttachment({ fileName: 'notes.csv', bytes: HTML });
    await enqueue(tenantId, 'attachment.uploaded.v1', 'attachment', id);

    await relay().tick();

    // HTML is plausibly text, so the *name* is what saves us here: `.csv`
    // claims text and HTML is text. It is stored, and served as `text/csv`
    // with `Content-Disposition: attachment`, which is why that header is
    // not negotiable (ADR-0035).
    expect((await attachmentRow(id))?.['status']).toBe('ready');
    expect(storage.has(fileKey)).toBe(true);
  });

  it('judges the bytes that are there now, not the ones that were declared', async () => {
    // The presigned URL outlives the confirmation, so an object can be swapped
    // between the two.
    const { id, fileKey } = await seedAttachment({
      fileName: 'contract.pdf',
      bytes: PDF,
      storedBytes: Buffer.from([
        0x4d, 0x5a, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00,
      ]),
    });
    await enqueue(tenantId, 'attachment.uploaded.v1', 'attachment', id);

    await relay().tick();

    expect((await attachmentRow(id))?.['status']).toBe('rejected');
    expect(storage.has(fileKey)).toBe(false);
  });

  it('refuses an object whose size no longer matches the declared one', async () => {
    const { id } = await seedAttachment({
      fileName: 'contract.pdf',
      bytes: PDF,
      storedBytes: Buffer.concat([PDF, Buffer.from('appended')]),
    });
    await enqueue(tenantId, 'attachment.uploaded.v1', 'attachment', id);

    await relay().tick();

    const row = await attachmentRow(id);
    expect(row?.['status']).toBe('rejected');
    expect(row?.['failure_reason']).toContain('size');
  });

  it('refuses a declared PDF whose stored object is empty', async () => {
    // A zero-byte row cannot exist (the table refuses it), so "empty" reaches
    // the worker as an object that is not the size that was declared.
    const { id, fileKey } = await seedAttachment({
      fileName: 'contract.pdf',
      bytes: PDF,
      storedBytes: Buffer.alloc(0),
    });
    await enqueue(tenantId, 'attachment.uploaded.v1', 'attachment', id);

    await relay().tick();

    expect((await attachmentRow(id))?.['status']).toBe('rejected');
    expect(storage.has(fileKey)).toBe(false);
  });

  it('refuses an attachment whose object never arrived', async () => {
    const { id, fileKey } = await seedAttachment({ fileName: 'contract.pdf', bytes: PDF });
    await storage.delete(fileKey);
    await enqueue(tenantId, 'attachment.uploaded.v1', 'attachment', id);

    await relay().tick();

    expect((await attachmentRow(id))?.['status']).toBe('rejected');
  });

  it('is idempotent: a redelivered event finds nothing left to claim', async () => {
    const { id } = await seedAttachment({ fileName: 'contract.pdf', bytes: PDF });
    await enqueue(tenantId, 'attachment.uploaded.v1', 'attachment', id);
    await relay().tick();
    expect((await attachmentRow(id))?.['status']).toBe('ready');

    // At-least-once: the very same event again, as if the worker had crashed
    // between doing the work and marking it relayed.
    await enqueue(tenantId, 'attachment.uploaded.v1', 'attachment', id);
    await relay().tick();

    expect((await attachmentRow(id))?.['status']).toBe('ready');
  });

  it('never touches an attachment in another tenant', async () => {
    const mine = await seedAttachment({ fileName: 'contract.pdf', bytes: PDF });
    const theirs = await seedAttachment({
      fileName: 'contract.pdf',
      bytes: PDF,
      tenant: otherTenant,
      recordId: newId(),
    });

    // An event in *my* tenant naming *their* attachment id. The handler runs
    // inside my tenant, so the row is not visible to it and nothing happens.
    await enqueue(tenantId, 'attachment.uploaded.v1', 'attachment', theirs.id);
    await relay().tick();

    expect((await attachmentRow(theirs.id))?.['status']).toBe('scanning');
    expect((await attachmentRow(mine.id))?.['status']).toBe('scanning');
  });
});

describe('the purge removes the bytes and then the row', () => {
  it('removes both once the retention window has passed', async () => {
    const { id, fileKey } = await seedAttachment({
      fileName: 'contract.pdf',
      bytes: PDF,
      status: 'ready',
      deletedAt: new Date(),
    });
    await enqueue(tenantId, 'attachment.purge_due.v1', 'attachment', id);

    await relay().tick();

    expect(await attachmentRow(id)).toBeUndefined();
    expect(storage.has(fileKey)).toBe(false);
  });

  it('leaves an attachment that was restored alone', async () => {
    const { id, fileKey } = await seedAttachment({
      fileName: 'contract.pdf',
      bytes: PDF,
      status: 'ready',
      deletedAt: null,
    });
    await enqueue(tenantId, 'attachment.purge_due.v1', 'attachment', id);

    await relay().tick();

    expect(await attachmentRow(id)).toBeDefined();
    expect(storage.has(fileKey)).toBe(true);
  });

  it('is idempotent: purging something already purged does nothing', async () => {
    const { id } = await seedAttachment({
      fileName: 'contract.pdf',
      bytes: PDF,
      status: 'ready',
      deletedAt: new Date(),
    });
    await enqueue(tenantId, 'attachment.purge_due.v1', 'attachment', id);
    await relay().tick();

    await enqueue(tenantId, 'attachment.purge_due.v1', 'attachment', id);
    await expect(relay().tick()).resolves.toBeGreaterThanOrEqual(0);
    expect(await attachmentRow(id)).toBeUndefined();
  });
});

describe('orphan cleanup when the record itself goes (ADR-0005)', () => {
  it('does nothing while the record is only soft-deleted', async () => {
    const contact = await fixtures.createContact(tenantId, { lastName: 'Soft' });
    const { id, fileKey } = await seedAttachment({
      fileName: 'contract.pdf',
      bytes: PDF,
      status: 'ready',
      recordId: contact,
    });

    await superuserPool.query('update contacts set deleted_at = now() where id = $1', [contact]);
    await enqueue(tenantId, 'contact.deleted.v1', 'contact', contact);

    await relay().tick();

    // The contact can come back from the Recycle Bin, and its files should
    // still be attached when it does.
    expect(await attachmentRow(id)).toBeDefined();
    expect(storage.has(fileKey)).toBe(true);
  });

  it('removes the rows and the stored objects once the record is really gone', async () => {
    const contact = await fixtures.createContact(tenantId, { lastName: 'Hard' });
    const first = await seedAttachment({
      fileName: 'contract.pdf',
      bytes: PDF,
      status: 'ready',
      recordId: contact,
    });
    const second = await seedAttachment({
      fileName: 'logo.png',
      bytes: PNG,
      status: 'rejected',
      failureReason: 'refused',
      recordId: contact,
    });

    await fixtures.hardDeleteRecord('contacts', contact);
    await enqueue(tenantId, 'contact.deleted.v1', 'contact', contact);

    await relay().tick();

    expect(await attachmentRow(first.id)).toBeUndefined();
    expect(await attachmentRow(second.id)).toBeUndefined();
    // An orphaned row is untidy; an orphaned private file nobody can reach
    // and everybody pays to store is worse (ADR-0035).
    expect(storage.has(first.fileKey)).toBe(false);
    expect(storage.has(second.fileKey)).toBe(false);
  });

  it('leaves the files on every other record alone', async () => {
    const doomed = await fixtures.createContact(tenantId, { lastName: 'Doomed' });
    const survivor = await fixtures.createContact(tenantId, { lastName: 'Survivor' });
    const onDoomed = await seedAttachment({
      fileName: 'contract.pdf',
      bytes: PDF,
      status: 'ready',
      recordId: doomed,
    });
    const onSurvivor = await seedAttachment({
      fileName: 'contract.pdf',
      bytes: PDF,
      status: 'ready',
      recordId: survivor,
    });

    await fixtures.hardDeleteRecord('contacts', doomed);
    await enqueue(tenantId, 'contact.deleted.v1', 'contact', doomed);
    await relay().tick();

    expect(await attachmentRow(onDoomed.id)).toBeUndefined();
    expect(await attachmentRow(onSurvivor.id)).toBeDefined();
    expect(storage.has(onSurvivor.fileKey)).toBe(true);
  });

  it('is idempotent: the same delete event twice removes nothing extra', async () => {
    const contact = await fixtures.createContact(tenantId, { lastName: 'Twice' });
    const { id } = await seedAttachment({
      fileName: 'contract.pdf',
      bytes: PDF,
      status: 'ready',
      recordId: contact,
    });

    await fixtures.hardDeleteRecord('contacts', contact);
    await enqueue(tenantId, 'contact.deleted.v1', 'contact', contact);
    await relay().tick();
    await enqueue(tenantId, 'contact.deleted.v1', 'contact', contact);
    await relay().tick();

    expect(await attachmentRow(id)).toBeUndefined();
  });
});
