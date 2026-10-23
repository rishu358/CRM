import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The accessibility pass (MVP_SPEC §9: WCAG 2.1 AA; CLAUDE.md §9).
 *
 * No scanner is added to the dependency tree (CLAUDE.md §11.4); these are the checks a scanner
 * would make that can be made from the page itself, run on the pages the product ships, as a
 * signed-in user, through a production build, in both colour schemes:
 *
 *   - 1.1.1 / 4.1.2  every control and every image has a name a screen reader can say;
 *   - 1.3.1 / 2.4.6  one `h1`, headings that do not skip a level, one `main`, a `nav`;
 *   - 2.4.1          a way past the navigation: the `main` landmark;
 *   - 2.4.2 / 3.1.1  a page title, a document language;
 *   - 2.4.3 / 2.4.7  nothing steals the tab order, and whatever takes focus shows it;
 *   - 1.4.3          text contrast, computed from the colours the browser actually painted.
 *
 * What a script cannot establish stays manual and is written down in docs/ACCESSIBILITY.md:
 * whether a label is *meaningful*, reading order against visual order, and how a screen reader
 * announces a live region. This is a floor, not a certificate.
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as { owner: string; password: string };

const PAGES = [
  '/dashboard',
  '/my-day',
  '/contacts',
  '/leads',
  '/accounts',
  '/deals',
  '/import',
  '/settings/fields',
  '/settings/team',
  '/settings/security',
  '/settings/audit-log',
  '/setup',
];

async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(credentials.owner);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
}

/** Everything that can be checked from the DOM alone. Returns a list of findings, empty if clean. */
function structuralFindings(): string[] {
  const findings: string[] = [];
  const describe = (element: Element): string => {
    const id = element.id === '' ? '' : `#${element.id}`;
    const classes =
      typeof element.className === 'string' && element.className.trim() !== ''
        ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
    return `${element.tagName.toLowerCase()}${id}${classes}`;
  };
  const visible = (element: Element): boolean => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      (box.width > 0 || box.height > 0) &&
      element.closest('[hidden], [aria-hidden="true"], [inert]') === null
    );
  };
  const textOf = (element: Element): string =>
    (element.textContent ?? '').replace(/\s+/g, ' ').trim();

  /** The accessible name, by the rules that matter here (not the whole accname algorithm). */
  const nameOf = (element: Element): string => {
    const labelledby = element.getAttribute('aria-labelledby');
    if (labelledby !== null) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .map((target) => (target === null ? '' : textOf(target)))
        .join(' ')
        .trim();
      if (text !== '') return text;
    }
    const label = element.getAttribute('aria-label')?.trim();
    if (label !== undefined && label !== '') return label;
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    ) {
      const labels = Array.from(element.labels ?? [])
        .map(textOf)
        .join(' ')
        .trim();
      if (labels !== '') return labels;
      if (
        element instanceof HTMLInputElement &&
        ['button', 'submit', 'reset'].includes(element.type)
      ) {
        return element.value.trim();
      }
    }
    const own = textOf(element);
    if (own !== '') return own;
    const img = element.querySelector('img[alt]');
    if (img !== null && (img.getAttribute('alt') ?? '').trim() !== '')
      return img.getAttribute('alt')!.trim();
    const svgTitle = element.querySelector('svg title');
    if (svgTitle !== null && textOf(svgTitle) !== '') return textOf(svgTitle);
    return (element.getAttribute('title') ?? '').trim();
  };

  // Names.
  for (const element of document.querySelectorAll(
    'button, [role="button"], a[href], [role="link"]',
  )) {
    if (visible(element) && nameOf(element) === '')
      findings.push(`no accessible name: ${describe(element)}`);
  }
  for (const element of document.querySelectorAll('input, select, textarea')) {
    if (element instanceof HTMLInputElement && ['hidden'].includes(element.type)) continue;
    if (visible(element) && nameOf(element) === '') findings.push(`no label: ${describe(element)}`);
  }
  for (const element of document.querySelectorAll('img')) {
    if (visible(element) && !element.hasAttribute('alt'))
      findings.push(`image without alt: ${describe(element)}`);
  }

  // Document.
  if ((document.documentElement.lang ?? '').trim() === '')
    findings.push('the document has no language');
  if (document.title.trim() === '') findings.push('the page has no title');

  // Landmarks and headings.
  const mains = Array.from(document.querySelectorAll('main, [role="main"]')).filter(visible);
  if (mains.length !== 1)
    findings.push(`expected one main landmark, found ${String(mains.length)}`);
  if (
    Array.from(document.querySelectorAll('nav, [role="navigation"]')).filter(visible).length === 0
  ) {
    findings.push('no navigation landmark');
  }
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).filter(visible);
  const h1s = headings.filter((heading) => heading.tagName === 'H1');
  if (h1s.length !== 1) findings.push(`expected one h1, found ${String(h1s.length)}`);
  let previous = 0;
  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1));
    if (previous !== 0 && level > previous + 1) {
      findings.push(
        `heading level jumps from h${String(previous)} to h${String(level)}: "${textOf(heading).slice(0, 40)}"`,
      );
    }
    previous = level;
  }

  // Ids and tab order.
  const seen = new Set<string>();
  for (const element of document.querySelectorAll('[id]')) {
    if (seen.has(element.id)) findings.push(`duplicate id: ${element.id}`);
    seen.add(element.id);
  }
  for (const element of document.querySelectorAll('[tabindex]')) {
    if (Number(element.getAttribute('tabindex')) > 0)
      findings.push(`positive tabindex: ${describe(element)}`);
  }
  return findings;
}

