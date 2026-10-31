import { clientAddressHeaders } from '../../../../lib/client-address';
import { webEnv } from '../../../../lib/env';
import { submitUnsubscribe } from '../../../../lib/unsubscribe-server';

/**
 * The button on `/u/<token>` posts here (ADR-0076): a plain form post, so it works without scripts.
 *
 * It does what a mail program's own unsubscribe button does, by asking the API, and then sends the person on
 * with a 303: to the "done" page when it worked, back to the question when it did not (the page then says
 * "not valid" for a link that is not, or asks again after a limit). It reads no cookie and sends no credential.
 * The token is the only thing that selects an email, and it is checked by the API.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  const outcome = await submitUnsubscribe({
    apiUrl: webEnv().API_URL,
    token,
    clientAddress: clientAddressHeaders(request.headers),
  });
  const next = `/u/${encodeURIComponent(token)}${outcome === 'done' ? '/done' : ''}`;
  return new Response(null, {
    status: 303,
    headers: { location: next, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
}
