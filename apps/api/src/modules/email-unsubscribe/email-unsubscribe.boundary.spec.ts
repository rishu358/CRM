import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The unsubscribe door stays narrow (ADR-0076, as ADR-0065 3.3 did for the lead form and ADR-0075 for the events
 * door).
 *
 * The step that does a stranger's work runs as `crm_app` inside one company, so the database alone does not make
 * it narrow: the code does, and this keeps it so. It reads the imports of the files a stranger reaches and fails
 * on anything not on the lists below, so widening what the door can touch is a change to these lists, in a diff,
 * with a reviewer, and not an accident of an import that was handy.
 */

const HERE = __dirname;

function read(file: string): string {
  return readFileSync(join(HERE, file), 'utf8');
}

function importsOf(file: string): string[] {
  return [...read(file).matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gms)].map(
    (match) => match[1] ?? '',
  );
}

/** The code with comments removed, so a word in a comment is not mistaken for a use. */
function codeOf(file: string): string {
  return read(file)
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
}

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'email-unsubscribe.service.ts': [
    '@nestjs/common',
    '@crm/core',
    '@crm/core/email-unsubscribe-token',
    '@crm/contracts',
    '../../common/unsubscribe-secrets.js',
    '../../config/env.js',
    '../../database/database.service.js',
    '../../platform/outbox.service.js',
    '../../platform/rate-limit/counter.js',
    './email-unsubscribe.repository.js',
  ],
  'email-unsubscribe.controller.ts': [
    '@nestjs/common',
    '@crm/contracts',
    'fastify',
    '../../auth/auth.guard.js',
    '../../common/zod-validation.pipe.js',
    './email-unsubscribe.service.js',
  ],
  'email-unsubscribe.repository.ts': ['@nestjs/common', '@crm/db'],
};

describe('what the unsubscribe door may import', () => {
  for (const [file, allowed] of Object.entries(ALLOWED)) {
    it(`${file} reaches only what is on the list, and every entry is used`, () => {
      const imports = importsOf(file);
      expect(imports.filter((name) => !allowed.includes(name))).toEqual([]);
      // A stale allowance is a door left open for nothing.
      expect(allowed.filter((name) => !imports.includes(name))).toEqual([]);
    });
  }

  it('the controller reaches the service and nothing below it', () => {
    const imports = importsOf('email-unsubscribe.controller.ts');
    expect(imports).not.toContain('./email-unsubscribe.repository.js');
    expect(imports).not.toContain('../../database/database.service.js');
  });

  it('touches no other module’s repository, service or table', () => {
    const everything = ['email-unsubscribe.service.ts', 'email-unsubscribe.repository.ts']
      .map((file) => codeOf(file))
      .join('\n');
    expect(everything).not.toMatch(/modules\/(?!email-unsubscribe)/);
    for (const table of [
      'contacts',
      'accounts',
      'deals',
      'leads',
      'activities',
      'memberships',
      'users',
      'email_suppressions',
      'emailSuppressions',
    ]) {
      expect(everything, table).not.toMatch(
        new RegExp(`from\\(${table}\\)|into ${table}\\b|from ${table}\\b|update ${table}\\b`),
      );
    }
    // The only tables it writes or reads are its own record of what it received and the email itself.
    expect(everything).toContain('email_messages');
    expect(everything).toContain('emailProviderEvents');
  });

  it('reads nothing but a company id as the routing role: the token, the address and the words stay out of reach', () => {
    const repository = codeOf('email-unsubscribe.repository.ts');
    const start = repository.indexOf('async routeEmailId');
    const end = repository.indexOf('async senderNameOf');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const routing = repository.slice(start, end);
    expect(routing).toContain('select m.tenant_id');
    for (const column of [
      'unsubscribe_token',
      'to_address',
      'subject',
      'body_text',
      'from_name',
      'reply_to',
    ]) {
      expect(routing, column).not.toContain(column);
    }
  });

  it('uses the unscoped database entry point once, for the routing read, and never an actor', () => {
    const service = codeOf('email-unsubscribe.service.ts');
    expect(service.match(/runAsAuth\(/g)).toHaveLength(1);
    expect(service).not.toMatch(/\bActor\b/);
    expect(service).not.toMatch(/\bfetch\s*\(/);
  });

  it('checks the signature before it touches the database', () => {
    const service = codeOf('email-unsubscribe.service.ts');
    const resolve = service.slice(service.indexOf('private async resolve'));
    expect(resolve.indexOf('verifyUnsubscribeToken(')).toBeGreaterThan(-1);
    expect(resolve.indexOf('verifyUnsubscribeToken(')).toBeLessThan(resolve.indexOf('runAsAuth('));
  });

  it('marks exactly two handlers public, each by itself, and reads no cookie or credential', () => {
    const text = read('email-unsubscribe.controller.ts');
    expect(text.match(/^\s+@Public\(\)\s*$/gm)).toHaveLength(2);
    expect(text).not.toMatch(/^@Public/m);
    expect(codeOf('email-unsubscribe.controller.ts')).not.toMatch(
      /cookies|x-tenant-id|authorization/i,
    );
    expect(codeOf('email-unsubscribe.service.ts')).not.toMatch(
      /cookies|x-tenant-id|authorization/i,
    );
  });

  it('the GET handler writes nothing: only the POST handler reaches the service’s write', () => {
    const controller = codeOf('email-unsubscribe.controller.ts');
    const get = controller.slice(controller.indexOf('@Get('), controller.indexOf('@Post('));
    expect(get).toContain('this.unsubscribes.page(');
    expect(get).not.toContain('this.unsubscribes.unsubscribe(');
    const service = codeOf('email-unsubscribe.service.ts');
    const page = service.slice(
      service.indexOf('async page('),
      service.indexOf('async unsubscribe('),
    );
    expect(page).not.toMatch(/insertEvent|publish\(|runInTenant\(/);
  });
});
