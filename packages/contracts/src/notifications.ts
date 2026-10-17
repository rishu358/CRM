import { z } from 'zod';

/**
 * Notification API contracts (ADR-0007, MVP_SPEC §M6).
 *
 * A notification is addressed to **one person**, which is why there is no
 * `userId` anywhere in these shapes: the server reads it from the session and
 * every query is scoped to it. Accepting a user id here would turn the
 * endpoint into "read anybody's notifications" the moment a check was missed,
 * and the safest version of that check is having nothing to check.
 */

/**
 * The kinds of notification the product sends today.
 *
 * Open on the read side — a client must tolerate a type it does not know,
 * because a newer API will send one — and closed on the write side, where
 * only the worker writes at all.
 */
export const NOTIFICATION_TYPES = ['activity.assigned', 'activity.due'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notificationSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  /**
   * Enough to render the line and link to the thing it is about. It carries
   * no field that permissions could hide: a notification says "a task was
   * assigned to you", and opening it goes through the activity endpoint,
   * which applies the usual record and field checks.
   */
  payload: z.record(z.string(), z.unknown()),
  readAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type Notification = z.infer<typeof notificationSchema>;

export const notificationListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /** The bell's own query: just the ones not yet seen. */
    unreadOnly: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((value) => value === true || value === 'true')
      .optional(),
  })
  .strict();

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const notificationParamsSchema = z.object({ id: z.uuid() }).strict();

export const unreadCountSchema = z.object({ unread: z.number().int().nonnegative() });
export type UnreadCount = z.infer<typeof unreadCountSchema>;
