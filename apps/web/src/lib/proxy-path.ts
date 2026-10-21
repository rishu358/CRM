/**
 * The path the credential proxy forwards to (CLAUDE.md §5, ADR-0040).
 *
 * The proxy attaches the session token to a request and sends it to the API, so the
 * one thing it must never do is let the caller choose *where*. The origin is fixed
 * in configuration; this decides the path, from the matched route segments, and
 * refuses anything that could leave `/api/v1`.
 *
 * Each segment arrives decoded, so `..%2Fhealth` is a single segment containing a slash
 * and `%2e%2e` is `..`. Re-encoding does not help: `encodeURIComponent('..')` is `..`,
 * and `new URL('/api/v1/../x', origin)` resolves to `/x`. So a segment that is a dot
 * segment, or that contains a separator, is refused rather than escaped.
 *
 * Nothing on the API is outside `/api/v1` today, so this closes a door nobody has
 * walked through. It is here because a metrics route, a documentation UI or an
 * administration route is exactly what gets added outside the versioned prefix later,
 * and by then this proxy would be attaching a session to a request for it.
 */

const MAX_SEGMENTS = 20;
const MAX_SEGMENT_LENGTH = 200;

/** ASCII control characters, DEL, and the separators a path must not smuggle in. */
function hasForbiddenCharacter(segment: string): boolean {
  for (const character of segment) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || character === '/' || character === '\\') return true;
  }
  return false;
}

export function upstreamPath(segments: readonly string[]): string | null {
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) return null;

  for (const segment of segments) {
    if (segment.length === 0 || segment.length > MAX_SEGMENT_LENGTH) return null;
    if (segment === '.' || segment === '..') return null;
    if (hasForbiddenCharacter(segment)) return null;
  }

  return `/api/v1/${segments.map(encodeURIComponent).join('/')}`;
}
