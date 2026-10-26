#!/usr/bin/env node
// Conventional-commit check with no dependencies (CLAUDE.md §11.3, CONTRIBUTING.md).
//
//   node scripts/check-commit-message.mjs --file .git/COMMIT_EDITMSG   (the commit-msg hook)
//   node scripts/check-commit-message.mjs --range origin/master..HEAD  (CI, over a branch)
//   node scripts/check-commit-message.mjs --message "feat(x): y"       (by hand)
//
// Exit 0 if every message conforms, 1 with the offending subject and the rule otherwise.
// The rules are exported so the tests (and anything else) share exactly one definition.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

export const MAX_SUBJECT_LENGTH = 100;

const CONVENTIONAL = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S.*$`);

/** Why a commit message is not acceptable, or null if it is. */
export function problemWith(message) {
  const subject = message.split(/\r?\n/, 1)[0] ?? '';

  // Merges, reverts and fixup commits are written by git, not by a person.
  if (/^Merge( |:)/.test(subject) || /^Revert "/.test(subject)) return null;
  if (/^(fixup|squash)! /.test(subject)) return null;

  if (subject.trim() === '') return 'the subject line is empty';
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return `the subject is ${String(subject.length)} characters; keep it to ${String(MAX_SUBJECT_LENGTH)}`;
  }
  if (!CONVENTIONAL.test(subject)) {
    return `expected "<type>(<scope>): <summary>" with type one of ${TYPES.join(', ')}`;
  }
  if (subject.endsWith('.')) return 'the subject should not end with a full stop';
  return null;
}

function messagesInRange(range) {
  // %x00 separates commits so a body containing anything cannot be mistaken for a boundary.
  let out;
  try {
    out = execFileSync('git', ['log', '--format=%H%x1f%B%x00', range], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Most often a base ref that was not fetched (CI needs `fetch-depth: 0`).
    console.error(`[commit] cannot read the range "${range}"; is the base branch fetched?`);
    process.exit(2);
  }
  return out
    .split('\0')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [sha = '', ...rest] = entry.split('\x1f');
      return { sha: sha.slice(0, 8), message: rest.join('\x1f') };
    });
}

function main(argv) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  let items;
  if (flag('--file') !== undefined) {
    items = [{ sha: 'commit', message: readFileSync(flag('--file'), 'utf8') }];
  } else if (flag('--message') !== undefined) {
    items = [{ sha: 'message', message: flag('--message') }];
  } else if (flag('--range') !== undefined) {
    items = messagesInRange(flag('--range'));
  } else {
    console.error(
      'usage: check-commit-message.mjs --file <path> | --range <a..b> | --message <text>',
    );
    return 2;
  }

  let failures = 0;
  for (const { sha, message } of items) {
    const problem = problemWith(message);
    if (problem !== null) {
      failures += 1;
      console.error(
        `[commit] ${sha}: ${problem}\n         > ${message.split(/\r?\n/, 1)[0] ?? ''}`,
      );
    }
  }
  if (failures > 0) {
    console.error(
      `\n${String(failures)} commit message(s) do not follow Conventional Commits (CONTRIBUTING.md).`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
