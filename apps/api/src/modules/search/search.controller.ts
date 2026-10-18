import { Controller, Get, Inject, Query } from '@nestjs/common';
import { searchQuerySchema, type SearchQuery } from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { SearchService } from './search.service.js';

/**
 * `GET /api/v1/search` (ADR-0007).
 *
 * Validate, hand off, wrap. Everything that decides what comes back — which
 * objects, which records, which fields — is in the service, the provider and
 * the serializer, so the public API and the mobile app get it without a
 * controller having to remember.
 */
@Controller('search')
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

  @Get()
  async run(@CurrentActor() actor: Actor, @Query(zodPipe(searchQuerySchema)) query: SearchQuery) {
    return { data: await this.search.search(actor, query) };
  }
}
