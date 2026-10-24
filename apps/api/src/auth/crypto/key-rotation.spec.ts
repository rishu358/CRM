import { createOTP } from '@better-auth/utils/otp';
import { symmetricEncrypt } from 'better-auth/crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { runRotateKeys } from '../../cli/rotate-keys.js';
import { request, startApiHarness, type ApiHarness } from '../../testing/harness.js';
import { MfaService } from '../mfa.service.js';
import { KeyRing, keyId } from './key-ring.js';
import { KeyRotationService } from './key-rotation.service.js';

/**
 * Rotating `AUTH_SECRET` without losing anyone's authenticator (ADR-0049), against a real database
 * and three real applications: one running the old key, one the new key with the old as previous, and
 * one with the new key alone (what is left after the rotation is finished).
 *
 * Every rotation here is limited to the users this file made, because the database is shared with
 * other test files that are using their own rows under the harness's default key.
 */
const OLD = 'old-key-0123456789abcdefghijklmnopqrstuvwxyz';
const NEW = 'new-key-0123456789abcdefghijklmnopqrstuvwxyz';
const LOST = 'lost-key-0123456789abcdefghijklmnopqrstuvwxyz';

let oldApp: ApiHarness;
let bridgeApp: ApiHarness;
let newApp: ApiHarness;
let superuser: pg.Pool;
let tenantId: string;
let roleId: string;

async function totp(secret: string): Promise<string> {
  return createOTP(secret, { digits: 6, period: 30 }).totp();
}

async function enrolled(harness: ApiHarness, label: string) {
  const user = await harness.fixtures.createUser(tenantId, roleId);
  const email = `${label}-${user.userId.slice(-8)}@example.com`;
  const mfa = harness.app.get(MfaService);
  const enrolment = await mfa.begin(user.userId, email);
  await mfa.activate(user.userId, await totp(enrolment.secret));
  return { userId: user.userId, secret: enrolment.secret, backupCodes: enrolment.backupCodes };
}

async function stored(userId: string): Promise<Record<string, string>> {
  const result = await superuser.query<{ type: string; secret: string }>(
    'select type, secret from mfa_factors where user_id = $1 order by type',
    [userId],
  );
  return Object.fromEntries(result.rows.map((row) => [row.type, row.secret]));
}

const rotation = (harness: ApiHarness) => harness.app.get(KeyRotationService, { strict: false });

beforeAll(async () => {
  const urls = inject('dbUrls');
  oldApp = await startApiHarness(urls, { AUTH_SECRET: OLD });
  bridgeApp = await startApiHarness(urls, { AUTH_SECRET: NEW, AUTH_SECRET_PREVIOUS: OLD });
  newApp = await startApiHarness(urls, { AUTH_SECRET: NEW });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  tenantId = (await oldApp.fixtures.createTenant({ name: 'Rotation Traders' })).tenantId;
  roleId = (await oldApp.provision(tenantId)).get('Admin') as string;
}, 240_000);

afterAll(async () => {
  await superuser.end();
  await oldApp.close();
  await bridgeApp.close();
  await newApp.close();
});

describe('what a rotation does not touch', () => {
  it('does not sign anyone out: a session issued under the old key works under a new one', async () => {
    const user = await oldApp.fixtures.createUser(tenantId, roleId);
    const token = await oldApp.signIn(user.userId, tenantId);

    for (const harness of [bridgeApp, newApp]) {
      const response = await request(harness, {
        method: 'GET',
        url: '/api/v1/auth/mfa',
        token,
      });
      expect(response.status).toBe(200);
    }
  });
});

describe('an authenticator enrolled under the old key', () => {
  it('is stored under that key’s id', async () => {
    const user = await enrolled(oldApp, 'format');
    const rows = await stored(user.userId);
    expect(rows['totp']).toMatch(new RegExp(`^k1\\.${keyId(OLD)}\\.[0-9a-f]+$`));
    expect(rows['backup_codes']).toMatch(new RegExp(`^k1\\.${keyId(OLD)}\\.`));
  });

  it('still works when the new key is deployed with the old one as a previous key', async () => {
    const user = await enrolled(oldApp, 'bridge');
    expect(await bridgeApp.app.get(MfaService).verify(user.userId, await totp(user.secret))).toBe(
      true,
    );
    // A backup code too: that list is encrypted the same way.
    expect(
      await bridgeApp.app.get(MfaService).verify(user.userId, user.backupCodes[0] as string),
    ).toBe(true);
  });

  it('cannot be read at all by the new key alone, which is what the previous key is for', async () => {
    const user = await enrolled(oldApp, 'alone');
    await expect(
      newApp.app.get(MfaService).verify(user.userId, await totp(user.secret)),
    ).rejects.toThrow('AUTH_SECRET_PREVIOUS');
  });
});

