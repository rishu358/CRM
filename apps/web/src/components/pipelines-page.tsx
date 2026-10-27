'use client';

import { MAX_STAGES_PER_PIPELINE, stageSetProblems } from '@crm/core';
import type { ManagedPipeline, ManagedStage } from '@crm/contracts';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Badge,
  BoardViewIcon,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  NoPermissionState,
  PageHeader,
  PlusIcon,
  Select,
  Skeleton,
  cn,
} from '@crm/ui';
import { useState } from 'react';
import { DEFAULT_PREFERENCES, formatDate } from '../lib/format';
import { t } from '../lib/i18n';
import {
  useArchiveStage,
  useCreateStage,
  useManagedPipelines,
  useOrderStages,
  useRestoreStage,
  useUpdateStage,
} from '../lib/pipeline-editor';
import { AppShell } from './app-shell';
import { AddStageDialog, RetireStageDialog, detailFor } from './stage-dialogs';

/**
 * The pipeline and stage editor (MVP_SPEC M5, M9; ADR-0062).
 *
 * A company shapes the stages its deals move through: rename, re-weight, reorder, add, retire and
 * restore. The screen mirrors the rules the API enforces (open stages first, one of each kind kept,
 * a cap, retiring asks where the deals go) so a person is told before they click, but every one of
 * them is checked again by the server and an answer from it is what is shown.
 *
 * Reordering is by Move up / Move down buttons. They are the keyboard path and the touch path at
 * once, and the board's own drag stays where it belongs: on a deal.
 *
 * Whether the person may be here is the API's answer (a 403 on the list), never a guess from a role
 * name; hiding the nav link is cosmetic.
 */

type StageEdit = {
  readonly stage: ManagedStage;
  readonly field: 'name' | 'probability' | 'stageType';
};

function inUseOf(pipeline: ManagedPipeline): ManagedStage[] {
  return pipeline.stages.filter((stage) => stage.archivedAt === null);
}

function typeTone(type: ManagedStage['stageType']): 'neutral' | 'success' | 'destructive' {
  return type === 'won' ? 'success' : type === 'lost' ? 'destructive' : 'neutral';
}

/** Whether moving the stage at `index` by `by` leaves a usable pipeline, as the server will judge it. */
function canMove(stages: readonly ManagedStage[], index: number, by: -1 | 1): boolean {
  const target = index + by;
  if (target < 0 || target >= stages.length) return false;
  const next = [...stages];
  const moved = next.splice(index, 1)[0];
  if (moved === undefined) return false;
  next.splice(target, 0, moved);
  return stageSetProblems(next).length === 0;
}

/** A text box that saves when you leave it or press Enter, and goes back on Escape. */
function InlineField({
  label,
  value,
  disabled,
  className,
  type = 'text',
  error,
  onCommit,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  className?: string;
  type?: 'text' | 'number';
  error?: string | undefined;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // The server's answer (or a rollback) is the truth; follow it when it changes. Done while
  // rendering, not in an effect, so the box never shows one stale frame.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }

  const commit = () => {
    if (draft.trim() === value || draft.trim().length === 0) {
      setDraft(value);
      return;
    }
    onCommit(draft);
  };

  return (
    <Input
      label={label}
      labelHidden
      type={type}
      {...(type === 'number'
        ? { inputMode: 'numeric' as const, min: 0, max: 100, step: 1 }
        : { maxLength: 80 })}
      value={draft}
      disabled={disabled ?? false}
      className={className}
      error={error}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          setDraft(value);
        }
      }}
    />
  );
}

