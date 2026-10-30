'use client';

import type {
  EmailContext,
  EmailMessage,
  EmailSettings,
  EmailSettingsUpdateInput,
} from '@crm/contracts';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope, type ListEnvelope } from './api-client';
import { contactKeys, type ContactRecord } from './contacts';
import type { TranslationKey } from './i18n';

/**
 * Server state for email sent from a record (CLAUDE.md §9, ADR-0073).
 *
 * Nothing here decides who may send: a 403 on the list hides the card, a 402 says the feature is off,
 * and the API refuses every write on its own. `sent` means the mail service accepted the message, not
 * that it arrived; the wording on screen says so.
 */

export type { EmailContext, EmailMessage, EmailSettings };

export type EmailSourceType = 'contact' | 'lead' | 'deal';

export const emailKeys = {
  all: ['emails'] as const,
  forRecord: (objectType: string, recordId: string) =>
    ['emails', 'record', objectType, recordId] as const,
  context: (objectType: string, recordId: string, contactId: string | undefined) =>
    ['emails', 'context', objectType, recordId, contactId ?? null] as const,
  settings: ['emails', 'settings'] as const,
};

/** A 402 (feature off) and a 403 (no grant) are answers, not faults: asking again will not change them. */
function retry(count: number, error: ApiRequestError): boolean {
  return error.status !== 402 && error.status !== 403 && error.status !== 401 && count < 2;
}

/** How a failed message is explained, one plain sentence each. The codes come from the API. */
export const FAILURE_TEXT: Readonly<Record<string, TranslationKey>> = {
  rejected: 'email.failure.rejected',
  invalid_recipient: 'email.failure.invalid_recipient',
  provider_unavailable: 'email.failure.provider_unavailable',
  timeout: 'email.failure.timeout',
  outcome_unknown: 'email.failure.outcome_unknown',
  not_configured: 'email.failure.not_configured',
};

export function failureKey(code: string | null): TranslationKey {
  return (code !== null ? FAILURE_TEXT[code] : undefined) ?? 'email.failure.rejected';
}

/**
 * The emails on one record, newest first.
 *
 * While any of them is still queued or being sent the list refreshes every few seconds, then stops:
 * the status the person is waiting for is the one thing worth polling for.
 */
export function useRecordEmails(objectType: EmailSourceType, recordId: string) {
  return useQuery<ListEnvelope<EmailMessage>, ApiRequestError>({
    queryKey: emailKeys.forRecord(objectType, recordId),
    queryFn: () => {
      const params = new URLSearchParams({ objectType, recordId, limit: '25' });
      return api.get<ListEnvelope<EmailMessage>>(`/emails?${params.toString()}`);
    },
    retry,
    refetchInterval: (query) =>
      query.state.data?.data.some(
        (email) => email.status === 'queued' || email.status === 'sending',
      )
        ? 3_000
        : false,
  });
}

/** What the Send dialog needs to know before anything is typed: who it goes to, as whom. */
export function useEmailContext(
  objectType: EmailSourceType,
  recordId: string,
  contactId: string | undefined,
  enabled = true,
) {
  return useQuery<ItemEnvelope<EmailContext>, ApiRequestError>({
    queryKey: emailKeys.context(objectType, recordId, contactId),
    enabled,
    // Today's usage and the record's address change, so a dialog always asks again.
    staleTime: 0,
    gcTime: 0,
    queryFn: () => {
      const params = new URLSearchParams({ objectType, recordId });
      if (contactId !== undefined) params.set('contactId', contactId);
      return api.get<ItemEnvelope<EmailContext>>(`/emails/context?${params.toString()}`);
    },
    retry,
  });
}

export interface SendEmailInput {
  readonly objectType: EmailSourceType;
  readonly recordId: string;
  readonly contactId?: string | undefined;
  readonly subject: string;
  readonly body: string;
  /** One per opened dialog: a double click or a retry after a dropped connection sends once (ADR-0060). */
  readonly idempotencyKey: string;
}

export function useSendEmail() {
  const client = useQueryClient();
  return useMutation<ItemEnvelope<EmailMessage>, ApiRequestError, SendEmailInput>({
    mutationFn: ({ idempotencyKey, ...body }) =>
      api.post<ItemEnvelope<EmailMessage>>('/emails', body, { 'idempotency-key': idempotencyKey }),
    onSuccess: () => client.invalidateQueries({ queryKey: emailKeys.all }),
  });
}

export function useRetryEmail() {
  const client = useQueryClient();
  return useMutation<ItemEnvelope<EmailMessage>, ApiRequestError, string>({
    mutationFn: (id) =>
      api.post<ItemEnvelope<EmailMessage>>(`/emails/${id}/retry`, undefined, {
        'idempotency-key': `retry-${id}`,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: emailKeys.all }),
  });
}

export function useEmailSettings() {
  return useQuery<ItemEnvelope<EmailSettings>, ApiRequestError>({
    queryKey: emailKeys.settings,
    queryFn: () => api.get<ItemEnvelope<EmailSettings>>('/email-settings'),
    retry,
  });
}

export function useSaveEmailSettings() {
  const client = useQueryClient();
  return useMutation<ItemEnvelope<EmailSettings>, ApiRequestError, EmailSettingsUpdateInput>({
    mutationFn: (input) => api.patch<ItemEnvelope<EmailSettings>>('/email-settings', input),
    onSuccess: () => client.invalidateQueries({ queryKey: emailKeys.all }),
  });
}

/** The names of a deal's contacts, for the "write to" choice, through the same cache the record pages use. */
export function useContactNames(ids: readonly string[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: contactKeys.detail(id),
      queryFn: () => api.get<ItemEnvelope<ContactRecord>>(`/contacts/${id}`),
    })),
  });
}
