import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

/**
 * Create the local development bucket, once, and keep it private.
 *
 * Run by `pnpm infra:up` after the containers start (and safe to run again). It
 * exists so that local development needs nothing but the AWS SDK this repo
 * already depends on: no separate `mc` image to pull and keep pinned.
 *
 * It does two things a bucket for this app must have:
 *
 *   - **No public access.** Nothing in this bucket is ever served except
 *     through a short-lived presigned URL (CLAUDE.md §5.12). MinIO buckets are
 *     private by default; the explicit block makes that a stated property and
 *     is what S3 and R2 would be configured with in production.
 *   - **CORS for the web origin only.** The browser uploads straight to the
 *     bucket and downloads straight from it (CLAUDE.md §5.12), which is a
 *     cross-origin request. Only `WEB_URL` may make it, and only with the verbs
 *     the app uses (PUT to upload, GET to download). Real S3 and R2 need exactly
 *     this rule in production; MinIO ignores bucket CORS and is permissive.
 *   - **Expiry.** Import uploads, error files and exports are working files, not
 *     records. A lifecycle rule removes whatever the application did not clean
 *     up itself, so a forgotten export is not kept indefinitely.
 *
 * Reads the same `S3_*` variables the API and worker do. It never prints a
 * secret.
 */
const endpoint = process.env['S3_ENDPOINT'];
const bucket = process.env['S3_BUCKET'] ?? 'crm-files';
const accessKeyId = process.env['S3_ACCESS_KEY_ID'];
const secretAccessKey = process.env['S3_SECRET_ACCESS_KEY'];

if (accessKeyId === undefined || secretAccessKey === undefined) {
  console.error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set (see .env.example).');
  process.exit(1);
}

const client = new S3Client({
  region: process.env['S3_REGION'] ?? 'us-east-1',
  ...(endpoint === undefined ? {} : { endpoint }),
  forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] === 'true',
  credentials: { accessKeyId, secretAccessKey },
});

async function exists(): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (error) {
    if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return false;
    throw error;
  }
}

async function waitForServer(): Promise<void> {
  // `docker compose up -d` returns before the server is accepting connections.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await exists();
      return;
    } catch (error) {
      if (attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

await waitForServer();

if (!(await exists())) {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`Created bucket ${bucket}`);
} else {
  console.log(`Bucket ${bucket} already exists`);
}

// Best effort: some S3-compatible servers do not implement these two calls, and a
// development bucket without them is still private (see above).
try {
  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
} catch {
  console.log(
    'Note: this server does not support a public-access block; the bucket is private by default.',
  );
}

try {
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'expire-working-files',
            Status: 'Enabled',
            Filter: { Prefix: 'tenants/' },
            Expiration: { Days: 2 },
          },
        ],
      },
    }),
  );
} catch {
  console.log(
    'Note: this server does not support lifecycle rules; clean the bucket by hand if needed.',
  );
}

try {
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: [process.env['WEB_URL'] ?? 'http://localhost:3000'],
            AllowedMethods: ['PUT', 'GET'],
            // Only what the signature covers; nothing else is needed or sent.
            AllowedHeaders: ['content-type'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 600,
          },
        ],
      },
    }),
  );
} catch {
  console.log('Note: this server does not support bucket CORS; it is permissive by default.');
}
