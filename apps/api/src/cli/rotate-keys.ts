import type { RotationReport } from '../auth/crypto/key-rotation.service.js';

/**
 * The key-rotation command's logic (`pnpm auth:rotate-keys`, ADR-0049), apart from the process it
 * runs in: it takes the rotation service and where to print as parameters, so it is tested against a
 * real database without a terminal.
 *
 * Exit codes: 0 nothing is left under an old key, 1 something is (a second pass, or a missing
 * previous key), 2 the command line was wrong.
 */
export const USAGE = `Re-encrypt stored authenticator secrets under the current AUTH_SECRET.

Usage:
  pnpm auth:rotate-keys [--dry-run]

  --dry-run   Report what would change, and change nothing.
  --help      Show this text.

Run it after deploying a new AUTH_SECRET with the old one in AUTH_SECRET_PREVIOUS. When it reports
that nothing is left under an old key, remove AUTH_SECRET_PREVIOUS and redeploy. Safe to repeat, and
safe while the application is running. See docs/SECRETS.md.
`;

export interface KeyRotationPort {
  rotate(options: { dryRun: boolean }): Promise<RotationReport>;
}

export interface RotateKeysOptions {
  readonly argv: readonly string[];
  /** A function: the application is only started once the command line has been understood. */
  readonly rotation: () => Promise<KeyRotationPort>;
  readonly currentKeyId: () => string;
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
}

export async function runRotateKeys(options: RotateKeysOptions): Promise<number> {
  const unknown = options.argv.find(
    (arg) => arg !== '--dry-run' && arg !== '--help' && arg !== '-h',
  );
  if (unknown !== undefined) {
    options.printError(`Unknown argument: ${unknown}\n\n${USAGE}`);
    return 2;
  }
  if (options.argv.includes('--help') || options.argv.includes('-h')) {
    options.print(USAGE);
    return 0;
  }
  const dryRun = options.argv.includes('--dry-run');

  let report: RotationReport;
  try {
    report = await (await options.rotation()).rotate({ dryRun });
  } catch {
    // Not what the database said: it may carry a connection string.
    options.printError('The command failed unexpectedly. Nothing was reported as changed.');
    return 1;
  }

  options.print(present(report, options.currentKeyId()));

  const leftOver = report.unreadable + report.changedMeanwhile + (dryRun ? report.rotated : 0);
  return leftOver === 0 ? 0 : 1;
}

function present(report: RotationReport, currentId: string): string {
  const keys = Object.entries(report.keys).map(
    ([id, count]) => `    ${id === currentId ? `${id} (current)` : id}: ${String(count)}`,
  );
  const lines = [
    `${report.dryRun ? 'Dry run: nothing changed.' : 'Done.'} Stored authenticator secrets: ${String(report.total)}`,
    ...(keys.length === 0 ? [] : ['  by key:', ...keys]),
    `  already current:   ${String(report.current)}`,
    `  ${report.dryRun ? 'would re-encrypt:' : 're-encrypted:     '} ${String(report.rotated)}`,
  ];
  if (report.changedMeanwhile > 0) {
    lines.push(
      `  changed while running: ${String(report.changedMeanwhile)}  (run it again to pick these up)`,
    );
  }
  if (report.unreadable > 0) {
    lines.push(
      `  UNREADABLE: ${String(report.unreadable)}  (written with a key that is not AUTH_SECRET or in AUTH_SECRET_PREVIOUS; add it there and run again)`,
    );
  }

  const pending =
    report.unreadable + report.changedMeanwhile + (report.dryRun ? report.rotated : 0);
  lines.push(
    pending === 0
      ? report.dryRun
        ? 'Nothing is under an old key. AUTH_SECRET_PREVIOUS can be removed.'
        : 'Nothing is left under an old key. AUTH_SECRET_PREVIOUS can be removed and the application redeployed.'
      : 'Keep AUTH_SECRET_PREVIOUS until this reports nothing left.',
  );
  return lines.join('\n');
}
