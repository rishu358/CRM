'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, cn } from '@crm/ui';
import { t, type TranslationKey } from '../lib/i18n';
import { requestIntent, type PaletteIntent } from '../lib/palette-intent';
import {
  MIN_SEARCH_LENGTH,
  useDebounced,
  useSearch,
  type SearchObjectType,
  type SearchResultRecord,
} from '../lib/search';

/**
 * The command palette (MVP_SPEC M7, UX principle 3: keyboard-first).
 *
 * `Ctrl`/`Cmd` + `K` anywhere, or `/` when the caret is not already in a
 * field. Arrow keys move, Enter opens, Escape closes and puts focus back on
 * the button that opened it — so it can be used from end to end without a
 * mouse, which is the point of it rather than a nicety.
 *
 * The listbox follows the ARIA combobox pattern: focus stays in the input and
 * `aria-activedescendant` names the highlighted option, so a screen reader
 * announces each row as the arrow keys move without focus ever leaving the
 * text the user is typing.
 *
 * It renders what the API returned and nothing else. There is no filtering,
 * no "hide this type", no second guess about what the signed-in user may see
 * — every one of those decisions is made server-side (ADR-0028), and a
 * component that made them too would be a component that could disagree.
 */
interface PaletteItem {
  readonly key: string;
  readonly label: string;
  /** The small line underneath: the object type, or the matched value. */
  readonly detail: string;
  readonly href: string;
  readonly intent?: PaletteIntent;
}

/** Where a record of each type lives. */
const RECORD_PATHS: Readonly<Record<SearchObjectType, (id: string) => string>> = {
  account: (id) => `/accounts/${id}`,
  contact: (id) => `/contacts/${id}`,
  lead: (id) => `/leads/${id}`,
  deal: (id) => `/deals/${id}`,
  // Activities have no page of their own yet; My Day is where they are read.
  activity: () => '/my-day',
};

const OBJECT_LABELS: Readonly<Record<SearchObjectType, TranslationKey>> = {
  account: 'palette.objectType.account',
  contact: 'palette.objectType.contact',
  lead: 'palette.objectType.lead',
  deal: 'palette.objectType.deal',
  activity: 'palette.objectType.activity',
};

/**
 * The commands, which are the same whatever has been typed.
 *
 * Deliberately short. A palette that lists forty things is a menu, and a menu
 * is what the sidebar already is.
 */
