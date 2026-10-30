'use client';

import { CONDITION_OPERATORS, MAX_RULE_CONDITIONS } from '@crm/core';
import type { AssignmentOverview, AssignmentRule } from '@crm/contracts';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  Checkbox,
  CloseIcon,
  Dialog,
  DialogFooter,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  NoPermissionState,
  PageHeader,
  PlusIcon,
  Select,
} from '@crm/ui';
import { useState } from 'react';
import type { ApiRequestError } from '../lib/api-client';
import { t, type TranslationKey } from '../lib/i18n';
import {
  useAssignmentOverview,
  useCreateRule,
  useDeleteRule,
  useOrderRules,
  useTestAssignment,
  useToggleRule,
  useUpdateAssignmentSettings,
  useUpdateRule,
} from '../lib/lead-assignment';
import { AppShell } from './app-shell';

/**
 * Lead assignment: the rules that choose who gets a new lead (ADR-0065 10).
 *
 * An ordered list, a default owner and a place to try a sample lead. The screen mirrors what the API
 * enforces (the operators, the limits, who can be named) so a person is told before they click; the
 * server checks it all again and its answer is what is shown. Reordering is by Move up and Move down
 * buttons: the keyboard path and the touch path at once.
 *
 * Whether a person may be here is the API's answer (a 403), never a guess from a role name.
 */

type Operator = (typeof CONDITION_OPERATORS)[number];

interface ConditionDraft {
  field: string;
  operator: Operator;
  value: string;
}

const NO_VALUE: readonly Operator[] = ['is_empty', 'is_not_empty'];

function detail(error: ApiRequestError | null, path: string): string | undefined {
  return error?.error.details.find((entry) => entry.path === path)?.message;
}

function conditionText(
  condition: AssignmentRule['conditions'][number],
  overview: AssignmentOverview,
): string {
  const field =
    overview.fields.find((entry) => entry.key === condition.field)?.label ?? condition.field;
  const value = Array.isArray(condition.value)
    ? condition.value.join(', ')
    : (condition.value ?? '');
  return t(`assignment.condition.${condition.operator}` as TranslationKey, { field, value });
}

function describeRule(rule: AssignmentRule, overview: AssignmentOverview): string {
  const when =
    rule.conditions.length === 0
      ? t('assignment.rule.always')
      : t('assignment.rule.when', {
          conditions: rule.conditions
            .map((condition) => conditionText(condition, overview))
            .join(t('assignment.condition.and')),
        });
  if (rule.action.type === 'user') {
    const userId = rule.action.userId;
    const name =
      overview.people.find((person) => person.id === userId)?.name ??
      t('assignment.rule.unknownPerson');
    return `${when}, ${t('assignment.rule.then', { target: name })}`;
  }
  if (rule.action.type === 'team_round_robin') {
    const teamId = rule.action.teamId;
    const name =
      overview.teams.find((team) => team.id === teamId)?.name ?? t('assignment.rule.unknownTeam');
    return `${when}, ${t('assignment.rule.thenTeam', { target: name })}`;
  }
  return `${when}, ${t('assignment.rule.thenDefault')}`;
}

