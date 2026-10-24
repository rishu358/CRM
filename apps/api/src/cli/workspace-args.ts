/**
 * Arguments of the setup command (`pnpm tenant:create`, ADR-0046).
 *
 * Deliberately has no `--password`: a password in an argument ends up in shell history, `ps` output and
 * CI logs. The password is prompted for (hidden), or read from standard input with `--password-stdin`.
 * Nor is it read from an environment variable, which is inherited by every child process.
 */
export const USAGE = `Create a workspace and its owner.

Usage:
  pnpm tenant:create --workspace "Acme Ltd" --owner-email you@example.com --owner-name "Your Name"
  echo "$PASSWORD" | pnpm tenant:create --password-stdin --workspace ... --owner-email ... --owner-name ...

  --workspace <name>      The workspace's name.
  --owner-email <email>   The founding owner's address. It is marked verified.
  --owner-name <name>     The founding owner's name.
  --password-stdin        Read the owner's password from standard input (one line) instead of
                          prompting for it. There is no --password option, on purpose.
  --help                  Show this text.

On a single-tenant installation (DEPLOYMENT_MODE=single_tenant) this creates the one workspace and
refuses if it already exists. On a multi-tenant installation it creates another.
`;

export type ParsedArgs =
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'run';
      readonly workspace: string;
      readonly ownerEmail: string;
      readonly ownerName: string;
      readonly passwordStdin: boolean;
    };

const VALUE_FLAGS = ['--workspace', '--owner-email', '--owner-name'] as const;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  let passwordStdin = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--password-stdin') {
      passwordStdin = true;
    } else if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { kind: 'error', message: `${arg} needs a value` };
      }
      values.set(arg, value);
      index += 1;
    } else if (arg === '--password' || arg.startsWith('--password=')) {
      // Said plainly rather than treated as an unknown flag: someone will try it.
      return {
        kind: 'error',
        message:
          'There is no --password option: a password in an argument ends up in shell history and process listings. Omit it to be prompted, or use --password-stdin.',
      };
    } else {
      return { kind: 'error', message: `Unknown argument: ${arg}` };
    }
  }

  const missing = VALUE_FLAGS.filter((flag) => (values.get(flag) ?? '').trim() === '');
  if (missing.length > 0) return { kind: 'error', message: `Missing ${missing.join(', ')}` };

  return {
    kind: 'run',
    workspace: (values.get('--workspace') as string).trim(),
    ownerEmail: (values.get('--owner-email') as string).trim(),
    ownerName: (values.get('--owner-name') as string).trim(),
    passwordStdin,
  };
}
