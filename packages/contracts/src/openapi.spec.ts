import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ErrorCode } from '@crm/core';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument, openApiJson, type JsonObject } from './openapi.js';
import { API_ROUTES, routeKey } from './routes.js';

/**
 * The document, and the committed copy of it.
 *
 * `docs/openapi.json` is tracked so that a change to the API surface shows up
 * in review as a diff rather than as nothing at all. This test is what makes
 * that true: regenerating is not optional, because forgetting fails the build.
 *
 * The other half of the guarantee — that the registry describes the routes the
 * API actually serves — is in `apps/api/src/openapi/route-drift.spec.ts`,
 * which needs the running application and so cannot live here.
 */

const document = buildOpenApiDocument();
const committedPath = fileURLToPath(new URL('../../../docs/openapi.json', import.meta.url));

describe('openapi document', () => {
  it('matches the committed docs/openapi.json', () => {
    const committed = readFileSync(committedPath, 'utf8');
    expect(
      committed,
      'docs/openapi.json is stale. Run `pnpm openapi:generate` and commit the result.',
    ).toBe(openApiJson());
  });

  it('is OpenAPI 3.1 served from the versioned base', () => {
    expect(document['openapi']).toBe('3.1.0');
    expect(document['servers']).toEqual([{ url: '/api/v1', description: 'This deployment.' }]);
  });

  it('describes every registered route exactly once', () => {
    const paths = document['paths'] as Record<string, Record<string, unknown>>;
    const operations = Object.entries(paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => routeKey(method, path)),
    );
    expect(operations.sort()).toEqual(
      API_ROUTES.map((route) => routeKey(route.method, route.path)).sort(),
    );
    expect(new Set(operations).size).toBe(operations.length);
  });

  it('gives every operation a unique operationId', () => {
    const ids = API_ROUTES.map((route) => route.operationId);
    expect(new Set(ids).size, `Duplicate operationIds: ${ids.join(', ')}`).toBe(ids.length);
  });

  it('requires a session by default, and says which routes do not', () => {
    expect(document['security']).toEqual([{ bearerAuth: [] }, { sessionCookie: [] }]);

    const paths = document['paths'] as Record<string, Record<string, JsonObject>>;
    const publicOperations: string[] = [];
    for (const [path, item] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (Array.isArray(operation['security']) && operation['security'].length === 0) {
          publicOperations.push(routeKey(method, path));
        }
      }
    }

    // Every route that opts out does so because it cannot have a session yet.
    // A new name appearing here is a security decision, so it is listed rather
    // than counted (CLAUDE.md §5.3).
    expect(publicOperations.sort()).toEqual(
      [
        'GET /auth/google',
        'GET /auth/google/callback',
        'GET /health',
        'GET /health/ready',
        'GET /invitations/accept',
        'GET /openapi.json',
        // The website lead form's two routes (ADR-0063): the only ones a stranger can write through.
        'GET /public/forms/{key}',
        'POST /public/forms/{key}/submissions',
        'POST /auth/forgot-password',
        'POST /auth/mfa/verify',
        'POST /auth/reset-password',
        'POST /auth/resend-verification',
        'POST /auth/sign-in',
        'POST /auth/sign-up',
        'POST /auth/verify-email',
        'POST /invitations/accept',
      ].sort(),
    );
  });

  it('matches the registry on which routes are public', () => {
    const paths = document['paths'] as Record<string, Record<string, JsonObject>>;
    for (const route of API_ROUTES) {
      const operation = paths[route.path]?.[route.method.toLowerCase()];
      const optedOut = Array.isArray(operation?.['security']) && operation['security'].length === 0;
      expect(optedOut, `${routeKey(route.method, route.path)}`).toBe(route.auth === 'public');
    }
  });

  it('documents the error envelope and gives every route a 401, 422 and 500', () => {
    const schemas = (document['components'] as JsonObject)['schemas'] as Record<string, JsonObject>;
    const error = schemas['ErrorResponse'];
    expect(error).toBeDefined();
    const errorProperties = (error?.['properties'] as JsonObject)['error'] as JsonObject;
    expect(Object.keys(errorProperties['properties'] as JsonObject).sort()).toEqual([
      'code',
      'details',
      'message',
      'requestId',
    ]);

    const paths = document['paths'] as Record<string, Record<string, JsonObject>>;
    for (const route of API_ROUTES) {
      const operation = paths[route.path]?.[route.method.toLowerCase()];
      const responses = operation?.['responses'] as JsonObject;
      for (const status of ['422', '429', '500']) {
        expect(responses[status], `${routeKey(route.method, route.path)} ${status}`).toBeDefined();
      }
      if (route.auth === 'session') {
        expect(responses['401'], routeKey(route.method, route.path)).toBeDefined();
        expect(responses['403'], routeKey(route.method, route.path)).toBeDefined();
      }
    }
  });

  it('gives every error code an HTTP status', () => {
    // The status table lives in openapi.ts; this asserts it is exhaustive, so
    // a new ErrorCode cannot be added without deciding what it returns.
    const used = new Set<string>();
    const paths = document['paths'] as Record<string, Record<string, JsonObject>>;
    for (const item of Object.values(paths)) {
      for (const operation of Object.values(item)) {
        for (const response of Object.values(operation['responses'] as JsonObject)) {
          const description = (response as JsonObject)['description'];
          if (typeof description !== 'string') continue;
          for (const match of description.matchAll(/`([A-Z_]+)`/g)) used.add(match[1]!);
        }
      }
    }

    // Not every code is reachable from every route, but each must be *nameable*:
    // the table in openapi.ts is keyed by ErrorCode, so TypeScript already
    // requires exhaustiveness. This asserts the codes that do appear are real.
    for (const code of used) {
      expect(Object.values(ErrorCode), `Unknown error code in the document: ${code}`).toContain(
        code,
      );
    }
  });

  it('wraps list responses in the keyset envelope', () => {
    const schemas = (document['components'] as JsonObject)['schemas'] as Record<string, JsonObject>;
    const list = schemas['ContactListResponse'] as JsonObject;
    const properties = list['properties'] as JsonObject;
    expect((properties['data'] as JsonObject)['type']).toBe('array');
    const meta = properties['meta'] as JsonObject;
    // `truncated` is set only when a search matched more records than a list will show (ADR-0041 §5).
    expect(Object.keys(meta['properties'] as JsonObject).sort()).toEqual([
      'hasMore',
      'nextCursor',
      'truncated',
    ]);
  });

  it('expands query objects into parameters rather than a body', () => {
    const paths = document['paths'] as Record<string, Record<string, JsonObject>>;
    const listContacts = paths['/contacts']?.['get'] as JsonObject;
    const names = (listContacts['parameters'] as JsonObject[]).map((p) => p['name']);
    expect(names).toEqual(['cursor', 'limit', 'sort', 'filter', 'fields', 'q']);
    expect(listContacts['requestBody']).toBeUndefined();
  });

  it('marks a path parameter required even when its schema is not', () => {
    const paths = document['paths'] as Record<string, Record<string, JsonObject>>;
    const getContact = paths['/contacts/{id}']?.['get'] as JsonObject;
    const id = (getContact['parameters'] as JsonObject[]).find((p) => p['name'] === 'id');
    expect(id?.['in']).toBe('path');
    expect(id?.['required']).toBe(true);
  });

  it('documents request bodies from the input side of a transform', () => {
    // `contactCreateSchema` lowercases the email, so its output has no JSON
    // Schema at all. The document must describe what the caller sends.
    const schemas = (document['components'] as JsonObject)['schemas'] as Record<string, JsonObject>;
    const create = schemas['ContactCreate'] as JsonObject;
    expect((create['properties'] as JsonObject)['email']).toBeDefined();
  });

  it('carries no secret, no environment value and no tenant data', () => {
    const serialised = openApiJson();
    for (const forbidden of [
      'AUTH_SECRET',
      'DATABASE_URL',
      'DATABASE_AUTH_URL',
      'postgres://',
      'redis://',
    ]) {
      expect(serialised, `Document contains ${forbidden}`).not.toContain(forbidden);
    }
  });
});