export function LeadAssignmentScreen() {
  const query = useAssignmentOverview();
  const header = (
    <PageHeader title={t('assignment.title')} description={t('assignment.description')} />
  );

  if (query.isError) {
    return (
      <AppShell>
        {header}
        {query.error.status === 403 ? (
          <NoPermissionState
            title={t('assignment.forbidden.title')}
            description={t('assignment.forbidden.description')}
          />
        ) : (
          <ErrorState
            title={t('assignment.error.title')}
            description={t('assignment.error.description')}
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

  if (query.data === undefined) {
    return (
      <AppShell>
        {header}
        <CardSkeleton rows={4} label={t('common.loading')} />
      </AppShell>
    );
  }

  return (
    <AppShell>
      {header}
      <AssignmentBody overview={query.data.data} />
    </AppShell>
  );
}

function AssignmentBody({ overview }: { overview: AssignmentOverview }) {
  const order = useOrderRules();
  const toggle = useToggleRule();
  const remove = useDeleteRule();
  const [editing, setEditing] = useState<AssignmentRule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AssignmentRule | null>(null);

  const move = (index: number, by: -1 | 1) => {
    const ids = overview.rules.map((rule) => rule.id);
    const [moved] = ids.splice(index, 1);
    if (moved === undefined) return;
    ids.splice(index + by, 0, moved);
    order.mutate({ ruleIds: ids });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={t('assignment.rulesTitle')}
          description={
            <span className="figures">
              {t('assignment.rulesCount', {
                count: overview.rules.length,
                max: overview.maxRules,
              })}
            </span>
          }
          actions={
            <Button
              onClick={() => setEditing('new')}
              disabled={overview.rules.length >= overview.maxRules}
            >
              <PlusIcon className="h-4 w-4" />
              {t('assignment.add')}
            </Button>
          }
        />
        <CardBody className="p-0">
          {overview.rules.length === 0 ? (
            <EmptyState
              title={t('assignment.empty.title')}
              description={t('assignment.empty.description')}
              compact
            />
          ) : (
            <ol className="divide-y divide-border" data-testid="assignment-rules">
              {overview.rules.map((rule, index) => (
                <li key={rule.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span className="figures text-muted-foreground">{index + 1}.</span>
                      {rule.name}
                      <Badge tone={rule.enabled ? 'success' : 'neutral'}>
                        {rule.enabled ? t('assignment.rule.on') : t('assignment.rule.off')}
                      </Badge>
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {describeRule(rule, overview)}
                    </p>
                  </div>
                  <Checkbox
                    label={t('assignment.rule.toggle', { rule: rule.name })}
                    hideLabel
                    checked={rule.enabled}
                    disabled={toggle.isPending}
                    onChange={(event) => toggle.mutate({ rule, enabled: event.target.checked })}
                  />
                  <div className="flex items-center gap-1">
                    <IconButton
                      label={t('assignment.rule.moveUp', { rule: rule.name })}
                      icon={<ArrowUpIcon className="h-4 w-4" />}
                      disabled={index === 0 || order.isPending}
                      onClick={() => move(index, -1)}
                    />
                    <IconButton
                      label={t('assignment.rule.moveDown', { rule: rule.name })}
                      icon={<ArrowDownIcon className="h-4 w-4" />}
                      disabled={index === overview.rules.length - 1 || order.isPending}
                      onClick={() => move(index, 1)}
                    />
                    <Button variant="outline" onClick={() => setEditing(rule)}>
                      {t('assignment.rule.edit')}
                    </Button>
                    <Button variant="ghost" onClick={() => setDeleting(rule)}>
                      {t('assignment.rule.delete')}
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>

      <DefaultOwnerCard overview={overview} />
      <TestCard overview={overview} />

      {editing === null ? null : (
        <RuleEditor
          key={editing === 'new' ? 'new' : `${editing.id}-${editing.version}`}
          overview={overview}
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}

      {deleting === null ? null : (
        <Dialog
          title={t('assignment.delete.title')}
          description={t('assignment.delete.body')}
          closeLabel={t('common.close')}
          onClose={() => setDeleting(null)}
        >
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('assignment.editor.cancel')}
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(
                  { id: deleting.id, version: deleting.version },
                  { onSuccess: () => setDeleting(null) },
                )
              }
            >
              {t('assignment.delete.confirm')}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

function DefaultOwnerCard({ overview }: { overview: AssignmentOverview }) {
  const save = useUpdateAssignmentSettings();
  const [owner, setOwner] = useState(overview.settings.defaultOwnerId ?? '');

  return (
    <Card>
      <CardHeader
        title={t('assignment.default.title')}
        description={t('assignment.default.description')}
      />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t('assignment.default.label')}
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            error={detail(save.error, 'defaultOwnerId')}
          >
            <option value="">{t('assignment.default.none')}</option>
            {overview.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
          <Button
            variant="outline"
            loading={save.isPending}
            onClick={() =>
              save.mutate({
                defaultOwnerId: owner === '' ? null : owner,
                version: overview.settings.version,
              })
            }
          >
            {t('assignment.default.save')}
          </Button>
        </div>
        {overview.settings.defaultOwnerId !== null && !overview.settings.defaultOwnerEligible ? (
          <p role="alert" className="text-sm text-destructive">
            {t('assignment.default.gone')}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

function TestCard({ overview }: { overview: AssignmentOverview }) {
  const test = useTestAssignment();
  const [sample, setSample] = useState<{ field: string; value: string }[]>([]);
  const [adding, setAdding] = useState('');

  const available = overview.fields.filter(
    (field) => !sample.some((row) => row.field === field.key),
  );
  const result = test.data;

  return (
    <Card>
      <CardHeader
        title={t('assignment.test.title')}
        description={t('assignment.test.description')}
      />
      <CardBody className="space-y-4">
        <ul className="space-y-3">
          {sample.map((row, index) => {
            const field = overview.fields.find((entry) => entry.key === row.field);
            return (
              <li key={row.field} className="flex items-end gap-2">
                {field?.options === undefined ? (
                  <Input
                    label={field?.label ?? row.field}
                    wrapperClassName="min-w-56"
                    value={row.value}
                    onChange={(event) =>
                      setSample((rows) =>
                        rows.map((entry, i) =>
                          i === index ? { ...entry, value: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                ) : (
                  <Select
                    label={field.label}
                    value={row.value}
                    onChange={(event) =>
                      setSample((rows) =>
                        rows.map((entry, i) =>
                          i === index ? { ...entry, value: event.target.value } : entry,
                        ),
                      )
                    }
                  >
                    <option value="">{t('assignment.editor.choose')}</option>
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                )}
                <IconButton
                  label={t('assignment.test.removeField', { field: field?.label ?? row.field })}
                  icon={<CloseIcon className="h-4 w-4" />}
                  onClick={() => setSample((rows) => rows.filter((_, i) => i !== index))}
                />
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t('assignment.test.addField')}
            value={adding}
            onChange={(event) => {
              const key = event.target.value;
              if (key !== '') setSample((rows) => [...rows, { field: key, value: '' }]);
              setAdding('');
            }}
          >
            <option value="">{t('assignment.editor.choose')}</option>
            {available.map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
              </option>
            ))}
          </Select>
          <Button
            loading={test.isPending}
            onClick={() =>
              test.mutate({
                trigger: 'web_form',
                fields: Object.fromEntries(sample.map((row) => [row.field, row.value])),
              })
            }
          >
            {t('assignment.test.run')}
          </Button>
        </div>
        {result === undefined ? null : (
          <p role="status" className="text-sm" data-testid="assignment-test-result">
            {t(`assignment.test.result.${result.reason}` as TranslationKey, {
              owner: result.ownerName ?? '',
              rule: result.ruleName ?? '',
            })}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function RuleEditor({
  overview,
  rule,
  onClose,
}: {
  overview: AssignmentOverview;
  rule: AssignmentRule | null;
  onClose: () => void;
}) {
  const create = useCreateRule();
  const update = useUpdateRule(rule?.id ?? '');
  const mutation = rule === null ? create : update;
  const error: ApiRequestError | null = mutation.error;
  const stale = error?.status === 409 && error.code === 'VERSION_CONFLICT';

  const [name, setName] = useState(rule?.name ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [conditions, setConditions] = useState<ConditionDraft[]>(
    (rule?.conditions ?? []).map((condition) => ({
      field: condition.field,
      operator: condition.operator,
      value: Array.isArray(condition.value) ? condition.value.join(', ') : (condition.value ?? ''),
    })),
  );
  const [actionType, setActionType] = useState<'user' | 'team_round_robin' | 'default_owner'>(
    rule?.action.type ?? 'user',
  );
  const [userId, setUserId] = useState(rule?.action.type === 'user' ? rule.action.userId : '');
  const [teamId, setTeamId] = useState(
    rule?.action.type === 'team_round_robin' ? rule.action.teamId : '',
  );

  const patchCondition = (index: number, change: Partial<ConditionDraft>) =>
    setConditions((rows) => rows.map((row, i) => (i === index ? { ...row, ...change } : row)));

  const body = () => ({
    name,
    enabled,
    appliesTo: ['web_form' as const],
    conditions: conditions.map((condition) => ({
      field: condition.field,
      operator: condition.operator,
      ...(NO_VALUE.includes(condition.operator)
        ? {}
        : {
            value:
              condition.operator === 'in'
                ? condition.value
                    .split(',')
                    .map((part) => part.trim())
                    .filter((part) => part !== '')
                : condition.value,
          }),
    })),
    action:
      actionType === 'user'
        ? { type: 'user' as const, userId }
        : actionType === 'team_round_robin'
          ? { type: 'team_round_robin' as const, teamId }
          : { type: 'default_owner' as const },
  });

  const save = () => {
    if (rule === null) {
      create.mutate(body(), { onSuccess: onClose });
    } else {
      update.mutate({ ...body(), version: rule.version }, { onSuccess: onClose });
    }
  };

  return (
    <Dialog
      title={rule === null ? t('assignment.editor.titleNew') : t('assignment.editor.titleEdit')}
      closeLabel={t('common.close')}
      onClose={onClose}
      size="lg"
      data-testid="assignment-editor"
    >
      <div className="space-y-5">
        {stale ? (
          <div role="alert" className="rounded-md border border-border p-3 text-sm">
            <p className="font-medium">{t('assignment.editor.conflictTitle')}</p>
            <p className="text-muted-foreground">{t('assignment.editor.conflictBody')}</p>
          </div>
        ) : null}
        <Input
          label={t('assignment.editor.name')}
          maxLength={80}
          value={name}
          error={detail(error, 'name')}
          onChange={(event) => setName(event.target.value)}
        />
        <Checkbox
          label={t('assignment.editor.enabled')}
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t('assignment.editor.conditions')}</legend>
          <p className="text-xs text-muted-foreground">{t('assignment.editor.conditionsHint')}</p>
          {conditions.map((condition, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <Select
                label={`${t('assignment.editor.field')} ${index + 1}`}
                value={condition.field}
                error={detail(error, `conditions.${index}.field`)}
                onChange={(event) => patchCondition(index, { field: event.target.value })}
              >
                <option value="">{t('assignment.editor.choose')}</option>
                {overview.fields.map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.label}
                  </option>
                ))}
              </Select>
              <Select
                label={`${t('assignment.editor.operator')} ${index + 1}`}
                value={condition.operator}
                onChange={(event) =>
                  patchCondition(index, { operator: event.target.value as Operator })
                }
              >
                {CONDITION_OPERATORS.map((operator) => (
                  <option key={operator} value={operator}>
                    {t(`assignment.op.${operator}` as TranslationKey)}
                  </option>
                ))}
              </Select>
              {NO_VALUE.includes(condition.operator) ? null : (
                <Input
                  label={`${
                    condition.operator === 'in'
                      ? t('assignment.editor.valueIn')
                      : t('assignment.editor.value')
                  } ${index + 1}`}
                  maxLength={200}
                  value={condition.value}
                  error={detail(error, `conditions.${index}.value`)}
                  onChange={(event) => patchCondition(index, { value: event.target.value })}
                />
              )}
              <IconButton
                label={t('assignment.editor.removeCondition', { n: index + 1 })}
                icon={<CloseIcon className="h-4 w-4" />}
                onClick={() => setConditions((rows) => rows.filter((_, i) => i !== index))}
              />
            </div>
          ))}
          <Button
            variant="outline"
            disabled={conditions.length >= MAX_RULE_CONDITIONS}
            onClick={() =>
              setConditions((rows) => [...rows, { field: '', operator: 'equals', value: '' }])
            }
          >
            <PlusIcon className="h-4 w-4" />
            {t('assignment.editor.addCondition')}
          </Button>
        </fieldset>

        <div className="space-y-3">
          <Select
            label={t('assignment.editor.action')}
            value={actionType}
            onChange={(event) => setActionType(event.target.value as typeof actionType)}
          >
            <option value="user">{t('assignment.editor.actionUser')}</option>
            <option value="team_round_robin">{t('assignment.editor.actionTeam')}</option>
            <option value="default_owner">{t('assignment.editor.actionDefault')}</option>
          </Select>
          {actionType === 'user' ? (
            <Select
              label={t('assignment.editor.person')}
              value={userId}
              error={detail(error, 'action.userId')}
              onChange={(event) => setUserId(event.target.value)}
            >
              <option value="">{t('assignment.editor.choose')}</option>
              {overview.people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          ) : null}
          {actionType === 'team_round_robin' ? (
            <Select
              label={t('assignment.editor.team')}
              value={teamId}
              error={detail(error, 'action.teamId')}
              onChange={(event) => setTeamId(event.target.value)}
            >
              <option value="">{t('assignment.editor.choose')}</option>
              {overview.teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {t('assignment.editor.teamEligible', {
                    name: team.name,
                    count: team.eligibleMembers,
                  })}
                </option>
              ))}
            </Select>
          ) : null}
        </div>

        {error !== null && !stale && error.error.details.length === 0 ? (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('assignment.editor.cancel')}
        </Button>
        <Button onClick={save} loading={mutation.isPending}>
          {t('assignment.editor.save')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
