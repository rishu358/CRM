import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { LEAD_FALLBACK_ASSIGNER } from '../../platform/lead-assigner.js';
import { LeadAssignmentModule } from '../lead-assignment/lead-assignment.module.js';
import { DefaultOwnerAssigner } from './lead-assigner.js';
import { LeadFormsController } from './lead-forms.controller.js';
import { LeadFormsRepository } from './lead-forms.repository.js';
import { LeadFormsService } from './lead-forms.service.js';
import { PublicLeadFormsController } from './public-lead-forms.controller.js';
import { PublicLeadFormsService } from './public-lead-forms.service.js';

/**
 * Website lead forms (ADR-0001, ADR-0065).
 *
 * One module, because both halves own the same tables: the administration (`LeadFormsController`,
 * behind the session guard and `can()`) and the public door (`PublicLeadFormsController`, behind
 * nothing but a key). Nothing outside this module touches a form table.
 *
 * It reaches leads through `LeadsService`, and people through the access module's narrow
 * `LeadOwnerDirectory`; never through their repositories. Who owns a new lead is behind
 * `LEAD_ASSIGNER`, which the assignment rules module provides; the simple default owner is the fallback.
 */
@Module({
  imports: [LeadsModule, AccessModule, LeadAssignmentModule],
  controllers: [LeadFormsController, PublicLeadFormsController],
  providers: [
    LeadFormsRepository,
    LeadFormsService,
    PublicLeadFormsService,
    DefaultOwnerAssigner,
    { provide: LEAD_FALLBACK_ASSIGNER, useExisting: DefaultOwnerAssigner },
  ],
})
export class LeadFormsModule {}
