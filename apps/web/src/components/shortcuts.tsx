'use client';

import { Dialog, Kbd } from '@crm/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { t } from '../lib/i18n';
import {
  GO_TO,
  SEQUENCE_WINDOW_MS,
  isModalOpen,
  isTypingTarget,
  runCreateShortcut,
  singleKeyShortcutsEnabled,
  useModifierLabel,
  useSingleKeyShortcuts,
} from '../lib/shortcuts';

/**
 * The global single-key shortcuts, mounted once in the application frame.
 *
 * `?` opens the list; `C` runs the current screen's create action; `G` starts a
 * two-key "go to". After `G`, a small chip lists the destinations for a moment
 * — the sequence is only discoverable if the interface says it is waiting.
 * That chip is a sighted-keyboard aid and is hidden from assistive technology on
 * purpose: the same information is in the dialog, which is the accessible
 * surface, and a screen reader announcing a chip that vanishes after a second
 * would be noise.
 */
export function GlobalShortcuts({
  helpOpen,
  onHelpOpenChange,
}: {
  helpOpen: boolean;
  onHelpOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [waitingForDestination, setWaitingForDestination] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiting = false;

    const stopWaiting = () => {
      waiting = false;
      setWaitingForDestination(false);
      if (timer !== undefined) clearTimeout(timer);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // `Ctrl`/`Cmd`/`Alt` chords belong to the browser and the palette.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) || isModalOpen()) {
        if (waiting) stopWaiting();
        return;
      }
      // Every shortcut below is a single character key, so all of them honour
      // the switch (WCAG 2.1.4).
      if (!singleKeyShortcutsEnabled()) return;

      if (waiting) {
        const destination = GO_TO.find((entry) => entry.key === event.key.toLowerCase());
        stopWaiting();
        if (destination !== undefined) {
          event.preventDefault();
          router.push(destination.href);
        }
        return;
      }

      if (event.key === '?') {
        event.preventDefault();
        onHelpOpenChange(true);
        return;
      }

      if (event.key.toLowerCase() === 'c' && !event.shiftKey) {
        if (runCreateShortcut()) event.preventDefault();
        return;
      }

      if (event.key.toLowerCase() === 'g' && !event.shiftKey) {
        event.preventDefault();
        waiting = true;
        setWaitingForDestination(true);
        timer = setTimeout(stopWaiting, SEQUENCE_WINDOW_MS);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [router, onHelpOpenChange]);

  return (
    <>
      {waitingForDestination ? (
        <div
          aria-hidden="true"
          className="fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md animate-pop-in"
        >
          <span className="font-medium">{t('shortcuts.goToPending')}</span>
          {GO_TO.map((entry) => (
            <span key={entry.key} className="inline-flex items-center gap-1.5">
              <Kbd>{entry.key.toUpperCase()}</Kbd>
              <span className="text-muted-foreground">{t(entry.label)}</span>
            </span>
          ))}
        </div>
      ) : null}

      {helpOpen ? <ShortcutsDialog onClose={() => onHelpOpenChange(false)} /> : null}
    </>
  );
}

function Row({ label, keys }: { label: string; keys: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span>{label}</span>
      <span className="flex shrink-0 items-center gap-1">{keys}</span>
    </li>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="divide-y divide-border">{children}</ul>
    </section>
  );
}

/** The accessible home of every shortcut: a real list in a real dialog. */
function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const modifier = useModifierLabel();
  const [singleKey, setSingleKey] = useSingleKeyShortcuts();

  return (
    <Dialog
      title={t('shortcuts.title')}
      description={t('shortcuts.description')}
      closeLabel={t('common.close')}
      onClose={onClose}
      size="lg"
    >
      <div className="mb-5 flex items-start gap-3 rounded-lg border border-input bg-card p-3 text-sm">
        <input
          id="single-key-shortcuts"
          type="checkbox"
          checked={singleKey}
          aria-describedby="single-key-shortcuts-hint"
          onChange={(event) => setSingleKey(event.target.checked)}
          className="mt-0.5 h-4 w-4 cursor-pointer"
        />
        <div>
          <label htmlFor="single-key-shortcuts" className="block cursor-pointer font-medium">
            {t('shortcuts.singleKey')}
          </label>
          <p id="single-key-shortcuts-hint" className="text-muted-foreground">
            {t('shortcuts.singleKey.hint')}
          </p>
        </div>
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-6">
          <Group title={t('shortcuts.group.anywhere')}>
            <Row
              label={t('shortcuts.palette')}
              keys={
                <>
                  <Kbd>{modifier}</Kbd>
                  <Kbd>K</Kbd>
                </>
              }
            />
            <Row label={t('shortcuts.search')} keys={<Kbd>/</Kbd>} />
            <Row label={t('shortcuts.help')} keys={<Kbd>?</Kbd>} />
            <Row label={t('shortcuts.close')} keys={<Kbd>Esc</Kbd>} />
          </Group>
          <Group title={t('shortcuts.group.lists')}>
            <Row label={t('shortcuts.create')} keys={<Kbd>C</Kbd>} />
          </Group>
        </div>
        <Group title={t('shortcuts.group.goTo')}>
          {GO_TO.map((entry) => (
            <Row
              key={entry.key}
              label={t(entry.label)}
              keys={
                <>
                  <Kbd>G</Kbd>
                  <span className="text-xs text-muted-foreground">{t('shortcuts.then')}</span>
                  <Kbd>{entry.key.toUpperCase()}</Kbd>
                </>
              }
            />
          ))}
        </Group>
      </div>
    </Dialog>
  );
}
