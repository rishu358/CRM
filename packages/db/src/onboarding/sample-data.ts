import { minorUnitExponent, newId, toCurrency, type OpenLeadStatus } from '@crm/core';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import {
  accounts,
  activities,
  activityLinks,
  auditLogs,
  contacts,
  dealContacts,
  deals,
  leads,
  outboxEvents,
  pipelineStages,
  pipelines,
  sampleRecords,
} from '../schema/index.js';

/**
 * Sample data (MVP_SPEC M2, ADR-0037).
 *
 * A handful of accounts, contacts, leads, deals and tasks, so a new company's
 * lists, board and My Day are not empty on the first morning. They are real
 * rows, not a demo mode: they can be opened, edited, searched and linked to like
 * anything else, which is why they leave the same traces as anything else.
 *
 * ## Why this writes the rows itself
 *
 * Modules talk to each other through services and events (CLAUDE.md section 3),
 * and a service's `create` opens its own transaction, so creating thirty records
 * through them is thirty transactions and a crash in the middle leaves half a
 * demo company with some of it unregistered, and therefore never removable. This
 * is a single transaction instead: everything is created and registered, or
 * nothing is. It is the same arrangement as `provisionTenantDefaults`, which the
 * API already calls from inside a tenant transaction, and as the import
 * pipeline, which writes accounts, contacts and leads from the worker through
 * shared descriptors rather than through the API's services.
 *
 * What that costs is the guarantee a service gives for free, so it is paid for
 * explicitly. Every record gets the audit row and the `<object>.created.v1`
 * event a real creation writes in the same transaction, which is what makes it
 * searchable and puts it on a timeline; a test drives the relay and checks the
 * search index and timeline, so a change to what creation emits cannot silently
 * leave sample data behind.
 *
 * ## What it deliberately does not do
 *
 * Tasks are not given a reminder and are not announced as assigned, so loading
 * sample data never sends anybody a notification about a task nobody wrote.
 *
 * ## Two clocks
 *
 * "Due yesterday" is computed from the **database's** clock, not this process's:
 * the rows are stamped by Postgres, and a date taken from another clock can land
 * on the wrong side of "now" by however far the two disagree (ADR-0036).
 */

export interface SampleDataContext {
  readonly tenantId: string;
  /** Owns every sample record, and is recorded as the one who created them. */
  readonly actorId: string;
  /** The company's default currency; sample deals are in it. */
  readonly currency: string;
}

export interface SampleCounts {
  readonly accounts: number;
  readonly contacts: number;
  readonly leads: number;
  readonly deals: number;
  readonly activities: number;
}

/** Sample data is already in the workspace; loading it again would double it. */
export class SampleDataAlreadyPresentError extends Error {
  constructor() {
    super('Sample data is already present');
    this.name = 'SampleDataAlreadyPresentError';
  }
}

/** The workspace has no pipeline to put sample deals in. */
export class SampleDataUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SampleDataUnavailableError';
  }
}

/**
 * Serialise loading and removal for one tenant.
 *
 * Two concurrent loads would each see an empty registry and both insert a set;
 * a load racing a removal could register records the removal had already
 * decided about. A transaction-scoped advisory lock keyed by tenant makes them
 * take turns, and it is released by the commit or rollback it belongs to, so
 * there is nothing to forget to unlock.
 */
