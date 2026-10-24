import { signUpSchema } from '@crm/contracts';
import { DomainError } from '@crm/core';
import { parseArgs, USAGE } from './workspace-args.js';

/**
 * The setup command's logic (`pnpm tenant:create`, ADR-0046), apart from the process it runs in.
 *
 * It creates a workspace and its founding owner through the same service the sign-up form uses, so
 * there is one way a workspace comes into being. It takes everything it needs as parameters (the
 * service, how to get the password, where to print), so it is tested against a real database
 * without a terminal, and the entry point (`create-workspace-main.ts`) only wires it to the real
 * ones.
 *
 * Exit codes: 0 created, 1 refused or failed, 2 the command line was wrong.
 */
export interface WorkspaceCreator {
  createWorkspaceForOperator(input: {
    email: string;
    name: string;
    password: string;
    workspaceName: string;
  }): Promise<{ tenantId: string; userId: string }>;
}

export interface CreateWorkspaceOptions {
  readonly argv: readonly string[];
  readonly auth: WorkspaceCreator;
  /** Where the owner signs in afterwards. A function: it is only known once the application is up. */
  readonly webUrl: () => string;
  /** Ask for the password: prompt twice, or read standard input. Null means the person aborted. */
  readonly password: (fromStdin: boolean) => Promise<string | null>;
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
}

export async function runCreateWorkspace(options: CreateWorkspaceOptions): Promise<number> {
  const args = parseArgs(options.argv);
  if (args.kind === 'help') {
    options.print(USAGE);
    return 0;
  }
  if (args.kind === 'error') {
    options.printError(`${args.message}\n\n${USAGE}`);
    return 2;
  }

  const password = await options.password(args.passwordStdin);
  if (password === null) {
    options.printError('Cancelled. Nothing was created.');
    return 1;
  }

  // The sign-up form's own rules for every field, so the owner can sign in the way anyone does.
  // Only messages are printed: a rejected password is never repeated.
  const checked = signUpSchema.safeParse({
    email: args.ownerEmail,
    password,
    name: args.ownerName,
    companyName: args.workspace,
  });
  if (!checked.success) {
    for (const issue of checked.error.issues) {
      options.printError(`${issue.path.join('.') || 'input'}: ${issue.message}`);
    }
    return 1;
  }

  try {
    const { tenantId } = await options.auth.createWorkspaceForOperator({
      email: checked.data.email,
      name: checked.data.name,
      password: checked.data.password,
      workspaceName: checked.data.companyName ?? args.workspace,
    });
    options.print(`Created workspace "${args.workspace}" (${tenantId}).`);
    options.print(`Owner: ${checked.data.email}`);
    options.print(`Sign in at ${options.webUrl()}/sign-in`);
    return 0;
  } catch (error) {
    // A refusal the operator can act on says what it is; anything else says only that it failed,
    // because an unexpected error's text can quote a connection string.
    if (error instanceof DomainError) {
      options.printError(error.message);
    } else {
      options.printError('Could not create the workspace. See the API logs for the cause.');
    }
    return 1;
  }
}
