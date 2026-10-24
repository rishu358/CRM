/**
 * A brand colour that cannot break accessibility (WCAG 2.1 AA, MVP_SPEC §9, ADR-0045).
 *
 * An installation may set its own primary colour for the light and the dark theme. Colour is decided
 * in one place, the tokens in `styles.css`, and `contrast.test.ts` proves every pair a component can
 * put on screen clears AA. A configurable colour would walk straight around that proof, so this
 * module applies the same rules to the configured colour **before it is accepted**: a colour that
 * would make a link, a badge or a focus ring unreadable is refused at start-up, naming the rule,
 * instead of shipping an interface some people cannot read.
 *
 * What the configured colour is used as (each is a rule below):
 *   * text on the page and on cards (links, `text-primary`)          4.5:1
 *   * text inside a badge tinted 15% with the colour                  4.5:1
 *   * the focus ring                                                  3:1 (implied by the text rule)
 *   * the surface of a primary button, with its label on top          4.5:1, label chosen for you
 *   * the tinted surface of a selected row, with text on it           4.5:1 (derived, see `accentFor`)
 *
 * The surfaces are the theme's own tokens. They are repeated here as numbers because a stylesheet
 * cannot be imported into a module, and `brand.test.ts` parses `styles.css` and fails if any drifts.
 */

export type Hsl = readonly [hue: number, saturation: number, lightness: number];
export type Rgb = readonly [red: number, green: number, blue: number];
export type ThemeName = 'light' | 'dark';

interface ThemeSurfaces {
  readonly background: Hsl;
  readonly card: Hsl;
  readonly mutedForeground: Hsl;
}

/** The tokens of `styles.css` a primary colour has to be readable against. */
export const THEME_SURFACES: Readonly<Record<ThemeName, ThemeSurfaces>> = {
  light: {
    background: [200, 20, 97],
    card: [0, 0, 100],
    mutedForeground: [200, 14, 35],
  },
  dark: {
    background: [200, 28, 7],
    card: [200, 24, 10],
    mutedForeground: [200, 12, 68],
  },
};

const WHITE: Hsl = [0, 0, 100];
/** The dark ink the dark theme already puts on its primary buttons. */
const INK: Hsl = [200, 40, 7];
/**
 * The last resort. White or black always reaches 4.58:1 on any colour (the two cross at about
 * 4.58:1 on a mid-tone), but the ink above is not pure black and falls short on some mid-tones
 * (`#6666ff` gets 4.35:1 from the better of white and the ink), so black backs them up.
 */
const BLACK: Hsl = [0, 0, 0];

const BADGE_TINT = 0.15;
const TEXT = 4.5;

// ---- colour maths -------------------------------------------------------------------------------

/** `#rrggbb` as three channels in 0..1, or null if it is not that. */
export function parseHex(value: string): Rgb | null {
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(value);
  if (match === null) return null;
  return [
    parseInt(match[1] as string, 16) / 255,
    parseInt(match[2] as string, 16) / 255,
    parseInt(match[3] as string, 16) / 255,
  ];
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

export function rgbToHsl([r, g, b]: Rgb): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, round1(lightness * 100)];
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return [
    round1((((hue * 60) % 360) + 360) % 360),
    round1(saturation * 100),
    round1(lightness * 100),
  ];
}

