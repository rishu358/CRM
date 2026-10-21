'use client';

import type {
  CustomizableObjectName,
  FieldCreateInput,
  FieldDefinitionView,
  FieldOrderInput,
  FieldUpdateInput,
} from '@crm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope } from './api-client';

/**
 * Server state for custom fields and picklists (CLAUDE.md §9, MVP_SPEC M9).
 *
 * Two lists, deliberately separate. The **form list** is what record pages and
 * dialogs are drawn from: active fields the signed-in person may read. The
 * **management list** is the administrator's: every definition, switched-off ones
 * included. They are different questions with different answers, and different
 * cache entries, so an administrator's edit cannot leave a stale form behind.
 *
 * Nothing here decides who may customise. A 403 on the management list is the
 * answer that hides the screen; the API refuses every write regardless.
 */

export type { CustomizableObjectName, FieldDefinitionView };

export type FieldList = { readonly data: FieldDefinitionView[] };

export const fieldKeys = {
  all: ['fields'] as const,
  forms: (objectType: CustomizableObjectName) => ['fields', 'forms', objectType] as const,
  managed: (objectType: CustomizableObjectName) => ['fields', 'managed', objectType] as const,
};

/** A refusal is an answer; retrying it only delays the screen that explains it. */
function retry(count: number, error: ApiRequestError): boolean {
  return error.status !== 403 && error.status !== 401 && count < 2;
}

/**
 * What a form for this object is drawn from: active definitions this person may read.
 * Changes only when an administrator customises, so it is kept for a few minutes.
 */
export function useFieldDefinitions(objectType: CustomizableObjectName) {
  return useQuery<FieldList, ApiRequestError>({
    queryKey: fieldKeys.forms(objectType),
    queryFn: () => api.get<FieldList>(`/fields?objectType=${objectType}`),
    staleTime: 5 * 60 * 1000,
    retry,
  });
}

/** Everything the administrator manages, including what is switched off. */
export function useManagedFields(objectType: CustomizableObjectName) {
  return useQuery<FieldList, ApiRequestError>({
    queryKey: fieldKeys.managed(objectType),
    queryFn: () => api.get<FieldList>(`/fields?objectType=${objectType}&includeInactive=true`),
    retry,
  });
}

function useAfterChange() {
  const client = useQueryClient();
  // Every record page and dialog of every object may now draw differently.
  return () => client.invalidateQueries({ queryKey: fieldKeys.all });
}

export function useCreateField() {
  const afterChange = useAfterChange();
  return useMutation<ItemEnvelope<FieldDefinitionView>, ApiRequestError, FieldCreateInput>({
    mutationFn: (input) => api.post<ItemEnvelope<FieldDefinitionView>>('/fields', input),
    onSuccess: afterChange,
  });
}

export function useUpdateField() {
  const afterChange = useAfterChange();
  return useMutation<
    ItemEnvelope<FieldDefinitionView>,
    ApiRequestError,
    { id: string; input: FieldUpdateInput }
  >({
    mutationFn: ({ id, input }) =>
      api.patch<ItemEnvelope<FieldDefinitionView>>(`/fields/${id}`, input),
    onSuccess: afterChange,
  });
}

export function useOrderFields() {
  const client = useQueryClient();
  const afterChange = useAfterChange();
  return useMutation<FieldList, ApiRequestError, FieldOrderInput>({
    mutationFn: (input) => api.post<FieldList>('/fields/order', input),
    // Moving a row is a click the person is watching, so the list is put in the new
    // order at once and corrected by the server's answer (or put back on refusal).
    onMutate: async (input) => {
      const key = fieldKeys.managed(input.objectType);
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<FieldList>(key);
      if (previous !== undefined) {
        const system = previous.data.filter((field) => field.isSystem);
        const custom = new Map(previous.data.filter((f) => !f.isSystem).map((f) => [f.id, f]));
        const reordered = input.ids.flatMap((id) => {
          const field = custom.get(id);
          return field === undefined ? [] : [field];
        });
        client.setQueryData<FieldList>(key, { data: [...system, ...reordered] });
      }
      return { previous };
    },
    onError: (_error, input, context) => {
      const previous = (context as { previous?: FieldList } | undefined)?.previous;
      if (previous !== undefined) {
        client.setQueryData(fieldKeys.managed(input.objectType), previous);
      }
    },
    onSettled: afterChange,
  });
}
