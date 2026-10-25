import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { nodeIsRecent, parseArgs, runSetup } from './setup.mjs';

/**
 * The setup command (ADR-0051), with every outside effect replaced: a fake filesystem, a fake command
 * runner, a fixed "random". Nothing here touches Docker, a database or the real .env.
 */
const ROOT = '/repo';
/** The key a path has in the fake filesystem: what `resolve` makes of it, with forward slashes (Windows too). */
const at = (name) => resolve(ROOT, name).replaceAll('\\', '/');
const EXAMPLE = [
  '# example',
  'NODE_ENV=development',
  'APP_ENV=local',
  'AUTH_SECRET=dev-only-insecure-secret-replace-me-with-48-random-bytes',
  'EMAIL_PROVIDER=console',
  '',
].join('\n');

function world({
  files = {},
  failing = [],
  nodeVersion = '24.11.1',
  secret = 'A'.repeat(48),
} = {}) {
  const fs = new Map(Object.entries({ [at('.env.example')]: EXAMPLE, ...files }));
  const ran = [];
  const out = [];
  const err = [];
  const writes = [];
  const deps = (argv = []) => ({
    argv,
    root: ROOT,
    nodeVersion,
    exists: (path) => fs.has(path.replaceAll('\\', '/')),
    read: (path) => fs.get(path.replaceAll('\\', '/')),
    write: (path, text) => {
      const key = path.replaceAll('\\', '/');
      writes.push(key);
      fs.set(key, text);
    },
    run: (command, args) => {
      const line = [command, ...args].join(' ');
      ran.push(line);
      return Promise.resolve(failing.includes(line) ? 1 : 0);
    },
    random: (bytes) => Buffer.from(secret.slice(0, bytes).padEnd(bytes, 'x')),
    print: (line) => out.push(line),
    printError: (line) => err.push(line),
  });
  return { fs, ran, out, err, writes, deps };
}

const ENV = at('.env');

describe('the Node check', () => {
  it('accepts 24.7 and later, and refuses earlier', () => {
    for (const ok of ['24.7.0', '24.11.1', '25.0.0', '26.1.2'])
      assert.equal(nodeIsRecent(ok), true, ok);
    for (const bad of ['24.6.9', '24.0.0', '22.12.0', '20.0.0', '23.99.0']) {
      assert.equal(nodeIsRecent(bad), false, bad);
    }
  });
});

describe('the command line', () => {
  it('reads every flag and refuses the rest', () => {
    assert.deepEqual(parseArgs([]), { kind: 'run', check: false, seed: 'auto', build: true });
    assert.deepEqual(parseArgs(['--check', '--no-seed', '--no-build']), {
      kind: 'run',
      check: true,
      seed: 'no',
      build: false,
    });
    assert.equal(parseArgs(['--seed']).seed, 'yes');
    assert.equal(parseArgs(['--help']).kind, 'help');
    assert.equal(parseArgs(['--force']).kind, 'error');
  });

  it('exits 2 on a bad flag and starts nothing', async () => {
    const w = world();
    assert.equal(await runSetup(w.deps(['--force'])), 2);
    assert.deepEqual(w.ran, []);
    assert.deepEqual(w.writes, []);
  });
});

describe('the first run', () => {
  it('creates .env with a generated secret, starts the services, migrates, seeds and builds, in order', async () => {
    const w = world();
    assert.equal(await runSetup(w.deps()), 0);

    const env = w.fs.get(ENV);
    assert.match(env, /^AUTH_SECRET=[A-Za-z0-9+/=]{20,}$/m);
    assert.doesNotMatch(env, /dev-only-insecure/);
    // The rest of the file is carried over untouched.
    assert.match(env, /^APP_ENV=local$/m);
    assert.match(env, /^EMAIL_PROVIDER=console$/m);

    assert.deepEqual(w.ran.slice(2), [
      'pnpm infra:up',
      'pnpm db:migrate',
      'pnpm db:seed',
      'pnpm build',
    ]);
    assert.match(w.out.join('\n'), /Ready\. Start it with:\s+pnpm dev/);
    assert.match(w.out.join('\n'), /inbox\s+http:\/\/localhost:18025/);
  });

  it('never prints the secret it generated', async () => {
    const secret = 'Zq9-unique-marker-secret-value-0123456789abcdefABCDEF';
    const w = world({ secret });
    await runSetup(w.deps());
    const generated = Buffer.from(secret.slice(0, 48)).toString('base64');
    assert.ok(w.fs.get(ENV).includes(generated), 'the secret is in .env');
    for (const line of [...w.out, ...w.err]) {
      assert.ok(!line.includes(generated), 'a line printed the secret');
      assert.ok(!line.includes(secret.slice(0, 20)), 'a line printed part of the secret');
    }
  });

  it('writes a secret that differs each run when the source of randomness does', async () => {
    const a = world({ secret: 'a'.repeat(48) });
    const b = world({ secret: 'b'.repeat(48) });
    await runSetup(a.deps(['--no-build']));
    await runSetup(b.deps(['--no-build']));
    assert.notEqual(a.fs.get(ENV), b.fs.get(ENV));
  });

  it('keeps a "$" in the secret literal rather than reading it as a replacement pattern', async () => {
    const w = world({ secret: '$&$1$$' });
    await runSetup(w.deps(['--no-build']));
    const line = w.fs
      .get(ENV)
      .split('\n')
      .find((l) => l.startsWith('AUTH_SECRET='));
    assert.equal(line, `AUTH_SECRET=${Buffer.from('$&$1$$'.padEnd(48, 'x')).toString('base64')}`);
  });
});

