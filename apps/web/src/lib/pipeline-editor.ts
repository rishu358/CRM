'use client';

import type {
  ManagedPipeline,
  StageArchiveInput,
  StageArchiveResult,
  StageCreateInput,
  StageOrderInput,
  StageRestoreInput,
  StageUpdateInput,
} from '@crm/contracts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope } from './api-client';
import { dashboardKeys } from './dashboard';
import { dealKeys } from './deals';

/**
 * Server state for the pipeline and stage editor (CLAUDE.md §9, MVP_SPEC M5, ADR-0062).
 *
 * The editor has its own list (`/pipelines/manage`: retired stages and deal counts included), and
 * the board and dashboard have theirs. They are different questions with different cache entries,
 * so **every successful change invalidates all of them**: the pipeline list the board draws its
 * columns from, every board and column of every pipeline, and the dashboard. Nothing here decides
 * who may edit; a 403 on the list is the answer that hides the screen, and the API refuses every
 * write on its own.
 */

export type { ManagedPipeline };
export type ManagedPipelineList = { readonly data: ManagedPipeline[] };

export const pipelineEditorKeys = {
  managed: ['pipelines', 'managed'] as const,
};

/** A refusal is an answer; retrying it only delays the screen that explains it. */
function retry(count: number, error: ApiRequestError): boolean {
  return error.status !== 403 && error.status !== 401 && count < 2;
}

export function useManagedPipelines() {
  return useQuery<ManagedPipelineList, ApiRequestError>({
    queryKey: pipelineEditorKeys.managed,
    queryFn: () => api.get<ManagedPipelineList>('/pipelines/manage'),
    retry,
  });
}

/** What every part of the app that shows a stage must refetch once a stage has changed. */
export function invalidateStageViews(client: QueryClient): Promise<unknown> {
  return Promise.all([
    client.invalidateQueries({ queryKey: pipelineEditorKeys.managed }),
    client.invalidateQueries({ queryKey: dealKeys.pipelines }),
    client.invalidateQueries({ queryKey: dealKeys.all }),
    client.invalidateQueries({ queryKey: dashboardKeys.all }),
  ]);
}

/** Put the pipeline the server just answered with into the editor's list, replacing the old copy. */
function store(client: QueryClient, pipeline: ManagedPipeline): void {
  client.setQueryData<ManagedPipelineList>(pipelineEditorKeys.managed, (current) =>
    current === undefined
      ? current
      : { data: current.data.map((entry) => (entry.id === pipeline.id ? pipeline : entry)) },
  );
}

/** A new `Idempotency-Key` per user action, so a retry of one click cannot add two stages. */
function newKey(): string {
  return globalThis.crypto.randomUUID();
}

export function useCreateStage(pipelineId: string) {
  const client = useQueryClient();
  return useMutation<ItemEnvelope<ManagedPipeline>, ApiRequestError, StageCreateInput>({
    mutationFn: (input) =>
      api.post<ItemEnvelope<ManagedPipeline>>(`/pipelines/${pipelineId}/stages`, input, {
        'idempotency-key': newKey(),
      }),
    onSuccess: async (answer) => {
      store(client, answer.data);
      await invalidateStageViews(client);
    },
  });
}

/**
 * Rename, re-weight or retype a stage.
 *
 * Optimistic (CLAUDE.md §9: inline edit feedback under 100 ms): the cache shows the new name at
 * once, and goes back to what it was if the server says no. The answer then replaces the cache,
 * which carries the new `version` the next edit needs.
 */
