import { Controller, Get, Header } from '@nestjs/common';
import { buildOpenApiDocument, type JsonObject } from '@crm/contracts';
import { Public } from '../auth/auth.guard.js';

/**
 * `GET /api/v1/openapi.json` (ADR-0007, ADR-0027).
 *
 * Serves the document generated from the Zod contracts. It is built once, at
 * module construction, because it cannot change while the process runs —
 * nothing about it depends on the request, the tenant or the session.
 *
 * Public, deliberately. An integrator reads the spec before they have
 * credentials, which is the whole premise of ADR-0007, and the document
 * describes only the shape of a surface the web bundle already names. It
 * contains no tenant data, no configuration and no secret: it is generated
 * from `packages/contracts`, which holds neither.
 *
 * Not wrapped in the `{ data, meta }` envelope. Every OpenAPI tool in
 * existence expects the document itself at this path, and wrapping it would
 * make the one artifact whose job is to be machine-readable the one thing no
 * machine could read.
 */
@Controller('openapi.json')
export class OpenApiController {
  private readonly document: JsonObject = buildOpenApiDocument();

  @Get()
  @Public()
  @Header('cache-control', 'public, max-age=300')
  get(): JsonObject {
    return this.document;
  }
}
