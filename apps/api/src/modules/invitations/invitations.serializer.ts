import type { InvitationSummary } from '@crm/contracts';
import type { InvitationRow } from './invitations.repository.js';

/**
 * What leaves the API for an invitation (CLAUDE.md §5.4).
 *
 * An allow-list, built key by key, rather than a spread of the row with a few
 * properties deleted. The difference matters: a column added to the table
 * later — a note, an internal flag, another digest — appears in a response
 * built by spreading and does not appear in one built like this.
 *
 * The token and its digest are **never** in `InvitationRow` to begin with, so
 * they cannot reach a response even by accident. The admin list is readable by
 * every administrator of the workspace, and an invitation token is a key to a
 * seat in it; re-inviting is how you get a fresh link, not reading one back.
 *
 * There is no field-permission filter here, unlike `contacts.serializer.ts`:
 * invitations have no `field_definitions`, no custom fields and no per-field
 * overrides. Access to them is all-or-nothing through the `invitation` object
 * grant, which Owner and Admin hold and nobody else does.
 */
export function serializeInvitation(row: InvitationRow): InvitationSummary {
  return {
    id: row.id,
    email: row.email,
    roleId: row.role_id,
    roleName: row.role_name,
    invitedByName: row.invited_by_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function serializeInvitations(rows: readonly InvitationRow[]): InvitationSummary[] {
  return rows.map(serializeInvitation);
}
