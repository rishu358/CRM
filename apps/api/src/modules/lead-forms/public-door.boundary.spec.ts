import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The public door stays narrow (ADR-0063 3.3).
 *
 * The step that does a stranger's work runs as `crm_app` inside one workspace, so the database alone
 * does not make it narrow: the code does, and this keeps it so. It reads the imports of the two files
 * a stranger reaches and fails on anything that is not on the list below, so widening what the public
 * door can touch is a change to this list, in a diff, with a reviewer, and not an accident of an
 * import that was handy.
 */

const HERE = __dirname;

function importsOf(file: string): string[] {
  const text = readFileSync(join(HERE, file), 'utf8');
  return [...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gms)].map(
    (match) => match[1] ?? '',
  );
}

const ALLOWED_SERVICE_IMPORTS: readonly string[] = [
  '@nestjs/common',
  'node:crypto',
  '@crm/core',
  '@crm/core/lead-form-token',
  '@crm/contracts',
  '@crm/db',
  '../../config/env.js',
  '../../common/db-errors.js',
  '../../common/request-context.js',
  '../../database/database.service.js',
  '../../platform/audit.service.js',
  '../../platform/entitlements.service.js',
  '../../platform/field-metadata.service.js',
  '../../platform/outbox.service.js',
  '../../platform/rate-limit/counter.js',
  '../leads/leads.service.js',
  './lead-assigner.js',
  './lead-forms.repository.js',
];

const ALLOWED_CONTROLLER_IMPORTS: readonly string[] = [
  '@nestjs/common',
  '@crm/contracts',
  '@crm/core',
  'fastify',
  '../../auth/auth.guard.js',
  '../../common/idempotency.js',
  '../../common/zod-validation.pipe.js',
  './public-lead-forms.service.js',
];

describe('what the public door may import', () => {
  it('the service reaches only the services and helpers on the list', () => {
    const imports = importsOf('public-lead-forms.service.ts');
    expect(imports.filter((name) => !ALLOWED_SERVICE_IMPORTS.includes(name))).toEqual([]);
    // Every entry is used: a stale allowance is a door left open for nothing.
    expect(ALLOWED_SERVICE_IMPORTS.filter((name) => !imports.includes(name))).toEqual([]);
  });

  it('the controller reaches the service and nothing below it', () => {
    const imports = importsOf('public-lead-forms.controller.ts');
    expect(imports.filter((name) => !ALLOWED_CONTROLLER_IMPORTS.includes(name))).toEqual([]);
    expect(imports).not.toContain('./lead-forms.repository.js');
    expect(imports).not.toContain('../../database/database.service.js');
  });

  it('touches no other module’s repository or table', () => {
    const text = readFileSync(join(HERE, 'public-lead-forms.service.ts'), 'utf8');
    for (const table of ['contacts', 'accounts', 'deals', 'activities', 'memberships', 'users']) {
      expect(text, table).not.toMatch(new RegExp(`from\\(${table}\\)|into ${table}\\b`));
    }
  });

  it('uses the unscoped database entry point once, for the routing read, and nowhere else', () => {
    const text = readFileSync(join(HERE, 'public-lead-forms.service.ts'), 'utf8');
    expect(text.match(/runAsAuth\(/g)).toHaveLength(1);
    // And never an actor: a stranger has none, and a made-up one would be the worst way to have one.
    expect(text).not.toMatch(/\bActor\b/);
  });

  it('marks exactly two handlers public, one by one, and never the controller as a whole', () => {
    const text = readFileSync(join(HERE, 'public-lead-forms.controller.ts'), 'utf8');
    expect(text.match(/@Public\(\)/g)).toHaveLength(2);
    expect(text).not.toMatch(/^@Public/m);
    // No cookie and no credential is read.
    expect(text).not.toMatch(/cookies|authorization|x-tenant-id/i);
  });
});
