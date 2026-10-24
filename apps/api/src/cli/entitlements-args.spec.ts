import { describe, expect, it } from 'vitest';
import { featureListing, parseArgs } from './entitlements-args.js';

describe('the entitlements command line', () => {
  it('shows help when asked, or when given nothing', () => {
    expect(parseArgs([])).toEqual({ kind: 'help' });
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['show', '--help'])).toEqual({ kind: 'help' });
  });

  it('lists features with no other argument', () => {
    expect(parseArgs(['features'])).toEqual({ kind: 'features' });
  });

  it('reads each command with the flags it needs', () => {
    expect(parseArgs(['show', '--workspace', 'acme'])).toEqual({ kind: 'show', workspace: 'acme' });
    expect(parseArgs(['plan', '--workspace', 'acme', '--plan', 'pro'])).toEqual({
      kind: 'plan',
      workspace: 'acme',
      plan: 'pro',
    });
    expect(
      parseArgs(['grant', '--workspace', 'acme', '--feature', 'imports', '--reason', 'a pilot']),
    ).toEqual({
      kind: 'grant',
      workspace: 'acme',
      feature: 'imports',
      reason: 'a pilot',
    });
    expect(
      parseArgs(['revoke', '--workspace', 'acme', '--feature', 'exports', '--reason', 'unpaid']),
    ).toEqual({ kind: 'revoke', workspace: 'acme', feature: 'exports', reason: 'unpaid' });
    expect(parseArgs(['clear', '--workspace', 'acme', '--feature', 'exports'])).toEqual({
      kind: 'clear',
      workspace: 'acme',
      feature: 'exports',
    });
  });

  it('requires a reason for an exception, so nobody makes one nobody can explain', () => {
    for (const command of ['grant', 'revoke']) {
      const parsed = parseArgs([command, '--workspace', 'acme', '--feature', 'exports']);
      expect(parsed).toEqual({ kind: 'error', message: 'Missing --reason' });
    }
    expect(
      parseArgs(['grant', '--workspace', 'acme', '--feature', 'exports', '--reason', '   ']).kind,
    ).toBe('error');
  });

  it('says what is wrong rather than guessing', () => {
    expect(parseArgs(['explode'])).toEqual({ kind: 'error', message: 'Unknown command: explode' });
    expect(parseArgs(['show'])).toEqual({ kind: 'error', message: 'Missing --workspace' });
    expect(parseArgs(['show', '--workspace'])).toEqual({
      kind: 'error',
      message: '--workspace needs a value',
    });
    expect(parseArgs(['show', '--workspace', 'a', '--nope', 'x'])).toEqual({
      kind: 'error',
      message: 'Unknown argument: --nope',
    });
    expect(parseArgs(['show', '--workspace', 'a', '--reason', 'x'])).toEqual({
      kind: 'error',
      message: '--reason is not used by "show"',
    });
  });
});

describe('the feature listing', () => {
  it('names every feature and the plans', () => {
    const text = featureListing();
    expect(text).toContain('imports');
    expect(text).toContain('exports');
    expect(text).toContain('Plans: free, pro, enterprise');
  });
});
