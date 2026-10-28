import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { DefaultOwnerAssigner, LEAD_ASSIGNER } from './lead-assigner.js';
import { LeadFormsController } from './lead-forms.controller.js';
import { LeadFormsRepository } from './lead-forms.repository.js';
import { LeadFormsService } from './lead-forms.service.js';
import { PublicLeadFormsController } from './public-lead-forms.controller.js';
import { PublicLeadFormsService } from './public-lead-forms.service.js';

/**
 * Website lead forms (ADR-0001, ADR-0063).
 *
 * One module, because both halves own the same tables: the administration (`LeadFormsController`,
 * behind the session guard and `can()`) and the public door (`PublicLeadFormsController`, behind
 * nothing but a key). Nothing outside this module touches a form table.
 *
 * It reaches leads through `LeadsService`, and people through the access module's narrow
 * `LeadOwnerDirectory`; never through their repositories. Who owns a new lead is behind
 * `LEAD_ASSIGNER`, which the assignment rules take over without the public side changing.
 */
@Module({
  imports: [LeadsModule, AccessModule],
  controllers: [LeadFormsController, PublicLeadFormsController],
  providers: [
    LeadFormsRepository,
    LeadFormsService,
    PublicLeadFormsService,
    DefaultOwnerAssigner,
    { provide: LEAD_ASSIGNER, useExisting: DefaultOwnerAssigner },
  ],
})
export class LeadFormsModule {}
