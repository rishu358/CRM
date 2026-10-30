import { ErrorCode } from '@crm/core';
import {
  assignmentOverviewSchema,
  assignmentRuleCreateSchema,
  assignmentRuleDeleteQuerySchema,
  assignmentRuleOrderSchema,
  assignmentRuleParamsSchema,
  assignmentRuleSchema,
  assignmentRuleUpdateSchema,
  assignmentSettingsUpdateSchema,
  assignmentTestResultSchema,
  assignmentTestSchema,
} from './lead-assignment.js';
import type { RouteDefinition } from './routes.js';

const VERSIONED: readonly ErrorCode[] = [ErrorCode.NOT_FOUND, ErrorCode.VERSION_CONFLICT];

const NOTE =
  'Needs the `lead_assignment` grant for the action (`read` to look and to test a sample lead, ' +
  '`create` to add a rule, `update` to edit, reorder or change the default owner, `delete` to remove ' +
  'one); Owner and Admin have all four. Rules are tried in order and the first that matches and can ' +
  'be carried out wins; one whose person has left, or whose team has nobody who can work leads, is ' +
  'skipped rather than stopping at it (ADR-0065 10).';

/** The assignment rules' routes, kept beside their schemas and spread into `API_ROUTES`. */
export const leadAssignmentRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    path: '/lead-assignment',
    operationId: 'getLeadAssignment',
    tag: 'Lead assignment',
    summary: 'The assignment rules, the default owner and what the editor can offer',
    description:
      'The rules in order, the default owner, the lead fields a condition may look at, the people ' +
      'who can be given a lead and the teams, so the screen is drawn from one answer. ' +
      NOTE,
    auth: 'session',
    response: {
      kind: 'object',
      status: 200,
      name: 'LeadAssignmentResponse',
      description: 'The overview.',
      data: assignmentOverviewSchema,
    },
    errors: [],
  },
  {
    method: 'POST',
    path: '/lead-assignment/rules',
    operationId: 'createAssignmentRule',
    tag: 'Lead assignment',
    summary: 'Add an assignment rule',
    description:
      'The new rule goes last. A rule with no conditions matches every lead of its kinds. The ' +
      'person or team it names must exist and be able to work leads. At most `maxRules` rules. ' +
      NOTE,
    auth: 'session',
    body: { name: 'AssignmentRuleCreate', schema: assignmentRuleCreateSchema },
    response: {
      kind: 'object',
      status: 201,
      name: 'AssignmentRuleCreateResponse',
      description: 'The overview after the change.',
      data: assignmentOverviewSchema,
    },
    errors: [ErrorCode.CONFLICT],
  },
  {
    method: 'POST',
    path: '/lead-assignment/rules/order',
    operationId: 'orderAssignmentRules',
    tag: 'Lead assignment',
    summary: 'Put the rules in a new order',
    description:
      'Every rule once, in the order wanted; a list that leaves one out or names one that does not ' +
      'exist is refused. ' +
      NOTE,
    auth: 'session',
    body: { name: 'AssignmentRuleOrder', schema: assignmentRuleOrderSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'AssignmentRuleOrderResponse',
      description: 'The overview after the change.',
      data: assignmentOverviewSchema,
    },
    errors: [ErrorCode.CONFLICT],
  },
  {
    method: 'PATCH',
    path: '/lead-assignment/rules/{id}',
    operationId: 'updateAssignmentRule',
    tag: 'Lead assignment',
    summary: 'Edit, switch on or off, or retarget a rule',
    description: 'Carries `version`; a stale one is a 409. ' + NOTE,
    auth: 'session',
    params: assignmentRuleParamsSchema,
    body: { name: 'AssignmentRuleUpdate', schema: assignmentRuleUpdateSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'AssignmentRuleUpdateResponse',
      description: 'The rule after the change.',
      data: assignmentRuleSchema,
    },
    errors: [...VERSIONED, ErrorCode.CONFLICT],
  },
  {
    method: 'DELETE',
    path: '/lead-assignment/rules/{id}',
    operationId: 'deleteAssignmentRule',
    tag: 'Lead assignment',
    summary: 'Remove a rule',
    description: NOTE,
    auth: 'session',
    params: assignmentRuleParamsSchema,
    query: assignmentRuleDeleteQuerySchema,
    response: { kind: 'empty', status: 204, description: 'The rule is removed.' },
    errors: VERSIONED,
  },
  {
    method: 'PATCH',
    path: '/lead-assignment/settings',
    operationId: 'updateLeadAssignmentSettings',
    tag: 'Lead assignment',
    summary: 'Choose the default owner',
    description:
      'The person who gets a lead when no rule decides. Must be able to work leads, or null to leave ' +
      'it to the form’s own maker. ' +
      NOTE,
    auth: 'session',
    body: { name: 'AssignmentSettingsUpdate', schema: assignmentSettingsUpdateSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'AssignmentSettingsUpdateResponse',
      description: 'The overview after the change.',
      data: assignmentOverviewSchema,
    },
    errors: VERSIONED,
  },
  {
    method: 'POST',
    path: '/lead-assignment/test',
    operationId: 'testLeadAssignment',
    tag: 'Lead assignment',
    summary: 'Try a sample lead against the rules',
    description:
      'Says who would get a lead with these fields, and by which rule. Reads only: nothing is ' +
      'saved and no round-robin turn is taken, so testing never changes who gets the next real ' +
      'lead. ' +
      NOTE,
    auth: 'session',
    body: { name: 'AssignmentTest', schema: assignmentTestSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'AssignmentTestResponse',
      description: 'Who would get it.',
      data: assignmentTestResultSchema,
    },
    errors: [],
  },
];
