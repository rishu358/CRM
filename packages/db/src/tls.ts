import { X509Certificate } from 'node:crypto';

/**
 * TLS to a managed Postgres whose certificate is signed by the provider's own CA (ADR-0042).
 *
 * node-postgres reads `sslmode=require` in a connection string as full verification, so a provider
 * whose CA Node does not trust (DigitalOcean's, for one) refuses every connection with
 * `SELF_SIGNED_CERT_IN_CHAIN`. The tempting fixes are `sslmode=no-verify`, which encrypts to whoever
 * answers, and `NODE_TLS_REJECT_UNAUTHORIZED=0`, which does it for the whole process. This is the
 * third way: hand the driver the provider's CA, keep verification on, and keep the hostname check.
 *
 * Why the URL's TLS parameters are removed rather than left beside the CA: `pg` applies the
 * connection string's parameters over the `ssl` option, so a leftover `sslmode=require` would replace
 * the CA we pass with the driver's default trust store. One source of truth: when a CA is
 * configured, the CA decides, and the URL carries no opinion about TLS.
 */

const PEM_CERTIFICATE = '-----BEGIN CERTIFICATE-----';

/** Connection-string parameters that would override or fight the `ssl` option. */
const TLS_URL_PARAMETERS = [
  'sslmode',
  'ssl',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'sslcrl',
  'uselibpqcompat',
] as const;

export interface PoolConnectionConfig {
  readonly connectionString: string;
  readonly ssl?: { readonly ca: string; readonly rejectUnauthorized: true };
}

/**
 * The CA certificate(s) as PEM, from either of the forms an environment variable can carry.
 *
 * A multi-line value is awkward in an env file and in a platform's variable editor, so this accepts
 * the PEM as is, the PEM with literal `\n` in place of its newlines, or the base64 of the PEM
 * (`base64 -w0 ca.crt`), which is a single clean line. Whatever is accepted must parse as an X.509
 * certificate: a mistyped value fails at start-up, saying so, and never says what the value was.
 */
export function parseCaCert(value: string): string {
  const text = value.trim();
  let pem = text;
  if (!pem.includes(PEM_CERTIFICATE)) {
    pem = Buffer.from(text, 'base64').toString('utf8');
  } else if (!pem.includes('\n')) {
    pem = pem.replace(/\\n/g, '\n');
  }
  if (!pem.includes(PEM_CERTIFICATE)) {
    throw new Error('DATABASE_CA_CERT is not a PEM certificate, or the base64 of one');
  }
  try {
    // Throws on anything that is not a certificate; the first certificate is enough to check.
    new X509Certificate(pem);
  } catch {
    throw new Error('DATABASE_CA_CERT does not contain a valid X.509 certificate');
  }
  return pem;
}

/**
 * What to hand `pg` for a connection string and an optional CA.
 *
 * With no CA this changes nothing: the string goes through untouched and the driver's own rules
 * apply, as they did before (the right thing for a local database, and for a provider whose
 * certificate Node already trusts). With a CA, verification is on and cannot be turned off by the
 * URL: a URL that says `sslmode=disable` alongside a CA is a contradiction and is refused rather
 * than resolved in favour of either.
 */
export function poolConnectionConfig(
  connectionString: string,
  caCert?: string,
): PoolConnectionConfig {
  if (caCert === undefined || caCert.trim() === '') return { connectionString };

  const ca = parseCaCert(caCert);

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // Not echoed: a connection string carries a password.
    throw new Error('A database connection string is not a URL, so a CA cannot be applied to it');
  }
  if (url.searchParams.get('sslmode') === 'disable') {
    throw new Error(
      'DATABASE_CA_CERT is set but a database URL says sslmode=disable; remove one of them',
    );
  }
  for (const name of TLS_URL_PARAMETERS) url.searchParams.delete(name);

  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } };
}
