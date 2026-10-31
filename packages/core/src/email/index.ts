/**
 * Outbound email, as an interface (ADR-0009).
 *
 * The shape lives here, in a package both the API and the worker depend on,
 * because both of them send mail: the API sends verification and invitation
 * links, and the worker sends activity digests (ADR-0025). Two declarations of
 * the same interface would drift, and the drift would only show up as a
 * compile error in whichever one was edited second.
 *
 * No vendor SDK is imported here or anywhere outside an adapter.
 */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /**
   * The display name on the From line (`"Name" <address>`). Only the name is per message: the address
   * is the one the provider was built with, so no caller can send as another domain (ADR-0073).
   * Validated by `isValidFromName`, and again by each adapter.
   */
  readonly fromName?: string;
  /** Where a reply goes: one plain address. Validated by `isValidReplyTo`, and again by each adapter. */
  readonly replyTo?: string;
  /** Our own `Message-ID` (`<id@domain>`), so a reply can be matched to the email later (ADR-0073). */
  readonly messageId?: string;
}

/** What a provider tells us about a message it accepted. Nothing in it is secret. */
export interface EmailReceipt {
  /** The provider's own id for the message, when it gives one. */
  readonly providerMessageId?: string;
}

export interface EmailProvider {
  /** Resolves when the provider has **accepted** the message, which is not the same as delivered. */
  send(message: EmailMessage): Promise<EmailReceipt>;
}

export * from './merge-fields.js';
export * from './outreach.js';
