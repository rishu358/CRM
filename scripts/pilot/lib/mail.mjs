import { readFileSync, statSync } from 'node:fs';

import { sleep } from './http.mjs';

/**
 * The API prints outgoing mail to its own log (EMAIL_PROVIDER=console), so the invitation link a
 * person would click in their inbox is read from that log. Needs --mail-log pointing at it.
 */

export function logSize(logPath) {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

/** Looks only at what was written after `fromOffset`, so an older message is never mistaken for the new one. */
export async function findInvitationToken(logPath, email, { fromOffset = 0, waitMs = 10000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let text = '';
    try {
      text = readFileSync(logPath).subarray(fromOffset).toString('utf8');
    } catch {
      // The log may not exist yet.
    }
    // The log is pretty-printed over several lines; the link sits a few lines after "-> address".
    const marker = text.lastIndexOf(`-> ${email}`);
    const match =
      marker === -1 ? null : text.slice(marker).match(/accept-invite\?token=([A-Za-z0-9._~-]+)/);
    if (match) return match[1];
    if (Date.now() > deadline) return null;
    await sleep(300);
  }
}
