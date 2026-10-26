import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate this package's root directory from a module inside it.
 *
 * Walking up to a known landmark rather than counting `..` segments, because
 * the depth differs between the TypeScript sources and the compiled output in
 * `dist` — and counting wrong fails only at runtime, in whichever of the two
 * nobody tried.
 */
export function packageRootFrom(moduleUrl: string): string {
  let directory = dirname(fileURLToPath(moduleUrl));

  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(directory, 'migrations')) && existsSync(join(directory, 'sql'))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error('Could not locate the @crm/db package root from ' + moduleUrl);
}
