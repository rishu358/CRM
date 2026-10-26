/**
 * Object storage, as an interface (ADR-0009, CLAUDE.md §5.12).
 *
 * Nothing here names a vendor, a bucket layout or an SDK type, so the S3
 * adapter can become R2, GCS or a local directory without a caller noticing.
 *
 * The shape is dictated by one rule the product cannot bend: **a file never
 * passes through the API process.** The browser uploads straight to the store
 * with a presigned PUT and downloads straight from it with a presigned GET.
 * The API only ever holds the job row that says a file exists. That is why
 * there is no `upload(file)` and no `serve(key)` here — the two methods one
 * would reach for first are exactly the two that would put a request handler
 * on the file path.
 *
 * The worker does read bytes, because somebody has to parse them. It reads
 * them as a stream it can abandon partway, which is what makes a bounded
 * read of an unbounded file possible.
 */

/** What a caller is allowed to upload. Enforced again, on bytes, after upload. */
export interface UploadUrlRequest {
  readonly key: string;
  /**
   * The content type the presigned URL will be bound to.
   *
   * Advisory only as far as security goes: it is client-supplied, and the real
   * check is `detectUploadFormat` on the bytes themselves once they land
   * (CLAUDE.md §5.12). Binding it to the signature still stops a signed URL
   * handed to someone else being reused for a different kind of object.
   */
  readonly contentType: string;
  /**
   * The exact size the client declared. The signature binds to it, so the store
   * refuses a body of any other length: a presigned PUT cannot express a
   * ceiling, only an exact size, and "exactly what you said you would send" is
   * the stronger rule anyway. The worker checks `head().sizeBytes` again.
   */
  readonly sizeBytes: number;
  readonly expiresInSeconds: number;
}

export interface UploadUrl {
  readonly url: string;
  readonly method: 'PUT';
  /**
   * Headers the client must send verbatim for the signature to verify. The body
   * length is bound by the signature as well but is not listed: a client cannot
   * set `Content-Length` by hand, it follows from the body.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface DownloadUrlRequest {
  readonly key: string;
  readonly expiresInSeconds: number;
  /** Offered to the browser as the saved filename. Sanitised by the adapter. */
  readonly fileName: string;
  readonly contentType: string;
}

export interface DownloadUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface StoredObject {
  readonly key: string;
  readonly sizeBytes: number;
  readonly contentType: string | null;
}

export interface StorageProvider {
  /** A URL the browser may PUT one object to, once, for a short while. */
  createUploadUrl(request: UploadUrlRequest): Promise<UploadUrl>;

  /** A URL the browser may GET one object from, for a short while. */
  createDownloadUrl(request: DownloadUrlRequest): Promise<DownloadUrl>;

  /** Metadata only. `null` when the object is not there. */
  head(key: string): Promise<StoredObject | null>;

  /**
   * The object's bytes, in chunks.
   *
   * An `AsyncIterable` rather than a Buffer because the caller is parsing a
   * file a user supplied: it must be able to stop reading the moment a limit
   * is crossed, and never has to hold the whole thing in memory. A provider
   * that buffers internally has thrown that away.
   */
  openRead(key: string): AsyncIterable<Uint8Array>;

  /** The first `length` bytes. Used for the magic-byte check (CLAUDE.md §5.12). */
  readPrefix(key: string, length: number): Promise<Uint8Array>;

  /** Write an object we generated ourselves: an export, or an import's error file. */
  write(
    key: string,
    body: Uint8Array | AsyncIterable<Uint8Array>,
    contentType: string,
  ): Promise<void>;

  delete(key: string): Promise<void>;
}