export function hslToRgb([h, s, l]: Hsl): Rgb {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `foreground` laid over `background` at `alpha`, as a browser blends it. */
function over(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  const mix = (f: number, b: number) => f * alpha + b * (1 - alpha);
  return [
    mix(foreground[0], background[0]),
    mix(foreground[1], background[1]),
    mix(foreground[2], background[2]),
  ];
}

/** A token value as the stylesheet writes it: `186 88% 24%`. */
export function formatHsl([h, s, l]: Hsl): string {
  return `${String(h)} ${String(s)}% ${String(l)}%`;
}

// ---- the rules ----------------------------------------------------------------------------------

/**
 * The colour exactly as the browser will render it: the token is written as rounded HSL, so the
 * rules are applied to that, not to the hex that was typed.
 */
function asRendered(hex: string): { hsl: Hsl; rgb: Rgb } | null {
  const parsed = parseHex(hex);
  if (parsed === null) return null;
  const hsl = rgbToHsl(parsed);
  return { hsl, rgb: hslToRgb(hsl) };
}

const ratioText = (value: number): string => value.toFixed(2);

/** Why `hex` cannot be the primary colour of `theme`, as sentences. Empty if it can. */
export function primaryProblems(hex: string, theme: ThemeName): string[] {
  const colour = asRendered(hex);
  if (colour === null) return ['is not a colour written #rrggbb'];

  const surfaces = THEME_SURFACES[theme];
  const problems: string[] = [];
  for (const surface of ['background', 'card'] as const) {
    const base = hslToRgb(surfaces[surface]);
    const asText = contrast(colour.rgb, base);
    if (asText < TEXT) {
      problems.push(
        `is too ${theme === 'light' ? 'light' : 'dark'} to read as text on the ${theme} theme's ${surface} (${ratioText(asText)}:1; links need ${String(TEXT)}:1)`,
      );
      continue;
    }
    const tinted = contrast(colour.rgb, over(colour.rgb, base, BADGE_TINT));
    if (tinted < TEXT) {
      problems.push(
        `is too close to the ${theme} theme's ${surface} to read as a badge (${ratioText(tinted)}:1; badges need ${String(TEXT)}:1)`,
      );
    }
  }
  return problems;
}

/**
 * The label for a primary button of this colour: white or the theme's dark ink, whichever reads
 * better, or black if neither reaches 4.5:1. Never fails the rule, so no colour is refused for it.
 */
export function foregroundOn(hex: string): Hsl {
  const colour = asRendered(hex);
  if (colour === null) return WHITE;
  const onWhite = contrast(hslToRgb(WHITE), colour.rgb);
  const onInk = contrast(hslToRgb(INK), colour.rgb);
  if (Math.max(onWhite, onInk) >= TEXT) return onWhite >= onInk ? WHITE : INK;
  return BLACK;
}

/**
 * The tinted surface of a selected row or hovered menu item, in the brand's hue, with the text that
 * goes on it, or null if this hue cannot be made to pass (the built-in tint is then kept).
 */
export function accentFor(hex: string, theme: ThemeName): { surface: Hsl; text: Hsl } | null {
  const colour = asRendered(hex);
  if (colour === null) return null;
  const [hue, saturation] = colour.hsl;
  // A grey brand has no hue to tint with; scale the tint down with the colour's own saturation.
  const scale = Math.min(1, saturation / 40);
  const surface: Hsl =
    theme === 'light' ? [hue, round1(45 * scale), 92] : [hue, round1(40 * scale), 18];
  const text: Hsl =
    theme === 'light' ? [hue, round1(85 * scale), 17] : [hue, round1(70 * scale), 82];

  const surfaceRgb = hslToRgb(surface);
  const muted = hslToRgb(THEME_SURFACES[theme].mutedForeground);
  if (contrast(hslToRgb(text), surfaceRgb) < TEXT) return null;
  if (contrast(muted, surfaceRgb) < TEXT) return null;
  return { surface, text };
}

// ---- what is handed to the stylesheet -----------------------------------------------------------

export interface BrandColours {
  readonly light?: string | undefined;
  readonly dark?: string | undefined;
}

export interface BrandTheme {
  /** CSS custom properties for the root element; `styles.css` falls back to its own tokens without them. */
  readonly variables: Readonly<Record<string, string>>;
  /** One sentence per colour that was refused, each naming which setting and why. */
  readonly problems: readonly string[];
}

/**
 * The custom properties for a configured brand, and the reasons any colour was refused. Nothing is
 * emitted for a refused colour, so a caller that ignores `problems` still never ships it.
 */
export function brandTheme(colours: BrandColours): BrandTheme {
  const variables: Record<string, string> = {};
  const problems: string[] = [];

  const entries = [
    ['light', colours.light, 'BRAND_COLOR', ''],
    ['dark', colours.dark, 'BRAND_COLOR_DARK', '-dark'],
  ] as const;

  for (const [theme, hex, setting, suffix] of entries) {
    if (hex === undefined) continue;
    const refused = primaryProblems(hex, theme);
    if (refused.length > 0) {
      for (const reason of refused) problems.push(`${setting} ${hex} ${reason}`);
      continue;
    }
    const colour = asRendered(hex);
    if (colour === null) continue;
    const primary = formatHsl(colour.hsl);
    variables[`--brand-primary${suffix}`] = primary;
    variables[`--brand-ring${suffix}`] = primary;
    variables[`--brand-primary${suffix}-foreground`] = formatHsl(foregroundOn(hex));
    const accent = accentFor(hex, theme);
    if (accent !== null) {
      variables[`--brand-accent${suffix}`] = formatHsl(accent.surface);
      variables[`--brand-accent${suffix}-foreground`] = formatHsl(accent.text);
    }
  }
  return { variables, problems };
}
