import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health.controller.js';
import { AccessModule } from './modules/access/access.module.js';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { AuditLogModule } from './modules/audit/audit-log.module.js';
import { ActivitiesModule } from './modules/activities/activities.module.js';
import { AttachmentsModule } from './modules/attachments/attachments.module.js';
import { BulkModule } from './modules/bulk/bulk.module.js';
import { ContactsModule } from './modules/contacts/contacts.module.js';
import { DataRightsModule } from './modules/data-rights/data-rights.module.js';
import { DealsModule } from './modules/deals/deals.module.js';
import { ExportsModule } from './modules/exports/exports.module.js';
import { ImportsModule } from './modules/imports/imports.module.js';
import { InvitationsModule } from './modules/invitations/invitations.module.js';
import { LeadAssignmentModule } from './modules/lead-assignment/lead-assignment.module.js';
import { LeadFormsModule } from './modules/lead-forms/lead-forms.module.js';
import { LeadsModule } from './modules/leads/leads.module.js';
import { CustomizationModule } from './modules/customization/customization.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { PipelineEditorModule } from './modules/pipeline-editor/pipeline-editor.module.js';
import { PipelinesModule } from './modules/pipelines/pipelines.module.js';
import { OnboardingModule } from './modules/onboarding/onboarding.module.js';
import { RecycleBinModule } from './modules/recycle-bin/recycle-bin.module.js';
import { SavedViewsModule } from './modules/saved-views/saved-views.module.js';
import { TagsModule } from './modules/tags/tags.module.js';
import { SearchModule } from './modules/search/search.module.js';
import { OpenApiController } from './openapi/openapi.controller.js';
import { PlatformModule } from './platform/platform.module.js';
import type { ApiEnv } from './config/env.js';

/**
 * The modular monolith's root (ADR-0001).
 *
 * `AuthGuard` is registered as a global guard, so every route is authenticated
 * unless it explicitly opts out with `@Public()`. Default-deny applies to
 * routing as well as to permissions: a controller added by someone who forgets
 * the decorator ends up protected, not open.
 */
@Module({})
export class AppModule {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.forRoot(env),
        AuthModule,
        PlatformModule,
        AccountsModule,
        ContactsModule,
        PipelinesModule,
        DealsModule,
        PipelineEditorModule,
        LeadsModule,
        LeadAssignmentModule,
        LeadFormsModule,
        ActivitiesModule,
        AttachmentsModule,
        SearchModule,
        NotificationsModule,
        InvitationsModule,
        ImportsModule,
        ExportsModule,
        AccessModule,
        AuditLogModule,
        RecycleBinModule,
        DataRightsModule,
        OnboardingModule,
        DashboardModule,
        CustomizationModule,
        SavedViewsModule,
        TagsModule,
        BulkModule,
      ],
      controllers: [HealthController, OpenApiController],
      providers: [{ provide: APP_GUARD, useExisting: AuthGuard }],
    };
  }
}
