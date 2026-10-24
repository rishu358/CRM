/**
 * Writes the files generated from the registry, or checks that they are current (ADR-0044).
 *
 *   pnpm config:docs     write them
 *   pnpm config:check    fail (exit 1) if any committed file differs from what the registry produces
 *
 * Run from the repository root through tsx. Markdown goes through the repository's own Prettier
 * configuration so the output passes `pnpm format:check` unchanged.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { renderConfigurationMd, renderEnvExample } from '../src/docs.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

interface Target {
  readonly path: string;
  readonly render: () => Promise<string>;
}

async function markdown(path: string, text: string): Promise<string> {
  const options = (await resolveConfig(root + path)) ?? {};
  return format(text, { ...options, filepath: root + path });
}

const TARGETS: readonly Target[] = [
  { path: '.env.example', render: async () => renderEnvExample('local') },
  { path: 'deploy/staging.env.example', render: async () => renderEnvExample('staging') },
  { path: 'deploy/production.env.example', render: async () => renderEnvExample('production') },
  {
    path: 'docs/CONFIGURATION.md',
    render: () => markdown('docs/CONFIGURATION.md', renderConfigurationMd()),
  },
];

async function current(path: string): Promise<string | undefined> {
  try {
    return await readFile(root + path, 'utf8');
  } catch {
    return undefined;
  }
}

const check = process.argv.includes('--check');
const stale: string[] = [];

for (const target of TARGETS) {
  const wanted = await target.render();
  // Compare without line-ending noise: a Windows checkout may have CRLF.
  const existing = (await current(target.path))?.replace(/\r\n/g, '\n');
  if (existing === wanted) continue;
  if (check) {
    stale.push(target.path);
  } else {
    await writeFile(root + target.path, wanted, 'utf8');
    console.warn(`wrote ${target.path}`);
  }
}

if (check) {
  if (stale.length > 0) {
    console.error(
      `Generated configuration files are stale: ${stale.join(', ')}.\nRun \`pnpm config:docs\` and commit the result.`,
    );
    process.exit(1);
  }
  console.warn('Generated configuration files are current.');
}
