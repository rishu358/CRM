import {
  InfiniteQueryObserver,
  MutationObserver,
  QueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemEnvelope, ListEnvelope } from './api-client';
import {
  dealKeys,
  flattenDealPages,
  moveDealOptions,
  type DealRecord,
  type StageRecord,
} from './deals';

/**
 * The card must land in its new column after a move (the board, MVP_SPEC M5).
 *
 * A move cancels every deals query before it paints its guess. A column that was
 * still on its first load had nothing to roll back to, and nothing asked for it again,
 * so a card moved into it never showed up (the intermittent `deals.spec.ts` failure
 * in CI, where the Negotiation column answers a moment after the Proposal one). These
 * tests drive the same options the board uses, against real query observers.
 */

const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('./api-client', () => ({ api: { get: mocks.get, patch: mocks.patch } }));

const PIPELINE = 'pipeline-1';
const PROPOSAL: StageRecord = {
  id: 'stage-proposal',
  name: 'Proposal',
  position: 3,
  probability: 50,
  stageType: 'open',
};
const NEGOTIATION: StageRecord = {
  id: 'stage-negotiation',
  name: 'Negotiation',
  position: 4,
  probability: 75,
  stageType: 'open',
};

const DEAL: DealRecord = {
  id: 'deal-1',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  name: 'Studio lighting supply',
  pipelineId: PIPELINE,
  stageId: PROPOSAL.id,
};
const MOVED: DealRecord = { ...DEAL, version: 2, stageId: NEGOTIATION.id, probability: 75 };

function page(deals: DealRecord[]): ListEnvelope<DealRecord> {
  return { data: deals, meta: { nextCursor: null } } as unknown as ListEnvelope<DealRecord>;
}

function stageOf(url: string): string | null {
  const filter = new URLSearchParams(url.split('?')[1] ?? '').get('filter') ?? '';
  return /^stage_id:eq:(.+)$/.exec(filter)?.[1] ?? null;
}

function columnObserver(client: QueryClient, stage: StageRecord) {
  const observer = new InfiniteQueryObserver<
    ListEnvelope<DealRecord>,
    Error,
    InfiniteData<ListEnvelope<DealRecord>>
  >(client, {
    queryKey: dealKeys.column(PIPELINE, stage.id, ''),
    initialPageParam: null as string | null,
    queryFn: () => mocks.get(`/deals?filter=stage_id:eq:${stage.id}`) as Promise<never>,
    getNextPageParam: () => undefined,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  return { observer, unsubscribe };
}

function names(observer: ReturnType<typeof columnObserver>['observer']): string[] {
  return flattenDealPages(observer.getCurrentResult().data).map((deal) => deal.id);
}

describe('moving a deal on the board', () => {
  let client: QueryClient;
  let stops: (() => void)[];

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stops = [];
    mocks.get.mockReset();
    mocks.patch.mockReset();
    mocks.patch.mockResolvedValue({ data: MOVED } satisfies ItemEnvelope<DealRecord>);
  });

  afterEach(() => {
    for (const stop of stops) stop();
    client.clear();
  });

  function move() {
    const mutation = new MutationObserver(client, moveDealOptions(client));
    return mutation.mutate({ deal: DEAL, pipelineId: PIPELINE, from: PROPOSAL, to: NEGOTIATION });
  }

  it('shows the card in a column that had already loaded', async () => {
    mocks.get.mockImplementation((url: string) =>
      Promise.resolve(page(stageOf(url) === PROPOSAL.id ? [DEAL] : [])),
    );
    const proposal = columnObserver(client, PROPOSAL);
    const negotiation = columnObserver(client, NEGOTIATION);
    stops.push(proposal.unsubscribe, negotiation.unsubscribe);
    await vi.waitFor(() => expect(names(proposal.observer)).toEqual([DEAL.id]));
    await vi.waitFor(() => expect(negotiation.observer.getCurrentResult().isSuccess).toBe(true));

    await move();

    expect(names(negotiation.observer)).toEqual([DEAL.id]);
    expect(names(proposal.observer)).toEqual([]);
  });

  it('shows the card in a column that was still on its first load when the move began', async () => {
    // The target column's first request is slow: it has not answered when the card is moved.
    // Once the move has settled, the server includes the card, so a second request finds it.
    let firstNegotiationLoad = true;
    mocks.get.mockImplementation((url: string) => {
      if (stageOf(url) === PROPOSAL.id) return Promise.resolve(page([DEAL]));
      if (firstNegotiationLoad) {
        firstNegotiationLoad = false;
        return new Promise(() => undefined);
      }
      return Promise.resolve(page([MOVED]));
    });
    const proposal = columnObserver(client, PROPOSAL);
    const negotiation = columnObserver(client, NEGOTIATION);
    stops.push(proposal.unsubscribe, negotiation.unsubscribe);
    await vi.waitFor(() => expect(names(proposal.observer)).toEqual([DEAL.id]));
    expect(negotiation.observer.getCurrentResult().isPending).toBe(true);

    await move();

    await vi.waitFor(() => expect(names(negotiation.observer)).toEqual([DEAL.id]));
    expect(names(proposal.observer)).toEqual([]);
  });

  it('does not refetch a column that already holds its cards', async () => {
    mocks.get.mockImplementation((url: string) =>
      Promise.resolve(page(stageOf(url) === PROPOSAL.id ? [DEAL] : [])),
    );
    const proposal = columnObserver(client, PROPOSAL);
    const negotiation = columnObserver(client, NEGOTIATION);
    stops.push(proposal.unsubscribe, negotiation.unsubscribe);
    await vi.waitFor(() => expect(negotiation.observer.getCurrentResult().isSuccess).toBe(true));
    await vi.waitFor(() => expect(names(proposal.observer)).toEqual([DEAL.id]));
    const loads = mocks.get.mock.calls.length;

    await move();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.get.mock.calls.length).toBe(loads);
  });
});
