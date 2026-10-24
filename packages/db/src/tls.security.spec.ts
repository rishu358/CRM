import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { createDbClient } from './client.js';
import { runMigrations } from './migrator.js';
import { parseCaCert, poolConnectionConfig } from './tls.js';

/**
 * Verified TLS to a database whose certificate is signed by a private CA (ADR-0042).
 *
 * This is DigitalOcean's situation, reproduced: a real Postgres with `ssl=on`, a server certificate
 * signed by a CA that Node does not trust, and the name `localhost` and address `127.0.0.1` in the
 * certificate. node-postgres reads `sslmode=require` as full verification, so without the CA nothing
 * connects; with it, everything connects *and* a wrong CA or a wrong host still fails. The last two
 * are the point: a "fix" that merely made connections succeed would pass the first three.
 */
const DIR = '/var/lib/postgresql';

/** Two unrelated CAs (the server's, and a stranger's), a server certificate, then Postgres with TLS. */
const START_SCRIPT = `
set -e
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Test Provider CA" -keyout ${DIR}/ca.key -out ${DIR}/ca.crt
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Somebody Else" -keyout ${DIR}/other.key -out ${DIR}/other.crt
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout ${DIR}/server.key -out ${DIR}/server.csr
printf "subjectAltName=DNS:localhost,IP:127.0.0.1\\n" > ${DIR}/san.ext
openssl x509 -req -in ${DIR}/server.csr -CA ${DIR}/ca.crt -CAkey ${DIR}/ca.key -CAcreateserial -days 2 -extfile ${DIR}/san.ext -out ${DIR}/server.crt
chown postgres:postgres ${DIR}/server.key ${DIR}/server.crt
chmod 600 ${DIR}/server.key
exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=${DIR}/server.crt -c ssl_key_file=${DIR}/server.key
`;

let container: StartedTestContainer;
let port: number;
let providerCa: string;
let strangerCa: string;

const urlFor = (host: string, query = 'sslmode=require') =>
  `postgres://postgres:tls-test-pw@${host}:${String(port)}/postgres?${query}`;

async function cat(path: string): Promise<string> {
  const result = await container.exec(['cat', path]);
  if (result.exitCode !== 0) throw new Error(`could not read ${path} from the test container`);
  return result.output;
}

/** Connect the way the application does, and report whether the session really is encrypted. */
async function connect(url: string, caCert?: string): Promise<boolean> {
  const client = createDbClient({ connectionString: url, caCert, connectionTimeoutMillis: 10_000 });
  try {
    const { rows } = await client.pool.query<{ ssl: boolean }>(
      'select ssl from pg_stat_ssl where pid = pg_backend_pid()',
    );
    return rows[0]?.ssl === true;
  } finally {
    await client.close();
  }
}

/** The error a connection attempt dies with: its code and message, for matching, never its URL. */
async function failure(url: string, caCert?: string): Promise<string> {
  try {
    await connect(url, caCert);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    return `${code} ${error instanceof Error ? error.message : String(error)}`;
  }
  throw new Error('the connection succeeded, and was expected to fail');
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16.6')
    .withEnvironment({ POSTGRES_PASSWORD: 'tls-test-pw' })
    .withExposedPorts(5432)
    .withEntrypoint(['bash', '-c', START_SCRIPT])
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
    .withStartupTimeout(120_000)
    .start();
  port = container.getMappedPort(5432);
  providerCa = await cat(`${DIR}/ca.crt`);
  strangerCa = await cat(`${DIR}/other.crt`);
}, 180_000);

afterAll(async () => {
  await container.stop();
});

