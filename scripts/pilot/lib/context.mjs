/**
 * What a signed-in person can learn about their workspace from the API alone: the field definitions
 * (so custom field keys are looked up by label, never assumed), the pipeline, and the team.
 */

const OBJECTS = ['account', 'contact', 'lead', 'deal'];

export async function discover(api) {
  const fields = {};
  for (const objectType of OBJECTS) {
    const response = await api.get('fields.list', '/fields', { objectType });
    if (!response.ok) throw new Error(`cannot list ${objectType} fields: HTTP ${response.status}`);
    fields[objectType] = response.data;
  }
  const pipelines = await api.get('pipelines.list', '/pipelines');
  if (!pipelines.ok) throw new Error(`cannot list pipelines: HTTP ${pipelines.status}`);
  const pipeline = pipelines.data.find((item) => item.isDefault) ?? pipelines.data[0];
  const members = await api.get('members.list', '/members', { limit: 200 });
  const profile = await api.get('tenant.get', '/tenant');
  return {
    fields,
    pipeline,
    stages: pipeline.stages,
    openStages: pipeline.stages.filter((stage) => stage.stageType === 'open'),
    wonStage: pipeline.stages.find((stage) => stage.stageType === 'won'),
    lostStage: pipeline.stages.find((stage) => stage.stageType === 'lost'),
    members: members.ok ? members.data : [],
    tenant: profile.ok ? profile.data : null,
  };
}

/** The API key of a custom field, found by its label. */
export function fieldKey(context, objectType, label) {
  const found = context.fields[objectType].find((field) => field.label === label);
  if (!found) throw new Error(`no ${objectType} field labelled "${label}"`);
  return found.key;
}

/** The stored value of a picklist option, found by its label. */
export function optionValue(context, objectType, label, optionLabel) {
  const found = context.fields[objectType].find((field) => field.label === label);
  const option = found?.options?.find((item) => item.label === optionLabel);
  if (!option) throw new Error(`no option "${optionLabel}" on ${objectType} field "${label}"`);
  return option.value;
}

export function optionValues(context, objectType, label) {
  const found = context.fields[objectType].find((field) => field.label === label);
  return (found?.options ?? []).filter((item) => item.isActive !== false).map((item) => item.value);
}
