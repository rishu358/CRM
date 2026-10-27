import { WarningIcon, ChatIcon, buttonStyles } from '@crm/ui';
import type { WhatsAppTarget } from '@crm/core/whatsapp';
import { t } from '../lib/i18n';

/**
 * The "chat on WhatsApp" control, shown beside the number it uses.
 *
 * A plain link the person's own device opens (WhatsApp app or WhatsApp Web). Our
 * servers are not involved: no message is sent, nothing is logged. The address
 * comes only from `whatsAppTarget` in `@crm/core`, which accepts strict E.164 and
 * nothing else, so no value typed into a record can become a `javascript:` or
 * other-host link.
 *
 * A number that is there but not valid shows a hint instead of a dead button, so
 * the person knows why there is no button and what to do about it. A record with
 * no number at all passes `null` and shows nothing.
 */
export function WhatsAppChat({
  name,
  target,
}: {
  /** Who the chat is with, for the accessible name. May be empty. */
  name: string;
  target: WhatsAppTarget | null;
}) {
  if (target === null) return null;

  if (target.status === 'invalid') {
    return (
      <span
        data-testid="whatsapp-invalid"
        className="inline-flex items-start gap-1.5 text-xs text-muted-foreground"
      >
        <WarningIcon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{t('whatsapp.invalid')}</span>
      </span>
    );
  }

  const who = name.trim().length > 0 ? name.trim() : t('whatsapp.someone');
  const values = { name: who, number: target.number };
  const explanation =
    target.source === 'whatsapp'
      ? t('whatsapp.uses.whatsapp', values)
      : t('whatsapp.uses.phone', values);

  return (
    <a
      href={target.href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="whatsapp-chat"
      data-source={target.source}
      aria-label={`${t('whatsapp.label', values)} ${explanation} ${t('whatsapp.newTab')}`}
      title={explanation}
      className={buttonStyles({ variant: 'outline', size: 'sm' })}
    >
      <ChatIcon aria-hidden="true" className="h-4 w-4" />
      {t('whatsapp.button')}
    </a>
  );
}