describe('a private CA, accepted explicitly', () => {
  it('connects, verified and encrypted, when given the provider CA', async () => {
    await expect(connect(urlFor('127.0.0.1'), providerCa)).resolves.toBe(true);
  });

  it('accepts the CA as base64, the form an env file and a platform editor can carry', async () => {
    const base64 = Buffer.from(providerCa, 'utf8').toString('base64');
    expect(base64).not.toContain('\n');
    await expect(connect(urlFor('127.0.0.1'), base64)).resolves.toBe(true);
  });

  it('accepts the CA with literal backslash-n for its newlines', async () => {
    await expect(
      connect(urlFor('127.0.0.1'), providerCa.trim().replace(/\n/g, '\\n')),
    ).resolves.toBe(true);
  });

  it('is not defeated by a leftover sslmode in the URL, which would replace the CA', async () => {
    for (const mode of ['require', 'verify-full', 'verify-ca', 'prefer']) {
      await expect(connect(urlFor('127.0.0.1', `sslmode=${mode}`), providerCa)).resolves.toBe(true);
    }
  });

  it('also carries the migrations runner, which opens its own connection', async () => {
    // An empty directory: the point is that the runner connects, verified, and creates its table.
    const dir = await mkdtemp(join(tmpdir(), 'tls-migrations-'));
    await expect(runMigrations(urlFor('127.0.0.1'), dir, providerCa)).resolves.toMatchObject({
      applied: [],
    });
    await expect(runMigrations(urlFor('127.0.0.1'), dir)).rejects.toThrow(
      /unable to verify|self.signed/i,
    );
  });
});

describe('verification stays on', () => {
  it('refuses the private CA when none is configured: the problem this exists to solve', async () => {
    expect(await failure(urlFor('127.0.0.1'))).toMatch(/UNABLE_TO_VERIFY|SELF_SIGNED/i);
  });

  it("refuses a CA that did not sign the server's certificate", async () => {
    expect(await failure(urlFor('127.0.0.1'), strangerCa)).toMatch(/UNABLE_TO_VERIFY|SELF_SIGNED/i);
  });

  it('refuses a host the certificate does not name, even with the right CA', async () => {
    // 127.0.0.2 reaches the same published port but is not in the certificate's names.
    expect(await failure(urlFor('127.0.0.2'), providerCa)).toMatch(/ERR_TLS_CERT_ALTNAME_INVALID/);
  });
});

describe('what is accepted and what is refused up front', () => {
  it('leaves a connection with no CA exactly as it was', () => {
    const url = 'postgres://u:p@h:5432/d?sslmode=require';
    expect(poolConnectionConfig(url)).toEqual({ connectionString: url });
    expect(poolConnectionConfig(url, '')).toEqual({ connectionString: url });
    expect(poolConnectionConfig(url, '   ')).toEqual({ connectionString: url });
  });

  it('drops the URL parameters that would fight the CA, and keeps the rest', () => {
    const config = poolConnectionConfig(
      'postgres://u:p%40ss@h:25060/crm?sslmode=require&uselibpqcompat=true&application_name=crm',
      providerCa,
    );
    expect(config.connectionString).toBe('postgres://u:p%40ss@h:25060/crm?application_name=crm');
    expect(config.ssl).toEqual({ ca: parseCaCert(providerCa), rejectUnauthorized: true });
  });

  it('refuses a CA beside sslmode=disable rather than choose between them', () => {
    expect(() => poolConnectionConfig('postgres://u:p@h/d?sslmode=disable', providerCa)).toThrow(
      /sslmode=disable/,
    );
  });

  it.each(['not a certificate', '-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----'])(
    'refuses a value that is not a certificate, and never repeats it: %s',
    (value) => {
      const attempt = () => poolConnectionConfig('postgres://u:secret-pw@h/d', value);
      expect(attempt).toThrow(/DATABASE_CA_CERT/);
      expect(attempt).not.toThrow(/secret-pw/);
      expect(attempt).not.toThrow(/nope/);
    },
  );

  it('does not echo a connection string it cannot parse', () => {
    expect(() => poolConnectionConfig('not a url with secret-pw', providerCa)).not.toThrow(
      /secret-pw/,
    );
    expect(() => poolConnectionConfig('not a url with secret-pw', providerCa)).toThrow();
  });
});
