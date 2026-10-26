import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Everything the simulation notices that a person should read: defects, friction and good news.
 * Each has a stable id, so the same problem seen a hundred times is one finding with a count.
 */

export const SEVERITIES = ['high', 'medium', 'low', 'info', 'good'];

export class Findings {
  constructor() {
    this.items = new Map();
    /** check id -> how many times it was made and held */
    this.passes = new Map();
  }

  /** Note that a check was made and held. */
  pass(id, times = 1) {
    this.passes.set(id, (this.passes.get(id) ?? 0) + times);
  }

  /**
   * @param {{ id: string, severity: 'high'|'medium'|'low'|'info'|'good', title: string, detail?: string, where?: string, kind?: 'defect'|'friction'|'security'|'gap'|'observation' }} finding
   */
  add(finding) {
    const existing = this.items.get(finding.id);
    if (existing) {
      existing.count += 1;
      if (existing.examples.length < 3 && finding.detail) existing.examples.push(finding.detail);
      return existing;
    }
    const stored = { ...finding, count: 1, examples: finding.detail ? [finding.detail] : [] };
    this.items.set(finding.id, stored);
    return stored;
  }

  list() {
    return [...this.items.values()].sort(
      (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
    );
  }

  /** A check that must hold. Records a finding (with the supplied severity) when it does not. */
  expect(condition, finding) {
    if (condition) this.pass(finding.id);
    else this.add(finding);
    return Boolean(condition);
  }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