describe('rotating', () => {
  it('re-encrypts under the new key, so the old one can be removed, and loses nobody', async () => {
    const people = [await enrolled(oldApp, 'r1'), await enrolled(oldApp, 'r2')];
    const userIds = people.map((p) => p.userId);

    const report = await rotation(bridgeApp).rotate({ dryRun: false, userIds });
    expect(report).toMatchObject({
      total: 4, // a secret and a backup-code list each
      current: 0,
      rotated: 4,
      unreadable: 0,
      changedMeanwhile: 0,
      keys: { [keyId(OLD)]: 4 },
    });

    for (const person of people) {
      const rows = await stored(person.userId);
      expect(rows['totp']).toMatch(new RegExp(`^k1\\.${keyId(NEW)}\\.`));
      expect(rows['backup_codes']).toMatch(new RegExp(`^k1\\.${keyId(NEW)}\\.`));
      // Readable by the application that holds only the new key.
      expect(
        await newApp.app.get(MfaService).verify(person.userId, await totp(person.secret)),
      ).toBe(true);
      expect(await newApp.app.get(MfaService).remainingBackupCodes(person.userId)).toBe(
        person.backupCodes.length,
      );
    }
  });

  it('is repeatable: a second pass finds nothing to do', async () => {
    const person = await enrolled(oldApp, 'again');
    await rotation(bridgeApp).rotate({ dryRun: false, userIds: [person.userId] });
    const second = await rotation(bridgeApp).rotate({ dryRun: false, userIds: [person.userId] });
    expect(second).toMatchObject({ total: 2, current: 2, rotated: 0, unreadable: 0 });
  });

  it('changes nothing in a dry run, and says what it would do', async () => {
    const person = await enrolled(oldApp, 'dry');
    const before = await stored(person.userId);
    const report = await rotation(bridgeApp).rotate({ dryRun: true, userIds: [person.userId] });
    expect(report).toMatchObject({ dryRun: true, rotated: 2, unreadable: 0 });
    expect(await stored(person.userId)).toEqual(before);
  });

  it('upgrades a value written before key ids existed, and reports it as legacy', async () => {
    const person = await enrolled(oldApp, 'legacy');
    const legacy = await symmetricEncrypt({ key: OLD, data: person.secret });
    await superuser.query(
      `update mfa_factors set secret = $1 where user_id = $2 and type = 'totp'`,
      [legacy, person.userId],
    );

    const report = await rotation(bridgeApp).rotate({ dryRun: false, userIds: [person.userId] });
    expect(report.keys['legacy']).toBe(1);
    expect(report.rotated).toBe(2);
    expect((await stored(person.userId))['totp']).toMatch(new RegExp(`^k1\\.${keyId(NEW)}\\.`));
    expect(await newApp.app.get(MfaService).verify(person.userId, await totp(person.secret))).toBe(
      true,
    );
  });

  it('leaves a value it cannot read exactly as it was, and says so', async () => {
    const person = await enrolled(oldApp, 'lost');
    const lost = await new KeyRing(LOST).encrypt(person.secret);
    await superuser.query(
      `update mfa_factors set secret = $1 where user_id = $2 and type = 'totp'`,
      [lost, person.userId],
    );

    const report = await rotation(bridgeApp).rotate({ dryRun: false, userIds: [person.userId] });
    expect(report.unreadable).toBe(1);
    expect(report.rotated).toBe(1); // the backup codes, which were readable
    expect((await stored(person.userId))['totp']).toBe(lost);
    expect(report.keys[keyId(LOST)]).toBe(1);
  });

  it('does not overwrite a row that changed between being read and being written', async () => {
    const person = await enrolled(oldApp, 'race');
    const service = rotation(bridgeApp);

    // A request uses a backup code at the moment the command is rewriting that list.
    const ring = bridgeApp.app.get(KeyRing, { strict: false });
    const racing = await ring.encrypt(JSON.stringify({ hashes: [] }));
    const decrypt = ring.decrypt.bind(ring);
    ring.decrypt = async (value: string) => {
      const plain = await decrypt(value);
      await superuser.query(
        `update mfa_factors set secret = $1 where user_id = $2 and type = 'backup_codes'`,
        [racing, person.userId],
      );
      return plain;
    };
    try {
      const report = await service.rotate({ dryRun: false, userIds: [person.userId] });
      expect(report.changedMeanwhile).toBeGreaterThanOrEqual(1);
    } finally {
      ring.decrypt = decrypt;
    }
    // The list the request wrote is the one that stands, not a stale copy of the old one.
    expect((await stored(person.userId))['backup_codes']).toBe(racing);
  });

  it('touches nobody it was not asked about', async () => {
    const bystander = await enrolled(oldApp, 'bystander');
    const before = await stored(bystander.userId);
    const asked = await enrolled(oldApp, 'asked');
    await rotation(bridgeApp).rotate({ dryRun: false, userIds: [asked.userId] });
    expect(await stored(bystander.userId)).toEqual(before);

    const none = await rotation(bridgeApp).rotate({ dryRun: false, userIds: [] });
    expect(none.total).toBe(0);
  });
});

