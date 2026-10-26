import { Readable } from 'node:stream';
import { contentDispositionFor } from './download-name.js';
import type {
  DownloadUrl,
  DownloadUrlRequest,
  StorageProvider,
  StoredObject,
  UploadUrl,
  UploadUrlRequest,
} from '@crm/core';

/**
 * An in-memory `StorageProvider` (ADR-0009: "tests use in-memory fakes of the
 * interfaces, so no test needs network access").
 *
 * It is a fake of the *contract*, not of S3, so it keeps the properties the
 * security tests lean on: URLs expire, an upload is bound to the size and type
 * it was signed for, and bytes only appear in the store when something
 * actually uploads them. `simulateUpload` plays the browser's part.
 */

interface MemoryObject {
  bytes: Uint8Array;
  contentType: string;
}

interface IssuedUpload {
  readonly key: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly expiresAt: Date;
}

export class MemoryStorageProvider implements StorageProvider {
  private readonly objects = new Map<string, MemoryObject>();
  private readonly uploads = new Map<string, IssuedUpload>();
  private readonly downloads = new Map<
    string,
    { key: string; expiresAt: Date; headers: Readonly<Record<string, string>> }
  >();
  private counter = 0;

  /** Every URL ever issued, in order, so a test can assert what was signed. */
  readonly issuedUploadRequests: UploadUrlRequest[] = [];
  readonly issuedDownloadRequests: DownloadUrlRequest[] = [];

  /**
   * How many times something read or wrote bytes through the provider (as
   * opposed to signing a URL or asking for metadata). The API must leave both
   * at zero: a file never passes through the API process (CLAUDE.md §5.12).
   */
  reads = 0;
  writes = 0;

  /** Injectable clock so a test can step past an expiry without sleeping. */
  now: () => Date = () => new Date();

  createUploadUrl(request: UploadUrlRequest): Promise<UploadUrl> {
    this.issuedUploadRequests.push(request);
    const token = `u${(this.counter += 1)}`;
    const expiresAt = new Date(this.now().getTime() + request.expiresInSeconds * 1000);
    this.uploads.set(token, {
      key: request.key,
      contentType: request.contentType,
      sizeBytes: request.sizeBytes,
      expiresAt,
    });
    return Promise.resolve({
      url: `memory://upload/${token}`,
      method: 'PUT',
      headers: { 'Content-Type': request.contentType },
      expiresAt,
    });
  }

  createDownloadUrl(request: DownloadUrlRequest): Promise<DownloadUrl> {
    this.issuedDownloadRequests.push(request);
    const token = `d${(this.counter += 1)}`;
    const expiresAt = new Date(this.now().getTime() + request.expiresInSeconds * 1000);
    this.downloads.set(token, {
      key: request.key,
      expiresAt,
      // The same two headers the S3 adapter binds into the signature, built by
      // the same function, so a test that asserts them is asserting the real
      // control rather than this fake's idea of it (ADR-0035).
      headers: {
        'Content-Disposition': contentDispositionFor(request.fileName),
        'Content-Type': request.contentType,
      },
    });
    return Promise.resolve({ url: `memory://download/${token}`, expiresAt });
  }

  /** What the browser does with the upload URL. Refuses what S3 would refuse. */
  simulateUpload(url: string, bytes: Uint8Array, contentType: string): void {
    const issued = this.uploads.get(url.replace('memory://upload/', ''));
    if (issued === undefined) throw new Error('Unknown upload URL');
    if (issued.expiresAt.getTime() <= this.now().getTime()) throw new Error('Upload URL expired');
    if (bytes.length !== issued.sizeBytes) throw new Error('Body length does not match signature');
    if (contentType !== issued.contentType)
      throw new Error('Content type does not match signature');
    this.objects.set(issued.key, { bytes, contentType });
  }

  /** What the browser does with a download URL. */
  simulateDownload(url: string): Uint8Array {
    const issued = this.downloads.get(url.replace('memory://download/', ''));
    if (issued === undefined) throw new Error('Unknown download URL');
    if (issued.expiresAt.getTime() <= this.now().getTime()) throw new Error('Download URL expired');
    const object = this.objects.get(issued.key);
    if (object === undefined) throw new Error('No such object');
    return object.bytes;
  }

  /** The response headers the store would send for a download URL. */
  headersFor(url: string): Readonly<Record<string, string>> {
    const issued = this.downloads.get(url.replace('memory://download/', ''));
    if (issued === undefined) throw new Error('Unknown download URL');
    return issued.headers;
  }

  /** Test seam: put bytes in without a URL, as a hostile client could. */
  put(key: string, bytes: Uint8Array, contentType = 'application/octet-stream'): void {
    this.objects.set(key, { bytes, contentType });
  }

  /** Test seam: the stored bytes, as the worker (not a browser) would read them. */
  bytesOf(key: string): Uint8Array {
    const object = this.objects.get(key);
    if (object === undefined) throw new Error('No such object');
    return object.bytes;
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }

  head(key: string): Promise<StoredObject | null> {
    const object = this.objects.get(key);
    if (object === undefined) return Promise.resolve(null);
    return Promise.resolve({
      key,
      sizeBytes: object.bytes.length,
      contentType: object.contentType,
    });
  }

  openRead(key: string): AsyncIterable<Uint8Array> {
    this.reads += 1;
    const object = this.objects.get(key);
    if (object === undefined) throw new Error('No such object');
    const size = 64 * 1024;
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < object.bytes.length; offset += size) {
      chunks.push(object.bytes.subarray(offset, offset + size));
    }
    return Readable.from(chunks, { objectMode: true }) as AsyncIterable<Uint8Array>;
  }

  readPrefix(key: string, length: number): Promise<Uint8Array> {
    this.reads += 1;
    const object = this.objects.get(key);
    if (object === undefined) return Promise.reject(new Error('No such object'));
    return Promise.resolve(object.bytes.subarray(0, length));
  }

  async write(
    key: string,
    body: Uint8Array | AsyncIterable<Uint8Array>,
    contentType: string,
  ): Promise<void> {
    this.writes += 1;
    if (body instanceof Uint8Array) {
      this.objects.set(key, { bytes: body, contentType });
      return;
    }
    const parts: Uint8Array[] = [];
    for await (const part of body) parts.push(part);
    this.objects.set(key, { bytes: Buffer.concat(parts), contentType });
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}