/** Text contrast (1.4.3), from computed colours: the ratio of each visible text run to what is behind it. */
function contrastFindings(): { checked: number; findings: string[] } {
  type Rgba = [number, number, number, number];
  const canvas = document.createElement('canvas').getContext('2d');
  if (canvas === null) return { checked: 0, findings: ['no canvas to resolve colours with'] };

  /** Resolve any CSS colour (including `oklch()` / `color-mix()`) to sRGB through a 1x1 canvas. */
  const resolve = (value: string): Rgba => {
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = '#000';
    canvas.fillStyle = value;
    canvas.fillRect(0, 0, 1, 1);
    const data = canvas.getImageData(0, 0, 1, 1).data;
    return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, (data[3] ?? 0) / 255];
  };
  const over = (top: Rgba, bottom: Rgba): Rgba => {
    const alpha = top[3] + bottom[3] * (1 - top[3]);
    if (alpha === 0) return [0, 0, 0, 0];
    const mix = (a: number, b: number) => (a * top[3] + b * bottom[3] * (1 - top[3])) / alpha;
    return [mix(top[0], bottom[0]), mix(top[1], bottom[1]), mix(top[2], bottom[2]), alpha];
  };
  const luminance = ([r, g, b]: Rgba): number => {
    const channel = (value: number) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (a: Rgba, b: Rgba): number => {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (light + 0.05) / (dark + 0.05);
  };

  /** What is painted behind an element: backgrounds composited from the root down. */
  const backgroundOf = (element: Element): Rgba | null => {
    const stack: Element[] = [];
    for (let current: Element | null = element; current !== null; current = current.parentElement) {
      const style = getComputedStyle(current);
      // A background image or gradient cannot be resolved to one colour: skip, do not guess.
      if (style.backgroundImage !== 'none') return null;
      stack.push(current);
    }
    let result: Rgba = resolve(getComputedStyle(document.body).backgroundColor);
    if (result[3] === 0) result = [255, 255, 255, 1];
    for (const node of stack.reverse()) {
      const colour = resolve(getComputedStyle(node).backgroundColor);
      if (colour[3] > 0) result = over(colour, result);
    }
    return result;
  };

  const findings: string[] = [];
  let examined = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const checked = new Set<Element>();
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const element = node.parentElement;
    if (element === null || checked.has(element) || (node.textContent ?? '').trim() === '')
      continue;
    checked.add(element);
    if (element.closest('script, style, noscript, [hidden], [aria-hidden="true"]') !== null)
      continue;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    if (
      style.visibility === 'hidden' ||
      style.display === 'none' ||
      box.width === 0 ||
      box.height === 0
    )
      continue;
    // Disabled controls are exempt from 1.4.3.
    if (element.closest(':disabled, [aria-disabled="true"]') !== null) continue;

    const background = backgroundOf(element);
    if (background === null) continue;
    examined += 1;
    let foreground = resolve(style.color);
    // Opacity of the element and its ancestors dims the text.
    let opacity = 1;
    for (let current: Element | null = element; current !== null; current = current.parentElement) {
      opacity *= Number(getComputedStyle(current).opacity);
    }
    foreground = [foreground[0], foreground[1], foreground[2], foreground[3] * opacity];
    const painted = over(foreground, background);

    const size = Number.parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const needed = large ? 3 : 4.5;
    const got = ratio(painted, background);
    if (got < needed) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      findings.push(
        `contrast ${got.toFixed(2)}:1 (needs ${String(needed)}:1) for "${text}" in <${element.tagName.toLowerCase()}>`,
      );
    }
  }
  return { checked: examined, findings };
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test('every page has names, landmarks, headings, a title and a language', async ({ page }) => {
      await signIn(page);
      const problems: string[] = [];
      for (const path of PAGES) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        for (const finding of await page.evaluate(structuralFindings))
          problems.push(`${path}: ${finding}`);
      }
      expect(problems).toEqual([]);
    });

    test('text has enough contrast on every page (WCAG 1.4.3)', async ({ page }) => {
      await signIn(page);
      const problems: string[] = [];
      for (const path of PAGES) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const { checked, findings } = await page.evaluate(contrastFindings);
        // A check that examined nothing passes everything: demand it looked at real text.
        if (checked < 10) problems.push(`${path}: only ${String(checked)} text runs were examined`);
        for (const finding of findings) problems.push(`${path}: ${finding}`);
      }
      expect(problems).toEqual([]);
    });
  });
}

