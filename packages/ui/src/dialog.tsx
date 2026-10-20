import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from './cn.js';
import { IconButton } from './button.js';
import { CloseIcon } from './icons.js';

/**
 * A modal dialog, on the platform's own `<dialog>` element.
 *
 * `showModal()` is what makes this a real modal rather than a div that looks
 * like one: the browser traps focus inside it, makes everything behind it inert
 * (so Tab cannot wander into the page and a screen reader cannot read past it),
 * puts it in the top layer above any z-index, and closes it on Escape. Nine
 * hand-built overlays used to do some of that each, and only one of them
 * trapped focus. Doing it once, here, is the point of the design system.
 *
 * Mounted when open, unmounted when closed — the same way the screens already
 * use it — so there is no `open` prop to forget to reset.
 *
 * Closing is the caller's decision: Escape, the backdrop and the close button
 * all call `onClose`, and the caller unmounts. A dialog with a request in
 * flight can therefore refuse by simply not closing.
 */
export function Dialog({
  title,
  description,
  closeLabel,
  onClose,
  size = 'md',
  placement = 'center',
  hideTitle = false,
  children,
  className,
  ...rest
}: {
  title: string;
  description?: string | undefined;
  /** Accessible name of the X button. Passed in because this package has no i18n. */
  closeLabel: string;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg';
  /** `left` is a drawer, for navigation on narrow screens. */
  placement?: 'center' | 'left';
  hideTitle?: boolean;
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  // The latest `onClose`, readable from listeners that are attached once. Kept
  // current in an effect: writing a ref during render is what React warns about.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  // A layout effect, not an effect: children's effects (an input focusing
  // itself on mount) run before a parent's `useEffect`, and focusing inside a
  // dialog that is not open yet silently does nothing.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return undefined;

    const returnFocusTo =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();

    // Scroll lock: the page behind a modal must not scroll under the pointer.
    // (`scrollbar-gutter: stable` on <html> keeps the layout from shifting.)
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = 'hidden';

    // Escape. The browser's own close is cancelled so the caller decides.
    const onCancel = (event: Event) => {
      event.preventDefault();
      onCloseRef.current();
    };

    // A click on the backdrop lands on the <dialog> itself, since the content
    // fills it. Both ends of the click must be on the backdrop: dragging to
    // select text in a field and releasing outside the box is not a dismissal.
    // Registered here, not as a JSX handler: a click listener on a <dialog> is
    // a pointer shortcut for Escape, which is already handled, and the a11y
    // lint rule that would flag the prop is right about elements in general.
    let pressedOnBackdrop = false;
    const onPointerDown = (event: MouseEvent) => {
      pressedOnBackdrop = event.target === dialog;
    };
    const onClick = (event: MouseEvent) => {
      if (pressedOnBackdrop && event.target === dialog) onCloseRef.current();
      pressedOnBackdrop = false;
    };

    // A second Escape after the first was refused (a request in flight) is
    // closed by the browser itself, without a `cancel` event — Chrome only
    // lets a page veto Escape once per user gesture. React would still think
    // the dialog is open: an invisible modal, with the page scroll locked.
    // `close` fires for that, so the caller is told, and the dialog is not
    // left open in state while closed on screen.
    const onNativeClose = () => onCloseRef.current();

    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onNativeClose);
    dialog.addEventListener('mousedown', onPointerDown);
    dialog.addEventListener('click', onClick);

    return () => {
      // Listeners go first, so our own `close()` below does not report back.
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onNativeClose);
      dialog.removeEventListener('mousedown', onPointerDown);
      dialog.removeEventListener('click', onClick);
      root.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
      // Focus goes back where it came from; otherwise a keyboard user lands
      // at the top of the page every time a dialog closes.
      if (returnFocusTo?.isConnected === true) returnFocusTo.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      data-testid={rest['data-testid']}
      className={cn(
        'max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden border border-border bg-card p-0 text-card-foreground shadow-lg',
        'open:flex backdrop:animate-fade-in backdrop:bg-foreground/45',
        placement === 'center' &&
          'm-auto rounded-xl open:animate-pop-in ' +
            (size === 'sm' ? 'max-w-sm' : size === 'lg' ? 'max-w-2xl' : 'max-w-md'),
        placement === 'left' &&
          'm-0 mr-auto h-dvh max-h-dvh max-w-[18rem] rounded-none rounded-r-xl open:animate-slide-in-left',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
        <div className="min-w-0">
          <h2 id={titleId} className={cn('text-lg font-semibold', hideTitle && 'sr-only')}>
            {title}
          </h2>
          {description === undefined ? null : (
            <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        <IconButton
          label={closeLabel}
          icon={<CloseIcon className="h-4 w-4" />}
          size="icon-sm"
          onClick={onClose}
          className="-mr-2 -mt-1 text-muted-foreground"
        />
      </div>
      <div className="overflow-y-auto px-6 pb-6 pt-3">{children}</div>
    </dialog>
  );
}

/** The row of buttons at the foot of a dialog: the primary action is last. */
export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 pt-4">{children}</div>;
}
