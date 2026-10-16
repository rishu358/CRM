'use client';

/**
 * Session cookie operations, called by the sign-in screen.
 *
 * Lives in the data layer rather than in the component for the same reason the
 * contacts queries do: components describe what they need, not how it is
 * fetched (CLAUDE.md §9).
 */
export async function startSession(token: string): Promise<boolean> {
  const response = await globalThis.fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return response.ok;
}

export async function endSession(): Promise<void> {
  await globalThis.fetch('/api/session', { method: 'DELETE' });
}
