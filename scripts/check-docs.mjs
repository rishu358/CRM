#!/usr/bin/env node
/**
 * Checks that the documentation still points at things that exist (ADR-0052).
 *
 * Two kinds of drift make a handover document wrong without anyone noticing:
 *
 *   1. a link to a file, or to a heading in a file, that has since been renamed or removed;
 *   2. a `pnpm` command that no longer exists, because a script was renamed.
 *
 * Both are checked in every tracked Markdown file. Zero dependencies, like the other repository
 * scripts. The checks are pure functions of the file texts and the scripts that exist, so the tests
 * run them without touching the disk.
 *
 *   node scripts/check-docs.mjs          check every tracked .md file; exit 1 and list what is wrong
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** pnpm's own commands: valid to quote whether or not the repository defines a script of that name. */
export const PNPM_BUILTINS = new Set([
  'add',
  'audit',
  'config',
  'dlx',
  'exec',
  'i',
  'install',
  'list',
  'ls',
  'outdated',
  'remove',
  'rm',
  'run',
  'setup', // pnpm's own `setup`, which the docs mention in order to say it is not ours
  'store',
  'up',
  'update',
  'why',
]);

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function slugOf(heading) {
  return heading
    .replace(/[`*~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** The anchors a document defines, with GitHub's `-1`, `-2` suffixes for repeated headings. */
export function anchorsOf(text) {
  const seen = new Map();
  const anchors = new Set();
  for (const line of withoutFences(text).split('\n')) {
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (match === null) continue;
    const base = slugOf(match[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${String(count)}`);
  }
  return anchors;
}

/** The text with fenced code blocks blanked, so a link-looking string in an example is not checked. */
function withoutFences(text) {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
    })
    .join('\n');
}

/** Inline-code spans and fenced blocks: where a quoted command is meant to be taken literally. */
function codeParts(text) {
  const parts = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) parts.push(line);
    else for (const span of line.matchAll(/`([^`]+)`/g)) parts.push(span[1]);
  }
  return parts;
}

/**
 * @typedef {object} DocsWorld
 * @property {string[]} files                      Repository-relative paths of the Markdown files.
 * @property {(path: string) => string} read
 * @property {(path: string) => boolean} exists    A file or a directory.
 * @property {Set<string>} rootScripts
 * @property {Map<string, Set<string>>} packageScripts   Workspace package name to its scripts.
 */

/** @param {DocsWorld} world @returns {string[]} one line per problem */
export function checkDocs(world) {
  const problems = [];
  const anchorCache = new Map();
  const anchorsFor = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(world.read(file)));
    return anchorCache.get(file);
  };

  for (const file of world.files) {
    const text = world.read(file);

    // ---- links ----------------------------------------------------------------------------------
    for (const match of withoutFences(text).matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue; // http:, https:, mailto:, ...
      const [rawPath, anchor] = target.split('#');
      const path = rawPath ?? '';
      const resolved =
        path === ''
          ? file
          : posix.normalize(
              path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(file), path),
            );

      if (path !== '' && !world.exists(resolved.replace(/\/+$/, ''))) {
        problems.push(`${file}: the link "${target}" points at ${resolved}, which does not exist`);
        continue;
      }
      if (
        anchor !== undefined &&
        anchor !== '' &&
        /\.md$/.test(resolved) &&
        world.exists(resolved)
      ) {
        if (!world.files.includes(resolved)) continue; // untracked or generated: not checked
        if (!anchorsFor(resolved).has(decodeURIComponent(anchor).toLowerCase())) {
          problems.push(
            `${file}: the link "${target}" points at a heading that is not in ${resolved}`,
          );
        }
      }
    }

    // ---- commands -------------------------------------------------------------------------------
    for (const part of codeParts(text)) {
      for (const command of part.matchAll(/(?:^|[\s(;&|])pnpm((?:\s+[^\s`;&|)]+)+)/g)) {
        const problem = problemWithPnpm(command[1].trim().split(/\s+/), world);
        if (problem !== null) problems.push(`${file}: "pnpm ${command[1].trim()}": ${problem}`);
      }
    }
  }
  return problems;
}

/** @param {string[]} words what follows `pnpm` @param {DocsWorld} world */
function problemWithPnpm(words, world) {
  let filter = null;
  let index = 0;
  while (index < words.length && words[index].startsWith('-')) {
    if (words[index] === '--filter' || words[index] === '-F') {
      filter = words[index + 1] ?? null;
      index += 2;
    } else if (words[index].startsWith('--filter=')) {
      filter = words[index].slice('--filter='.length);
      index += 1;
    } else {
      index += 1;
    }
  }
  let name = words[index];
  if (name === undefined || !/^[a-z][\w:.-]*$/.test(name)) return null; // prose, a flag, a placeholder
  if (name === 'run') {
    name = words[index + 1];
    if (name === undefined || !/^[a-z][\w:.-]*$/.test(name)) return null;
  } else if (PNPM_BUILTINS.has(name)) {
    return null;
  }

  if (filter !== null) {
    const scripts = world.packageScripts.get(filter);
    if (scripts === undefined) return `no workspace package is named ${filter}`;
    return scripts.has(name) || PNPM_BUILTINS.has(name)
      ? null
      : `${filter} has no script "${name}"`;
  }
  return world.rootScripts.has(name)
    ? null
    : `there is no script "${name}" in the root package.json`;
}

// ---- the real world ----------------------------------------------------------------------------

function trackedMarkdown(root) {
  try {
    // Tracked files and new ones not yet added, but not ignored ones: a document is checked from the
    // moment it is written, not from the moment it is committed.
    const out = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
      { cwd: root, encoding: 'utf8' },
    );
    return out.split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

function workspaceScripts(root) {
  const map = new Map();
  for (const group of ['apps', 'packages']) {
    const base = resolve(root, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const file = resolve(base, name, 'package.json');
      if (!existsSync(file)) continue;
      const json = JSON.parse(readFileSync(file, 'utf8'));
      map.set(json.name, new Set(Object.keys(json.scripts ?? {})));
    }
  }
  return map;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const rootJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const files = trackedMarkdown(root);
  if (files.length === 0) {
    console.error('check-docs: found no tracked Markdown files; is this a git checkout?');
    process.exit(1);
  }
  const problems = checkDocs({
    files,
    read: (path) => readFileSync(resolve(root, path), 'utf8'),
    exists: (path) => existsSync(resolve(root, path)),
    rootScripts: new Set(Object.keys(rootJson.scripts ?? {})),
    packageScripts: workspaceScripts(root),
  });
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(
      `\ncheck-docs: ${String(problems.length)} problem(s) in ${String(files.length)} files`,
    );
    process.exit(1);
  }
  console.log(
    `check-docs: ${String(files.length)} Markdown files, every link and pnpm command resolves`,
  );
}
