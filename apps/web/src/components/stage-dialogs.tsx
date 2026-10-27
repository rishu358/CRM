'use client';

import {
  MAX_DEALS_MOVED_PER_RETIREMENT,
  STAGE_NAME_MAX_LENGTH,
  canMoveDealsBetween,
} from '@crm/core';
import type { ManagedStage, StageCreateInput } from '@crm/contracts';
import { Button, Dialog, Input, Select } from '@crm/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiRequestError } from '../lib/api-client';
import { t } from '../lib/i18n';

/**
 * The two dialogs of the pipeline editor (MVP_SPEC M5, ADR-0062): adding a stage, and retiring one.
 *
 * Both only ask. The rules (names, probabilities, which deals may go where) are enforced by the API
 * and answered here as a sentence; what the form mirrors is for feedback, never enforcement.
 */

/** The server's sentence for a field, if it sent one for it. */
export function detailFor(error: ApiRequestError | null, path: string): string | undefined {
  return error?.error.details.find((detail) => detail.path === path)?.message;
}

const STAGE_TYPES = ['open', 'won', 'lost'] as const;

export function AddStageDialog({
  pending,
  error,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  error: ApiRequestError | null;
  onClose: () => void;
  onSubmit: (input: StageCreateInput) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  // Where they can type, done in code as the rest of the app does, not with `autoFocus`.
  useEffect(() => nameRef.current?.focus(), []);
  const [name, setName] = useState('');
  const [stageType, setStageType] = useState<(typeof STAGE_TYPES)[number]>('open');
  const [probability, setProbability] = useState('50');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      name,
      stageType,
      ...(stageType === 'open' ? { probability: Number(probability) } : {}),
    });
  };

  return (
    <Dialog
      title={t('pipelines.add.title')}
      description={t('pipelines.add.description')}
      closeLabel={t('common.close')}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input
          label={t('pipelines.add.name')}
          value={name}
          maxLength={STAGE_NAME_MAX_LENGTH + 20}
          ref={nameRef}
          required
          onChange={(event) => setName(event.target.value)}
          error={detailFor(error, 'name')}
        />
        <Select
          label={t('pipelines.add.type')}
          value={stageType}
          onChange={(event) => setStageType(event.target.value as (typeof STAGE_TYPES)[number])}
          hint={t(`pipelines.type.${stageType}.hint` as const)}
        >
          {STAGE_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`pipelines.type.${type}` as const)}
            </option>
          ))}
        </Select>
        {stageType === 'open' ? (
          <Input
            label={t('pipelines.add.probability')}
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            value={probability}
            onChange={(event) => setProbability(event.target.value)}
            error={detailFor(error, 'probability')}
            hint={t('pipelines.add.probabilityHint')}
          />
        ) : null}
        {error !== null &&
        detailFor(error, 'name') === undefined &&
        detailFor(error, 'probability') === undefined ? (
          <p role="alert" className="text-sm text-destructive">
            {error.error.details[0]?.message ?? error.message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('pipelines.cancel')}
          </Button>
          <Button type="submit" loading={pending} disabled={name.trim().length === 0}>
            {t('pipelines.add.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Retire a stage. If it holds deals the person must choose where they go, and the dialog says how
 * many are affected before anything happens; the confirm button repeats the count so the click is
 * an informed one.
 */
export function RetireStageDialog({
  stage,
  inUse,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  stage: ManagedStage;
  /** Every stage in use in the same pipeline, in board order. */
  inUse: readonly ManagedStage[];
  pending: boolean;
  error: ApiRequestError | null;
  onClose: () => void;
  onConfirm: (moveDealsToStageId: string | undefined) => void;
}) {
  const held = stage.dealCount + stage.recycleBinDealCount;
  const targets = inUse.filter(
    (candidate) =>
      candidate.id !== stage.id && canMoveDealsBetween(stage.stageType, candidate.stageType),
  );
  const [target, setTarget] = useState(targets[0]?.id ?? '');
  const tooMany = held > MAX_DEALS_MOVED_PER_RETIREMENT;
  const cannot = held > 0 && (targets.length === 0 || tooMany);

  return (
    <Dialog
      title={t('pipelines.retire.title', { name: stage.name })}
      closeLabel={t('common.close')}
      onClose={onClose}
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('pipelines.retire.body')}</p>

        {held === 0 ? (
          <p className="text-sm">{t('pipelines.retire.noDeals')}</p>
        ) : (
          <>
            <p className="text-sm font-medium" data-testid="retire-deal-count">
              {t(
                stage.dealCount === 1
                  ? 'pipelines.retire.affected.one'
                  : 'pipelines.retire.affected.other',
                {
                  count: stage.dealCount,
                },
              )}
              {stage.recycleBinDealCount > 0
                ? ` ${t('pipelines.retire.inBin', { count: stage.recycleBinDealCount })}`
                : ''}
            </p>
            {tooMany ? (
              <p role="alert" className="text-sm text-destructive">
                {t('pipelines.retire.tooMany', { max: MAX_DEALS_MOVED_PER_RETIREMENT })}
              </p>
            ) : targets.length === 0 ? (
              <p role="alert" className="text-sm text-destructive">
                {t('pipelines.retire.noTarget')}
              </p>
            ) : (
              <Select
                label={t('pipelines.retire.target')}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                hint={t('pipelines.retire.targetHint')}
                error={detailFor(error, 'moveDealsToStageId')}
              >
                {targets.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </Select>
            )}
          </>
        )}

        {error !== null && detailFor(error, 'moveDealsToStageId') === undefined ? (
          <p role="alert" className="text-sm text-destructive">
            {error.error.details[0]?.message ?? error.message}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('pipelines.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            loading={pending}
            disabled={cannot}
            onClick={() => onConfirm(held === 0 ? undefined : target)}
          >
            {held === 0
              ? t('pipelines.retire.confirm')
              : t(
                  held === 1
                    ? 'pipelines.retire.confirmMove.one'
                    : 'pipelines.retire.confirmMove.other',
                  {
                    count: held,
                  },
                )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