export function useUpdateStage(pipelineId: string) {
  const client = useQueryClient();
  return useMutation<
    ItemEnvelope<ManagedPipeline>,
    ApiRequestError,
    { stageId: string; input: StageUpdateInput },
    { previous: ManagedPipelineList | undefined }
  >({
    mutationFn: ({ stageId, input }) =>
      api.patch<ItemEnvelope<ManagedPipeline>>(`/pipelines/${pipelineId}/stages/${stageId}`, input),
    onMutate: async ({ stageId, input }) => {
      await client.cancelQueries({ queryKey: pipelineEditorKeys.managed });
      const previous = client.getQueryData<ManagedPipelineList>(pipelineEditorKeys.managed);
      client.setQueryData<ManagedPipelineList>(pipelineEditorKeys.managed, (current) =>
        current === undefined
          ? current
          : {
              data: current.data.map((pipeline) =>
                pipeline.id !== pipelineId
                  ? pipeline
                  : {
                      ...pipeline,
                      stages: pipeline.stages.map((stage) =>
                        stage.id !== stageId
                          ? stage
                          : {
                              ...stage,
                              ...(input.name === undefined ? {} : { name: input.name.trim() }),
                              ...(input.probability === undefined
                                ? {}
                                : { probability: input.probability }),
                            },
                      ),
                    },
              ),
            },
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous !== undefined) {
        client.setQueryData(pipelineEditorKeys.managed, context.previous);
      }
    },
    onSuccess: async (answer) => {
      store(client, answer.data);
      await invalidateStageViews(client);
    },
  });
}

/** Reorder. Optimistic, like a rename: the rows move at once and snap back on a refusal. */
export function useOrderStages(pipelineId: string) {
  const client = useQueryClient();
  return useMutation<
    ItemEnvelope<ManagedPipeline>,
    ApiRequestError,
    StageOrderInput,
    { previous: ManagedPipelineList | undefined }
  >({
    mutationFn: (input) =>
      api.post<ItemEnvelope<ManagedPipeline>>(`/pipelines/${pipelineId}/stages/order`, input),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: pipelineEditorKeys.managed });
      const previous = client.getQueryData<ManagedPipelineList>(pipelineEditorKeys.managed);
      client.setQueryData<ManagedPipelineList>(pipelineEditorKeys.managed, (current) => {
        if (current === undefined) return current;
        return {
          data: current.data.map((pipeline) => {
            if (pipeline.id !== pipelineId) return pipeline;
            const byId = new Map(pipeline.stages.map((stage) => [stage.id, stage]));
            const ordered = input.stageIds.flatMap((id) => {
              const stage = byId.get(id);
              return stage === undefined ? [] : [stage];
            });
            const rest = pipeline.stages.filter((stage) => !input.stageIds.includes(stage.id));
            return { ...pipeline, stages: [...ordered, ...rest] };
          }),
        };
      });
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous !== undefined) {
        client.setQueryData(pipelineEditorKeys.managed, context.previous);
      }
    },
    onSuccess: async (answer) => {
      store(client, answer.data);
      await invalidateStageViews(client);
    },
  });
}

/** Retire a stage. Not optimistic: it moves deals, so the screen waits for the server's count. */
export function useArchiveStage(pipelineId: string) {
  const client = useQueryClient();
  return useMutation<
    ItemEnvelope<StageArchiveResult>,
    ApiRequestError,
    { stageId: string; input: StageArchiveInput }
  >({
    mutationFn: ({ stageId, input }) =>
      api.post<ItemEnvelope<StageArchiveResult>>(
        `/pipelines/${pipelineId}/stages/${stageId}/archive`,
        input,
      ),
    onSuccess: async (answer) => {
      store(client, answer.data.pipeline);
      await invalidateStageViews(client);
    },
  });
}

export function useRestoreStage(pipelineId: string) {
  const client = useQueryClient();
  return useMutation<
    ItemEnvelope<ManagedPipeline>,
    ApiRequestError,
    { stageId: string; input: StageRestoreInput }
  >({
    mutationFn: ({ stageId, input }) =>
      api.post<ItemEnvelope<ManagedPipeline>>(
        `/pipelines/${pipelineId}/stages/${stageId}/restore`,
        input,
      ),
    onSuccess: async (answer) => {
      store(client, answer.data);
      await invalidateStageViews(client);
    },
  });
}
