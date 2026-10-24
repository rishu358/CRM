import { describe, expect, it } from 'vitest';
import { parseArgs } from './workspace-args.js';

const FULL = [
  '--workspace',
  'Acme Ltd',
  '--owner-email',
  'owner@acme.example',
  '--owner-name',
  'A. Owner',
];

describe('the setup command line', () => {
  it('reads the three required values', () => {
    expect(parseArgs(FULL)).toEqual({
      kind: 'run',
      workspace: 'Acme Ltd',
      ownerEmail: 'owner@acme.example',
      ownerName: 'A. Owner',
      passwordStdin: false,
    });
  });

  it('knows --password-stdin, wherever it is', () => {
    expect(parseArgs(['--password-stdin', ...FULL])).toMatchObject({
      kind: 'run',
      passwordStdin: true,
    });
    expect(parseArgs([...FULL, '--password-stdin'])).toMatchObject({
      kind: 'run',
      passwordStdin: true,
    });
  });

  it('shows help and ignores the rest', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs([...FULL, '-h'])).toEqual({ kind: 'help' });
  });

  it('refuses a missing value, naming it', () => {
    const result = parseArgs(['--workspace', 'Acme', '--owner-email', 'a@b.example']);
    expect(result).toMatchObject({ kind: 'error' });
    expect(result.kind === 'error' ? result.message : '').toContain('--owner-name');
  });

  it('refuses a flag with no value rather than swallowing the next flag as its value', () => {
    const result = parseArgs(['--workspace', '--owner-email', 'a@b.example', '--owner-name', 'x']);
    expect(result).toEqual({ kind: 'error', message: '--workspace needs a value' });
  });

  it('refuses an unknown argument', () => {
    expect(parseArgs([...FULL, '--force'])).toEqual({
      kind: 'error',
      message: 'Unknown argument: --force',
    });
  });

  it.each([['--password', 'hunter2'], ['--password=hunter2']])(
    'refuses a password on the command line, and says why, without repeating it (%s)',
    (...extra) => {
      const result = parseArgs([...FULL, ...extra]);
      expect(result.kind).toBe('error');
      const message = result.kind === 'error' ? result.message : '';
      expect(message).toContain('There is no --password option');
      expect(message).toContain('--password-stdin');
      expect(message).not.toContain('hunter2');
    },
  );

  it('trims the values', () => {
    expect(
      parseArgs([
        '--workspace',
        '  Acme  ',
        '--owner-email',
        ' a@b.example ',
        '--owner-name',
        ' X ',
      ]),
    ).toMatchObject({ workspace: 'Acme', ownerEmail: 'a@b.example', ownerName: 'X' });
  });

  it('treats a blank value as missing', () => {
    expect(
      parseArgs(['--workspace', '   ', '--owner-email', 'a@b.example', '--owner-name', 'X']).kind,
    ).toBe('error');
  });
});
