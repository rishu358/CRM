import { ErrorCode } from '@crm/core';
import { z } from 'zod';

import { errorResponseSchema, listMetaSchema } from './envelope.js';
import { API_ROUTES, type RouteDefinition, type RouteResponse } from './routes.js';

/**
 * The OpenAPI 3.1 document, generated from the Zod contracts (ADR-0007).
 *
 * OpenAPI 3.1 uses JSON Schema 2020-12, which is exactly what Zod's own
 * `z.toJSONSchema` emits, so this needs no schema-conversion dependency and no
 * second description of any request or response.
 *
 * ## Input and output are different documents
 *
 * A schema with `.transform()` — the email fields that lowercase, the boolean
 * query parameters that coerce — has no single JSON Schema: what a client
 * sends and what the server ends up with differ. Zod says so by refusing to
 * convert such a schema in `output` mode. That is the right answer rather than
 * an obstacle: request bodies, path parameters and query strings are converted
 * in `input` mode, which documents what a caller must send, and responses in
 * `output` mode, which documents what they get back. Nothing had to be removed
 * from a schema to make this work.
 *
 * `.refine()` predicates are dropped, because JSON Schema cannot express
 * "these two fields must be given together". Those rules are stated in prose
 * on the operation instead; the API still enforces them.
 *
 * ## This document decides nothing
 *
 * It is generated from contracts that already exist and is never read at
 * request time. Authentication, tenancy and permissions live in the guards,
 * the services and the serializers (ADR-0027).
 */

export const OPENAPI_VERSION = '3.1.0';

/** The one document version. Bumped by hand when the surface changes meaningfully. */
export const API_DOCUMENT_VERSION = '1.0.0';

/** JSON, as far as this file is concerned. Deliberately loose at the edges. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

/**
 * HTTP status for each stable error code.
 *
 * Mirrors the `DomainError` subclasses in `@crm/core`; `openapi.spec.ts`
 * asserts that every code in `ErrorCode` appears here, so a new code cannot be
 * added without deciding its status.
 */
const STATUS_BY_ERROR_CODE: Readonly<Record<ErrorCode, number>> = {
  [ErrorCode.INVALID_TOKEN]: 400,
  [ErrorCode.UNAUTHENTICATED]: 401,
  [ErrorCode.INVALID_CREDENTIALS]: 401,
  [ErrorCode.MFA_INVALID]: 401,
  [ErrorCode.INVITATION_SIGN_IN_REQUIRED]: 401,
  [ErrorCode.ENTITLEMENT_REQUIRED]: 402,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.EMAIL_NOT_VERIFIED]: 403,
  [ErrorCode.SIGN_UP_DISABLED]: 403,
  [ErrorCode.MFA_ENROLMENT_REQUIRED]: 403,
  [ErrorCode.FIELD_NOT_WRITABLE]: 403,
  [ErrorCode.INVITATION_RECIPIENT_MISMATCH]: 403,
  [ErrorCode.PERMISSION_ESCALATION]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.RECORD_MERGED]: 410,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.VERSION_CONFLICT]: 409,
  [ErrorCode.DUPLICATE_RECORDS]: 409,
  [ErrorCode.LAST_ADMINISTRATOR]: 409,
  [ErrorCode.ROLE_IN_USE]: 409,
  [ErrorCode.IDEMPOTENT_RECORD_UNAVAILABLE]: 409,
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 409,
  [ErrorCode.IDEMPOTENCY_IN_PROGRESS]: 409,
  [ErrorCode.RECORD_ALREADY_MERGED]: 409,
  [ErrorCode.VALIDATION_FAILED]: 422,
  [ErrorCode.MERGE_TOO_LARGE]: 422,
  [ErrorCode.MERGE_BLOCKED]: 422,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL]: 500,
  [ErrorCode.SERVICE_BUSY]: 503,
  [ErrorCode.SEARCH_TIMEOUT]: 503,
  [ErrorCode.FORM_EXPIRED]: 422,
};