test.describe('keyboard', () => {
  test('the sign-in form is reachable and operable from the keyboard alone, with focus shown', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    const stops: string[] = [];
    const unseen: string[] = [];
    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press('Tab');
      const state = await page.evaluate(() => {
        const element = document.activeElement;
        if (element === null || element === document.body) return null;
        const style = getComputedStyle(element);
        const outlined = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
        const shadowed = style.boxShadow !== 'none';
        const label =
          element.getAttribute('aria-label') ??
          (element as HTMLInputElement).labels?.[0]?.textContent ??
          element.textContent ??
          element.tagName;
        return { label: label.trim().slice(0, 40), shown: outlined || shadowed };
      });
      if (state === null) continue;
      stops.push(state.label);
      if (!state.shown) unseen.push(state.label);
    }
    // Email, password, sign in, and the links around them, in order, none lost.
    expect(stops.length).toBeGreaterThanOrEqual(3);
    expect(unseen).toEqual([]);

    // And the form works without a pointer.
    await page.getByLabel('Email address').focus();
    await page.keyboard.type(credentials.owner);
    await page.keyboard.press('Tab');
    await page.keyboard.type(credentials.password);
    await page.keyboard.press('Enter');
    await page.waitForURL('**/dashboard');
  });

  test('every focusable thing on the main pages shows where focus is', async ({ page }) => {
    await signIn(page);
    const unseen: string[] = [];
    for (const path of ['/dashboard', '/contacts', '/deals', '/settings/fields']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const count = await page.evaluate(
        () =>
          document.querySelectorAll('a[href], button, input, select, textarea, [tabindex="0"]')
            .length,
      );
      for (let press = 0; press < Math.min(count, 40); press += 1) {
        await page.keyboard.press('Tab');
        const state = await page.evaluate(() => {
          const element = document.activeElement;
          if (element === null || element === document.body) return null;
          const style = getComputedStyle(element);
          const outlined =
            style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
          return {
            shown: outlined || style.boxShadow !== 'none',
            label: `${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 30)}"`,
          };
        });
        if (state !== null && !state.shown) unseen.push(`${path}: ${state.label}`);
      }
    }
    expect(unseen).toEqual([]);
  });
});

test.describe('the checks catch what they claim to', () => {
  // Without these a clean result could mean "the page is fine" or "the checker is blind".
  test('contrast: flags grey on white and passes black on white, in the same page', async ({
    page,
  }) => {
    await page.setContent(
      '<body style="background:#fff"><p id="bad" style="color:#999">Low contrast text here</p>' +
        '<p id="good" style="color:#000">High contrast text here</p></body>',
    );
    const { findings } = await page.evaluate(contrastFindings);
    expect(findings.some((finding) => finding.includes('Low contrast'))).toBe(true);
    expect(findings.some((finding) => finding.includes('High contrast'))).toBe(false);
  });

  test('contrast: sees through opacity and dark backgrounds', async ({ page }) => {
    await page.setContent(
      '<body style="background:#111"><p style="color:#222">Dark on dark</p>' +
        '<p style="color:#fff;opacity:0.2">Faded white</p></body>',
    );
    const { findings } = await page.evaluate(contrastFindings);
    expect(findings.filter((finding) => /Dark on dark|Faded white/.test(finding))).toHaveLength(2);
  });

  test('structure: flags an unlabelled input, a nameless button, a skipped heading and a missing language', async ({
    page,
  }) => {
    await page.setContent(
      '<html><head><title>t</title></head><body><main><h1>One</h1><h3>Skipped</h3>' +
        '<input id="x"><button></button><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main></body></html>',
    );
    const findings = (await page.evaluate(structuralFindings)).join(' | ');
    expect(findings).toContain('no label');
    expect(findings).toContain('no accessible name');
    expect(findings).toContain('heading level jumps');
    expect(findings).toContain('image without alt');
    expect(findings).toContain('no navigation landmark');
  });

  test('structure: a labelled, well-formed page has no findings', async ({ page }) => {
    await page.setContent(
      '<html lang="en"><head><title>Fine</title></head><body><nav><a href="/x">Home</a></nav><main><h1>One</h1><h2>Two</h2>' +
        '<label for="e">Email</label><input id="e"><button>Save</button></main></body></html>',
    );
    expect(await page.evaluate(structuralFindings)).toEqual([]);
  });
});
