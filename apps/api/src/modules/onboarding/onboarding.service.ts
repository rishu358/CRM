import { Inject, Injectable } from '@nestjs/common';
import { assertCan, ConflictError, NotFoundError, type Actor, type ObjectType } from '@crm/core';
import {
  CHECKLIST_KEYS,
  type OnboardingStatus,
  type RecordCounts,
  type SampleDataLoaded,
  type SampleDataRemoval,
  type TenantProfile,
  type TenantProfileUpdateInput,
} from '@crm/contracts';
import {
  loadSampleData,
  SampleDataAlreadyPresentError,
  SampleDataUnavailableError,
  type Tx,
} from '@crm/db';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { OnboardingRepository, type ProfileRow } from './onboarding.repository.js';

/**
 * The kinds of record sample data is made of. Loading creates every one of them,
 * so loading needs the right to create every one of them — a person who cannot
 * create deals must not be able to make five by pressing a button here.
 */
const SAMPLE_OBJECTS = [
  'account',
  'contact',
  'lead',
  'deal',
  'activity',
] as const satisfies readonly ObjectType[];

/**
 * Company setup, the setup checklist and sample data (MVP_SPEC M2, ADR-0037).
 *
 * Every method is authorized by `can()` against `tenant_settings` before
 * anything is read, like every other endpoint (CLAUDE.md section 5.3). The
 * company is always the caller's own: it comes from the session, never from a
 * request, so there is no id here for a client to substitute.
 *
 * Loading sample data runs inside the request, in one transaction, as the
 * application role. **Removing it does not**: the cleanup clears the search and
 * timeline projections, which that role cannot write by design, so the request
 * only records that it was asked for and the worker does the work. The screen
 * watches `sampleData.removing` until it clears.
 */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OnboardingRepository) private readonly repository: OnboardingRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async profile(actor: Actor): Promise<TenantProfile> {
    assertCan(actor, 'read', { objectType: 'tenant_settings' });
    return this.inTenant(actor, async (tx) => present(await this.requireProfile(tx, actor)));
  }

  async updateProfile(actor: Actor, input: TenantProfileUpdateInput): Promise<TenantProfile> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });

    return this.inTenant(actor, async (tx) => {
      const existing = await this.requireProfile(tx, actor);

      // Only what actually differs: a screen that re-saves what it already shows
      // changes nothing and so records nothing.
      const changes: Record<string, { old: unknown; new: unknown }> = {};
      const patch: {
        name?: string;
        defaultCurrency?: string;
        timezone?: string;
        industry?: string | null;
      } = {};
      if (input.name !== undefined && input.name !== existing.name) {
        patch.name = input.name;
        changes['name'] = { old: existing.name, new: input.name };
      }
      if (
        input.defaultCurrency !== undefined &&
        input.defaultCurrency !== existing.defaultCurrency
      ) {
        patch.defaultCurrency = input.defaultCurrency;
        changes['defaultCurrency'] = { old: existing.defaultCurrency, new: input.defaultCurrency };
      }
      if (input.timezone !== undefined && input.timezone !== existing.timezone) {
        patch.timezone = input.timezone;
        changes['timezone'] = { old: existing.timezone, new: input.timezone };
      }
      if (input.industry !== undefined && input.industry !== existing.industry) {
        patch.industry = input.industry;
        changes['industry'] = { old: existing.industry, new: input.industry };
      }

      if (Object.keys(changes).length === 0) return present(existing);

      await this.repository.updateProfile(tx, actor.tenantId, patch);
      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'tenant',
        recordId: actor.tenantId,
        changes,
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'tenant.updated.v1',
        objectType: 'tenant',
        recordId: actor.tenantId,
      });
      return present(await this.requireProfile(tx, actor));
    });
  }

  async status(actor: Actor): Promise<OnboardingStatus> {
    assertCan(actor, 'read', { objectType: 'tenant_settings' });
    return this.inTenant(actor, (tx) => this.readStatus(tx, actor));
  }

  async complete(actor: Actor): Promise<OnboardingStatus> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });

    return this.inTenant(actor, async (tx) => {
      const didComplete = await this.repository.markSetupComplete(tx, actor.tenantId);
      if (didComplete) {
        await this.audit.record(tx, actor, {
          action: 'update',
          objectType: 'tenant',
          recordId: actor.tenantId,
          changes: { setupCompleted: { old: false, new: true } },
        });
        await this.outbox.publish(tx, actor, {
          eventType: 'tenant.setup_completed.v1',
          objectType: 'tenant',
          recordId: actor.tenantId,
        });
      }
      return this.readStatus(tx, actor);
    });
  }

  async loadSampleData(actor: Actor): Promise<SampleDataLoaded> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });
    for (const objectType of SAMPLE_OBJECTS) assertCan(actor, 'create', { objectType });

    return this.inTenant(actor, async (tx) => {
      const profile = await this.requireProfile(tx, actor);
      try {
        const created = await loadSampleData(tx, {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          currency: profile.defaultCurrency,
        });
        return { created };
      } catch (error) {
        if (error instanceof SampleDataAlreadyPresentError) {
          throw new ConflictError('Sample data is already loaded');
        }
        if (error instanceof SampleDataUnavailableError) {
          throw new ConflictError(error.message);
        }
        throw error;
      }
    });
  }

  async requestSampleDataRemoval(actor: Actor): Promise<SampleDataRemoval> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });
    for (const objectType of SAMPLE_OBJECTS) assertCan(actor, 'delete', { objectType });

    return this.inTenant(actor, async (tx) => {
      // A second press while one is pending is the same request, not a second job.
      if (await this.repository.removalPending(tx, actor.tenantId)) return { status: 'removing' };

      const counts = await this.repository.sampleCounts(tx, actor.tenantId);
      if (total(counts) === 0) throw new ConflictError('There is no sample data to remove');

      await this.outbox.publish(tx, actor, {
        eventType: 'sample_data.removal_requested.v1',
        objectType: 'tenant',
        recordId: actor.tenantId,
      });
      return { status: 'removing' };
    });
  }

  // -------------------------------------------------------------------------

  private async readStatus(tx: Tx, actor: Actor): Promise<OnboardingStatus> {
    const profile = await this.requireProfile(tx, actor);
    const facts = await this.repository.checklist(tx, actor.tenantId);
    const counts = await this.repository.sampleCounts(tx, actor.tenantId);
    const removing = await this.repository.removalPending(tx, actor.tenantId);

    const done: Record<(typeof CHECKLIST_KEYS)[number], boolean> = {
      invite_team: facts.inviteTeam,
      import_contacts: facts.importContacts,
      add_first_deal: facts.addFirstDeal,
      set_email_sender: facts.setEmailSender,
    };
    return {
      setupCompleted: profile.setupCompletedAt !== null,
      checklist: CHECKLIST_KEYS.map((key) => ({ key, done: done[key] })),
      sampleData: { present: total(counts) > 0, counts, removing },
    };
  }

  private async requireProfile(tx: Tx, actor: Actor): Promise<ProfileRow> {
    const profile = await this.repository.findProfile(tx, actor.tenantId);
    if (profile === null) throw new NotFoundError('Company');
    return profile;
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

function total(counts: RecordCounts): number {
  return counts.accounts + counts.contacts + counts.leads + counts.deals + counts.activities;
}

function present(profile: ProfileRow): TenantProfile {
  return {
    name: profile.name,
    defaultCurrency: profile.defaultCurrency,
    timezone: profile.timezone,
    locale: profile.locale,
    industry: profile.industry as TenantProfile['industry'],
  };
}