/** A one-line gloss per status, so the document reads without the code table. */
const STATUS_SUMMARY: Readonly<Record<number, string>> = {
  400: 'The request was malformed, or a one-time token was wrong or expired.',
  401: 'No session, or the credentials offered were not accepted.',
  402: "The tenant's plan does not include this capability.",
  403: 'Authenticated, but not permitted.',
  404: 'No such record, or it is outside the caller’s tenant or visibility scope.',
  409: 'The write conflicts with the record’s current state.',
  410: 'The record was merged into another; the surviving record’s id is in `details`.',
  422: 'Input failed validation at the API boundary.',
  429: 'Rate limit exceeded. Limits are per user, per tenant and per address, shared across API instances. Wait the number of seconds in `Retry-After` and try again.',
  500: 'Unexpected failure. Quote `requestId` when reporting it.',
  503: 'The service is at capacity. Wait the number of seconds in `Retry-After` and try again.',
};

/** Every route can fail this way, whatever it does. */
const UNIVERSAL_ERRORS: readonly ErrorCode[] = [
  ErrorCode.VALIDATION_FAILED,
  ErrorCode.RATE_LIMITED,
  ErrorCode.SERVICE_BUSY,
  ErrorCode.INTERNAL,
];

/** Any route behind the global `AuthGuard` can fail these two ways. */
const SESSION_ERRORS: readonly ErrorCode[] = [ErrorCode.UNAUTHENTICATED, ErrorCode.FORBIDDEN];

// ---------------------------------------------------------------------------
// Schema conversion
// ---------------------------------------------------------------------------

/**
 * `$schema` and `$id` are correct for a standalone JSON Schema document and
 * wrong inside `components.schemas`, where the key *is* the identity.
 */
function stripSchemaKeywords(schema: JsonObject): JsonObject {
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return rest;
}

function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/**
 * Converts one schema on its own, with no `$ref`s.
 *
 * Used for parameters, whose properties are expanded inline — a `$ref` to a
 * whole query object would not be a parameter list.
 */
function convert(schema: z.ZodType, io: 'input' | 'output'): JsonObject {
  return stripSchemaKeywords(
    toJsonObject(z.toJSONSchema(schema, { target: 'draft-2020-12', io, reused: 'inline' })),
  );
}

/**
 * Collects named component schemas, converting each registry in one pass so
 * shared sub-schemas come out as `$ref`s rather than being copied per route.
 *
 * Two registries rather than one because `io` applies to a whole pass, and a
 * request schema with a transform cannot be converted in `output` mode at all.
 */
class ComponentCollector {
  private readonly inputs = z.registry<{ id: string }>();
  private readonly outputs = z.registry<{ id: string }>();
  private readonly inputIds = new Map<z.ZodType, string>();
  private readonly outputIds = new Map<z.ZodType, string>();

  /** Registers a schema under `name` and returns its `$ref`. */
  ref(schema: z.ZodType, name: string, io: 'input' | 'output'): JsonObject {
    const [registry, ids] =
      io === 'input'
        ? ([this.inputs, this.inputIds] as const)
        : ([this.outputs, this.outputIds] as const);

    const existing = ids.get(schema);
    if (existing !== undefined) {
      if (existing !== name) {
        throw new Error(
          `Schema registered as both "${existing}" and "${name}" (${io}). ` +
            'One schema is one component; give the route the name already in use.',
        );
      }
    } else {
      ids.set(schema, name);
      registry.add(schema, { id: name });
    }
    return { $ref: `#/components/schemas/${name}` };
  }

