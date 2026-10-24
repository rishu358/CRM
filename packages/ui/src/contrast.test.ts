import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 2.1 AA, enforced (MVP_SPEC §9).
 *
 * The tokens in `styles.css` are the only place colour is decided, so this is
 * the only place contrast needs checking: parse the stylesheet, resolve every
 * pair a component can put on screen, and fail if one drops under the line.
 * A designer nudging a lightness by two points gets told at `pnpm test`, not
 * by a user who cannot read a label.
 *
 *   4.5:1  text (1.4.3)
 *   3:1    the edge of a control, and the focus ring (1.4.11)
 */
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

type Tokens = Record<string, [number, number, number]>;

/** Pull `--name: H S% L%;` declarations out of the block that opens at `selector`. */
function block(selector: string): Tokens {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`No block for ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const tokens: Tokens = {};
  for (const match of css
    .slice(open, close)
    // A token may be `H S% L%` or `var(--brand-x, H S% L%)`: the brand variable is only set when an
    // installation configures a colour (ADR-0045), so what is proven here is the built-in fallback.
    .matchAll(/--([a-z-]+):\s*(?:var\(--[a-z-]+,\s*)?([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)?;/g)) {
    tokens[match[1] as string] = [Number(match[2]), Number(match[3]), Number(match[4])];
  }
  return tokens;
}

const light = block(':root {');
const darkOs = block(":root:not([data-theme='light']) {");
const darkExplicit = block(":root[data-theme='dark']");

function rgb([h, s, l]: [number, number, number]): [number, number, number] {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function luminance(color: [number, number, number]): number {
  const [r, g, b] = color.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `foreground` laid over `background` at `alpha`, as the browser would blend it. */
function over(
  foreground: [number, number, number],
  background: [number, number, number],
  alpha: number,
): [number, number, number] {
  return [0, 1, 2].map((i) => foreground[i]! * alpha + background[i]! * (1 - alpha)) as [
    number,
    number,
    number,
  ];
}

const themes = [
  ['light', light],
  ['dark', darkExplicit],
] as const;

describe('design tokens', () => {
  it('declares the same dark palette for the OS preference and the explicit choice', () => {
    expect(darkOs).toEqual(darkExplicit);
  });

  describe.each(themes)('%s theme', (_name, tokens) => {
    const color = (key: string) => rgb(tokens[key] as [number, number, number]);

    // Text pairs a component can render, with the surface each one sits on.
    const text: [string, string, string][] = [
      ['foreground', 'background', 'body text on the page'],
      ['card-foreground', 'card', 'body text on a surface'],
      ['popover-foreground', 'popover', 'text in a menu or dialog'],
      ['muted-foreground', 'background', 'secondary text on the page'],
      ['muted-foreground', 'card', 'secondary text on a surface'],
      ['muted-foreground', 'muted', 'secondary text on a table header'],
      ['muted-foreground', 'secondary', 'secondary text on a chip'],
      ['muted-foreground', 'accent', 'secondary text on a hovered row or menu item'],
      ['primary-foreground', 'primary', 'primary button label'],
      ['secondary-foreground', 'secondary', 'secondary button label'],
      ['accent-foreground', 'accent', 'selected nav item, hovered row'],
      ['destructive-foreground', 'destructive', 'destructive button label'],
      ['success-foreground', 'success', 'success label'],
      ['warning-foreground', 'warning', 'warning label'],
      ['primary', 'card', 'links on a surface'],
      ['primary', 'background', 'links on the page'],
      ['destructive', 'card', 'error text on a surface'],
      ['destructive', 'background', 'error text on the page'],
      ['success', 'card', 'success text on a surface'],
      ['warning', 'card', 'warning text on a surface'],
    ];

    it.each(text)('%s on %s clears 4.5:1 (%s)', (fg, bg) => {
      expect(ratio(color(fg), color(bg))).toBeGreaterThanOrEqual(4.5);
    });

    // Badges tint the surface with the status colour at 15%, then draw text in it.
    it.each(['success', 'warning', 'destructive', 'primary'])(
      'a %s badge on a surface clears 4.5:1',
      (tone) => {
        const tint = over(color(tone), color('card'), 0.15);
        expect(ratio(color(tone), tint)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it.each(['success', 'warning', 'destructive', 'primary'])(
      'a %s badge on the page clears 4.5:1',
      (tone) => {
        const tint = over(color(tone), color('background'), 0.15);
        expect(ratio(color(tone), tint)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it.each(['background', 'card', 'popover'])('a control border clears 3:1 on %s', (surface) => {
      expect(ratio(color('input'), color(surface))).toBeGreaterThanOrEqual(3);
    });

    it.each(['background', 'card'])('the focus ring clears 3:1 on %s', (surface) => {
      expect(ratio(color('ring'), color(surface))).toBeGreaterThanOrEqual(3);
    });
  });
});
