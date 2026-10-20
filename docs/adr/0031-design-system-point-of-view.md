# ADR-0031: The design system has a point of view, and accessibility is a test

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

CLAUDE.md §9 says every component comes from `packages/ui`, and that light and
dark mode are driven by CSS variables. That made the system _consistent_. It did
not make it _designed_: the tokens were a neutral grey-and-blue shadcn default,
type was the browser's, every surface had the same border, spacing was uniform,
and the product looked like any other admin template. Nine screens had been
built on it, and the remaining ones would inherit whatever it was.

Doing the pass now, before the rest of the screens, is cheaper than doing it
after. It is also the last moment it is cheap to change the _shape_ of the
system — which is what this record fixes — because every later screen will be
written against it.

## Decision

**The design system makes choices, and the choices live in two files**:
`packages/config/tailwind/preset.js` (scales) and `packages/ui/src/styles.css`
(colour). Components reference semantic names only.

### 1. Overriding Tailwind's scales, rather than adding parallel names

`text-sm` is the body size; `shadow-md` is the floating elevation; `rounded-lg`
is a surface. The preset _replaces_ Tailwind's `fontSize` scale and the shadow
and radius steps. The alternative — new names (`text-body`, `shadow-float`) —
would have left every existing class in the app on the old values and made the
pass a find-and-replace across nine screens. Overriding means a change to the
scale reaches everything at once, and a screen written next year with `text-sm`
gets the right thing without having read this.

- **Type:** 11 / 12 / 13 / 14 / 16 / 20 / 24 / 30 px on a 4px line-height grid,
  tracking tightening as size grows. **13px is the working size** — a CRM is read
  as tables, and a 16px table is a table you scroll. The system font stack is
  kept, with tabular lining figures (`.figures`) for money, counts and dates.
- **Elevation:** three steps — resting, floating, overlay — tinted with the ink
  colour, not black.
- **Radius:** controls < surfaces < dialogs, so nesting reads as nesting.
- **Motion:** two durations (120 / 180 ms), one easing, and one entrance
  (`pop-in`) used only for something the user just asked for. Nothing animates
  for decoration, and `prefers-reduced-motion` turns all of it off globally.

### 2. One accent, with a reserved meaning

The page is a quiet cool-tinted paper; content sits on pure-white surfaces above
it, so hierarchy is one step of lightness rather than a border on everything.
**Teal is the only accent and means "you can act on this"**; green, amber and red
are reserved for won, waiting and lost/overdue. Open stages on the deal board
narrow through tints of the accent, as a funnel does.

### 3. Accessibility is enforced by a test, not by a promise

`packages/ui/src/contrast.test.ts` parses `styles.css` and fails if any
foreground/background pair a component can render drops under WCAG 2.1 AA, in
**both** themes:

- 4.5:1 for text, including badge text on its 15% tint;
- 3:1 for the edge of a control and for the focus ring (1.4.11).

The old input border was `--border` (about 1.3:1 against white), which is a real
non-text-contrast failure; control borders now use `--input`, which clears 3:1.
The test also asserts the two dark blocks (OS preference and explicit choice)
are identical, since they are duplicated by design (see the comment in
`styles.css`) and drift between them is exactly the bug that would be invisible
until someone with a dark OS and a light override hit it.

### 4. One dialog, on the platform's element

Nine screens each hand-built a modal; one of them trapped focus. `Dialog` in
`packages/ui` is the native `<dialog>` opened with `showModal()`, which gives
focus trapping, an inert background, top-layer stacking and Escape handling from
the browser instead of from nine re-implementations. It restores focus on close
and locks page scroll. Closing is always the caller's decision (`onClose`), so a
dialog with a request in flight can refuse.

### 5. Keyboard-first is part of the system

Single-key shortcuts live in `apps/web/src/lib/shortcuts.ts` and one global
handler: `C` creates on the current list, `G` then a letter navigates, `?` lists
them all, and `Ctrl`/`Cmd`+`K` / `/` open the palette. They are ignored while
typing, while any modal is open, and when a modifier is held. A shortcut calls
the same handler the visible button calls, so it can do nothing a button could
not, and authorization is exactly where it was.

### 6. Icons

`lucide-react`, re-exported from `packages/ui/src/icons.ts` **under our own
names**. Screens import `SearchIcon` from `@crm/ui`, never from the vendor, so
swapping the set is one file. Each icon is tree-shaken individually. Icons are
decorative (`aria-hidden`) and always sit beside a text label; an icon that is
the only thing in a control goes through `IconButton`, which requires the label.
This is the one dependency added to §2's table.

### 7. The system font stack was kept

A webfont would add a network dependency to `pnpm build` (a required gate) and a
font swap to first paint, against a performance budget stated in seconds. The
platform faces carry the tabular figures that matter in a table of money.

## Consequences

- **Good.** A change to the scale or the palette is one edit and reaches every
  screen; a contrast regression fails `pnpm test`; every modal behaves the same;
  a new screen is built from `PageHeader`, `Toolbar`, the table kit and the four
  state components and looks like the rest without effort.
- **Cost.** Overriding Tailwind's scale means a future contributor's mental model
  of `text-sm` from other projects is off by a pixel; the preset's comment says
  so. Teal as the single accent is a brand decision a tenant theme will want to
  override — which is what `--primary` and `--accent` being variables is for.
- **Not decided here.** A theme switcher UI, a webfont, saved density preferences
  and a tenant brand-colour setting. Each is additive on top of this.
