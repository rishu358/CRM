import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  ConflictError,
  generateInvitationToken,
  hashOneTimeToken,
  InvalidTokenError,
  InvitationRecipientMismatchError,
  InvitationSignInRequiredError,
  NotFoundError,
  parseInvitationToken,
  TOKEN_TTL_SECONDS,
  ValidationError,
  type Actor,
} from '@crm/core';
import type {
  InvitationAcceptInput,
  InvitationAcceptResult,
  InvitationCreateInput,
  InvitationListQuery,
  InvitationPreview,
  InvitationRole,
  InvitationSummary,
} from '@crm/contracts';
import type { Tx } from '@crm/db';
import { API_ENV_TOKEN, type ApiEnv } from '../../config/env.js';
import { AuthService } from '../../auth/auth.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { EMAIL_PROVIDER, type EmailProvider } from '../../platform/email/email.provider.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { InvitationsRepository, type PendingInvitationLookup } from './invitations.repository.js';
import { serializeInvitation, serializeInvitations } from './invitations.serializer.js';

/**
 * Team invitations (MVP_SPEC M2).
 *
 * Until this module existed nothing ever wrote a second `memberships` row, so
 * the whole permission engine — roles, scopes, field rules — only ever applied
 * to the one person who signed up. This is what lets a workspace have a team.
 *
 * ## The two things an invitation token must not be able to do
 *
 * **Join a different workspace, or confer a different role.** Both live on the
 * invitation's own row and are read from it at acceptance. Neither appears in
 * any request body, and the contract is `.strict()` so sending one is a 422
 * rather than something quietly ignored (CLAUDE.md §5.2).
 *
 * **Be redeemed by somebody who is not the recipient.** Acceptance always
 * matches the accepting identity to the invited address (ADR-0019):
 *
 *   * the address has no account — the token proves control of that mailbox,
 *     an account is created *at that address*, and a session is issued. That
 *     is the same proof sign-up collects with its verification link.
 *   * the address has an account — the recipient signs in first, through MFA
 *     if their account has it, and accepts from that session. An emailed link
 *     never issues a session for an account that already exists, because that
 *     would walk straight past a second factor its owner deliberately enrolled.
 *   * somebody else is signed in — refused, and the invitation is left
 *     untouched: not consumed, not transferred, still usable by the person it
 *     was sent to.
 *
 * ## No enumeration
 *
 * Inviting an address that already has an account is indistinguishable, in the
 * response, from inviting one that does not: both return the invitation that
 * was created, and the difference shows up only in the mail that address
 * receives. The acceptance screen does distinguish them, but only for somebody
 * already holding a token that was mailed to that address.
 */
