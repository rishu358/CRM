import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anchorsOf, checkDocs, slugOf } from './check-docs.mjs';

/**
 * The docs checker (ADR-0052), against a fake repository: it must catch the two kinds of drift it exists
 * for, and must not cry wolf at things that are not links or commands.
 */
function world(
  files,
  { scripts = ['dev', 'build', 'tenant:create', 'run:thing'], packages = {} } = {},
) {
  const texts = new Map(Object.entries(files));
  return {
    files: [...texts.keys()].filter((name) => name.endsWith('.md')),
    read: (path) => texts.get(path) ?? '',
    exists: (path) =>
      texts.has(path) || [...texts.keys()].some((name) => name.startsWith(`${path}/`)),
    rootScripts: new Set(scripts),
    packageScripts: new Map(Object.entries(packages).map(([name, list]) => [name, new Set(list)])),
  };
}

const check = (files, options) => checkDocs(world(files, options));

describe('headings and anchors', () => {
  it('slugs a heading the way GitHub does', () => {
    assert.equal(
      slugOf('Rotating `AUTH_SECRET`: with no one losing it'),
      'rotating-auth_secret-with-no-one-losing-it',
    );
    assert.equal(
      slugOf('9.4 Bootstrap, and the one connection'),
      '94-bootstrap-and-the-one-connection',
    );
    assert.equal(slugOf('A [link](x.md) in a heading'), 'a-link-in-a-heading');
  });

  it('numbers repeated headings and ignores headings inside code fences', () => {
    const anchors = anchorsOf('# Setup\n\n## Notes\n\n## Notes\n\n```\n# not a heading\n```\n');
    assert.deepEqual([...anchors].sort(), ['notes', 'notes-1', 'setup']);
  });
});

describe('links', () => {
  it('accepts a link to a file, a directory, a heading and the same page', () => {
    const problems = check({
      'README.md': '[a](docs/A.md) [b](docs/) [c](docs/A.md#second-part) [d](#top)\n\n# Top\n',
      'docs/A.md': '# A\n\n## Second part\n',
    });
    assert.deepEqual(problems, []);
  });

  it('resolves a link relative to the file that holds it, and a leading slash from the root', () => {
    const problems = check({
      'docs/B.md': '[up](../README.md) [sibling](A.md) [root](/README.md)\n',
      'docs/A.md': '# A\n',
      'README.md': '# R\n',
    });
    assert.deepEqual(problems, []);
  });

  it('catches a link to a file that is not there', () => {
    const problems = check({ 'README.md': 'See [the guide](docs/GONE.md).\n' });
    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /README\.md: the link "docs\/GONE\.md" points at docs\/GONE\.md, which does not exist/,
    );
  });

  it('catches a link to a heading that is not in the file', () => {
    const problems = check({
      'README.md': '[x](docs/A.md#missing) [y](#nowhere)\n\n# Top\n',
      'docs/A.md': '# A\n',
    });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /heading that is not in docs\/A\.md/);
    assert.match(problems[1], /heading that is not in README\.md/);
  });

  it('checks an image like any other link', () => {
    const problems = check({ 'README.md': '![shot](docs/shot.png)\n' });
    assert.match(problems[0] ?? '', /docs\/shot\.png, which does not exist/);
  });

  it('ignores web addresses, mail addresses and a link-looking string in a code fence', () => {
    const problems = check({
      'README.md':
        '[w](https://example.com/x) [m](mailto:a@example.com) [p](//example.com)\n\n```md\n[gone](docs/GONE.md)\n```\n',
    });
    assert.deepEqual(problems, []);
  });
});

describe('pnpm commands', () => {
  it('accepts a script that exists, with or without run', () => {
    assert.deepEqual(
      check({
        'README.md': 'Use `pnpm dev`, `pnpm run build` and `pnpm tenant:create --workspace x`.\n',
      }),
      [],
    );
  });

  it('accepts pnpm’s own commands, whether or not there is a script of that name', () => {
    assert.deepEqual(
      check({
        'README.md': '`pnpm install` then `pnpm exec prettier --check .` and `pnpm audit`\n',
      }),
      [],
    );
  });

  it('catches a script that does not exist, in inline code and in a fenced block', () => {
    const problems = check({
      'README.md': 'Run `pnpm vanished`.\n\n```bash\npnpm also-gone --flag\n```\n',
    });
    assert.equal(problems.length, 2);
    assert.match(
      problems[0],
      /"pnpm vanished": there is no script "vanished" in the root package\.json/,
    );
    assert.match(problems[1], /"pnpm also-gone --flag"/);
  });

  it('catches `pnpm run <missing>`', () => {
    const problems = check({ 'README.md': '`pnpm run nothing`\n' });
    assert.match(problems[0] ?? '', /no script "nothing"/);
  });

  it('checks a --filter command against that package’s scripts', () => {
    const options = { packages: { '@crm/api': ['perf:run'], '@crm/db': ['perf:seed'] } };
    assert.deepEqual(
      check(
        {
          'README.md':
            '`pnpm --filter @crm/api perf:run -- --x` and `pnpm --filter @crm/db perf:seed`\n',
        },
        options,
      ),
      [],
    );
    const wrong = check(
      { 'README.md': '`pnpm --filter @crm/api perf:seed` and `pnpm --filter @crm/nope dev`\n' },
      options,
    );
    assert.equal(wrong.length, 2);
    assert.match(wrong[0], /@crm\/api has no script "perf:seed"/);
    assert.match(wrong[1], /no workspace package is named @crm\/nope/);
  });

  it('does not mistake prose or a version for a command, and ignores pnpm outside code', () => {
    assert.deepEqual(
      check({
        'README.md': 'Requires pnpm 9 and `pnpm 9`. Plain pnpm vanished in prose is not code.\n',
      }),
      [],
    );
  });

  it('finds a command after a pipe, a semicolon or a parenthesis', () => {
    const problems = check({ 'README.md': '`echo x | pnpm gone1; pnpm gone2` (`(pnpm gone3)`)\n' });
    assert.equal(problems.length, 3);
  });
});
