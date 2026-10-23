import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  newId,
  type SearchDocument,
  type SearchObjectScope,
  type SearchWeight,
  type Uuid,
} from '@crm/core';
import { createDbClient, withTenant, type DbClient } from '../client.js';
import { Fixtures } from '../testing/fixtures.js';
import { PostgresSearchProvider, recordMatchDocumentCap } from './postgres.js';

/**
 * What the Postgres provider does when a list's search matches more than it will read (ADR-0041 §5).
 *
 * The provider contract says a search reports `truncated` honestly. These are the parts of that
 * which belong to this engine: it reads at most `recordMatchDocumentCap` index rows, newest first,
 * and a scan that stopped at the cap must say so even when it found few records, and must not be
 * followed by a typo-tolerant pass that would return something the exact pass never reached.
 */
let client: DbClient;
let superuser: pg.Pool;
const provider = new PostgresSearchProvider();

async function freshTenant(): Promise<Uuid> {
  return (await new Fixtures(superuser).createTenant({ name: 'Match bounds' })).tenantId as Uuid;
}

function contact(fields: Record<string, string>, updatedAt: Date): SearchDocument {
  return {
    objectType: 'contact',
    recordId: newId(),
    ownerId: null,
    updatedAt,
    fields: Object.entries(fields).map(([fieldKey, value]) => ({
      fieldKey,
      value,
      weight: 'A' as SearchWeight,
    })),
  };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

function scopeFor(fieldKeys: readonly string[]): SearchObjectScope {
  return { objectType: 'contact', constraint: { kind: 'all' }, fieldKeys };
}

async function indexAll(tenantId: Uuid, documents: readonly SearchDocument[]): Promise<void> {
  await withTenant(client.db, { tenantId, userId: null }, (tx) =>
    provider.index(tx, tenantId, documents),
  );
}

function match(tenantId: Uuid, term: string, fieldKeys: readonly string[], limit: number) {
  return withTenant(client.db, { tenantId, userId: null }, (tx) =>
    provider.matchRecordIds(tx, { tenantId, term, scope: scopeFor(fieldKeys), limit }),
  );
}

beforeAll(() => {
  const urls = inject('dbUrls');
  client = createDbClient({ connectionString: urls.worker, maxConnections: 2 });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
});

afterAll(async () => {
  await client.close();
  await superuser.end();
});

describe('how much of the index a list search reads', () => {
  it('reads three rows per record asked for, plus three', () => {
    expect(recordMatchDocumentCap(3)).toBe(12);
    expect(recordMatchDocumentCap(300)).toBe(903);
  });

  it('says the scan was cut short when it read as many rows as it may, even for a single record', async () => {
    const tenantId = await freshTenant();
    // One record that matches through twenty fields: twenty index rows, one record.
    const fields = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, 'acme']));
    await indexAll(tenantId, [contact(fields, minutesAgo(1))]);

    const keys = Object.keys(fields);
    const cut = await match(tenantId, 'acme', keys, 3);
    expect(cut.recordIds).toHaveLength(1);
    expect(cut.truncated).toBe(true);

    // Under the cap the same record is the whole answer, and it says so.
    const whole = await match(tenantId, 'acme', keys.slice(0, 2), 3);
    expect(whole.recordIds).toHaveLength(1);
    expect(whole.truncated).toBe(false);
  });
});

describe('the typo-tolerant pass', () => {
  async function seeded(johns: number): Promise<{ tenantId: Uuid; typo: Uuid }> {
    const tenantId = await freshTenant();
    const typo = contact({ last_name: 'Smithe' }, minutesAgo(1000));
    const others = Array.from({ length: johns }, (_, i) =>
      contact({ first_name: 'John', last_name: `Other${String(i)}x` }, minutesAgo(i + 1)),
    );
    await indexAll(tenantId, [typo, ...others]);
    return { tenantId, typo: typo.recordId };
  }

  it('finds a near match when nothing matched exactly and the scan was complete', async () => {
    const { tenantId, typo } = await seeded(3);
    const result = await match(tenantId, 'john smith', ['first_name', 'last_name'], 2);
    expect(result.recordIds).toEqual([typo]);
    expect(result.truncated).toBe(false);
  });

  it('does not run it when the exact scan was cut short: more may be there, so say so', async () => {
    // Ten records match `john` and none has `smith`; with a limit of 2 only nine index rows are read.
    const { tenantId } = await seeded(10);
    const result = await match(tenantId, 'john smith', ['first_name', 'last_name'], 2);
    expect(result.recordIds).toEqual([]);
    expect(result.truncated).toBe(true);
  });
  it('says there are more near matches than it returned, when there are', async () => {
    const tenantId = await freshTenant();
    await indexAll(
      tenantId,
      Array.from({ length: 4 }, (_, i) => contact({ last_name: 'Washington' }, minutesAgo(i + 1))),
    );
    // A misspelling: no word starts with it, so only the typo-tolerant pass can answer.
    const result = await match(tenantId, 'washingtn', ['last_name'], 2);
    expect(result.recordIds).toHaveLength(2);
    expect(result.truncated).toBe(true);

    const all = await match(tenantId, 'washingtn', ['last_name'], 4);
    expect(all.recordIds).toHaveLength(4);
    expect(all.truncated).toBe(false);
  });
});
