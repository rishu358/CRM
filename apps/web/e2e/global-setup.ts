import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Seed a demo tenant and capture the credentials it prints.
 *
 * Reading them from the seed's output rather than minting them here keeps the
 * tests honest: they sign in with exactly what a developer following the
 * README would use, so a change that breaks that path breaks the suite too.
 *
 * Credentials, not session tokens: the suite signs in through the real form
 * against the real API (MVP_SPEC M1). The previous version pasted a token the
 * seed had minted, which proved the app could carry a session but nothing
 * about how one is obtained.
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

  const credentials: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = /^\s{2}(Owner|Sales rep|MFA demo|Password)\s+(\S+)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const key = {
        Owner: 'owner',
        'Sales rep': 'rep',
        'MFA demo': 'mfaUser',
        Password: 'password',
      }[match[1]];
      if (key !== undefined) credentials[key] = match[2];
    }
  }

  for (const key of ['owner', 'rep', 'mfaUser', 'password']) {
    if (credentials[key] === undefined) {
      throw new Error(`Could not read ${key} from the seed output:\n${output}`);
    }
  }

  writeFileSync(
    join(process.cwd(), 'e2e', '.credentials.json'),
    JSON.stringify(credentials),
    'utf8',
  );
}
