import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, for the one kind of request this system signs itself: a JSON `POST` with
 * no query string (the email adapter, ADR-0048). No SDK: the algorithm is a page of hashing, and a
 * vendor SDK is a dependency to audit and an HTTP client outside the one guarded door every
 * outbound call goes through (`OutboundHttp`).
 *
 * Pure: the clock is a parameter, so the result is a function of its inputs and is tested against
 * the signature AWS publishes for its own test vector.
 */
export interface SigV4Input {
  readonly method: string;
  readonly host: string;
  /** Already URI-encoded, starting with `/`. */
  readonly path: string;
  readonly region: string;
  readonly service: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Headers to sign besides `host` and `x-amz-date`, lowercase names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly now: Date;
}

export interface SigV4Output {
  /** The headers to send, `authorization` and `x-amz-date` included. `host` is the client's to set. */
  readonly headers: Readonly<Record<string, string>>;
}

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: string | Buffer, value: string): Buffer =>
  createHmac('sha256', key).update(value, 'utf8').digest();

/** `20150830T123600Z`: the form AWS wants in `x-amz-date`. */
export function amzDate(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export function signV4(input: SigV4Input): SigV4Output {
  const timestamp = amzDate(input.now);
  const day = timestamp.slice(0, 8);

  const signed: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value.trim()]),
    ),
    host: input.host,
    'x-amz-date': timestamp,
  };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((name) => `${name}:${signed[name] as string}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    input.method,
    input.path,
    '', // no query string
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.body),
  ].join('\n');

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256Hex(canonicalRequest)].join(
    '\n',
  );

  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  const { host: _host, ...sendable } = signed;
  return {
    headers: {
      ...sendable,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