  /** The `components.schemas` map, with both passes merged. */
  build(): Record<string, JsonObject> {
    const out: Record<string, JsonObject> = {};
    for (const [registry, io] of [
      [this.inputs, 'input'],
      [this.outputs, 'output'],
    ] as const) {
      const { schemas } = z.toJSONSchema(registry, {
        target: 'draft-2020-12',
        io,
        reused: 'inline',
        uri: (id) => `#/components/schemas/${id}`,
      });
      for (const [id, schema] of Object.entries(schemas)) {
        const converted = stripSchemaKeywords(toJsonObject(schema));
        const previous = out[id];
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(converted)) {
          throw new Error(
            `Component "${id}" differs between the input and output passes. ` +
              'Give the request and response shapes distinct names.',
          );
        }
        out[id] = converted;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Expands an object schema into OpenAPI parameters.
 *
 * Repeatable parameters — `filter`, which is `string | string[]` — are emitted
 * with `style: form, explode: true`, which is how `?filter=a&filter=b` is
 * spelled in OpenAPI.
 */
function parameters(schema: z.ZodType, location: 'path' | 'query'): JsonObject[] {
  const converted = convert(schema, 'input');
  const properties = (converted['properties'] ?? {}) as Record<string, JsonValue>;
  const required = new Set((converted['required'] ?? []) as string[]);

  return Object.entries(properties).map(([name, propertySchema]) => {
    const parameter: JsonObject = {
      name,
      in: location,
      // A path parameter is required by definition, whatever the schema says.
      required: location === 'path' ? true : required.has(name),
      schema: propertySchema,
    };
    const description = (propertySchema as JsonObject)['description'];
    if (typeof description === 'string') parameter['description'] = description;
    if (isRepeatable(propertySchema)) {
      parameter['style'] = 'form';
      parameter['explode'] = true;
    }
    return parameter;
  });
}

/** True for `string | string[]` and friends: a parameter that may repeat. */
function isRepeatable(schema: JsonValue): boolean {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
  const anyOf = schema['anyOf'];
  if (!Array.isArray(anyOf)) return schema['type'] === 'array';
  return anyOf.some((branch) =>
    typeof branch === 'object' && branch !== null && !Array.isArray(branch)
      ? branch['type'] === 'array'
      : false,
  );
}

/** Builds the `{ data, meta }` body for a success response. */
function successBody(response: RouteResponse, components: ComponentCollector): JsonObject | null {
  if (response.kind === 'empty') return null;
  if (response.kind === 'raw') {
    return { [response.contentType]: { schema: { type: 'object' } } };
  }

  const data = response.kind === 'list' ? z.array(response.data) : response.data;
  const meta =
    response.meta ??
    (response.kind === 'list'
      ? listMetaSchema
      : // `meta` is optional on a single-record response and carries nothing
        // the client needs, so it is documented as a free-form object.
        z.record(z.string(), z.unknown()).optional());

  const envelope = z.object({ data, meta });
  return {
    'application/json': { schema: components.ref(envelope, response.name, 'output') },
  };
}

/** Groups a route's error codes by status, one response per status. */
function errorResponses(route: RouteDefinition): Record<string, JsonObject> {
  const codes = new Set<ErrorCode>([
    ...UNIVERSAL_ERRORS,
    ...(route.auth === 'session' ? SESSION_ERRORS : []),
    ...route.errors,
  ]);

  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const status = STATUS_BY_ERROR_CODE[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }

  const responses: Record<string, JsonObject> = {};
  for (const [status, statusCodes] of [...byStatus].sort(([a], [b]) => a - b)) {
    const sorted = [...statusCodes].sort();
    responses[String(status)] = {
      description: `${STATUS_SUMMARY[status] ?? 'Error.'} \`error.code\` is one of: ${sorted
        .map((code) => `\`${code}\``)
        .join(', ')}.`,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
      },
    };
  }
  return responses;
}

function operation(route: RouteDefinition, components: ComponentCollector): JsonObject {
  const operationObject: JsonObject = {
    operationId: route.operationId,
    summary: route.summary,
    tags: [route.tag],
  };
  if (route.description !== undefined) operationObject['description'] = route.description;

  // The document's `security` requires a session; a public route opts out with
  // an empty array, which is how OpenAPI spells "no credential needed".
  if (route.auth === 'public') operationObject['security'] = [];

  const params = [
    ...(route.params === undefined ? [] : parameters(route.params, 'path')),
    ...(route.query === undefined ? [] : parameters(route.query, 'query')),
  ];
  if (params.length > 0) operationObject['parameters'] = params;

  if (route.body !== undefined) {
    operationObject['requestBody'] = {
      required: true,
      content: {
        'application/json': {
          schema: components.ref(route.body.schema, route.body.name, 'input'),
        },
      },
    };
  }

  const body = successBody(route.response, components);
  const success: JsonObject = { description: route.response.description };
  if (body !== null) success['content'] = body;

  operationObject['responses'] = {
    [String(route.response.status)]: success,
    ...errorResponses(route),
  };
  return operationObject;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const DESCRIPTION = [
  'The CRM platform API. One versioned REST surface: the web app, the mobile app,',
  'the public API and partner integrations are all clients of exactly this, and there',
  'are no hidden internal endpoints (ADR-0007).',
  '',
  '## Authentication',
  '',
  'Every endpoint requires a session except liveness, readiness and this document',
  'itself. A browser authenticates with the httpOnly session cookie set at sign-in;',
  'every other client sends `Authorization: Bearer <token>`. A user who belongs to',
  'more than one workspace may name one with `X-Tenant-Id` — that is a request, not',
  'an authorization: the server checks the membership and derives the tenant from the',
  'session either way (CLAUDE.md §5.2).',
  '',
  'A handful of routes are reachable without a session because they cannot have one',
  'yet — sign-up, sign-in, the MFA second step, email verification, the password-reset',
  'pair, Google sign-in, and invitation acceptance. They are not unauthenticated: the',
  'one-time token in the link or body *is* the credential, and it is checked against',
  'its own row (ADR-0019). They are marked `security: []` below.',
  '',
  '## Envelopes',
  '',
  'Every success is `{ data, meta }`; every failure is `{ error: { code, message,',
  'details, requestId } }` with a stable, machine-readable `code`. Codes may be added',
  'to, never renamed. Every response carries `X-Request-Id`; quote it when reporting a',
  'problem.',
  '',
  '## Paging',
  '',
  'Lists are keyset-paginated (ADR-0012): pass `meta.nextCursor` back as `cursor`.',
  'There is no `page` or `offset`. The cursor is opaque — never parse or construct one.',
  '',
  '## Versioning',
  '',
  'Within `/api/v1`, changes are additive only. Anything breaking gets `/api/v2`.',
  '',
  '## How this document is produced',
  '',
  'Generated from the Zod schemas in `packages/contracts`, which are the same schemas',
  'the API validates with — so it cannot drift from what the server accepts. Rules that',
  'JSON Schema cannot express (for example "these two query parameters must be given',
  'together") are stated in prose on the operation and enforced by the API regardless.',
].join('\n');

const TAG_DESCRIPTIONS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'Health', description: 'Liveness and readiness. The only routes with no session.' },
  { name: 'Meta', description: 'This document.' },
  { name: 'Authentication', description: 'Sign-in, sessions, passwords and MFA.' },
  { name: 'Invitations', description: 'Inviting people into a workspace, and accepting.' },
  { name: 'Accounts', description: 'Companies.' },
  { name: 'Contacts', description: 'People.' },
  { name: 'Leads', description: 'Unqualified interest, and its conversion.' },
  { name: 'Deals', description: 'Opportunities, pipelines and the board.' },
  { name: 'Activities', description: 'Tasks, calls, meetings, notes and My Day.' },
  { name: 'Search', description: 'One query across every object the caller may read.' },
  { name: 'Notifications', description: 'The bell.' },
  { name: 'Lead forms', description: 'Website lead forms: building them and their keys.' },
  {
    name: 'Public forms',
    description: 'The two routes a website visitor reaches with no session (ADR-0065).',
  },
  { name: 'Saved Views', description: 'A list’s search, filters, columns and sort, under a name.' },
  { name: 'Merge', description: 'Fold a duplicate contact or account into the one that stays.' },
  {
    name: 'Bulk Actions',
    description: 'Edit, assign, delete and tag many records.',
  },
  {
    name: 'Tags',
    description: 'The workspace’s tags: the list, the settings screen, and the filter on a list.',
  },
];

/** `/contacts/{id}` sorts before `/contacts/{id}/links`; deterministic either way. */
function sortedRoutes(): RouteDefinition[] {
  return [...API_ROUTES].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

export function buildOpenApiDocument(): JsonObject {
  const components = new ComponentCollector();
  components.ref(errorResponseSchema, 'ErrorResponse', 'output');

  const paths: Record<string, JsonObject> = {};
  for (const route of sortedRoutes()) {
    const item = paths[route.path] ?? {};
    const method = route.method.toLowerCase();
    if (method in item) {
      throw new Error(`Duplicate route in the registry: ${route.method} ${route.path}`);
    }
    item[method] = operation(route, components);
    paths[route.path] = item;
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'CRM Platform API',
      version: API_DOCUMENT_VERSION,
      description: DESCRIPTION,
    },
    servers: [{ url: '/api/v1', description: 'This deployment.' }],
    tags: TAG_DESCRIPTIONS.map((tag) => ({ ...tag })),
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'The session token returned by `/auth/sign-in` to a non-browser client.',
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'crm_session',
          description:
            'Set at sign-in: httpOnly, Secure, SameSite=Lax. A browser never reads it, ' +
            'and state-changing requests additionally carry CSRF protection.',
        },
      },
      schemas: components.build(),
    },
  };
}

/** The document as it is written to `docs/openapi.json` and served. */
export function openApiJson(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