export function PipelinesScreen() {
  const query = useManagedPipelines();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const header = (
    <PageHeader title={t('pipelines.title')} description={t('pipelines.description')} />
  );

  if (query.isError) {
    return (
      <AppShell>
        {header}
        {query.error.status === 403 ? (
          <NoPermissionState
            title={t('pipelines.forbidden.title')}
            description={t('pipelines.forbidden.description')}
          />
        ) : (
          <ErrorState
            title={t('pipelines.error.title')}
            description={t('pipelines.error.description')}
            action={
              <Button variant="outline" onClick={() => void query.refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
      </AppShell>
    );
  }

  if (query.isPending) {
    return (
      <AppShell>
        {header}
        <div className="space-y-6">
          <CardSkeleton rows={5} label={t('common.loading')} />
          <Skeleton className="h-24 w-full" />
        </div>
      </AppShell>
    );
  }

  const pipelines = query.data.data;
  const pipeline = pipelines.find((entry) => entry.id === selectedId) ?? pipelines[0];

  if (pipeline === undefined) {
    return (
      <AppShell>
        {header}
        <EmptyState
          icon={<BoardViewIcon className="h-5 w-5" />}
          title={t('pipelines.empty.title')}
          description={t('pipelines.empty.description')}
        />
      </AppShell>
    );
  }

  return (
    <AppShell>
      {header}
      {pipelines.length > 1 ? (
        <div className="mb-5 max-w-xs">
          <Select
            label={t('pipelines.pipeline')}
            value={pipeline.id}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {pipelines.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      <PipelineEditor key={pipeline.id} pipeline={pipeline} onReload={() => void query.refetch()} />
    </AppShell>
  );
}

function PipelineEditor({
  pipeline,
  onReload,
}: {
  pipeline: ManagedPipeline;
  onReload: () => void;
}) {
  const create = useCreateStage(pipeline.id);
  const update = useUpdateStage(pipeline.id);
  const order = useOrderStages(pipeline.id);
  const archive = useArchiveStage(pipeline.id);
  const restore = useRestoreStage(pipeline.id);

  const [adding, setAdding] = useState(false);
  const [retiring, setRetiring] = useState<ManagedStage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [edited, setEdited] = useState<StageEdit | null>(null);

  const stages = inUseOf(pipeline);
  const retired = pipeline.stages.filter((stage) => stage.archivedAt !== null);
  const full = stages.length >= MAX_STAGES_PER_PIPELINE;

  const move = (index: number, by: -1 | 1) => {
    const ids = stages.map((stage) => stage.id);
    const moved = ids.splice(index, 1)[0];
    if (moved === undefined) return;
    ids.splice(index + by, 0, moved);
    setNotice(null);
    order.mutate({ version: pipeline.version, stageIds: ids });
  };

  const save = (stage: ManagedStage, field: StageEdit['field'], input: Record<string, unknown>) => {
    setNotice(null);
    setEdited({ stage, field });
    update.mutate({ stageId: stage.id, input: { version: stage.version, ...input } });
  };

  // The server's refusal of the last edit, shown beside the row it came from.
  const editError = update.isError ? update.error : null;
  const stale =
    (editError?.status === 409 && editError.code === 'VERSION_CONFLICT') ||
    (order.isError && order.error.status === 409 && order.error.code === 'VERSION_CONFLICT');

  return (
    <div className="space-y-6">
      {stale ? (
        <Card>
          <CardBody>
            <p role="alert" className="text-sm font-medium">
              {t('pipelines.conflict.title')}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('pipelines.conflict.description')}
            </p>
            <Button
              className="mt-3"
              variant="outline"
              onClick={() => {
                update.reset();
                order.reset();
                onReload();
              }}
            >
              {t('pipelines.conflict.reload')}
            </Button>
          </CardBody>
        </Card>
      ) : null}

      {notice === null ? null : (
        <p role="status" className="text-sm text-muted-foreground" data-testid="pipeline-notice">
          {notice}
        </p>
      )}

      <Card data-testid="pipeline-stages">
        <CardHeader
          title={pipeline.name}
          description={
            <>
              {t('pipelines.stages.description')}{' '}
              <span className="figures">
                {t('pipelines.stages.count', {
                  count: stages.length,
                  max: MAX_STAGES_PER_PIPELINE,
                })}
              </span>
            </>
          }
          actions={
            <Button
              onClick={() => {
                create.reset();
                setAdding(true);
              }}
              disabled={full}
            >
              <PlusIcon className="h-4 w-4" />
              {t('pipelines.add')}
            </Button>
          }
        />
        <CardBody className="p-0">
          <ul className="divide-y divide-border">
            {stages.map((stage, index) => {
              const closed = stage.stageType !== 'open';
              const rowError =
                editError !== null && edited?.stage.id === stage.id ? editError : null;
              const held = stage.dealCount + stage.recycleBinDealCount;
              return (
                <li
                  key={stage.id}
                  data-testid="stage-row"
                  className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-3"
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <InlineField
                      label={t('pipelines.row.name', { name: stage.name })}
                      value={stage.name}
                      error={edited?.field === 'name' ? detailFor(rowError, 'name') : undefined}
                      onCommit={(value) => save(stage, 'name', { name: value })}
                    />
                  </div>

                  <div className="w-28 shrink-0">
                    <Select
                      label={t('pipelines.row.type', { name: stage.name })}
                      labelHidden
                      value={stage.stageType}
                      disabled={held > 0}
                      title={held > 0 ? t('pipelines.row.typeLocked') : undefined}
                      onChange={(event) =>
                        save(stage, 'stageType', { stageType: event.target.value })
                      }
                    >
                      <option value="open">{t('pipelines.type.open')}</option>
                      <option value="won">{t('pipelines.type.won')}</option>
                      <option value="lost">{t('pipelines.type.lost')}</option>
                    </Select>
                  </div>

                  <div className="flex w-24 shrink-0 items-center gap-1">
                    <InlineField
                      label={t('pipelines.row.probability', { name: stage.name })}
                      type="number"
                      value={String(stage.probability)}
                      disabled={closed}
                      error={
                        edited?.field === 'probability'
                          ? detailFor(rowError, 'probability')
                          : undefined
                      }
                      onCommit={(value) =>
                        save(stage, 'probability', { probability: Number(value) })
                      }
                    />
                    <span aria-hidden="true" className="text-sm text-muted-foreground">
                      %
                    </span>
                  </div>

                  <div className="flex w-28 shrink-0 items-center gap-2 pt-1.5">
                    <Badge tone={typeTone(stage.stageType)}>
                      {t(`pipelines.type.${stage.stageType}`)}
                    </Badge>
                    <span
                      className="figures text-sm text-muted-foreground"
                      data-testid="stage-deals"
                    >
                      {t(
                        stage.dealCount === 1
                          ? 'pipelines.row.deals.one'
                          : 'pipelines.row.deals.other',
                        {
                          count: stage.dealCount,
                        },
                      )}
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    <IconButton
                      label={t('pipelines.row.moveUp', { name: stage.name })}
                      icon={<ArrowUpIcon className="h-4 w-4" />}
                      size="icon-sm"
                      disabled={!canMove(stages, index, -1) || order.isPending}
                      onClick={() => move(index, -1)}
                    />
                    <IconButton
                      label={t('pipelines.row.moveDown', { name: stage.name })}
                      icon={<ArrowDownIcon className="h-4 w-4" />}
                      size="icon-sm"
                      disabled={!canMove(stages, index, 1) || order.isPending}
                      onClick={() => move(index, 1)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t('pipelines.row.retire', { name: stage.name })}
                      onClick={() => {
                        archive.reset();
                        setRetiring(stage);
                      }}
                    >
                      {t('pipelines.row.retireShort')}
                    </Button>
                  </div>

                  {rowError !== null &&
                  detailFor(rowError, 'name') === undefined &&
                  detailFor(rowError, 'probability') === undefined &&
                  !stale ? (
                    <p role="alert" className="basis-full text-sm text-destructive">
                      {rowError.error.details[0]?.message ?? rowError.message}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </CardBody>
        {full ? (
          <p
            role="status"
            className="border-t border-border px-5 py-3 text-sm text-muted-foreground"
          >
            {t('pipelines.limitReached', { max: MAX_STAGES_PER_PIPELINE })}
          </p>
        ) : null}
      </Card>

      {order.isError && !stale ? (
        <p role="alert" className="text-sm text-destructive">
          {order.error.error.details[0]?.message ?? t('pipelines.saveError')}
        </p>
      ) : null}

      {retired.length === 0 ? null : (
        <Card data-testid="retired-stages">
          <CardHeader
            title={t('pipelines.retired.title')}
            description={t('pipelines.retired.description')}
          />
          <CardBody className="p-0">
            <ul className="divide-y divide-border">
              {retired.map((stage) => (
                <li
                  key={stage.id}
                  className={cn(
                    'flex flex-wrap items-center gap-x-4 gap-y-2 bg-muted/40 px-5 py-3',
                  )}
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="font-medium text-muted-foreground">{stage.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {t(`pipelines.type.${stage.stageType}`)}
                      {stage.archivedAt === null
                        ? ''
                        : ` · ${t('pipelines.retired.on', { date: formatDate(stage.archivedAt, DEFAULT_PREFERENCES) })}`}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={t('pipelines.row.restore', { name: stage.name })}
                    loading={restore.isPending && restore.variables?.stageId === stage.id}
                    disabled={full}
                    onClick={() => {
                      setNotice(null);
                      restore.mutate({ stageId: stage.id, input: { version: stage.version } });
                    }}
                  >
                    {t('pipelines.row.restoreShort')}
                  </Button>
                </li>
              ))}
            </ul>
          </CardBody>
          {restore.isError ? (
            <p role="alert" className="border-t border-border px-5 py-3 text-sm text-destructive">
              {restore.error.error.details[0]?.message ?? restore.error.message}
            </p>
          ) : null}
        </Card>
      )}

      {adding ? (
        <AddStageDialog
          pending={create.isPending}
          error={create.error ?? null}
          onClose={() => setAdding(false)}
          onSubmit={(input) =>
            create.mutate(input, {
              onSuccess: () => {
                setAdding(false);
                setNotice(t('pipelines.added', { name: input.name.trim() }));
              },
            })
          }
        />
      ) : null}

      {retiring === null ? null : (
        <RetireStageDialog
          stage={retiring}
          inUse={stages}
          pending={archive.isPending}
          error={archive.error ?? null}
          onClose={() => setRetiring(null)}
          onConfirm={(moveDealsToStageId) =>
            archive.mutate(
              {
                stageId: retiring.id,
                input: {
                  version: retiring.version,
                  ...(moveDealsToStageId === undefined ? {} : { moveDealsToStageId }),
                },
              },
              {
                onSuccess: (answer) => {
                  setRetiring(null);
                  const count = answer.data.movedDeals;
                  setNotice(
                    t(
                      count === 0
                        ? 'pipelines.retired.done.none'
                        : count === 1
                          ? 'pipelines.retired.done.one'
                          : 'pipelines.retired.done.other',
                      { name: retiring.name, count },
                    ),
                  );
                },
              },
            )
          }
        />
      )}
    </div>
  );
}
