/**
 * The filename a browser is offered, for the one place it reaches a header.
 *
 * Its own module rather than a helper inside the S3 adapter, because it is a
 * security control and every provider must apply the same one: a fake used by
 * the test suite that sanitised differently from the real adapter would prove
 * the wrong thing (ADR-0035).
 *
 * The name arrives from the uploader. By the time it gets here the contract
 * has already *rejected* separators, traversal, control characters and
 * bidirectional overrides (`attachmentFileNameProblem` in `@crm/core`); this
 * is the second, independent pass, written as an allow-list so that it is
 * correct even if the first one is ever bypassed, relaxed, or simply not
 * called by whatever uses storage next.
 */

/**
 * Reduce a name to a boring, header-safe alphabet.
 *
 * An allow-list, not a deny-list: everything outside `A-Za-z0-9._-` becomes an
 * underscore, so quotes, semicolons, newlines, NULs, right-to-left overrides
 * and every path separator are gone without any of them having to be
 * anticipated. `..` cannot survive, so the result can never read as a path
 * component, and the length is bounded because a 300-character name is a
 * header-length problem rather than a filename.
 */
export function safeDownloadName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    // No `..` survives, so the result can never read as a path component.
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '');
  return cleaned.length === 0 ? 'download' : cleaned.slice(0, 120);
}

/**
 * The `Content-Disposition` an object is served with.
 *
 * Always `attachment`, never `inline`: a file a user uploaded must be saved,
 * not rendered, or an origin that holds this app's session renders somebody
 * else's document. The value is quoted and the name has already been reduced
 * to an alphabet that contains no quote, so the header cannot be broken out of.
 */
export function contentDispositionFor(fileName: string): string {
  return `attachment; filename="${safeDownloadName(fileName)}"`;
}
