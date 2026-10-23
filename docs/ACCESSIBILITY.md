# Accessibility

The target is WCAG 2.1 AA (MVP_SPEC §9, CLAUDE.md §9). This is what has been checked, how, what it
found, and, as important, what it cannot tell you.

> **Status:** a first pass, run on 2026-10-23. It is a floor, not a certificate. No screen reader has
> been used on this product, no one with a disability has used it, and nothing here has been audited
> by a specialist. Do not claim conformance on the strength of it.

## 1. What is automated

`apps/web/e2e/accessibility.spec.ts` runs in Playwright against a **production build**, signed in as an
owner, over the twelve screens the product ships (dashboard, My Day, contacts, leads, accounts, deals,
import, field settings, team, security, audit log, setup), **in light and in dark mode**. No scanner was
added to the dependency tree (CLAUDE.md §11.4: ask before adding one); these are the checks a scanner
would make that can be made from the page itself.

| WCAG         | What is checked                                                                                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1.1, 4.1.2 | Every button, link and form control has an accessible name (label, `aria-label`, `aria-labelledby`, text, image alt, SVG title). Every image has an `alt` attribute.                                                                                             |
| 1.3.1, 2.4.6 | One `h1`; headings never skip a level; exactly one `main` landmark; a `nav` landmark.                                                                                                                                                                            |
| 2.4.1        | The `main` landmark is the way past the navigation.                                                                                                                                                                                                              |
| 2.4.2, 3.1.1 | The page has a title; the document has a language.                                                                                                                                                                                                               |
| 2.4.3, 2.4.7 | No positive `tabindex`; no duplicate ids; the sign-in form is reachable and operable by keyboard alone; every focusable element on four main screens shows a focus indicator (an outline or a shadow) when it receives focus.                                    |
| 1.4.3        | Text contrast, computed from the colours the browser actually painted: each visible text run against the backgrounds composited beneath it, with opacity applied, 4.5:1 (3:1 for large text). Backgrounds that are images or gradients are skipped, not guessed. |

### The checks are themselves checked

A clean result means "the page is fine" or "the checker is blind", and only one of those is useful.
So the same file plants known violations and demands they are caught: grey on white and faded white on
near-black for contrast; an unlabelled input, a nameless button, a skipped heading, an image with no alt
and a missing language for structure; and a well-formed page that must produce no findings. The contrast
check also fails if it examined fewer than ten text runs on a real page.

## 2. What it found

One defect across twelve screens and two colour modes: **the audit log had no `h1`**. It was the only
screen that titled itself with a card heading instead of the shared `PageHeader`. Fixed by using
`PageHeader`, which also removes the duplicated heading. Everything else passed on the first run,
including contrast in both modes, which says the design tokens were chosen with contrast in mind.

## 3. What it cannot tell you (do these by hand)

An automated check cannot judge meaning or experience. Still to do, and worth a day of someone's time
before a paid launch:

- **A screen reader** (NVDA with Firefox or Chrome on Windows, VoiceOver on macOS and iOS, TalkBack on
  Android) through the critical flows: sign in, create a contact, edit inline, move a deal, import a
  file, use the command palette. Listen for: labels that are present but meaningless ("button"),
  announcements for loading, errors and saved states, the order things are read in against the order
  they appear.
- **Keyboard-only use of the dense screens**: the deals board's drag and drop has a keyboard path to
  verify; the command palette's focus trap and return; dialogs' focus return; the keyboard shortcuts
  (`G then H`, `C`) against people who use assistive technology that claims single keys.
- **Zoom and reflow**: 200% and 400% browser zoom, a 320 px viewport, text-only zoom. Tables are the
  likely failure.
- **Reduced motion and forced colours** (Windows high contrast): not checked at all.
- **Touch targets** (2.5.8 is WCAG 2.2) and the mobile layouts: not checked.
- **Language of parts**, and right-to-left scripts: the product's first market writes in Devanagari
  and other scripts (MVP_SPEC §1); the search tokenizer was built for it, the interface has not been
  checked in it.
- **Error identification and suggestions** (3.3.1, 3.3.3) in forms: that the text of each error makes
  sense is a reading task.
- **Time limits** (2.2.1): a session lasts 14 days (`SESSION_TTL_DAYS`), and nothing warns before it ends or offers to extend it.

## 4. Running it

```bash
bash <your e2e script> e2e/accessibility.spec.ts     # builds, seeds, serves, runs, tears down
```

It needs the same stack as the other end-to-end tests (a built API, worker and web, Postgres, MinIO and
the demo seed). It takes about a minute. A failure prints the page, the element and the rule:

    /settings/audit-log: expected one h1, found 0
    /contacts: contrast 3.12:1 (needs 4.5:1) for "Last contacted" in <span>

Add a screen to `PAGES` when one ships; a screen that is not in the list is not checked.

## 5. If you want a scanner

`@axe-core/playwright` would add checks this file does not make (ARIA validity, table structure,
landmark uniqueness across frames, form-field autocomplete values), at the cost of a dependency. It was
not added without asking, and it would complement these checks, not replace them. Say the word and it
is an hour's work.
