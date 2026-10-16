'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiRequestError } from '../lib/api-client';

/**
 * Server state lives in TanStack Query (CLAUDE.md §9).
 *
 * Created inside a `useState` initialiser so each browser session gets exactly
 * one client, and so a server render never shares a cache between requests —
 * which would leak one tenant's data into another's page.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Fresh enough that moving between screens feels instant, short
            // enough that a colleague's edit shows up without a hard reload.
            staleTime: 30_000,
            refetchOnWindowFocus: true,
            retry: (failureCount, error) => {
              // Retrying an authorization failure cannot succeed, and retrying
              // a validation error just repeats the same rejection.
              if (error instanceof ApiRequestError && error.status < 500) return false;
              return failureCount < 2;
            },
          },
          mutations: { retry: false },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
