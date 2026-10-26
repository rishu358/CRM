import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_SUBJECT_LENGTH, problemWith } from './check-commit-message.mjs';

describe('commit messages', () => {
  const good = [
    'feat(contacts): add duplicate detection',
    'fix(auth): revoke sessions on password change',
    'docs: record the hardening B decisions',
    'chore(deps)!: drop Node 20',
    'refactor(core/permissions): split the scope resolver',
    'test(search): pin the document cap',
    'feat(security): refuse to start as a role that bypasses RLS\n\nA body is welcome.',
    // Written by git, not by a person:
    'Merge: hardening B — load test, search seam',
    'Merge branch "x" into master',
    'Revert "feat(x): y"',
    'fixup! feat(x): y',
  ];
  for (const message of good) {
    it(`accepts: ${message.split('\n')[0]}`, () => {
      assert.equal(problemWith(message), null);
    });
  }

  const bad = [
    ['', /empty/],
    ['updated stuff', /expected/],
    ['Feat(contacts): capitalised type', /expected/],
    ['feat(Contacts): capitalised scope', /expected/],
    ['feat(contacts) missing colon', /expected/],
    ['feat(contacts):no space after colon', /expected/],
    ['feature(contacts): not a listed type', /expected/],
    ['feat(contacts): ends with a full stop.', /full stop/],
    [`feat: ${'x'.repeat(MAX_SUBJECT_LENGTH)}`, /characters/],
  ];
  for (const [message, reason] of bad) {
    it(`rejects: ${message.slice(0, 40) || '(empty)'}`, () => {
      assert.match(problemWith(message) ?? '', reason);
    });
  }

  it('judges the subject line only, not the body', () => {
    assert.equal(
      problemWith('fix(x): fine\n\nthis body is not "type: summary" shaped at all.'),
      null,
    );
  });
});
