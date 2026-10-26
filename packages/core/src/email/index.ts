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
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}