const ACTIONS: readonly {
  key: string;
  label: TranslationKey;
  href: string;
  intent?: PaletteIntent;
}[] = [
  { key: 'new-deal', label: 'palette.action.newDeal', href: '/deals', intent: 'new-deal' },
  { key: 'go-my-day', label: 'palette.action.goToMyDay', href: '/my-day' },
  { key: 'go-deals', label: 'palette.action.goToDeals', href: '/deals' },
  { key: 'go-team', label: 'palette.action.goToTeam', href: '/settings/team' },
  { key: 'go-settings', label: 'palette.action.goToSettings', href: '/settings/security' },
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const debounced = useDebounced(term);
  const search = useSearch(debounced);

  const close = useCallback(() => {
    setOpen(false);
    setTerm('');
    setActive(0);
    // Focus goes back where it came from. Leaving it on <body> would drop a
    // keyboard user at the top of the page every time they closed this.
    triggerRef.current?.focus();
  }, []);

  /**
   * The global shortcut.
   *
   * `Ctrl`/`Cmd` + `K` works wherever the caret is, because that is the
   * contract of that particular chord. `/` only works when the caret is not
   * in a field — otherwise typing a URL or a price into any input on the page
   * would open this instead.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
        return;
      }
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !isTyping(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /**
   * Closing by clicking away.
   *
   * Listened for on the document rather than put on a backdrop element,
   * because a `div` that swallows clicks is an interactive control with no
   * role, no focus and no keyboard equivalent. Keyboard users close with
   * Escape, which is handled where the focus actually is.
   */
  useEffect(() => {
    if (!open) return undefined;
    const onMouseDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (dialogRef.current?.contains(event.target) === true) return;
      close();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, close]);

  const matchingActions = useMemo(() => filterActions(term), [term]);

  const items = useMemo<PaletteItem[]>(() => {
    const results = (search.data?.data ?? []).map(toItem);
    // Records first once there is a term: somebody who typed a name wants the
    // person, and the commands they might also have meant stay one key away.
    return [...results, ...matchingActions];
  }, [search.data, matchingActions]);

  /**
   * The highlighted row, clamped rather than reset.
   *
   * Results arrive a moment after the keystroke that asked for them, so the
   * list can get shorter underneath a selection. Clamping at render keeps the
   * highlight valid without a state update inside an effect, which would make
   * React render twice before it painted. Typing resets it to the top, which
   * is what the `onChange` below does.
   */
  const activeIndex = items.length === 0 ? 0 : Math.min(active, items.length - 1);

  const choose = useCallback(
    (item: PaletteItem) => {
      close();
      if (item.intent !== undefined) requestIntent(item.intent);
      router.push(item.href);
    },
    [close, router],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close();
        return;
      case 'ArrowDown':
        event.preventDefault();
        if (items.length > 0) setActive((index) => (index + 1) % items.length);
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (items.length > 0) setActive((index) => (index - 1 + items.length) % items.length);
        return;
      case 'Home':
        event.preventDefault();
        setActive(0);
        return;
      case 'End':
        event.preventDefault();
        setActive(Math.max(0, items.length - 1));
        return;
      case 'Enter': {
        event.preventDefault();
        const item = items[activeIndex];
        if (item !== undefined) choose(item);
        return;
      }
      case 'Tab':
        // The dialog holds exactly one focusable element, so trapping focus
        // is simply refusing to leave it while the dialog is open.
        event.preventDefault();
        return;
      default:
    }
  };

  const activeItem = items[activeIndex];

  return (
    <>
      <Button
        ref={triggerRef}
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="palette-trigger"
        aria-keyshortcuts="Control+K Meta+K"
      >
        {t('palette.open')}
        <kbd className="ml-2 rounded border border-border px-1 text-xs text-muted-foreground">
          {t('palette.shortcut')}
        </kbd>
      </Button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('palette.title')}
            data-testid="palette"
            className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-card shadow-xl"
          >
            <div className="border-b border-border p-2">
              {/*
                Every key is handled here rather than on the dialog: focus
                never leaves this input, so this is where the events actually
                are, and a handler on a wrapping div would be a keyboard
                listener on something that cannot be focused.
              */}
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-autocomplete="list"
                aria-label={t('palette.title')}
                aria-activedescendant={
                  activeItem === undefined ? undefined : optionId(listId, activeIndex)
                }
                data-testid="palette-input"
                placeholder={t('palette.placeholder')}
                value={term}
                onKeyDown={onKeyDown}
                onChange={(event) => {
                  setTerm(event.target.value);
                  // A different query means a different list; start at the top
                  // rather than leaving the highlight on row four of something
                  // the user has not seen yet.
                  setActive(0);
                }}
                className="w-full bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>

            <div
              id={listId}
              role="listbox"
              aria-label={t('palette.results')}
              className="max-h-80 overflow-y-auto p-1"
            >
              {items.map((item, index) => (
                <button
                  key={item.key}
                  type="button"
                  id={optionId(listId, index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  // Out of the tab order on purpose: this is the ARIA combobox
                  // pattern, where focus stays in the input and
                  // `aria-activedescendant` says which row is current. Tabbing
                  // through ten results to reach the status line would be a
                  // worse experience, not a more accessible one.
                  tabIndex={-1}
                  data-testid="palette-option"
                  className={cn(
                    'block w-full rounded-md px-3 py-2 text-left text-sm',
                    index === activeIndex ? 'bg-accent text-accent-foreground' : 'text-foreground',
                  )}
                  // Keep the caret where it is: a click must not move focus out
                  // of the input, or the next arrow key would go nowhere.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(item)}
                >
                  <span className="block font-medium">{item.label}</span>
                  <span className="block text-xs text-muted-foreground">{item.detail}</span>
                </button>
              ))}
            </div>

            <div
              role="status"
              aria-live="polite"
              className="border-t border-border px-4 py-2 text-xs text-muted-foreground"
            >
              {statusLine(term, search, items.length)}
            </div>
            <p className="px-4 pb-2 text-xs text-muted-foreground">{t('palette.hint')}</p>
          </div>
        </div>
      ) : null}
    </>
  );
}

function optionId(listId: string, index: number): string {
  return `${listId}-option-${String(index)}`;
}

function toItem(result: SearchResultRecord): PaletteItem {
  const typeLabel = t(OBJECT_LABELS[result.objectType]);
  // The snippet is the value of the field that matched — and only ever a
  // field the signed-in user may read (ADR-0028). Repeating it when it is the
  // title would just be the same words twice.
  const detail = result.snippet === result.title ? typeLabel : `${typeLabel} · ${result.snippet}`;

  return {
    key: `${result.objectType}:${result.id}`,
    label: result.title,
    detail,
    href: RECORD_PATHS[result.objectType](result.id),
  };
}

function filterActions(term: string): PaletteItem[] {
  const needle = term.trim().toLowerCase();
  return ACTIONS.filter(
    (action) => needle === '' || t(action.label).toLowerCase().includes(needle),
  ).map((action) => ({
    key: `action:${action.key}`,
    label: t(action.label),
    detail: t('palette.actions'),
    href: action.href,
    ...(action.intent === undefined ? {} : { intent: action.intent }),
  }));
}

/**
 * One line that says what is going on (CLAUDE.md §9: every screen handles
 * loading, empty, error and no-permission).
 *
 * It is the palette's live region, so it is also what a screen reader
 * announces when a search settles.
 */
function statusLine(term: string, search: ReturnType<typeof useSearch>, count: number): string {
  const trimmed = term.trim();
  if (trimmed.length < MIN_SEARCH_LENGTH) return t('palette.typeMore');
  if (search.isError) {
    return search.error.status === 403 ? t('palette.forbidden') : t('palette.error');
  }
  if (search.isFetching && search.data === undefined) return t('palette.searching');
  if ((search.data?.data.length ?? 0) === 0) {
    return `${t('palette.noResults', { term: trimmed })} ${t('palette.noResultsHint')}`;
  }
  return t('palette.resultCount', { count });
}

/** Whether a key event came from somewhere the user is already typing. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