export async function lockSampleData(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`sample-data:${tenantId}`}, 0))`,
  );
}

/** Every sample record's name carries this, so they are obvious wherever they appear. */
const SAMPLE_MARK = '(sample)';

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

export async function loadSampleData(tx: Tx, ctx: SampleDataContext): Promise<SampleCounts> {
  await lockSampleData(tx, ctx.tenantId);

  const existing = await tx.execute(
    sql`select 1 from sample_records where tenant_id = ${ctx.tenantId}::uuid limit 1`,
  );
  if (existing.rows.length > 0) throw new SampleDataAlreadyPresentError();

  // The pipeline the company actually has — never a stage by name, because an
  // administrator may have renamed or replaced them (the seed says so too).
  const [pipeline] = await tx
    .select()
    .from(pipelines)
    .where(eq(pipelines.tenantId, ctx.tenantId))
    .orderBy(desc(pipelines.isDefault), asc(pipelines.position), asc(pipelines.id))
    .limit(1);
  if (pipeline === undefined) {
    throw new SampleDataUnavailableError('This workspace has no pipeline to put sample deals in');
  }
  const stages = await tx
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, pipeline.id))
    .orderBy(asc(pipelineStages.position), asc(pipelineStages.id));
  const open = stages.filter((stage) => stage.stageType === 'open');
  const won = stages.find((stage) => stage.stageType === 'won');
  if (open.length === 0) {
    throw new SampleDataUnavailableError('The pipeline has no open stages to put sample deals in');
  }
  const stageAt = (index: number) => open[Math.min(index, open.length - 1)]!;

  const clock = (await tx.execute(sql`select clock_timestamp()::text as now`))
    .rows[0] as unknown as {
    now: string;
  };
  const now = new Date(clock.now);
  const inDays = (days: number): Date => new Date(now.getTime() + days * DAY_MS);

  const scale = 10n ** BigInt(minorUnitExponent(toCurrency(ctx.currency)));
  const major = (amount: number): bigint => BigInt(amount) * scale;

  const { tenantId, actorId } = ctx;
  const base = { tenantId, ownerId: actorId, createdBy: actorId, updatedBy: actorId };

  // ---- accounts ----------------------------------------------------------
  const accountRows = [
    {
      name: `Sunrise Textiles ${SAMPLE_MARK}`,
      domain: 'sunrise-textiles.example',
      industry: 'Textiles',
    },
    {
      name: `Greenleaf Organics ${SAMPLE_MARK}`,
      domain: 'greenleaf.example',
      industry: 'Food and beverage',
    },
    {
      name: `Bluewave Logistics ${SAMPLE_MARK}`,
      domain: 'bluewave.example',
      industry: 'Logistics',
    },
  ].map((row) => ({ id: newId(), ...base, ...row }));
  await tx.insert(accounts).values(accountRows);

  // ---- contacts ----------------------------------------------------------
  const contactRows = [
    { firstName: 'Priya', lastName: 'Nair', account: 0, source: 'referral' },
    { firstName: 'Rohan', lastName: 'Kapoor', account: 1, source: 'website' },
    { firstName: 'Meera', lastName: 'Iyer', account: 1, source: 'exhibition' },
    { firstName: 'Sanjay', lastName: 'Gupta', account: 2, source: 'referral' },
  ].map((row) => {
    const account = accountRows[row.account]!;
    return {
      id: newId(),
      ...base,
      firstName: row.firstName,
      lastName: `${row.lastName} ${SAMPLE_MARK}`,
      email: `${row.firstName}.${row.lastName}@${account.domain}`.toLowerCase(),
      accountId: account.id,
      leadSource: row.source,
    };
  });
  await tx.insert(contacts).values(contactRows);

  // ---- leads -------------------------------------------------------------
  const leadPlans: {
    firstName: string;
    lastName: string;
    company: string;
    source: string;
    status: OpenLeadStatus;
  }[] = [
    {
      firstName: 'Neha',
      lastName: 'Kulkarni',
      company: 'Kulkarni Silks',
      source: 'exhibition',
      status: 'qualified',
    },
    {
      firstName: 'Imran',
      lastName: 'Qureshi',
      company: 'Qureshi Leather Works',
      source: 'website',
      status: 'new',
    },
    {
      firstName: 'Divya',
      lastName: 'Pillai',
      company: 'Pillai Spice Traders',
      source: 'referral',
      status: 'contacted',
    },
    {
      firstName: 'Karan',
      lastName: 'Malhotra',
      company: 'Malhotra Print House',
      source: 'social',
      status: 'new',
    },
  ];
  const leadRows = leadPlans.map((row) => ({
    id: newId(),
    ...base,
    firstName: row.firstName,
    lastName: `${row.lastName} ${SAMPLE_MARK}`,
    company: row.company,
    email: `${row.firstName}.${row.lastName}@example.com`.toLowerCase(),
    source: row.source,
    status: row.status,
  }));
  await tx.insert(leads).values(leadRows);

  // ---- deals -------------------------------------------------------------
  const dealPlans = [
    {
      name: 'Showroom fit-out',
      amount: 85_000,
      stage: stageAt(0),
      account: 0,
      contact: 0,
      closeIn: 45,
    },
    {
      name: 'Quarterly supply contract',
      amount: 240_000,
      stage: stageAt(1),
      account: 1,
      contact: 1,
      closeIn: 30,
    },
    {
      name: 'Warehouse automation pilot',
      amount: 120_000,
      stage: stageAt(2),
      account: 2,
      contact: 3,
      closeIn: 20,
    },
    {
      name: 'Festive season order',
      amount: 60_000,
      stage: stageAt(3),
      account: 1,
      contact: 2,
      closeIn: 10,
    },
  ];
  const dealRows = dealPlans.map((plan) => ({
    id: newId(),
    ...base,
    name: `${plan.name} ${SAMPLE_MARK}`,
    accountId: accountRows[plan.account]!.id,
    primaryContactId: contactRows[plan.contact]!.id,
    pipelineId: pipeline.id,
    stageId: plan.stage.id,
    amountMinor: major(plan.amount),
    currency: ctx.currency,
    probability: plan.stage.probability,
    expectedCloseDate: isoDate(inDays(plan.closeIn)),
  }));
  // One already won, so "deals won this month" has something to show.
  if (won !== undefined) {
    dealRows.push({
      id: newId(),
      ...base,
      name: `Anniversary gifting ${SAMPLE_MARK}`,
      accountId: accountRows[0]!.id,
      primaryContactId: contactRows[0]!.id,
      pipelineId: pipeline.id,
      stageId: won.id,
      amountMinor: major(40_000),
      currency: ctx.currency,
      probability: won.probability,
      expectedCloseDate: isoDate(now),
    });
  }
  await tx
    .insert(deals)
    .values(dealRows.map((row) => (row.stageId === won?.id ? { ...row, closedAt: now } : row)));

  await tx.insert(dealContacts).values(
    dealRows.map((deal) => ({
      id: newId(),
      tenantId,
      dealId: deal.id,
      contactId: deal.primaryContactId,
      role: 'Decision maker',
      createdBy: actorId,
      updatedBy: actorId,
    })),
  );

  // ---- tasks -------------------------------------------------------------
  const taskPlans = [
    {
      type: 'call' as const,
      subject: `Follow up with Priya about the fit-out quote ${SAMPLE_MARK}`,
      dueIn: -1,
      priority: 'high' as const,
      target: ['contact', contactRows[0]!.id] as const,
    },
    {
      type: 'task' as const,
      subject: `Send the supply contract draft ${SAMPLE_MARK}`,
      dueIn: 1,
      priority: 'normal' as const,
      target: ['deal', dealRows[1]!.id] as const,
    },
    {
      type: 'meeting' as const,
      subject: `Demo for the warehouse pilot ${SAMPLE_MARK}`,
      dueIn: 3,
      priority: 'normal' as const,
      target: ['deal', dealRows[2]!.id] as const,
    },
    {
      type: 'task' as const,
      subject: `Prepare festive order paperwork ${SAMPLE_MARK}`,
      dueIn: 6,
      priority: 'low' as const,
      target: ['deal', dealRows[3]!.id] as const,
    },
  ];
  const activityRows = taskPlans.map((plan) => ({
    id: newId(),
    tenantId,
    assignedTo: actorId,
    type: plan.type,
    subject: plan.subject,
    dueAt: inDays(plan.dueIn),
    priority: plan.priority,
    status: 'open' as const,
    createdBy: actorId,
    updatedBy: actorId,
  }));
  await tx.insert(activities).values(activityRows);
  await tx.insert(activityLinks).values(
    taskPlans.map((plan, index) => ({
      id: newId(),
      tenantId,
      activityId: activityRows[index]!.id,
      objectType: plan.target[0],
      recordId: plan.target[1],
      createdBy: actorId,
      updatedBy: actorId,
    })),
  );

  // ---- what a real creation also writes ------------------------------------
  type Created = { type: 'account' | 'contact' | 'lead' | 'deal' | 'activity'; id: string };
  const created: Created[] = [
    ...accountRows.map((row) => ({ type: 'account' as const, id: row.id })),
    ...contactRows.map((row) => ({ type: 'contact' as const, id: row.id })),
    ...leadRows.map((row) => ({ type: 'lead' as const, id: row.id })),
    ...dealRows.map((row) => ({ type: 'deal' as const, id: row.id })),
    ...activityRows.map((row) => ({ type: 'activity' as const, id: row.id })),
  ];

  const changesFor: Record<string, Record<string, { new: unknown }>> = {};
  for (const row of accountRows) changesFor[row.id] = { name: { new: row.name } };
  for (const row of contactRows) {
    changesFor[row.id] = {
      firstName: { new: row.firstName },
      lastName: { new: row.lastName },
      email: { new: row.email },
    };
  }
  for (const row of leadRows) {
    changesFor[row.id] = {
      firstName: { new: row.firstName },
      lastName: { new: row.lastName },
      company: { new: row.company },
      source: { new: row.source },
      status: { new: row.status },
    };
  }
  for (const row of dealRows) {
    changesFor[row.id] = {
      name: { new: row.name },
      amountMinor: { new: row.amountMinor.toString() },
      currency: { new: row.currency },
    };
  }
  for (const row of activityRows) {
    changesFor[row.id] = { subject: { new: row.subject }, type: { new: row.type } };
  }

  await tx.insert(auditLogs).values(
    created.map((record) => ({
      id: newId(),
      tenantId,
      actorId,
      action: 'create',
      objectType: record.type,
      recordId: record.id,
      changes: changesFor[record.id] ?? {},
    })),
  );

  await tx.insert(outboxEvents).values([
    ...created.map((record) => ({
      id: newId(),
      tenantId,
      eventType: `${record.type}.created.v1`,
      objectType: record.type,
      recordId: record.id,
      payload: { ownerId: actorId },
      actorId,
    })),
    // The timeline is written from the *target's* side, one event per link.
    ...taskPlans.map((plan, index) => ({
      id: newId(),
      tenantId,
      eventType: 'activity.linked.v1',
      objectType: plan.target[0],
      recordId: plan.target[1],
      payload: {
        activityId: activityRows[index]!.id,
        activityType: plan.type,
        subject: plan.subject,
        dueAt: activityRows[index]!.dueAt.toISOString(),
      },
      actorId,
    })),
  ]);

  await tx.insert(sampleRecords).values(
    created.map((record) => ({
      id: newId(),
      tenantId,
      objectType: record.type,
      recordId: record.id,
      createdBy: actorId,
      updatedBy: actorId,
    })),
  );

  const counts: SampleCounts = {
    accounts: accountRows.length,
    contacts: contactRows.length,
    leads: leadRows.length,
    deals: dealRows.length,
    activities: activityRows.length,
  };

  await tx.insert(auditLogs).values({
    id: newId(),
    tenantId,
    actorId,
    action: 'sample_data_loaded',
    objectType: 'tenant',
    recordId: tenantId,
    changes: { created: { new: counts } },
  });

  return counts;
}
