import { describe, expect, it } from 'vitest';
import {
  createStorageProvider,
  MemoryStorageProvider,
  newStorageKey,
  safeDownloadName,
  storageEnvShape,
} from './index.js';
import { z } from 'zod';

const parseEnv = (source: Record<string, string>) => z.object(storageEnvShape).parse(source);

describe('newStorageKey (CLAUDE.md §5.12: random keys)', () => {
  const tenant = '0192f9b0-0000-7000-8000-000000000001';

  it('is unguessable and never derived from anything a user typed', () => {
    const keys = new Set(Array.from({ length: 200 }, () => newStorageKey(tenant, 'imports')));
    expect(keys.size).toBe(200);
    for (const key of keys) {
      expect(key).toMatch(new RegExp(`^tenants/${tenant}/imports/[A-Za-z0-9_-]{43}$`));
    }
  });

  it('keeps imports and exports apart', () => {
    expect(newStorageKey(tenant, 'exports')).toContain('/exports/');
  });
});

describe('safeDownloadName', () => {
  it.each([
    ['customers.csv', 'customers.csv'],
    ['my file (1).csv', 'my_file_1_.csv'],
    ['../../etc/passwd', '_._etc_passwd'],
    ['line\r\nbreak.csv', 'line_break.csv'],
    ['quote".csv', 'quote_.csv'],
    ['.hidden', 'hidden'],
    ['', 'download'],
    ['***', '_'],
  ])('%j -> %j', (input, expected) => {
    expect(safeDownloadName(input)).toBe(expected);
  });

  it('cannot carry a header-injection payload', () => {
    expect(safeDownloadName('a.csv"\r\nSet-Cookie: x=1')).not.toMatch(/[\r\n"]/);
  });

  it('is bounded', () => {
    expect(safeDownloadName('a'.repeat(1000)).length).toBeLessThanOrEqual(120);
  });
});

describe('createStorageProvider', () => {
  it('refuses the in-memory store in production: two processes would each hold their own', () => {
    expect(() =>
      createStorageProvider(parseEnv({ STORAGE_PROVIDER: 'memory' }), 'production'),
    ).toThrow(/cannot be used in production/);
    expect(createStorageProvider(parseEnv({ STORAGE_PROVIDER: 'memory' }), 'test')).toBeInstanceOf(
      MemoryStorageProvider,
    );
  });

  it('refuses S3 without credentials, naming the variables and never a value', () => {
    expect(() => createStorageProvider(parseEnv({}), 'development')).toThrow(
      /S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/,
    );
  });

  it('builds the S3 adapter when configured', () => {
    const provider = createStorageProvider(
      parseEnv({
        S3_ACCESS_KEY_ID: 'id',
        S3_SECRET_ACCESS_KEY: 'secret',
        S3_ENDPOINT: 'http://localhost:19000',
        S3_FORCE_PATH_STYLE: 'true',
      }),
      'development',
    );
    expect(provider.constructor.name).toBe('S3StorageProvider');
  });

  it('defaults to a private bucket name and region, and path-style off', () => {
    const env = parseEnv({});
    expect(env).toMatchObject({
      STORAGE_PROVIDER: 's3',
      S3_BUCKET: 'crm-files',
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: false,
    });
  });
});

describe('MemoryStorageProvider honours the contract the security tests lean on', () => {
  const upload = { key: 'a/b', contentType: 'text/csv', sizeBytes: 5, expiresInSeconds: 600 };

  it('binds an upload to its declared size and type', async () => {
    const store = new MemoryStorageProvider();
    const url = await store.createUploadUrl(upload);
    expect(() => store.simulateUpload(url.url, Buffer.alloc(6), 'text/csv')).toThrow(/length/);
    expect(() => store.simulateUpload(url.url, Buffer.alloc(5), 'application/pdf')).toThrow(/type/);
    store.simulateUpload(url.url, Buffer.alloc(5), 'text/csv');
    expect((await store.head('a/b'))?.sizeBytes).toBe(5);
  });

  it('expires URLs', async () => {
    const store = new MemoryStorageProvider();
    const url = await store.createUploadUrl(upload);
    store.now = () => new Date(Date.now() + 11 * 60_000);
    expect(() => store.simulateUpload(url.url, Buffer.alloc(5), 'text/csv')).toThrow(/expired/);
  });

  it('has no object until something uploads one', async () => {
    const store = new MemoryStorageProvider();
    await store.createUploadUrl(upload);
    expect(await store.head('a/b')).toBeNull();
  });

  it('counts reads and writes, which the API test asserts stay at zero', async () => {
    const store = new MemoryStorageProvider();
    await store.createUploadUrl(upload);
    await store.createDownloadUrl({
      key: 'a/b',
      expiresInSeconds: 60,
      fileName: 'f.csv',
      contentType: 'text/csv',
    });
    await store.head('a/b');
    expect(store.reads + store.writes).toBe(0);

    await store.write('k', Buffer.from('x'), 'text/plain');
    await store.readPrefix('k', 1);
    expect(store.writes).toBe(1);
    expect(store.reads).toBe(1);
  });

  it('streams in chunks and can read a bounded prefix', async () => {
    const store = new MemoryStorageProvider();
    await store.write('big', Buffer.alloc(200_000, 1), 'application/octet-stream');
    let total = 0;
    let chunks = 0;
    for await (const chunk of store.openRead('big')) {
      total += chunk.length;
      chunks += 1;
    }
    expect(total).toBe(200_000);
    expect(chunks).toBeGreaterThan(1);
    expect((await store.readPrefix('big', 10)).length).toBe(10);
  });
});
