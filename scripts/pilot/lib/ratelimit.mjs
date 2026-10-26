import { SHARED_PASSWORD } from '../data/businesses.mjs';
import { Api } from './http.mjs';
import { Metrics } from './stats.mjs';

/**
 * With the DEFAULT rate limits (a second API instance started without the raised limits): how quickly
 * does one person, and one office address, run into a 429? Reports the request number of the first refusal
 * and the Retry-After the client is told.
 */
export async function rateLimitProbe(baseUrl, member) {
  const result = {};
  const metrics = new Metrics();
  const api = new Api({ baseUrl, metrics, who: 'rate probe' });
  const first = await api.signIn(member.email, SHARED_PASSWORD, { totpSecret: member.totpSecret });
  if (!first.ok) return { error: `sign-in failed: ${first.status}` };

  // One person, one request after another, as fast as the laptop answers.
  const started = Date.now();
  let hit = null;
  for (let index = 1; index <= 600; index += 1) {
    const response = await api.get('rate.my-day', '/my-day');
    if (response.status === 429) {
      hit = {
        request: index,
        afterMs: Date.now() - started,
        retryAfter: response.headers.get('retry-after'),
        code: response.code,
        message: response.body?.error?.message,
      };
      break;
    }
  }
  result.perUser = hit ?? { request: null, note: 'no 429 in 600 requests' };

  // Sign-ins from one address (an office behind one router).
  let signInHit = null;
  for (let index = 1; index <= 80; index += 1) {
    const anonymous = new Api({ baseUrl, metrics, who: 'rate probe sign-in' });
    const response = await anonymous.post('rate.sign-in', '/auth/sign-in', {
      email: member.email,
      password: SHARED_PASSWORD,
    });
    if (response.status === 429) {
      signInHit = {
        request: index,
        retryAfter: response.headers.get('retry-after'),
        code: response.code,
        message: response.body?.error?.message,
      };
      break;
    }
  }
  result.signIn = signInHit ?? { request: null, note: 'no 429 in 80 sign-ins' };
  return result;
}
