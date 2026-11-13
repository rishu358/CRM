import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The events door stays narrow (ADR-0075, as ADR-0065 3.3 did for the lead form).
 *
 * The step that does a stranger's work runs as `crm_app` inside one company, so the database alone does
 * not make it narrow: the code does, and this keeps it so. It reads the imports of the files a stranger
 * reaches and fails on anything not on the lists below, so widening what the door can touch is a change to
 * these lists, in a diff, with a reviewer, and not an accident of an import that was handy.
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
  'email-events.service.ts': [
    '@nestjs/common',
    '@crm/core',
    '@crm/core/email-reply-address',
    '@crm/outbound',
    '../../common/unsubscribe-secrets.js',
    '../../config/env.js',
    '../../database/database.service.js',
    '../../platform/outbox.service.js',
    './email-events.repository.js',
  ],
  'email-events.controller.ts': [
    '@nestjs/common',
    '@crm/contracts',
    'fastify',
    '../../auth/auth.guard.js',
    '../../common/public-routes.js',
    '../../common/zod-validation.pipe.js',
    './email-events.service.js',
  ],
  'email-events.repository.ts': ['@nestjs/common', '@crm/db'],
};

describe('what the events door may import', () => {
  for (const [file, allowed] of Object.entries(ALLOWED)) {
    it(`${file} reaches only what is on the list, and every entry is used`, () => {
      const imports = importsOf(file);
      expect(imports.filter((name) => !allowed.includes(name))).toEqual([]);
      // A stale allowance is a door left open for nothing.
      expect(allowed.filter((name) => !imports.includes(name))).toEqual([]);
    });
  }

  it('the controller reaches the service and nothing below it', () => {
    const imports = importsOf('email-events.controller.ts');
    expect(imports).not.toContain('./email-events.repository.js');
    expect(imports).not.toContain('../../database/database.service.js');
  });

  it('touches no other module’s repository, service or table', () => {
    const everything = ['email-events.service.ts', 'email-events.repository.ts']
      .map((file) => codeOf(file))
      .join('\n');
    expect(everything).not.toMatch(/modules\/(?!email-events)/);
    for (const table of [
      'contacts',
      'accounts',
      'deals',
      'leads',
      'activities',
      'memberships',
      'users',
    ]) {
      expect(everything, table).not.toMatch(
        new RegExp(`from\\(${table}\\)|into ${table}\\b|from ${table}\\b`),
      );
    }
    // The only table it writes is its own record of what it received, and the only one it reads for routing.
    expect(everything).toContain('email_messages');
    expect(everything).toContain('emailProviderEvents');
  });

  it('uses the unscoped database entry point twice, for the two routing reads, and never an actor', () => {
    const service = codeOf('email-events.service.ts');
    // One finds a company from the provider's id for an email we sent, the other from a reply address.
    expect(service.match(/runAsAuth\(/g)).toHaveLength(2);
    expect(service).not.toMatch(/\bActor\b/);
    expect(service).not.toMatch(/\bfetch\s*\(/);
  });

  it('marks exactly one handler public, by itself, and reads no cookie or credential', () => {
    const text = read('email-events.controller.ts');
    expect(text.match(/^\s+@Public\(\)\s*$/gm)).toHaveLength(1);
    expect(text).not.toMatch(/^@Public/m);
    expect(codeOf('email-events.controller.ts')).not.toMatch(/cookies|x-tenant-id|authorization/i);
    expect(codeOf('email-events.service.ts')).not.toMatch(/cookies|x-tenant-id|authorization/i);
  });

  it('reads one column as the routing role for a reply, and checks the address before it reads anything', () => {
    const repository = codeOf('email-events.repository.ts');
    const start = repository.indexOf('async routeEmailId');
    const end = repository.indexOf('async insertProviderEvent');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const routing = repository.slice(start, end);
    expect(routing).toContain('select m.tenant_id');
    for (const column of [
      'reply_token',
      'unsubscribe_token',
      'to_address',
      'from_address',
      'subject',
      'body_text',
    ]) {
      expect(routing, column).not.toContain(column);
    }

    const service = codeOf('email-events.service.ts');
    const reply = service.slice(service.indexOf('private async receiveReply'));
    expect(reply.indexOf('verifyReplyToken(')).toBeGreaterThan(-1);
    expect(reply.indexOf('verifyReplyToken(')).toBeLessThan(reply.indexOf('runAsAuth('));
  });

  it('never fetches or stores a message: the door only records that one arrived', () => {
    const everything = ['email-events.service.ts', 'email-events.repository.ts']
      .map((file) => codeOf(file))
      .join('\n');
    expect(everything).not.toMatch(/insert\(emailMessages\)|into email_messages/);
    expect(everything).not.toMatch(/retrieve\(|InboundEmailProvider/);
  });
});
