import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  DownloadUrl,
  DownloadUrlRequest,
  StorageProvider,
  StoredObject,
  UploadUrl,
  UploadUrlRequest,
} from '@crm/core';
import { Readable } from 'node:stream';
import { contentDispositionFor } from './download-name.js';

/**
 * The S3-compatible adapter (ADR-0009): AWS S3, Cloudflare R2, MinIO.
 *
 * This is the only file in the repository that imports the AWS SDK. Nothing
 * above it knows the vendor, so a move to GCS is a new adapter and a changed
 * line of configuration.
 *
 * Two clients, because the two jobs are reachable at different addresses. The
 * worker and API talk to the store over the internal network
 * (`endpoint`); a browser must be handed URLs it can reach from outside
 * (`publicEndpoint`). Signing with the wrong host produces a URL that is valid
 * and unusable, which is a miserable thing to debug in a container setup. In
 * production on S3 or R2 the two are the same and `publicEndpoint` is omitted.
 */
export interface S3StorageConfig {
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Internal endpoint. Omit for AWS S3 itself. */
  readonly endpoint?: string | undefined;
  /** The address browsers use, when it differs from `endpoint`. */
  readonly publicEndpoint?: string | undefined;
  /** MinIO needs path-style addressing; S3 and R2 do not. */
  readonly forcePathStyle?: boolean | undefined;
}

export class S3StorageProvider implements StorageProvider {
  private readonly internal: S3Client;
  private readonly signing: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    const base = {
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: config.forcePathStyle ?? false,
      // Checksums are optional on a presigned PUT and the browser will not send
      // the one the SDK would otherwise require, so do not demand it.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.internal = new S3Client({
      ...base,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    });
    const publicEndpoint = config.publicEndpoint ?? config.endpoint;
    this.signing = new S3Client({
      ...base,
      ...(publicEndpoint ? { endpoint: publicEndpoint } : {}),
    });
  }

  async createUploadUrl(request: UploadUrlRequest): Promise<UploadUrl> {
    // Only the type is returned for the client to send. The length is signed too,
    // but a browser sets `Content-Length` itself from the body (it is a forbidden
    // header name for `fetch` and XHR), so the client cannot send a different
    // one — and a body that does not match what was signed is refused by the
    // store.
    const headers = { 'Content-Type': request.contentType };
    const url = await getSignedUrl(
      this.signing,
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: request.key,
        ContentType: request.contentType,
        ContentLength: request.sizeBytes,
      }),
      {
        expiresIn: request.expiresInSeconds,
        // Bound into the signature, so the PUT only works with exactly these.
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
    return {
      url,
      method: 'PUT',
      headers,
      expiresAt: new Date(Date.now() + request.expiresInSeconds * 1000),
    };
  }

  async createDownloadUrl(request: DownloadUrlRequest): Promise<DownloadUrl> {
    const url = await getSignedUrl(
      this.signing,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: request.key,
        // `attachment` makes the browser save the file rather than render it,
        // so an uploaded or generated file is never interpreted as a page.
        ResponseContentDisposition: contentDispositionFor(request.fileName),
        ResponseContentType: request.contentType,
      }),
      { expiresIn: request.expiresInSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + request.expiresInSeconds * 1000) };
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const result = await this.internal.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return {
        key,
        sizeBytes: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async *openRead(key: string): AsyncIterable<Uint8Array> {
    const result = await this.internal.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    if (!(result.Body instanceof Readable)) throw new Error('Object store returned no body');
    for await (const chunk of result.Body) yield chunk as Uint8Array;
  }

  async readPrefix(key: string, length: number): Promise<Uint8Array> {
    const result = await this.internal.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Range: `bytes=0-${Math.max(length, 1) - 1}`,
      }),
    );
    if (result.Body === undefined) return new Uint8Array();
    return result.Body.transformToByteArray();
  }

  async write(
    key: string,
    body: Uint8Array | AsyncIterable<Uint8Array>,
    contentType: string,
  ): Promise<void> {
    if (body instanceof Uint8Array) {
      await this.internal.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      return;
    }
    // Multipart, streamed: an export of a million rows is never held in memory.
    await new Upload({
      client: this.internal,
      params: {
        Bucket: this.config.bucket,
        Key: key,
        Body: Readable.from(body),
        ContentType: contentType,
      },
    }).done();
  }

  async delete(key: string): Promise<void> {
    await this.internal.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
}

function isNotFound(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    return error.$metadata.httpStatusCode === 404 || error.name === 'NotFound';
  }
  return false;
}