describe('a later run', () => {
  const existing = {
    [ENV]: `${EXAMPLE.replace('dev-only-insecure-secret-replace-me-with-48-random-bytes', 'already-generated-secret')}`,
  };

  it('leaves .env exactly as it is and does not seed another demo workspace', async () => {
    const w = world({ files: existing });
    const before = w.fs.get(ENV);
    assert.equal(await runSetup(w.deps()), 0);
    assert.equal(w.fs.get(ENV), before);
    assert.deepEqual(w.writes, []);
    assert.ok(!w.ran.includes('pnpm db:seed'));
    assert.ok(w.ran.includes('pnpm db:migrate'), 'migrations are safe to repeat');
    assert.match(w.out.join('\n'), /not the first run/);
  });

  it('seeds again only when asked', async () => {
    const w = world({ files: existing });
    await runSetup(w.deps(['--seed']));
    assert.ok(w.ran.includes('pnpm db:seed'));
  });

  it('says so, and changes nothing, when .env still has the development secret', async () => {
    const w = world({ files: { [ENV]: EXAMPLE } });
    await runSetup(w.deps(['--no-build']));
    // Replacing it would make enrolled authenticators unreadable: it is a warning, not an edit.
    assert.equal(w.fs.get(ENV), EXAMPLE);
    assert.match(
      w.out.join('\n'),
      /warning\s+AUTH_SECRET in \.env is still the development placeholder/,
    );
  });
});

describe('flags', () => {
  it('--no-seed and --no-build skip those steps and say so', async () => {
    const w = world();
    await runSetup(w.deps(['--no-seed', '--no-build']));
    assert.ok(!w.ran.includes('pnpm db:seed'));
    assert.ok(!w.ran.includes('pnpm build'));
    assert.match(w.out.join('\n'), /skipped\s+demo workspace \(--no-seed\)/);
    assert.match(w.out.join('\n'), /skipped\s+build \(--no-build\)/);
  });
});

describe('--minimal', () => {
  it('seeds one empty workspace instead of the demo company, even on a later run', async () => {
    const w = world({
      files: { [ENV]: EXAMPLE.replace('dev-only-insecure', 'already-generated') },
    });
    assert.equal(await runSetup(w.deps(['--minimal', '--no-build'])), 0);
    assert.ok(w.ran.includes('pnpm db:seed --minimal'));
    assert.ok(!w.ran.includes('pnpm db:seed'));
  });

  it('on a first run, seeds the minimal workspace and only that', async () => {
    const w = world();
    await runSetup(w.deps(['--minimal', '--no-build']));
    const seeds = w.ran.filter((line) => line.startsWith('pnpm db:seed'));
    assert.deepEqual(seeds, ['pnpm db:seed --minimal']);
  });

  it('is offered in the usage text and parsed as its own mode', () => {
    assert.equal(parseArgs(['--minimal']).seed, 'minimal');
  });
});

describe('--check', () => {
  it('changes nothing and starts nothing, and says when .env is missing', async () => {
    const w = world();
    assert.equal(await runSetup(w.deps(['--check'])), 1);
    assert.deepEqual(w.writes, []);
    assert.ok(!w.ran.some((line) => line.startsWith('pnpm infra') || line.startsWith('pnpm db')));
    assert.match(w.err.join('\n'), /\.env does not exist yet/);
  });

  it('passes on a machine that is ready', async () => {
    const w = world({
      files: {
        [ENV]: EXAMPLE.replace(
          'dev-only-insecure-secret-replace-me-with-48-random-bytes',
          'x'.repeat(40),
        ),
      },
    });
    assert.equal(await runSetup(w.deps(['--check'])), 0);
    assert.match(w.out.join('\n'), /Nothing to fix/);
  });
});

describe('what stops it, and what it says', () => {
  it('names the old Node, and starts nothing', async () => {
    const w = world({ nodeVersion: '22.12.0' });
    assert.equal(await runSetup(w.deps()), 1);
    assert.match(w.err.join('\n'), /Node 22\.12\.0 is too old: Node 24\.7\.0 or later is required/);
    assert.deepEqual(w.writes, []);
    assert.ok(!w.ran.includes('pnpm infra:up'));
  });

  it('names a missing pnpm and a Docker that is not running, together', async () => {
    const w = world({ failing: ['pnpm --version', 'docker info'] });
    assert.equal(await runSetup(w.deps()), 1);
    const text = w.err.join('\n');
    assert.match(text, /pnpm was not found/);
    assert.match(text, /Docker is not reachable/);
    assert.deepEqual(w.writes, []);
  });

  it('refuses a checkout with no .env.example, writing nothing', async () => {
    const w = world();
    w.fs.delete(at('.env.example'));
    assert.equal(await runSetup(w.deps()), 1);
    assert.match(w.err.join('\n'), /\.env\.example is missing/);
    assert.deepEqual(w.writes, []);
  });

  it('stops at the first failing step, names it, and does not go on', async () => {
    const w = world({ failing: ['pnpm db:migrate'] });
    assert.equal(await runSetup(w.deps()), 1);
    assert.match(w.err.join('\n'), /"pnpm db:migrate" failed \(exit 1\)/);
    assert.match(w.err.join('\n'), /safe to repeat/);
    assert.ok(!w.ran.includes('pnpm db:seed'));
    assert.ok(!w.ran.includes('pnpm build'));
  });

  it('does not write .env if .env.example has no placeholder to replace', async () => {
    const w = world({
      files: {
        [at('.env.example')]: 'NODE_ENV=development\nAUTH_SECRET=already-a-real-looking-value\n',
      },
    });
    assert.equal(await runSetup(w.deps()), 1);
    assert.deepEqual(w.writes, []);
    assert.match(w.err.join('\n'), /no AUTH_SECRET placeholder/);
  });
});
