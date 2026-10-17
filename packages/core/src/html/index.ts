import sanitizeHtmlLibrary, { type IOptions } from 'sanitize-html';

/**
 * Rich-text sanitization (ADR-0024, MVP_SPEC §8 "Input").
 *
 * Activity bodies are HTML a user typed, so they are the one place in the
 * product where attacker-controlled markup is stored and later rendered for a
 * colleague. The rule is an **allow-list**: everything is removed unless it is
 * named here. A block-list — "strip `<script>`" — fails the moment somebody
 * finds a vector nobody thought of, and the history of XSS is a history of
 * vectors nobody thought of (`<svg onload>`, `javascript:` in an href,
 * `<math><annotation-xml>`, mutation-XSS through nested parsing).
 *
 * Exported from `@crm/core/html` rather than from the package index on
 * purpose: the web app imports `@crm/core`, and a server-side HTML parser has
 * no business in a browser bundle.
 */

/**
 * Tags a person can produce from a rich-text toolbar, and nothing else.
 *
 * Absent deliberately:
 *   - `img`, `video`, `iframe`, `object`, `embed` — remote content in a note
 *     is a tracking pixel at best and an SSRF/CSP problem at worst; files go
 *     through attachments, which check magic bytes and serve presigned URLs
 *     (CLAUDE.md §5.12).
 *   - `style`, `script`, `svg`, `math`, `form`, `input`, `template` — each is
 *     a known script-execution or parser-confusion vector.
 *   - `span`, `div`, `font` — they carry nothing we need once `style` and
 *     `class` are gone, and keeping them only widens the parse surface.
 */
export const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'h3',
  'h4',
  'a',
] as const;

/**
 * The only attribute that survives, on the only tag that may carry one.
 *
 * No `style` (expression/url vectors and layout takeover), no `class` (lets a
 * note borrow application chrome and fake UI), no `id` (DOM clobbering), no
 * event handlers of any kind — `on*` is not block-listed, it is simply never
 * allowed through.
 */
export const ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  // `rel` and `target` are listed because the transform below *adds* them;
  // an allow-list strips what it is not told to keep, including attributes we
  // put there ourselves. A value the author supplied is overwritten by the
  // transform, so listing them does not let a note choose its own `rel`.
  a: ['href', 'rel', 'target'],
};

/**
 * Link schemes. `javascript:`, `data:` and `vbscript:` are not here, which is
 * what makes `<a href="javascript:...">` lose its href rather than its tag.
 */
export const ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'tel'] as const;

/**
 * Tags whose **content** goes too.
 *
 * Unknown tags are unwrapped by default — `<foo>hello</foo>` becomes `hello`,
 * which keeps the user's words. That is wrong for these: unwrapping
 * `<script>alert(1)</script>` would leave `alert(1)` as visible text, and
 * unwrapping `<style>` would leak CSS into the prose. The text inside them was
 * never prose.
 */
const DISCARDED_WITH_CONTENT = [
  'script',
  'style',
  'textarea',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
  'title',
  'xmp',
] as const;

/**
 * A stored body is capped so a single note cannot become a denial of service
 * against the list endpoint that renders fifty of them.
 */
export const MAX_RICH_TEXT_LENGTH = 32_000;

/**
 * Slack left when a body has to be truncated a second time.
 *
 * Sanitizing can make a string slightly longer — `&` becomes `&amp;`, an
 * unclosed `<p>` gains a `</p>` — so truncating the input to exactly the cap
 * can still produce output above it. Cutting the *output* with headroom and
 * sanitizing once more closes whatever the cut opened, and sanitize-html does
 * not re-escape an entity it already escaped, so the second pass cannot grow
 * the string again.
 */
const TRUNCATION_HEADROOM = 512;

const OPTIONS: IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: { a: [...(ALLOWED_ATTRIBUTES['a'] ?? [])] },
  allowedSchemes: [...ALLOWED_SCHEMES],
  // Relative URLs would resolve against our own origin; a note is not a place
  // to link into the application's own state-changing routes.
  allowProtocolRelative: false,
  allowedSchemesAppliedToAttributes: ['href'],
  nonTextTags: [...DISCARDED_WITH_CONTENT],
  // Every surviving link opens in a new tab without handing the opener window
  // to the destination, and is not an endorsement for search engines.
  transformTags: {
    a: sanitizeHtmlLibrary.simpleTransform('a', {
      rel: 'noopener noreferrer nofollow',
      target: '_blank',
    }),
  },
  // Anything not named above is dropped, rather than escaped into visible
  // angle brackets: a note full of `&lt;script&gt;` is noise, not safety.
  disallowedTagsMode: 'discard',
};

/**
 * Sanitize a rich-text body, or return null for "no body".
 *
 * Run on **write** so nothing dangerous is ever stored, and again on **read**
 * in the serializer. The second pass is not redundancy for its own sake: rows
 * can arrive from an import, a seed, a restored backup or a future code path
 * that forgot, and a body is rendered as HTML, so the rendering side must not
 * depend on every writer having been careful (ADR-0024).
 *
 * Whitespace-only input — including markup that sanitizes away to nothing —
 * becomes null rather than an empty element, so "has a body" is a question
 * with one answer.
 */
export function sanitizeRichText(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;

  let clean = sanitizeHtmlLibrary(input.slice(0, MAX_RICH_TEXT_LENGTH), OPTIONS).trim();
  if (clean.length > MAX_RICH_TEXT_LENGTH) {
    clean = sanitizeHtmlLibrary(
      clean.slice(0, MAX_RICH_TEXT_LENGTH - TRUNCATION_HEADROOM),
      OPTIONS,
    ).trim();
  }
  return richTextToPlain(clean).length === 0 ? null : clean;
}

/**
 * The readable text of a body, with no markup at all.
 *
 * Used for search, for notification and digest emails, and for anywhere a
 * body is shown in a context that is not HTML. The result is **text**: it has
 * entities decoded, so it may legitimately contain `<` and `&`. Anything that
 * puts it back into an HTML document must run it through `escapeHtml` first. Produced by sanitizing to an
 * empty allow-list rather than by stripping tags with a regular expression:
 * `<p title=">">` defeats the regular expression, and the result would be
 * inserted somewhere that trusts it.
 */
export function richTextToPlain(input: string | null | undefined): string {
  if (input === null || input === undefined) return '';

  // Insert a space where a block ends, so "<p>Call</p><p>at 4pm</p>" reads as
  // two words rather than one. This regular expression only *adds*
  // whitespace — it removes no markup and makes no safety decision — and the
  // sanitizer still runs over the result afterwards.
  const spaced = input
    .slice(0, MAX_RICH_TEXT_LENGTH)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|li|ul|ol|h[1-6]|blockquote|pre|div|tr)\s*>/gi, ' ');

  return sanitizeHtmlLibrary(spaced, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: [...DISCARDED_WITH_CONTENT],
  })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** A short preview of a body, for a list row or an email digest line. */
export function richTextSummary(input: string | null | undefined, maxLength = 140): string {
  const text = richTextToPlain(input);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Escape text for inclusion in an HTML document we are generating ourselves. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
