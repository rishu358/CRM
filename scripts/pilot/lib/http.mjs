import { totp } from './totp.mjs';

/**
 * One person's browser, as far as the API can tell: a cookie jar holding the session cookie, and a
 * stopwatch around every request. It never throws on an HTTP error (a 409 is an answer, not a crash):
 * it returns the status and body and records the outcome for the report.
 */

export class Api {
  /**
   * @param {{ baseUrl: string, metrics: import('./stats.mjs').Metrics, who: string, issues?: object[] }} options
   */
  constructor({ baseUrl, metrics, who, issues = [] }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.metrics = metrics;
    this.who = who;
    this.issues = issues;
    this.cookie = null;
    this.userId = null;
    this.tenantId = null;
  }

  /**
   * @param {string} action a short name for the report ("contact.create")
   * @param {string} method
   * @param {string} path begins with a slash, without /api/v1
   * @param {{ body?: unknown, query?: Record<string, string | number | undefined | string[]>, raw?: boolean, headers?: Record<string,string> }} [options]
   */
  async call(action, method, path, options = {}) {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, item));
      else url.searchParams.set(key, String(value));
    }
    const headers = { accept: 'application/json', ...(options.headers ?? {}) };
    if (this.cookie) headers.cookie = `crm_session=${this.cookie}`;
    let body;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const started = performance.now();
    let response;
    let text = '';
    try {
      response = await fetch(url, { method, headers, body, redirect: 'manual' });
      text = await response.text();
    } catch (error) {
      const ms = performance.now() - started;
      this.metrics.record({ action, ms, status: 0, code: 'NETWORK' });
      this.metrics.serverErrors.push({
        who: this.who,
        action,
        method,
        path,
        status: 0,
        message: String(error?.cause?.code ?? error?.message ?? error),
      });
      return { status: 0, ok: false, body: null, ms, requestId: null, headers: new Headers() };
    }
    const ms = performance.now() - started;

    let parsed = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 500) };
      }
    }
    const code = parsed?.error?.code ?? null;
    const requestId = response.headers.get('x-request-id');
    this.metrics.record({ action, ms, status: response.status, code });
    if (response.status >= 500) {
      this.metrics.serverErrors.push({
        who: this.who,
        action,
        method,
        path,
        status: response.status,
        code,
        requestId,
      });
    }
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      body: parsed,
      data: parsed?.data,
      meta: parsed?.meta,
      code,
      ms,
      requestId,
      headers: response.headers,
    };
  }

  get(action, path, query) {
    return this.call(action, 'GET', path, { query });
  }
  post(action, path, body, extra = {}) {
    return this.call(action, 'POST', path, { body: body ?? {}, ...extra });
  }
  patch(action, path, body) {
    return this.call(action, 'PATCH', path, { body });
  }
  delete(action, path, query) {
    return this.call(action, 'DELETE', path, { query });
  }

  /**
   * Sign in the way the sign-in page does: password first, then the one-time code if asked.
   * @returns {Promise<{ ok: boolean, status: string, detail?: object }>}
   */
  async signIn(email, password, { totpSecret } = {}) {
    const first = await this.post('auth.sign-in', '/auth/sign-in', { email, password });
    if (!first.ok)
      return { ok: false, status: `HTTP ${first.status} ${first.code ?? ''}`, detail: first.body };
    let result = first.data;
    if (result.status === 'mfa_required') {
      if (!totpSecret) return { ok: false, status: 'mfa_required but no secret known' };
      const second = await this.post('auth.mfa-verify', '/auth/mfa/verify', {
        challengeToken: result.challengeToken,
        code: totp(totpSecret),
      });
      if (!second.ok)
        return {
          ok: false,
          status: `MFA HTTP ${second.status} ${second.code ?? ''}`,
          detail: second.body,
        };
      result = second.data;
    }
    this.cookie = result.token ?? null;
    this.tenantId = result.tenantId ?? null;
    const me = await this.get('auth.me', '/auth/me');
    this.userId = me.data?.id ?? null;
    return { ok: this.cookie !== null, status: 'signed_in', me: me.data };
  }

  /** Follow a paged list to the end (or to `max` rows). */
  async listAll(action, path, query = {}, max = 5000) {
    const rows = [];
    let cursor;
    for (;;) {
      const page = await this.get(action, path, { ...query, limit: 100, cursor });
      if (!page.ok) return { ok: false, rows, last: page };
      rows.push(...page.data);
      if (!page.meta?.hasMore || rows.length >= max) return { ok: true, rows, last: page };
      cursor = page.meta.nextCursor;
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