@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(InvitationsRepository) private readonly repository: InvitationsRepository,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  // -------------------------------------------------------------------------
  // Administration
  // -------------------------------------------------------------------------

  async list(
    actor: Actor,
    query: InvitationListQuery,
  ): Promise<{ data: InvitationSummary[]; meta: { hasMore: boolean } }> {
    assertCan(actor, 'read', { objectType: 'invitation' });

    return this.inTenant(actor, async (tx) => {
      // One row more than asked for, so "is there another page" needs no count.
      const rows = await this.repository.listPending(tx, actor.tenantId, query.limit + 1);
      const hasMore = rows.length > query.limit;
      return {
        data: serializeInvitations(hasMore ? rows.slice(0, query.limit) : rows),
        meta: { hasMore },
      };
    });
  }

  /**
   * The roles somebody may be invited as.
   *
   * Behind the same `create` grant as inviting, not `read`: this list exists
   * to fill the invite form, and anyone who cannot invite has no business
   * enumerating the workspace's permission configuration.
   */
  async assignableRoles(actor: Actor): Promise<InvitationRole[]> {
    assertCan(actor, 'create', { objectType: 'invitation' });

    return this.inTenant(actor, async (tx) => {
      const rows = await this.repository.listRoles(tx, actor.tenantId);
      return rows.map((row) => ({ id: row.id, name: row.name, description: row.description }));
    });
  }

  /**
   * Invite somebody, and mail them a link.
   *
   * The link is mailed and never returned, so an administrator cannot read a
   * token back out of the API and redeem it themselves — which would turn
   * "invite" into "create an account at any address I choose and sign in as
   * it".
   */
  async invite(actor: Actor, input: InvitationCreateInput): Promise<InvitationSummary> {
    assertCan(actor, 'create', { objectType: 'invitation' });

    const token = generateInvitationToken(actor.tenantId);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS.team_invite * 1000);

    const { summary, workspaceName } = await this.inTenant(actor, async (tx) => {
      // The role must belong to this workspace. RLS already confines the
      // lookup to it, so a role id copied from another tenant reads as absent
      // — a 422 about an unknown role, never a hint that it exists elsewhere.
      const role = await this.repository.findRole(tx, actor.tenantId, input.roleId);
      if (role === null) {
        throw new ValidationError([{ path: 'roleId', message: 'Unknown role' }]);
      }

      const superseded = await this.repository.supersedeOutstanding(
        tx,
        actor.tenantId,
        input.email,
      );

      const id = await this.repository.insert(tx, {
        tenantId: actor.tenantId,
        email: input.email,
        roleId: input.roleId,
        tokenHash: hashOneTimeToken(token),
        expiresAt,
        invitedBy: actor.userId,
      });

      // Audit entry and event in the same transaction as the invitation, so
      // all three exist or none do (CLAUDE.md §5.10, ADR-0006).
      await this.audit.record(tx, actor, {
        action: 'create',
        objectType: 'invitation',
        recordId: id,
        changes: {
          email: { new: input.email },
          roleId: { new: input.roleId },
          ...(superseded === 0 ? {} : { superseded: { new: superseded } }),
        },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'invitation.created.v1',
        objectType: 'invitation',
        recordId: id,
        payload: { roleId: input.roleId, expiresAt: expiresAt.toISOString() },
      });

      const created = await this.repository.findPendingById(tx, actor.tenantId, id);
      if (created === null) throw new NotFoundError('Invitation');

      return {
        summary: serializeInvitation(created),
        workspaceName: await this.repository.workspaceName(tx, actor.tenantId),
      };
    });

    // Sent after the transaction commits: a link to an invitation that rolled
    // back is a link to nothing, and the recipient has no way to tell.
    await this.sendInvitation({
      to: input.email,
      token,
      workspaceName,
      roleName: summary.roleName,
      inviterName: summary.invitedByName,
    });

    return summary;
  }

  /**
   * Revoke a pending invitation.
   *
   * 404 rather than 403 for one that is not this workspace's, already accepted
   * or already revoked — the same id-is-not-an-oracle rule every other record
   * follows (CLAUDE.md §5.5). The row is updated, never deleted, so who
   * invited whom and what became of it survives.
   */
  async revoke(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'delete', { objectType: 'invitation' });

    await this.inTenant(actor, async (tx) => {
      const revoked = await this.repository.revoke(tx, actor.tenantId, id, actor.userId);
      if (revoked === null) throw new NotFoundError('Invitation');

      await this.audit.record(tx, actor, {
        action: 'delete',
        objectType: 'invitation',
        recordId: id,
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'invitation.revoked.v1',
        objectType: 'invitation',
        recordId: id,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Acceptance
  // -------------------------------------------------------------------------

  /**
   * Describe a link without consuming it.
   *
   * Tells the acceptance screen which of the three states to draw. Everything
   * it returns is about an address the caller has already proved they can
   * read, by holding a token that was mailed only there — so "this address has
   * an account" is not enumeration here, as it would be anywhere else. The
   * person who *chose* the address, the inviter, never sees the token.
   */
  async preview(token: string, currentUserId: string | null): Promise<InvitationPreview> {
    const { invitation } = await this.loadPending(token);

    const account = await this.auth.findAccountByEmail(invitation.email);
    const signedInAs = currentUserId === null ? null : await this.auth.emailForUser(currentUserId);
    const isRecipient = signedInAs !== null && this.sameAddress(signedInAs, invitation.email);

    return {
      workspaceName: invitation.workspace_name,
      email: invitation.email,
      roleName: invitation.role_name,
      requiresAccount: account === null,
      signedInAs,
      // Accepting right now works either when the signed-in person *is* the
      // recipient, or when nobody is signed in and the address has no account
      // to sign in to.
      canAccept: isRecipient || (signedInAs === null && account === null),
    };
  }

  /**
   * Accept an invitation (ADR-0019).
   *
   * The identity rule in this class's comment is enforced here, in this order,
   * and the order is the point: every refusal below happens *before* the token
   * is redeemed, so a refused attempt leaves the invitation usable by the
   * person it was sent to.
   */
  async accept(
    input: InvitationAcceptInput,
    session: { userId: string; sessionId: string } | null,
  ): Promise<InvitationAcceptResult> {
    const { tenantId, invitation } = await this.loadPending(input.token);

    const signedInEmail = session === null ? null : await this.auth.emailForUser(session.userId);

    // A signed-in caller must *be* the recipient. Checked first, so an
    // administrator who opens a colleague's link cannot consume it on their
    // behalf, and learns nothing by trying.
    if (signedInEmail !== null && !this.sameAddress(signedInEmail, invitation.email)) {
      throw new InvitationRecipientMismatchError();
    }

    if (session !== null && signedInEmail !== null) {
      if (input.name !== undefined || input.password !== undefined) {
        // They already have an account; a name and password here would either
        // be ignored or quietly change their credentials. An invitation link
        // is not a password reset.
        throw new ValidationError([
          { path: 'password', message: 'You already have an account. Accept without one.' },
        ]);
      }
      const result = await this.redeemFor(tenantId, input.token, invitation, session.userId);
      // Land them in the workspace they have just joined rather than leaving
      // the session pointed at wherever they happened to be.
      await this.auth.switchSessionTo(session.sessionId, tenantId);
      return result;
    }

    const existing = await this.auth.findAccountByEmail(invitation.email);

    // Nobody signed in, and the address already has an account. The recipient
    // signs in — through their second factor, if they have one — and comes
    // back. The invitation is untouched and still waiting for them.
    if (existing !== null) throw new InvitationSignInRequiredError();

    if (input.name === undefined || input.password === undefined) {
      throw new ValidationError([
        { path: 'password', message: 'Choose a name and a password to finish setting up' },
      ]);
    }

    const userId = await this.auth.createInvitedAccount({
      email: invitation.email,
      name: input.name,
      password: input.password,
    });

    let result: InvitationAcceptResult;
    try {
      result = await this.redeemFor(tenantId, input.token, invitation, userId);
    } catch (error) {
      // The invitation was revoked, or another acceptance won, between the
      // lookup and the redemption. Leave nothing half-made: a user row with no
      // workspace would reserve the address forever, and the no-enumeration
      // rule means nobody would ever be told why.
      await this.auth.discardInvitedAccount(userId);
      throw error;
    }

    return { ...result, token: await this.auth.startSessionIn(userId, tenantId) };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Redeem the token and give the user their membership, in one transaction.
   *
   * The redemption is a single guarded UPDATE, so when two acceptances arrive
   * together exactly one finds the row unconsumed and the other is told the
   * link is invalid. The audit entries and the events are written in the same
   * transaction, so none of them can describe a membership that does not exist.
   */
  private async redeemFor(
    tenantId: string,
    token: string,
    invitation: PendingInvitationLookup,
    userId: string,
  ): Promise<InvitationAcceptResult> {
    const identity = { tenantId, userId };
    const workspaceName = invitation.workspace_name;

    return this.database.runInTenant(identity, async (tx) => {
      const membership = await this.repository.findMembership(tx, tenantId, userId);

      // Suspension is an administrative decision about a person. An invitation
      // link must not be a way around it, whoever sent the link.
      if (membership?.status === 'suspended') {
        throw new ConflictError('This account cannot join this workspace');
      }

      const redeemed = await this.repository.redeem(tx, tenantId, hashOneTimeToken(token), userId);
      if (redeemed === null) throw new InvalidTokenError();

      if (membership?.status === 'active') {
        // Already a member — the invitation is spent and that is all. An
        // invitation must never re-role somebody who is already in the
        // workspace; changing a member's role is its own permission, in M3.
        await this.audit.record(tx, identity, {
          action: 'update',
          objectType: 'invitation',
          recordId: redeemed.id,
          changes: { acceptedBy: { new: userId }, membership: { new: 'already a member' } },
        });
        return { tenantId, workspaceName };
      }

      let membershipId: string;
      if (membership === null) {
        membershipId = await this.repository.createActiveMembership(tx, {
          tenantId,
          userId,
          roleId: redeemed.role_id,
          invitedBy: redeemed.created_by,
          invitedAt: redeemed.created_at,
        });
      } else {
        membershipId = membership.id;
        await this.repository.activateMembership(
          tx,
          tenantId,
          membershipId,
          redeemed.role_id,
          userId,
        );
      }

      await this.audit.record(tx, identity, {
        action: 'update',
        objectType: 'invitation',
        recordId: redeemed.id,
        changes: { acceptedBy: { new: userId }, membership: { new: membershipId } },
      });
      await this.audit.record(tx, identity, {
        action: 'create',
        objectType: 'membership',
        recordId: membershipId,
        changes: { userId: { new: userId }, roleId: { new: redeemed.role_id } },
      });
      await this.outbox.publish(tx, identity, {
        eventType: 'invitation.accepted.v1',
        objectType: 'invitation',
        recordId: redeemed.id,
        payload: { userId, membershipId, roleId: redeemed.role_id },
      });
      await this.outbox.publish(tx, identity, {
        eventType: 'membership.created.v1',
        objectType: 'membership',
        recordId: membershipId,
        payload: { userId, roleId: redeemed.role_id },
      });

      return { tenantId, workspaceName };
    });
  }

  /**
   * Resolve a token into the workspace it names and the invitation it matches.
   *
   * The workspace id comes from the token's own prefix, which is a routing
   * hint and nothing more: the row is still found by the digest of the whole
   * token, inside that workspace's RLS context, so a tampered prefix selects a
   * context in which the digest matches nothing (ADR-0019).
   *
   * Reads without consuming. Redemption is a separate, guarded statement, so
   * the checks between the two cannot burn a link they end up refusing.
   */
  private async loadPending(
    token: string,
  ): Promise<{ tenantId: string; invitation: PendingInvitationLookup }> {
    const parsed = parseInvitationToken(token);
    if (parsed === null) throw new InvalidTokenError();

    const invitation = await this.database.runInTenant(
      { tenantId: parsed.tenantId, userId: null },
      (tx) => this.repository.findPendingByTokenHash(tx, parsed.tenantId, hashOneTimeToken(token)),
    );
    if (invitation === null) throw new InvalidTokenError();

    return { tenantId: parsed.tenantId, invitation };
  }

  /** `citext` makes the column case-insensitive; this keeps the code agreeing. */
  private sameAddress(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }

  private async sendInvitation(message: {
    to: string;
    token: string;
    workspaceName: string;
    roleName: string;
    inviterName: string | null;
  }): Promise<void> {
    const from = message.inviterName ?? 'Somebody';
    await this.email.send({
      to: message.to,
      subject: `You have been invited to join ${message.workspaceName}`,
      text:
        `${from} has invited you to join ${message.workspaceName} on CRM as ` +
        `${message.roleName}.\n\n` +
        `Open this link to accept. It expires in 7 days and can be used once:\n\n` +
        `${this.env.WEB_URL}/accept-invite?token=${message.token}\n\n` +
        `If you were not expecting this you can ignore this email — nothing ` +
        `happens until you open the link.\n`,
    });
  }
}
