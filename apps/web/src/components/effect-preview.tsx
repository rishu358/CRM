'use client';

import {
  AlertIcon,
  Badge,
  Button,
  ErrorState,
  InfoIcon,
  Skeleton,
  SuccessIcon,
  WarningIcon,
  cn,
} from '@crm/ui';
import type { ReactNode } from 'react';
import type { EffectPreview } from '../lib/access';
import {
  actionLabel,
  directionLabel,
  directionTone,
  actionVerb,
  fieldAccessLabel,
  objectLabel,
  objectSingularLabel,
  scopeLabel,
} from '../lib/access-labels';
import { DEFAULT_PREFERENCES, formatCount } from '../lib/format';
import { t, tPlural } from '../lib/i18n';

/**
 * What a change would do, shown **before** it is saved (MVP_SPEC M3).
 *
 * This is the screen a cautious administrator trusts or does not, so it is
 * written to be read rather than scanned past. It leads with the consequence in
 * words — "3 people lose sight of up to 1,240 contacts each" — not with a diff
 * of the switches that were flipped, because the switches are the means and
 * "who can no longer see what" is the thing being decided. Underneath, each
 * affected person is itemised, with their numbers before and after, so the
 * sentence can be checked rather than believed.
 *
 * Everything shown is the API's: the effect is computed there by running the
 * proposed permissions through the very `can()` that enforces them. This
 * component adds nothing to it and works nothing out — which is also why it can
 * say "no counts available" honestly when the API withholds them.
 *
 * It is always one of five things, and says which:
 *   idle      nothing proposed yet — says how to see a consequence
 *   loading   first answer on its way — skeleton, announced
 *   ready     the answer, for exactly what is on screen
 *   stale     the answer to an *earlier* edit, while the new one loads — kept
 *             visible and marked, so the page never blanks mid-click, and the
 *             Save button is held until it is current again
 *   error     the preview could not be computed — and saving is not offered
 */
export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

export function EffectPreviewPanel({
  status,
  preview,
  onRetry,
  idleMessage,
  noHoldersMessage,
  footer,
  heading,
}: {
  status: PreviewStatus;
  preview: EffectPreview | undefined;
  onRetry?: () => void;
  idleMessage: string;
  /** Shown when the change affects nobody because nobody holds the role. */
  noHoldersMessage?: string;
  /** Where the save button goes: inside the panel, beside the consequence. */
  footer?: ReactNode;
  heading?: string;
}) {
  return (
    <section
      aria-labelledby="effect-heading"
      aria-busy={status === 'loading' || status === 'stale'}
      data-testid="effect-preview"
      data-status={status}
      className="rounded-lg border border-border bg-card shadow-sm"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <h2 id="effect-heading" className="text-base font-semibold">
          {heading ?? t('effect.heading')}
        </h2>
        {status === 'stale' ? (
          <span className="text-xs text-muted-foreground" role="status">
            {t('effect.updating')}
          </span>
        ) : null}
      </div>

      <div className="space-y-4 p-5">
        {status === 'idle' ? <IdleBody message={idleMessage} /> : null}
        {status === 'loading' ? <LoadingBody /> : null}
        {status === 'error' ? (
          <ErrorState
            compact
            title={t('effect.error.title')}
            description={t('effect.error.description')}
            action={
              onRetry === undefined ? undefined : (
                <Button variant="outline" size="sm" onClick={onRetry}>
                  {t('common.retry')}
                </Button>
              )
            }
          />
        ) : null}
        {(status === 'ready' || status === 'stale') && preview !== undefined ? (
          <div className={cn(status === 'stale' && 'opacity-60 transition-opacity')}>
            <ReadyBody
              preview={preview}
              {...(noHoldersMessage === undefined ? {} : { noHoldersMessage })}
            />
          </div>
        ) : null}
      </div>

      {footer === undefined ? null : (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/40 px-5 py-3">
          {footer}
        </div>
      )}
    </section>
  );
}

function IdleBody({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 text-sm text-muted-foreground">
      <InfoIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{message}</p>
    </div>
  );
}

