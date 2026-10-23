import { describe, expect, it } from 'vitest';
import { newId } from '../ids/index.js';
import type { Uuid } from '../ids/index.js';
import type {
  SearchDocument,
  SearchObjectScope,
  SearchProvider,
  SearchableObjectType,
} from './index.js';

/**
 * What every `SearchProvider` must do, as a test any implementation runs (ADR-0009, ADR-0028, ADR-0041).
 *
 * CLAUDE.md §2 promises that Postgres search can be replaced by Meilisearch behind this interface.
 * A promise like that is only as good as the thing that would tell you a replacement broke it, and
 * until this file existed that was nothing: the interface had one implementation and its behaviour
 * was whatever that implementation did. Now the behaviour is written down as assertions, and a
 * second provider is acceptable when it passes the same ones.
 *
 * It tests the **contract**, never an implementation: no SQL, no index name, no query language.
 * What it will not do is test speed, which belongs to a plan or a stopwatch on the real engine.
 *
 * The four rules at the top of `index.ts` (tenant, record scope, field permissions, soft deletes)
 * are the part that must never regress, so they are checked for `search` and for `matchRecordIds`
 * alike.
 *
 * An engine that indexes asynchronously supplies `settle`, which waits until what was written is
 * searchable; the Postgres one is transactional and has none.
 */
export interface SearchProviderHarness<Ctx> {
  readonly provider: SearchProvider<Ctx>;
  /** Run `fn` with whatever handle the provider needs for this tenant (for Postgres, a scoped transaction). */
  within<T>(tenantId: Uuid, fn: (ctx: Ctx) => Promise<T>): Promise<T>;
  /** A tenant that exists, empty. */
  newTenant(): Promise<Uuid>;
  /** Wait for indexed documents to become searchable, if the engine is eventually consistent. */
  settle?(): Promise<void>;
}

const ALL = { kind: 'all' } as const;

function doc(
  objectType: SearchableObjectType,
  options: {
    recordId?: Uuid;
    ownerId?: Uuid | null;
    updatedAt?: Date;
    fields: Record<string, string>;
  },
): SearchDocument {
  return {
    objectType,
    recordId: options.recordId ?? newId(),
    ownerId: options.ownerId ?? null,
    updatedAt: options.updatedAt ?? new Date(),
    fields: Object.entries(options.fields).map(([fieldKey, value]) => ({
      fieldKey,
      value,
      weight: 'A' as const,
    })),
  };
}

function scope(
  objectType: SearchableObjectType,
  fieldKeys: readonly string[],
  constraint: SearchObjectScope['constraint'] = ALL,
): SearchObjectScope {
  return { objectType, constraint, fieldKeys };
}

const CONTACT_FIELDS = ['first_name', 'last_name', 'email', 'phone'] as const;

