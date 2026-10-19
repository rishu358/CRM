import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3StorageProvider } from './s3.js';

/**
 * The S3 adapter against a real S3-compatible server (MinIO).
 *
 * The memory provider is a fake of the *contract*; this is what shows the real
 * adapter keeps it. The properties CLAUDE.md §5.12 depends on are not ones to
 * take on faith: that a presigned upload is bound to the size and type it was
 * signed for, that a download is offered as an attachment, that URLs expire, and
 * that nothing is readable without a signature.
 */
let container: StartedTestContainer;
let provider: S3StorageProvider;
let endpoint: string;
const BUCKET = 'crm-test';

beforeAll(async () => {
  // The same digest-pinned image docker-compose runs (RELEASE.2025-09-07T16-13-09Z).
  container = await new GenericContainer(
    'quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e',
  )
    .withExposedPorts(9000)
    .withEnvironment({ MINIO_ROOT_USER: 'test_access', MINIO_ROOT_PASSWORD: 'test_secret_key_1' })
    .withCommand(['server', '/data'])
    .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
    .start();

  endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  const admin = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test_access', secretAccessKey: 'test_secret_key_1' },
  });
  await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));

  provider = new S3StorageProvider({
    bucket: BUCKET,
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    accessKeyId: 'test_access',
    secretAccessKey: 'test_secret_key_1',
  });
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

async function put(
  url: { url: string; headers: Record<string, string> },
  body: Buffer,
  headers?: Record<string, string>,
) {
  return fetch(url.url, { method: 'PUT', headers: headers ?? url.headers, body });
}

describe('presigned upload', () => {
  it('accepts exactly the body that was signed for', async () => {
    const body = Buffer.from('last_name,email\nAda,ada@x.io\n');
    const url = await provider.createUploadUrl({
      key: 'tenants/t/imports/ok',
      contentType: 'text/csv',
      sizeBytes: body.length,
      expiresInSeconds: 60,
    });
    const response = await put(url, body);
    expect(response.status).toBe(200);

    const head = await provider.head('tenants/t/imports/ok');
    expect(head).toMatchObject({ sizeBytes: body.length });
  });

  it('rejects a body of a different length than was signed', async () => {
    const url = await provider.createUploadUrl({
      key: 'tenants/t/imports/long',
      contentType: 'text/csv',
      sizeBytes: 10,
      expiresInSeconds: 60,
    });
    // 11 bytes against a signature for 10; the client computes Content-Length itself.
    const response = await put(url, Buffer.alloc(11, 0x61));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await provider.head('tenants/t/imports/long')).toBeNull();
  });

  it('rejects a different content type than was signed', async () => {
    const url = await provider.createUploadUrl({
      key: 'tenants/t/imports/typed',
      contentType: 'text/csv',
      sizeBytes: 4,
      expiresInSeconds: 60,
    });
    const response = await put(url, Buffer.from('abcd'), {
      ...url.headers,
      'Content-Type': 'application/x-msdownload',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await provider.head('tenants/t/imports/typed')).toBeNull();
  });

  it('rejects a PUT to a different key than was signed', async () => {
    const url = await provider.createUploadUrl({
      key: 'tenants/t/imports/signed',
      contentType: 'text/csv',
      sizeBytes: 3,
      expiresInSeconds: 60,
    });
    const tampered = url.url.replace('imports/signed', 'imports/other');
    const response = await fetch(tampered, {
      method: 'PUT',
      headers: url.headers,
      body: Buffer.from('abc'),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await provider.head('tenants/t/imports/other')).toBeNull();
  });

  it('stops working when it expires', async () => {
    const url = await provider.createUploadUrl({
      key: 'tenants/t/imports/expiring',
      contentType: 'text/csv',
      sizeBytes: 3,
      expiresInSeconds: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const response = await put(url, Buffer.from('abc'));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await provider.head('tenants/t/imports/expiring')).toBeNull();
  });

  it('is not readable without a signature: the bucket is private', async () => {
    const response = await fetch(`${endpoint}/${BUCKET}/tenants/t/imports/ok`);
    expect(response.status).toBe(403);
  });
});

describe('presigned download', () => {
  it('serves the object as an attachment, with a sanitised name and the stated type', async () => {
    await provider.write('tenants/t/exports/file', Buffer.from('a,b\n1,2\n'), 'text/csv');
    const link = await provider.createDownloadUrl({
      key: 'tenants/t/exports/file',
      expiresInSeconds: 60,
      fileName: 'my "export".csv\r\nX-Evil: 1',
      contentType: 'text/csv',
    });
    const response = await fetch(link.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('a,b\n1,2\n');
    expect(response.headers.get('content-type')).toBe('text/csv');
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
    expect(disposition).not.toMatch(/[\r\n]/);
  });

  it('stops working when it expires', async () => {
    await provider.write('tenants/t/exports/short', Buffer.from('x'), 'text/csv');
    const link = await provider.createDownloadUrl({
      key: 'tenants/t/exports/short',
      expiresInSeconds: 1,
      fileName: 'x.csv',
      contentType: 'text/csv',
    });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await fetch(link.url)).status).toBeGreaterThanOrEqual(400);
  });

  it('will not serve a different key from the one signed', async () => {
    await provider.write('tenants/t/exports/a', Buffer.from('A'), 'text/csv');
    await provider.write('tenants/t/exports/b', Buffer.from('B'), 'text/csv');
    const link = await provider.createDownloadUrl({
      key: 'tenants/t/exports/a',
      expiresInSeconds: 60,
      fileName: 'a.csv',
      contentType: 'text/csv',
    });
    const response = await fetch(link.url.replace('exports/a', 'exports/b'));
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('worker-side reads and writes', () => {
  it('reports a missing object as null, not an error', async () => {
    expect(await provider.head('tenants/t/nope')).toBeNull();
  });

  it('reads a bounded prefix without fetching the whole object', async () => {
    await provider.write('tenants/t/big', Buffer.alloc(100_000, 0x41), 'application/octet-stream');
    const prefix = await provider.readPrefix('tenants/t/big', 16);
    expect(prefix.length).toBe(16);
    expect(Buffer.from(prefix).toString()).toBe('A'.repeat(16));
  });

  it('streams an object back in chunks', async () => {
    const body = Buffer.alloc(300_000, 0x42);
    await provider.write('tenants/t/stream', body, 'application/octet-stream');
    let total = 0;
    for await (const chunk of provider.openRead('tenants/t/stream')) total += chunk.length;
    expect(total).toBe(body.length);
  });

  it('writes a streamed body (multipart) and deletes', async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 6; i += 1) {
        // A real producer awaits its data; yield to the event loop like one.
        await Promise.resolve();
        yield Buffer.alloc(1_000_000, 0x30 + i);
      }
    }
    await provider.write('tenants/t/multipart', source(), 'text/csv');
    expect((await provider.head('tenants/t/multipart'))?.sizeBytes).toBe(6_000_000);

    await provider.delete('tenants/t/multipart');
    expect(await provider.head('tenants/t/multipart')).toBeNull();
  });
});