describe('the command', () => {
  async function run(argv: string[], harness: ApiHarness, userIds: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const service = rotation(harness);
    const code = await runRotateKeys({
      argv,
      rotation: () =>
        Promise.resolve({ rotate: (options) => service.rotate({ ...options, userIds }) }),
      currentKeyId: () => harness.app.get(KeyRing, { strict: false }).currentId,
      print: (line) => out.push(line),
      printError: (line) => err.push(line),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('says it is safe to remove the old key only when nothing is left under one', async () => {
    const person = await enrolled(oldApp, 'cmd');

    const dry = await run(['--dry-run'], bridgeApp, [person.userId]);
    expect(dry.code).toBe(1);
    expect(dry.out).toContain('Dry run: nothing changed.');
    expect(dry.out).toContain('would re-encrypt:');
    expect(dry.out).toContain('Keep AUTH_SECRET_PREVIOUS');

    const real = await run([], bridgeApp, [person.userId]);
    expect(real.code).toBe(0);
    expect(real.out).toContain(
      'Nothing is left under an old key. AUTH_SECRET_PREVIOUS can be removed',
    );
  });

  it('exits non-zero, and tells the operator what to add, for what it could not read', async () => {
    const person = await enrolled(oldApp, 'cmd-lost');
    const lost = await new KeyRing(LOST).encrypt(person.secret);
    await superuser.query(
      `update mfa_factors set secret = $1 where user_id = $2 and type = 'totp'`,
      [lost, person.userId],
    );
    const result = await run([], bridgeApp, [person.userId]);
    expect(result.code).toBe(1);
    expect(result.out).toContain('UNREADABLE: 1');
    expect(result.out).toContain('add it there and run again');
    for (const secret of [OLD, NEW, LOST, person.secret]) {
      expect(result.out + result.err).not.toContain(secret);
    }
  });

  it('shows help and refuses an unknown argument, starting nothing', async () => {
    const boot = () => Promise.reject(new Error('must not start the application'));
    const help = await runRotateKeys({
      argv: ['--help'],
      rotation: boot,
      currentKeyId: () => '',
      print: () => undefined,
      printError: () => undefined,
    });
    expect(help).toBe(0);
    const bad = await runRotateKeys({
      argv: ['--everything'],
      rotation: boot,
      currentKeyId: () => '',
      print: () => undefined,
      printError: () => undefined,
    });
    expect(bad).toBe(2);
  });
});

describe('configuration', () => {
  it('refuses to start with a previous key that is too short, or too many, naming the variable only', async () => {
    const urls = inject('dbUrls');
    const short = startApiHarness(urls, { AUTH_SECRET: NEW, AUTH_SECRET_PREVIOUS: 'tooshort' });
    await expect(short).rejects.toThrow('Every key in AUTH_SECRET_PREVIOUS must be at least 32');
    await short.catch((error: unknown) => expect(String(error)).not.toContain('tooshort'));

    const many = [1, 2, 3, 4].map((n) => `previous-${String(n)}-${'x'.repeat(40)}`).join(',');
    await expect(
      startApiHarness(urls, { AUTH_SECRET: NEW, AUTH_SECRET_PREVIOUS: many }),
    ).rejects.toThrow('at most 3 are accepted');
  }, 240_000);

  it('refuses to start when a previous key is the current one', async () => {
    await expect(
      startApiHarness(inject('dbUrls'), { AUTH_SECRET: NEW, AUTH_SECRET_PREVIOUS: NEW }),
    ).rejects.toThrow('must all be different keys');
  }, 240_000);
});
