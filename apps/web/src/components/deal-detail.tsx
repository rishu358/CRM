'use client';

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  NoPermissionState,
  Select,
  Skeleton,
} from '@crm/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useAccount } from '../lib/accounts';
import { useContact } from '../lib/contacts';
import { useDeal, useMoveDeal, usePipelines, useUpdateDeal, type StageRecord } from '../lib/deals';
import { DEFAULT_PREFERENCES, formatDateTime, formatName } from '../lib/format';
import { t } from '../lib/i18n';
import { AppShell } from './app-shell';
import { InlineField } from './inline-field';
import { InlineMoneyField } from './inline-money-field';
import { LostReasonDialog } from './lost-reason-dialog';

/**
 * One deal, edited in place.
 *
 * Which fields appear is decided by what the API returned: a field the caller
 * may not read is absent from the payload entirely (CLAUDE.md §5.4), so the
 * form is built from the response rather than from a fixed list. A field
 * hidden by configuration simply does not render — no empty row hinting that
 * something is being withheld.
 */

function AccountLink({ id }: { id: string }) {
  const account = useAccount(id);
  const name = account.data?.data.name;
  // The account may be outside this user's record scope, in which case that
  // request is a 404 and the link falls back to a neutral label: this page must
  // not reach around the scope check to show a name they may not read.
  return (
    <Link href={`/accounts/${id}`} className="text-primary underline-offset-4 hover:underline">
      {name === undefined || name.length === 0 ? t('deal.account') : name}
    </Link>
  );
}

function ContactLink({ id, role }: { id: string; role?: string | null }) {
  const contact = useContact(id);
  const name = contact.data === undefined ? '' : formatName(contact.data.data);

  return (
    <span>
      <Link href={`/contacts/${id}`} className="text-primary underline-offset-4 hover:underline">
        {name.length === 0 ? t('deal.primaryContact') : name}
      </Link>
      {role == null || role.length === 0 ? null : (
        <span className="ml-2 text-muted-foreground">{role}</span>
      )}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] items-start gap-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div>{children}</div>
    </div>
  );
}

