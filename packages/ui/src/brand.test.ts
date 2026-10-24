import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  THEME_SURFACES,
  accentFor,
  brandTheme,
  contrast,
  foregroundOn,
  formatHsl,
  hslToRgb,
  parseHex,
  primaryProblems,
  rgbToHsl,
  type Hsl,
  type ThemeName,
} from './brand.js';

/**
 * A configured brand colour must clear the same accessibility bar as the built-in one (ADR-0045).
 * Three things are proved: the surface constants in `brand.ts` are the tokens in `styles.css`;
 * the colours it accepts satisfy EVERY pair `contrast.test.ts` enforces, re-derived here
 * independently so the two cannot share a mistake; and the colours it refuses are refused.
 */
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** `--name: H S% L%` (or `var(--brand-x, H S% L%)`) from the block that opens at `selector`. */
function tokens(selector: string): Record<string, Hsl> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`No block for ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const found: Record<string, Hsl> = {};
  for (const match of css
    .slice(open, close)
    .matchAll(/--([a-z-]+):\s*(?:var\(--[a-z-]+,\s*)?([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)?;/g)) {
    found[match[1] as string] = [Number(match[2]), Number(match[3]), Number(match[4])];
  }
  return found;
}

const THEMES: Record<ThemeName, Record<string, Hsl>> = {
  light: tokens(':root {'),
  dark: tokens(":root[data-theme='dark']"),
};

const hex = (hsl: Hsl): string => {
  const [r, g, b] = hslToRgb(hsl);
  const part = (channel: number) =>
    Math.round(channel * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
};

describe('the surfaces a brand colour is judged against', () => {
  it.each(['light', 'dark'] as const)('are the %s theme tokens in styles.css', (theme) => {
    const real = THEMES[theme];
    expect(THEME_SURFACES[theme].background).toEqual(real['background']);
    expect(THEME_SURFACES[theme].card).toEqual(real['card']);
    expect(THEME_SURFACES[theme].mutedForeground).toEqual(real['muted-foreground']);
  });

  it('use the dark ink the dark theme already puts on a primary button', () => {
    expect(THEMES.dark['primary-foreground']).toEqual([200, 40, 7]);
  });
});

describe('the built-in colours', () => {
  it.each(['light', 'dark'] as const)('pass their own rules (%s)', (theme) => {
    expect(primaryProblems(hex(THEMES[theme]['primary'] as Hsl), theme)).toEqual([]);
  });
});

describe('colour maths', () => {
  it('round-trips a colour through HSL closely enough to render the same', () => {
    for (const value of ['#0b6b73', '#ff6a00', '#123456', '#ffffff', '#000000', '#808080']) {
      const rgb = parseHex(value)!;
      const back = hslToRgb(rgbToHsl(rgb));
      for (const i of [0, 1, 2] as const) expect(Math.abs(rgb[i] - back[i])).toBeLessThan(0.01);
    }
  });

  it('measures contrast as WCAG does', () => {
    expect(contrast([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 5);
    expect(contrast([1, 1, 1], [1, 1, 1])).toBeCloseTo(1, 5);
  });

  it('refuses what is not #rrggbb', () => {
    expect(parseHex('red')).toBeNull();
    expect(parseHex('#abc')).toBeNull();
    expect(primaryProblems('red', 'light')).toEqual(['is not a colour written #rrggbb']);
  });
});

describe('which colours are accepted', () => {
  it('accepts a dark teal on the light theme and a bright one on the dark theme', () => {
    expect(primaryProblems('#0b6b73', 'light')).toEqual([]);
    expect(primaryProblems('#3ad0d8', 'dark')).toEqual([]);
  });

  it('refuses a colour too light to read as text on the light theme, saying why', () => {
    const problems = primaryProblems('#7fd6dc', 'light');
    expect(problems.join(' ')).toMatch(/too light to read as text on the light theme/);
    expect(problems.join(' ')).toMatch(/links need 4\.5:1/);
  });

  it('refuses a colour too dark to read as text on the dark theme', () => {
    expect(primaryProblems('#0b6b73', 'dark').join(' ')).toMatch(/too dark to read as text/);
  });

  it('refuses black on the dark theme and white on the light theme', () => {
    expect(primaryProblems('#000000', 'dark')).not.toEqual([]);
    expect(primaryProblems('#ffffff', 'light')).not.toEqual([]);
  });
});

describe('the label on a primary button', () => {
  it('is white on a dark colour and the dark ink on a light one', () => {
    expect(foregroundOn('#0b6b73')).toEqual([0, 0, 100]);
    expect(foregroundOn('#3ad0d8')).toEqual([200, 40, 7]);
  });

  it('falls back to black where neither white nor the ink reaches 4.5:1', () => {
    // The better of white and the ink gets 4.35:1 on this mid-tone; black gets 5.4:1.
    expect(foregroundOn('#6666ff')).toEqual([0, 0, 0]);
  });

  it('always reads at 4.5:1, whatever the colour', () => {
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          const colour = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
          const rendered = hslToRgb(rgbToHsl(parseHex(colour)!));
          expect(contrast(hslToRgb(foregroundOn(colour)), rendered), colour).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      }
    }
  });
});

describe('the variables handed to the stylesheet', () => {
  it('are empty when nothing is configured, so the built-in theme applies', () => {
    expect(brandTheme({})).toEqual({ variables: {}, problems: [] });
  });

  it('carry the light colour and its derived tokens', () => {
    const { variables, problems } = brandTheme({ light: '#0b6b73' });
    expect(problems).toEqual([]);
    expect(Object.keys(variables).sort()).toEqual([
      '--brand-accent',
      '--brand-accent-foreground',
      '--brand-primary',
      '--brand-primary-foreground',
      '--brand-ring',
    ]);
    expect(variables['--brand-primary']).toBe(variables['--brand-ring']);
    expect(variables['--brand-primary-foreground']).toBe('0 0% 100%');
  });

  it('keep the two themes apart: a light colour sets no dark variable and vice versa', () => {
    expect(
      Object.keys(brandTheme({ light: '#0b6b73' }).variables).some((k) => k.includes('dark')),
    ).toBe(false);
    const dark = brandTheme({ dark: '#3ad0d8' }).variables;
    expect(Object.keys(dark).every((k) => k.includes('dark'))).toBe(true);
  });

  it('emit nothing for a refused colour, and say which setting and why', () => {
    const { variables, problems } = brandTheme({ light: '#7fd6dc', dark: '#3ad0d8' });
    expect(Object.keys(variables).some((k) => !k.includes('dark'))).toBe(false);
    expect(problems.join(' ')).toMatch(/^BRAND_COLOR #7fd6dc is too light/);
    expect(brandTheme({ dark: '#0b6b73' }).problems.join(' ')).toMatch(/^BRAND_COLOR_DARK #0b6b73/);
  });

  it('derive a grey tint, not a red one, from a grey brand', () => {
    const accent = accentFor('#444444', 'light');
    expect(accent?.surface[1]).toBe(0);
    expect(accent?.text[1]).toBe(0);
  });

  it('format tokens the way the stylesheet writes them', () => {
    expect(formatHsl([186, 88, 24])).toBe('186 88% 24%');
  });
});

/**
 * The independent check. Sweep colours through both themes; for every one the module accepts,
 * recompute each pair `contrast.test.ts` asserts, from the tokens parsed out of the stylesheet,
 * with the brand tokens substituted. If this and `brand.ts` ever disagree, a colour is being
 * accepted that the design-token proof would have refused.
 */
describe('every accepted colour satisfies every pair the design-token proof enforces', () => {
  const over = (
    f: readonly number[],
    b: readonly number[],
    alpha: number,
  ): [number, number, number] => [
    (f[0] as number) * alpha + (b[0] as number) * (1 - alpha),
    (f[1] as number) * alpha + (b[1] as number) * (1 - alpha),
    (f[2] as number) * alpha + (b[2] as number) * (1 - alpha),
  ];

  for (const theme of ['light', 'dark'] as const) {
    it(`${theme} theme`, () => {
      const real = THEMES[theme];
      const rgb = (name: string) => hslToRgb(real[name] as Hsl);
      let accepted = 0;
      let refused = 0;

      for (let hue = 0; hue < 360; hue += 15) {
        for (const saturation of [10, 45, 80, 100]) {
          for (let lightness = 6; lightness <= 96; lightness += 3) {
            const colour = hex([hue, saturation, lightness]);
            const { variables, problems } = brandTheme(
              theme === 'light' ? { light: colour } : { dark: colour },
            );
            if (problems.length > 0) {
              refused += 1;
              expect(variables, colour).toEqual({});
              continue;
            }
            accepted += 1;

            const suffix = theme === 'light' ? '' : '-dark';
            const token = (name: string): Hsl => {
              const raw = variables[name];
              if (raw === undefined)
                return real[name.replace(/^--brand-/, '').replace(suffix, '')] as Hsl;
              const [h, s, l] = raw.replace(/%/g, '').split(' ').map(Number);
              return [h as number, s as number, l as number];
            };
            const primary = hslToRgb(token(`--brand-primary${suffix}`));
            const primaryFg = hslToRgb(token(`--brand-primary${suffix}-foreground`));
            const ring = hslToRgb(token(`--brand-ring${suffix}`));
            const accent =
              variables[`--brand-accent${suffix}`] === undefined
                ? rgb('accent')
                : hslToRgb(token(`--brand-accent${suffix}`));
            const accentFg =
              variables[`--brand-accent${suffix}`] === undefined
                ? rgb('accent-foreground')
                : hslToRgb(token(`--brand-accent${suffix}-foreground`));

            for (const surface of ['background', 'card']) {
              const base = rgb(surface);
              expect(
                contrast(primary, base),
                `${colour} as links on ${surface}`,
              ).toBeGreaterThanOrEqual(4.5);
              expect(
                contrast(primary, over(primary, base, 0.15)),
                `${colour} badge on ${surface}`,
              ).toBeGreaterThanOrEqual(4.5);
              expect(
                contrast(ring, base),
                `${colour} focus ring on ${surface}`,
              ).toBeGreaterThanOrEqual(3);
            }
            expect(contrast(primaryFg, primary), `${colour} button label`).toBeGreaterThanOrEqual(
              4.5,
            );
            expect(contrast(accentFg, accent), `${colour} selected row`).toBeGreaterThanOrEqual(
              4.5,
            );
            expect(
              contrast(rgb('muted-foreground'), accent),
              `${colour} secondary text on a hovered row`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
      // The sweep must actually exercise both outcomes, or it proves nothing.
      expect(accepted).toBeGreaterThan(100);
      expect(refused).toBeGreaterThan(100);
    });
  }
});