export function describeSearchProviderContract<Ctx>(
  name: string,
  makeHarness: () => Promise<SearchProviderHarness<Ctx>>,
): void {
  describe(`SearchProvider contract: ${name}`, () => {
    let harness: SearchProviderHarness<Ctx>;
    const ready = async () => (harness ??= await makeHarness());

    const index = async (tenantId: Uuid, ...documents: SearchDocument[]) => {
      const h = await ready();
      await h.within(tenantId, (ctx) => h.provider.index(ctx, tenantId, documents));
      await h.settle?.();
    };
    const search = async (
      tenantId: Uuid,
      term: string,
      scopes: readonly SearchObjectScope[],
      limit = 10,
    ) => {
      const h = await ready();
      return h.within(tenantId, (ctx) => h.provider.search(ctx, { tenantId, term, limit, scopes }));
    };
    const match = async (tenantId: Uuid, term: string, one: SearchObjectScope, limit = 50) => {
      const h = await ready();
      return h.within(tenantId, (ctx) =>
        h.provider.matchRecordIds(ctx, { tenantId, term, scope: one, limit }),
      );
    };
    const tenant = async () => (await ready()).newTenant();

    describe('search', () => {
      it('finds a record by the start of a word, whatever the case', async () => {
        const t = await tenant();
        const record = doc('contact', {
          fields: { first_name: 'Priyanka', last_name: 'Raghunathan' },
        });
        await index(t, record);
        for (const term of ['priyanka', 'PRIYA', 'Raghu']) {
          const hits = await search(t, term, [scope('contact', CONTACT_FIELDS)]);
          expect(
            hits.map((hit) => hit.recordId),
            term,
          ).toContain(record.recordId);
        }
        expect(await search(t, 'zzzunrelated', [scope('contact', CONTACT_FIELDS)])).toEqual([]);
      });

      it('is idempotent: indexing the same record twice leaves one hit', async () => {
        const t = await tenant();
        const record = doc('contact', { fields: { last_name: 'Idempotentson' } });
        await index(t, record);
        await index(t, record);
        const hits = await search(t, 'idempotentson', [scope('contact', CONTACT_FIELDS)]);
        expect(hits.filter((hit) => hit.recordId === record.recordId)).toHaveLength(1);
      });

      it('replaces a record, so a value it no longer holds stops matching', async () => {
        const t = await tenant();
        const recordId = newId();
        await index(t, doc('contact', { recordId, fields: { last_name: 'Formerly' } }));
        await index(t, doc('contact', { recordId, fields: { last_name: 'Presently' } }));
        expect(await search(t, 'formerly', [scope('contact', CONTACT_FIELDS)])).toEqual([]);
        expect(
          (await search(t, 'presently', [scope('contact', CONTACT_FIELDS)])).map(
            (hit) => hit.recordId,
          ),
        ).toContain(recordId);
      });

      it('forgets a removed record, and clear forgets only that tenant', async () => {
        const h = await ready();
        const a = await tenant();
        const b = await tenant();
        const gone = doc('contact', { fields: { last_name: 'Removable' } });
        const kept = doc('contact', { fields: { last_name: 'Keepable' } });
        const other = doc('contact', { fields: { last_name: 'Keepable' } });
        await index(a, gone, kept);
        await index(b, other);

        await h.within(a, (ctx) =>
          h.provider.remove(ctx, a, [{ objectType: 'contact', recordId: gone.recordId }]),
        );
        await h.settle?.();
        expect(await search(a, 'removable', [scope('contact', CONTACT_FIELDS)])).toEqual([]);
        expect(await search(a, 'keepable', [scope('contact', CONTACT_FIELDS)])).not.toEqual([]);

        await h.within(a, (ctx) => h.provider.clear(ctx, a));
        await h.settle?.();
        expect(await search(a, 'keepable', [scope('contact', CONTACT_FIELDS)])).toEqual([]);
        expect(await search(b, 'keepable', [scope('contact', CONTACT_FIELDS)])).not.toEqual([]);
      });

      it('never returns another tenant’s record', async () => {
        const a = await tenant();
        const b = await tenant();
        const theirs = doc('contact', { fields: { last_name: 'Crosstenant' } });
        await index(b, theirs);
        expect(await search(a, 'crosstenant', [scope('contact', CONTACT_FIELDS)])).toEqual([]);
      });

      it('applies record scope: an own-scope caller sees only their own records', async () => {
        const t = await tenant();
        const me = newId();
        const mine = doc('contact', { ownerId: me, fields: { last_name: 'Ownedby' } });
        const notMine = doc('contact', { ownerId: newId(), fields: { last_name: 'Ownedby' } });
        await index(t, mine, notMine);
        const own = await search(t, 'ownedby', [
          scope('contact', CONTACT_FIELDS, { kind: 'own', userId: me }),
        ]);
        expect(own.map((hit) => hit.recordId)).toEqual([mine.recordId]);
        const all = await search(t, 'ownedby', [scope('contact', CONTACT_FIELDS)]);
        expect(all.map((hit) => hit.recordId).sort()).toEqual(
          [mine.recordId, notMine.recordId].sort(),
        );
      });

      it('applies field permissions: a field the caller may not read is not searchable and never quoted', async () => {
        const t = await tenant();
        const record = doc('contact', {
          fields: { last_name: 'Visibleone', email: 'hiddenaddress@secret.example' },
        });
        await index(t, record);
        const readable = [scope('contact', ['last_name'])];
        expect(await search(t, 'hiddenaddress', readable)).toEqual([]);
        const hits = await search(t, 'visibleone', readable);
        expect(hits).toHaveLength(1);
        expect(hits[0]?.matchedFieldKey).toBe('last_name');
        expect(JSON.stringify(hits)).not.toContain('hiddenaddress');
        // Readable object, no readable searchable field: matches nothing, not everything.
        expect(await search(t, 'visibleone', [scope('contact', [])])).toEqual([]);
      });
    });

    describe('matchRecordIds', () => {
      it('requires every word, which may match in different fields', async () => {
        const t = await tenant();
        const both = doc('contact', { fields: { first_name: 'Johnathan', last_name: 'Smithers' } });
        const onlyFirst = doc('contact', {
          fields: { first_name: 'Johnathan', last_name: 'Other' },
        });
        const onlyLast = doc('contact', {
          fields: { first_name: 'Someone', last_name: 'Smithers' },
        });
        await index(t, both, onlyFirst, onlyLast);
        const result = await match(t, 'johnathan smithers', scope('contact', CONTACT_FIELDS));
        expect(result.recordIds).toEqual([both.recordId]);
        expect(result.truncated).toBe(false);
      });

      it('matches the start of a word, and does not prefer a match in the middle of one', async () => {
        const t = await tenant();
        const starts = doc('contact', { fields: { first_name: 'Deepkumarson' } });
        const middle = doc('contact', { fields: { first_name: 'Sandeepkumarson' } });
        await index(t, starts, middle);
        // A word is a prefix: `deepkumar` finds Deepkumarson and `sandeep` finds Sandeepkumarson. When
        // something matches, a record that only has the word in the middle of another is not returned
        // (an engine may bring such a record in by typo tolerance only when nothing matches at all).
        expect((await match(t, 'deepkumar', scope('contact', CONTACT_FIELDS))).recordIds).toEqual([
          starts.recordId,
        ]);
        expect((await match(t, 'sandeep', scope('contact', CONTACT_FIELDS))).recordIds).toEqual([
          middle.recordId,
        ]);
      });

      it('returns the most recently updated first', async () => {
        const t = await tenant();
        const oldest = doc('contact', {
          updatedAt: new Date('2024-01-01'),
          fields: { last_name: 'Ordered' },
        });
        const middle = doc('contact', {
          updatedAt: new Date('2025-01-01'),
          fields: { last_name: 'Ordered' },
        });
        const newest = doc('contact', {
          updatedAt: new Date('2026-01-01'),
          fields: { last_name: 'Ordered' },
        });
        await index(t, oldest, newest, middle);
        const result = await match(t, 'ordered', scope('contact', CONTACT_FIELDS));
        expect(result.recordIds).toEqual([newest.recordId, middle.recordId, oldest.recordId]);
      });

      it('stops at the limit and says so, and says so only when there was more', async () => {
        const t = await tenant();
        const records = Array.from({ length: 5 }, (_, i) =>
          doc('contact', { updatedAt: new Date(2026, 0, i + 1), fields: { last_name: 'Limited' } }),
        );
        await index(t, ...records);
        const some = await match(t, 'limited', scope('contact', CONTACT_FIELDS), 3);
        expect(some.recordIds).toHaveLength(3);
        expect(some.truncated).toBe(true);
        const exactly = await match(t, 'limited', scope('contact', CONTACT_FIELDS), 5);
        expect(exactly.recordIds).toHaveLength(5);
        expect(exactly.truncated).toBe(false);
      });

      it('answers for one object type and not another', async () => {
        const t = await tenant();
        const contact = doc('contact', { fields: { last_name: 'Samename' } });
        const account = doc('account', { fields: { name: 'Samename' } });
        await index(t, contact, account);
        expect((await match(t, 'samename', scope('contact', CONTACT_FIELDS))).recordIds).toEqual([
          contact.recordId,
        ]);
        expect((await match(t, 'samename', scope('account', ['name']))).recordIds).toEqual([
          account.recordId,
        ]);
      });

      it('applies the same four rules as search', async () => {
        const a = await tenant();
        const b = await tenant();
        const me = newId();
        const mine = doc('contact', {
          ownerId: me,
          fields: { last_name: 'Ruleset', email: 'secretbox@x.example' },
        });
        const theirs = doc('contact', { ownerId: newId(), fields: { last_name: 'Ruleset' } });
        const elsewhere = doc('contact', { ownerId: me, fields: { last_name: 'Ruleset' } });
        await index(a, mine, theirs);
        await index(b, elsewhere);

        // record scope
        const own = await match(
          a,
          'ruleset',
          scope('contact', CONTACT_FIELDS, { kind: 'own', userId: me }),
        );
        expect(own.recordIds).toEqual([mine.recordId]);
        // tenant
        const wide = await match(a, 'ruleset', scope('contact', CONTACT_FIELDS));
        expect(wide.recordIds).not.toContain(elsewhere.recordId);
        // field permissions
        expect((await match(a, 'secretbox', scope('contact', ['last_name']))).recordIds).toEqual(
          [],
        );
        expect((await match(a, 'ruleset', scope('contact', []))).recordIds).toEqual([]);
      });

      it('does not return a removed record', async () => {
        const h = await ready();
        const t = await tenant();
        const record = doc('contact', { fields: { last_name: 'Binned' } });
        await index(t, record);
        await h.within(t, (ctx) =>
          h.provider.remove(ctx, t, [{ objectType: 'contact', recordId: record.recordId }]),
        );
        await h.settle?.();
        expect((await match(t, 'binned', scope('contact', CONTACT_FIELDS))).recordIds).toEqual([]);
      });

      it('survives hostile and degenerate input, answering with nothing rather than throwing', async () => {
        const t = await tenant();
        await index(t, doc('contact', { fields: { last_name: 'Normalperson' } }));
        for (const term of [
          'john & smith | !x:* \' " ) (',
          '\\',
          '%_',
          ':*',
          '   ',
          '',
          'a',
          'x'.repeat(5000),
        ]) {
          const result = await match(t, term, scope('contact', CONTACT_FIELDS));
          expect(Array.isArray(result.recordIds), JSON.stringify(term.slice(0, 20))).toBe(true);
        }
      });
    });
  });
}
