'use client';

import type {
  DashboardLeaderboard,
  DashboardLeadsBySource,
  DashboardPipeline,
  DashboardWon,
} from '@crm/contracts';
import { useQuery } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope } from './api-client';
import type { ActivityRecord } from './activities';

/**
 * Server state for the home dashboard (CLAUDE.md §9, MVP_SPEC M10).
 *
 * One query per widget, because the API authorizes one widget at a time: a role
 * that may read leads and not deals gets a working leads card and a "no access"
 * pipeline card, not a blank page. Nothing here decides who sees what — a 403 is
 * the answer, and a `null` inside a 200 means a field is hidden.
 */

export type { DashboardLeaderboard, DashboardLeadsBySource, DashboardPipeline, DashboardWon };

export interface DashboardOverdue {
  /** Null when a field the count is derived from is hidden from this role. */
  readonly count: number | null;
  readonly items: readonly ActivityRecord[];
}

export const dashboardKeys = {
  all: ['dashboard'] as const,
  pipeline: () => ['dashboard', 'pipeline'] as const,
  won: () => ['dashboard', 'won'] as const,
  leads: () => ['dashboard', 'leads-by-source'] as const,
  overdue: () => ['dashboard', 'overdue-tasks'] as const,
  leaderboard: () => ['dashboard', 'leaderboard'] as const,
};

/** A refusal is an answer; retrying it only delays the card that explains it. */
function retry(count: number, error: ApiRequestError): boolean {
  return error.status !== 403 && error.status !== 401 && count < 2;
}

/** Figures change as colleagues work, but not so fast that a minute is stale. */
const STALE_MS = 60 * 1000;

function useWidget<T>(key: readonly string[], path: string) {
  return useQuery<ItemEnvelope<T>, ApiRequestError>({
    queryKey: key,
    queryFn: () => api.get<ItemEnvelope<T>>(path),
    retry,
    staleTime: STALE_MS,
  });
}

export function useDashboardPipeline() {
  return useWidget<DashboardPipeline>(dashboardKeys.pipeline(), '/dashboard/pipeline');
}

export function useDashboardWon() {
  return useWidget<DashboardWon>(dashboardKeys.won(), '/dashboard/won');
}

export function useDashboardLeads() {
  return useWidget<DashboardLeadsBySource>(dashboardKeys.leads(), '/dashboard/leads-by-source');
}

export function useDashboardOverdue() {
  return useWidget<DashboardOverdue>(dashboardKeys.overdue(), '/dashboard/overdue-tasks');
}

export function useDashboardLeaderboard() {
  return useWidget<DashboardLeaderboard>(dashboardKeys.leaderboard(), '/dashboard/leaderboard');
}