export function DealDetail({ id }: { id: string }) {
  const query = useDeal(id);
  const update = useUpdateDeal();
  const move = useMoveDeal();
  const pipelines = usePipelines();
  const [pendingLost, setPendingLost] = useState<StageRecord | null>(null);

  if (query.isPending) {
    return (
      <AppShell>
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-64 w-full" />
        </div>
      </AppShell>
    );
  }

  if (query.isError) {
    const status = query.error.status;
    return (
      <AppShell>
        {status === 403 ? (
          <NoPermissionState
            title={t('deals.forbidden.title')}
            description={t('deals.forbidden.description')}
          />
        ) : (
          <ErrorState
            title={status === 404 ? t('deal.notFound.title') : t('deals.error.title')}
            description={
              status === 404 ? t('deal.notFound.description') : t('deals.error.description')
            }
            action={
              <Link href="/deals">
                <Button variant="outline">{t('deal.backToList')}</Button>
              </Link>
            }
          />
        )}
      </AppShell>
    );
  }

  const deal = query.data.data;
  const record = deal as unknown as Record<string, unknown>;

  const pipeline = pipelines.data?.data.find((candidate) => candidate.id === deal.pipelineId);
  const stages =
    pipeline === undefined ? [] : [...pipeline.stages].sort((a, b) => a.position - b.position);
  const stage = stages.find((candidate) => candidate.id === deal.stageId);
  const closed = stage !== undefined && stage.stageType !== 'open';

  // A 409 means a colleague saved while this user was editing. Offering a
  // reload is the honest response: we will not guess whose version wins.
  const conflicted =
    update.error?.code === 'VERSION_CONFLICT' || move.error?.code === 'VERSION_CONFLICT';
  const rejected =
    !conflicted && (update.error !== null || move.error !== null)
      ? (update.error ?? move.error)?.message
      : null;

  const save = (patch: Record<string, unknown>) => {
    update.mutate({ id: deal.id, version: deal.version, patch });
  };

  const moveTo = (to: StageRecord, lostReason?: string) => {
    if (deal.pipelineId === undefined) return;
    update.reset();
    move.reset();
    move.mutate({
      deal,
      pipelineId: deal.pipelineId,
      from: stage,
      to,
      lostReason,
    });
  };

  return (
    <AppShell>
      <nav className="mb-4">
        <Link
          href="/deals"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          {t('deal.backToList')}
        </Link>
      </nav>

      <h1 className="mb-6 text-xl font-semibold tracking-tight">{deal.name ?? t('field.empty')}</h1>

      {conflicted ? (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-4 rounded-md border border-warning/40 bg-warning/10 p-3"
        >
          <div>
            <p className="text-sm font-medium">{t('conflict.title')}</p>
            <p className="text-sm text-muted-foreground">{t('conflict.description.deal')}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              update.reset();
              move.reset();
              void query.refetch();
            }}
          >
            {t('conflict.reload')}
          </Button>
        </div>
      ) : null}

      {rejected === null || rejected === undefined ? null : (
        <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm">
          {rejected}
        </p>
      )}

      <Card>
        <CardHeader title={t('deal.details')} />
        <CardBody className="divide-y divide-border">
          {'name' in record ? (
            <InlineField
              label={t('deal.name')}
              value={deal.name ?? null}
              onSave={(next) => save({ name: next })}
            />
          ) : null}

          {'stageId' in record && stages.length > 0 ? (
            <div className="grid grid-cols-[10rem_1fr] items-center gap-3 py-2">
              <span className="text-sm text-muted-foreground">{t('deal.stage')}</span>
              <div className="flex items-center gap-3">
                <Select
                  label={t('deal.stage')}
                  labelHidden
                  value={deal.stageId}
                  onChange={(event) => {
                    const target = stages.find((candidate) => candidate.id === event.target.value);
                    if (target === undefined || target.id === deal.stageId) return;
                    if (target.stageType === 'lost') setPendingLost(target);
                    else moveTo(target);
                  }}
                  className="w-56"
                >
                  {stages.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </Select>
                {stage === undefined || stage.stageType === 'open' ? null : (
                  <Badge tone={stage.stageType === 'won' ? 'success' : 'destructive'}>
                    {stage.name}
                  </Badge>
                )}
              </div>
            </div>
          ) : null}

          {'amount' in record ? (
            <InlineMoneyField
              label={t('deal.amount')}
              value={deal.amount}
              onSave={(next) => save({ amount: next })}
            />
          ) : null}

          {'probability' in record ? (
            <InlineField
              label={t('deal.probability')}
              type="number"
              // A closed stage fixes the probability (ADR-0020); offering to
              // edit it would only invite a refusal.
              readOnly={closed}
              value={deal.probability === undefined ? null : `${deal.probability}`}
              onSave={(next) => {
                if (next === null) return;
                const value = Number(next);
                if (Number.isInteger(value) && value >= 0 && value <= 100) {
                  save({ probability: value });
                }
              }}
            />
          ) : null}

          {'expectedCloseDate' in record ? (
            <InlineField
              label={t('deal.expectedCloseDate')}
              type="date"
              value={deal.expectedCloseDate ?? null}
              onSave={(next) => save({ expectedCloseDate: next })}
            />
          ) : null}

          {'lostReason' in record && stage?.stageType === 'lost' ? (
            <InlineField
              label={t('deal.lostReason')}
              value={deal.lostReason ?? null}
              onSave={(next) => {
                // A lost deal always has a reason (ADR-0020): clearing it is
                // not an edit the API would accept, so it is not sent.
                if (next !== null) save({ lostReason: next });
              }}
            />
          ) : null}

          {'closedAt' in record && deal.closedAt != null ? (
            <Row label={t('deal.closedAt')}>
              {formatDateTime(deal.closedAt, DEFAULT_PREFERENCES)}
            </Row>
          ) : null}

          {'accountId' in record ? (
            <Row label={t('deal.account')}>
              {deal.accountId == null ? (
                <span className="text-muted-foreground">{t('deal.account.none')}</span>
              ) : (
                <AccountLink id={deal.accountId} />
              )}
            </Row>
          ) : null}

          {'primaryContactId' in record ? (
            <Row label={t('deal.primaryContact')}>
              {deal.primaryContactId == null ? (
                <span className="text-muted-foreground">{t('deal.primaryContact.none')}</span>
              ) : (
                <ContactLink id={deal.primaryContactId} />
              )}
            </Row>
          ) : null}

          {'contacts' in record ? (
            <Row label={t('deal.people')}>
              {deal.contacts === undefined || deal.contacts.length === 0 ? (
                <span className="text-muted-foreground">{t('deal.people.none')}</span>
              ) : (
                <ul className="space-y-1">
                  {deal.contacts.map((person) => (
                    <li key={person.contactId}>
                      <ContactLink id={person.contactId} role={person.role} />
                    </li>
                  ))}
                </ul>
              )}
            </Row>
          ) : null}

          <Row label={t('deal.created')}>{formatDateTime(deal.createdAt, DEFAULT_PREFERENCES)}</Row>
          <Row label={t('deal.updated')}>{formatDateTime(deal.updatedAt, DEFAULT_PREFERENCES)}</Row>
        </CardBody>
      </Card>

      {pendingLost === null ? null : (
        <LostReasonDialog
          dealName={deal.name ?? t('field.empty')}
          stageName={pendingLost.name}
          pending={false}
          onClose={() => setPendingLost(null)}
          onConfirm={(reason) => {
            moveTo(pendingLost, reason);
            setPendingLost(null);
          }}
        />
      )}
    </AppShell>
  );
}
