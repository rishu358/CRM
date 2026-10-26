/** Latency and error bookkeeping for the simulation. */

export function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.ceil(fraction * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

export class Metrics {
  constructor() {
    /** action name -> latencies in milliseconds */
    this.latencies = new Map();
    /** "action|status|code" -> count */
    this.outcomes = new Map();
    /** every response with status 429 */
    this.rateLimited = 0;
    this.serverErrors = [];
    this.slow = [];
    this.total = 0;
  }

  record({ action, ms, status, code }) {
    this.total += 1;
    if (!this.latencies.has(action)) this.latencies.set(action, []);
    this.latencies.get(action).push(ms);
    const key = `${action}|${status}|${code ?? ''}`;
    this.outcomes.set(key, (this.outcomes.get(key) ?? 0) + 1);
    if (status === 429) this.rateLimited += 1;
    if (ms > 2000 && this.slow.length < 60) this.slow.push({ action, ms: Math.round(ms), status });
  }

  summary() {
    const rows = [];
    for (const [action, values] of this.latencies) {
      const sorted = [...values].sort((a, b) => a - b);
      rows.push({
        action,
        count: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        over1s: sorted.filter((value) => value > 1000).length,
        max: sorted[sorted.length - 1],
      });
    }
    return rows.sort((a, b) => a.action.localeCompare(b.action));
  }

  /** Error counts by status and code (everything that was not a 2xx). */
  errorCounts() {
    const result = new Map();
    for (const [key, count] of this.outcomes) {
      const [, status, code] = key.split('|');
      if (Number(status) >= 200 && Number(status) < 300) continue;
      const label = `${status} ${code || '(no code)'}`;
      result.set(label, (result.get(label) ?? 0) + count);
    }
    return Object.fromEntries([...result].sort((a, b) => b[1] - a[1]));
  }

  overall() {
    const all = [...this.latencies.values()].flat().sort((a, b) => a - b);
    return {
      count: all.length,
      p50: percentile(all, 0.5),
      p95: percentile(all, 0.95),
      p99: percentile(all, 0.99),
      over1s: all.filter((value) => value > 1000).length,
      over5s: all.filter((value) => value > 5000).length,
    };
  }
}