function LoadingBody() {
  return (
    <div role="status" aria-label={t('effect.loading')} className="space-y-3">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function ReadyBody({
  preview,
  noHoldersMessage,
}: {
  preview: EffectPreview;
  noHoldersMessage?: string;
}) {
  const nothingChanges = preview.people.length === 0;

  return (
    <div className="space-y-4">
      {preview.removesLastAdministrator ? (
        <Warning tone="destructive" testId="effect-lockout">
          {t('effect.lockout')}
        </Warning>
      ) : null}

      {preview.beyondYourAccess.length > 0 ? (
        <Warning tone="destructive" testId="effect-escalation">
          <p>{t('effect.escalation')}</p>
          <ul className="mt-1 list-disc pl-5">
            {preview.beyondYourAccess.map((grant) => (
              <li key={`${grant.objectType}.${grant.action}`}>
                {objectLabel(grant.objectType)} · {actionLabel(grant.action)} ·{' '}
                {scopeLabel(grant.scope)}
              </li>
            ))}
          </ul>
        </Warning>
      ) : null}

      {nothingChanges ? (
        <div
          className="flex items-start gap-3 rounded-md bg-success/10 p-3 text-sm"
          data-testid="effect-nothing"
        >
          <SuccessIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <div>
            <p className="font-medium">{t('effect.nothing.title')}</p>
            <p className="mt-0.5 text-muted-foreground">
              {preview.unaffectedCount === 0 && noHoldersMessage !== undefined
                ? noHoldersMessage
                : tPlural('effect.nothing.description', preview.unaffectedCount)}
            </p>
          </div>
        </div>
      ) : (
        <>
          <ul className="space-y-2" aria-label={t('effect.summary')} data-testid="effect-summary">
            {groupByObject(preview.summary).map(([objectType, rows]) => (
              <li
                key={objectType}
                className="rounded-md border border-border"
                data-testid="effect-object"
                data-object={objectType}
              >
                <h4 className="border-b border-border bg-muted/40 px-3 py-1.5 text-sm font-semibold">
                  {objectLabel(objectType)}
                </h4>
                <ul className="divide-y divide-border">
                  {rows.map((row) => (
                    <SummaryRow key={`${row.action}.${row.direction}`} row={row} />
                  ))}
                </ul>
              </li>
            ))}
            {preview.summary.length === 0 ? (
              // Only fields changed. Say so, in words, rather than showing an empty list.
              <li className="text-sm">{tPlural('effect.fieldsOnly', preview.people.length)}</li>
            ) : null}
          </ul>

          <div>
            <h3 className="mb-2 text-sm font-semibold">
              {tPlural('effect.people', preview.people.length)}
              {preview.unaffectedCount > 0 ? (
                <span className="ml-2 font-normal text-muted-foreground">
                  {tPlural('effect.unaffected', preview.unaffectedCount)}
                </span>
              ) : null}
            </h3>
            <ul className="divide-y divide-border rounded-md border border-border">
              {preview.people.map((person) => (
                <PersonRow key={person.userId} person={person} />
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function Warning({
  tone,
  children,
  testId,
}: {
  tone: 'destructive' | 'warning';
  children: ReactNode;
  testId: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className={cn(
        'flex items-start gap-3 rounded-md border p-3 text-sm',
        tone === 'destructive'
          ? 'border-destructive/40 bg-destructive/10'
          : 'border-warning/40 bg-warning/10',
      )}
    >
      {tone === 'destructive' ? (
        <AlertIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      ) : (
        <WarningIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      )}
      <div className="font-medium">{children}</div>
    </div>
  );
}

type SummaryRowData = EffectPreview['summary'][number];

/**
 * One line of consequence: what, to how many people, and by how much.
 *
 * The numbers are exactly what the API returned. When it withheld them (the
 * viewer could not count that object themselves) the line says the change
 * and stops, rather than inventing a figure or printing a zero.
 */
function SummaryRow({ row }: { row: SummaryRowData }) {
  const losing = row.direction === 'narrowed' || row.direction === 'revoked';
  const max = losing ? row.recordsLostMax : row.recordsGainedMax;
  const total = losing ? row.recordViewsLost : row.recordViewsGained;
  const counted = max !== null && total !== null;
  // Creating and importing make new records: there is nothing to count, and
  // saying "counts are hidden" about them would be false.
  const countable = row.action !== 'create' && row.action !== 'import';

  const values = {
    verb: actionVerb(row.action),
    // "up to 1 account", never "up to 1 accounts".
    objects: (max === 1
      ? objectSingularLabel(row.objectType)
      : objectLabel(row.objectType)
    ).toLowerCase(),
    max: counted ? formatCount(max, DEFAULT_PREFERENCES) : '',
    total: counted ? formatCount(total, DEFAULT_PREFERENCES) : '',
  };
  const base = losing
    ? counted
      ? 'effect.line.lose.counted'
      : 'effect.line.lose.plain'
    : counted
      ? 'effect.line.gain.counted'
      : 'effect.line.gain.plain';

  return (
    <li className="px-3 py-2.5" data-testid="effect-summary-row" data-direction={row.direction}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{actionLabel(row.action)}</span>
        <Badge tone={directionTone(row.direction)}>{directionLabel(row.direction)}</Badge>
      </div>
      <p className="mt-1 text-sm figures" data-testid="effect-sentence">
        {tPlural(base, row.peopleAffected, values)}
        {!counted && countable ? (
          <span className="text-muted-foreground"> {t('effect.line.noCounts')}</span>
        ) : null}
      </p>
    </li>
  );
}

/** Rows grouped by record type, in the order the API first mentioned each. */
function groupByObject(rows: readonly SummaryRowData[]): [string, SummaryRowData[]][] {
  const groups = new Map<string, SummaryRowData[]>();
  for (const row of rows) {
    const list = groups.get(row.objectType) ?? [];
    list.push(row);
    groups.set(row.objectType, list);
  }
  return [...groups.entries()];
}

type PersonData = EffectPreview['people'][number];

function PersonRow({ person }: { person: PersonData }) {
  const changes = person.scopeChanges.length + person.fieldChanges.length;

  return (
    <li data-testid="effect-person">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-accent/40">
          <span className="min-w-0">
            <span className="font-medium">{person.name}</span>
            <span className="ml-2 truncate text-muted-foreground">{person.email}</span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {tPlural('effect.changes', changes)}
          </span>
        </summary>
        <div className="space-y-3 border-t border-border bg-muted/30 px-3 py-3">
          {person.scopeChanges.length > 0 ? (
            <ul className="space-y-1.5">
              {person.scopeChanges.map((change) => (
                <li
                  key={`${change.objectType}.${change.action}`}
                  className="flex flex-wrap items-baseline gap-x-2 text-sm"
                >
                  <span className="font-medium">
                    {objectLabel(change.objectType)} · {actionLabel(change.action)}
                  </span>
                  <span>
                    {scopeLabel(change.before)} → {scopeLabel(change.after)}
                  </span>
                  {change.recordsBefore !== null && change.recordsAfter !== null ? (
                    <span className="text-muted-foreground figures">
                      {formatCount(change.recordsBefore, DEFAULT_PREFERENCES)} →{' '}
                      {formatCount(change.recordsAfter, DEFAULT_PREFERENCES)}
                      {change.recordsLost !== null && change.recordsLost > 0
                        ? ` (−${formatCount(change.recordsLost, DEFAULT_PREFERENCES)})`
                        : null}
                      {change.recordsGained !== null && change.recordsGained > 0
                        ? ` (+${formatCount(change.recordsGained, DEFAULT_PREFERENCES)})`
                        : null}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {person.fieldChanges.length > 0 ? (
            <ul className="space-y-1.5">
              {person.fieldChanges.map((change) => (
                <li
                  key={`${change.objectType}.${change.fieldKey}`}
                  className="flex flex-wrap items-baseline gap-x-2 text-sm"
                >
                  <span className="font-medium">
                    {objectLabel(change.objectType)} · {change.fieldLabel}
                  </span>
                  <span>
                    {fieldAccessLabel(change.before)} → {fieldAccessLabel(change.after)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
    </li>
  );
}
