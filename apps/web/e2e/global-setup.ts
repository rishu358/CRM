import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Seed a demo tenant and capture the session tokens it prints.
 *
 * Reading them from the seed's output rather than minting them here keeps the
 * tests honest: they sign in with exactly what a developer following the README
 * would use, so a change that breaks that path breaks the suite too.
 */
export default function globalSetup(): void {
  // Both streams: the seed reports through console.warn, which is stderr, so
  // reading stdout alone would silently find nothing.
  const result = spawnSync('pnpm', ['db:seed'], {
    cwd: join(process.cwd(), '..', '..'),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    throw new Error(`Seeding failed:
${result.stdout ?? ''}${result.stderr ?? ''}`);
  }

  const output = `${result.stdout ?? ''}
${result.stderr ?? ''}`;

  const tokens: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = /^\s{2}(Owner|Sales rep)\s+(\S+)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      tokens[match[1] === 'Owner' ? 'owner' : 'rep'] = match[2];
    }
  }

  if (tokens['owner'] === undefined || tokens['rep'] === undefined) {
    throw new Error(`Could not read session tokens from the seed output:\n${output}`);
  }

  writeFileSync(join(process.cwd(), 'e2e', '.tokens.json'), JSON.stringify(tokens), 'utf8');
}
