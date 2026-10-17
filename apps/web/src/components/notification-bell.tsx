'use client';

import { Button } from '@crm/ui';
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

  // Escape closes it, like every other overlay in the app (CLAUDE.md §9).
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const unread = count.data?.data.unread ?? 0;

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        {t('notifications.title')}
        {unread > 0 ? (
          <span
            className="ml-2 rounded-full bg-destructive px-2 py-0.5 text-xs text-destructive-foreground"
            aria-label={t('notifications.unread', { count: unread })}
          >
            {unread}
          </span>
        ) : null}
      </Button>

      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t('notifications.title')}
          className="absolute right-0 z-40 mt-2 w-80 rounded-lg border border-border bg-card p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
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
            <p className="py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : list.isError ? (
            <p role="alert" className="py-6 text-center text-sm text-destructive">
              {t('notifications.error')}
            </p>
          ) : list.data.data.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('notifications.empty')}
            </p>
          ) : (
            <ul className="max-h-80 divide-y divide-border overflow-y-auto">
              {list.data.data.map((notification) => (
                <li key={notification.id} className="py-2">
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => markRead.mutate(notification.id)}
                  >
                    <span
                      className={
                        notification.readAt === null
                          ? 'text-sm font-medium'
                          : 'text-sm text-muted-foreground'
                      }
                    >
                      {describe(notification)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
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
