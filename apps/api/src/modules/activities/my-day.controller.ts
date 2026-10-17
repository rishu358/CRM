import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import {
  myDayQuerySchema,
  recordViewCreateSchema,
  type MyDayQuery,
  type RecordViewCreateInput,
} from '@crm/contracts';
import type { Actor } from '@crm/core';
import { CurrentActor } from '../../auth/auth.guard.js';
import { zodPipe } from '../../common/zod-validation.pipe.js';
import { MyDayService } from './my-day.service.js';

/**
 * `/api/v1/my-day` and `/api/v1/record-views` (ADR-0007, MVP_SPEC M6).
 *
 * Both are about the signed-in person and take no user id: the server reads
 * it from the session, so there is no parameter anyone could change to read
 * or write somebody else's day (CLAUDE.md §5.2).
 */
@Controller()
export class MyDayController {
  constructor(@Inject(MyDayService) private readonly myDay: MyDayService) {}

  @Get('my-day')
  async get(@CurrentActor() actor: Actor, @Query(zodPipe(myDayQuerySchema)) query: MyDayQuery) {
    const data = await this.myDay.forActor(actor, query);
    return { data, meta: { timeZone: data.timeZone, date: data.date } };
  }

  @Post('record-views')
  @HttpCode(204)
  async recordView(
    @CurrentActor() actor: Actor,
    @Body(zodPipe(recordViewCreateSchema)) body: RecordViewCreateInput,
  ): Promise<void> {
    await this.myDay.recordView(actor, body);
  }
}
