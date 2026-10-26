'use client';

import { BellIcon, Button, IconButton, cn } from '@crm/ui';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PREFERENCES, formatDateTime } from '../lib/format';
import { t } from '../lib/i18n';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadCount,
  type NotificationRecord,
} from '../lib/notifications';

/**
 * The notification bell (MVP_SPEC M6).
 *
 * The badge polls a count; the list is only fetched once the panel is opened,
 * so a quiet workspace costs one small query a minute rather than a page of
 * rows nobody looked at.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const count = useUnreadCount();
  const list = useNotifications(open);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const panelRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Escape closes it, like every other overlay in the app (CLAUDE.md §9), and
  // so does a click anywhere else: a popover that can only be dismissed by
  // finding its own button again is a small trap.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (containerRef.current?.contains(event.target) === true) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const unread = count.data?.data.unread ?? 0;

  return (
    <div ref={containerRef} className="relative">
      <IconButton
        label={
          unread > 0
            ? `${t('notifications.title')}, ${t('notifications.unread', { count: unread })}`
            : t('notifications.title')
        }
        icon={<BellIcon className="h-[18px] w-[18px]" />}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      />
      {unread > 0 ? (
        // Decorative: the count is already in the button's accessible name.
        <span
          aria-hidden="true"
          className="figures pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-2xs font-semibold leading-none text-destructive-foreground ring-2 ring-background"
        >
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}

      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t('notifications.title')}
          className="absolute right-0 z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] animate-pop-in rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-semibold">{t('notifications.title')}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={unread === 0 || markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              {t('notifications.markAllRead')}
            </Button>
          </div>

          {list.isPending ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : list.isError ? (
            <p role="alert" className="py-8 text-center text-sm text-destructive">
              {t('notifications.error')}
            </p>
          ) : list.data.data.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('notifications.empty')}
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {list.data.data.map((notification) => (
                <li key={notification.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left transition-colors duration-fast hover:bg-accent/60"
                    onClick={() => markRead.mutate(notification.id)}
                  >
                    <span
                      className={cn(
                        'text-sm',
                        notification.readAt === null
                          ? 'font-medium text-foreground'
                          : 'text-muted-foreground',
                      )}
                    >
                      {describe(notification)}
                    </span>
                    <span className="figures block text-xs text-muted-foreground">
                      {formatDateTime(notification.createdAt, DEFAULT_PREFERENCES)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One line per notification.
 *
 * Rendered as text, never as markup: the subject came from whatever somebody
 * typed into a task, and React escapes it here because it is a string child
 * rather than HTML (ADR-0024).
 */
function describe(notification: NotificationRecord): string {
  const subject =
    typeof notification.payload['subject'] === 'string'
      ? notification.payload['subject']
      : t('notifications.aTask');

  return notification.type === 'activity.due'
    ? t('notifications.due', { subject })
    : t('notifications.assigned', { subject });
}
