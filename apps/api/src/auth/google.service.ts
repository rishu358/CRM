import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { google } from 'better-auth/social-providers';
import { InvalidTokenError, NotFoundError, secretsMatch } from '@crm/core';
import { API_ENV_TOKEN, googleConfigured, type ApiEnv } from '../config/env.js';
import { AuthRepository } from './auth.repository.js';

/**
 * Google sign-in (MVP_SPEC M1, ADR-0017).
 *
 * The OAuth dance — authorization URL, PKCE, code exchange, ID-token
 * validation — comes from Better Auth's Google provider. What is ours is where
 * the transient state lives and what we do with the identity that comes back.
 *
 * ## Where state and the PKCE verifier live
 *
 * In one short-lived httpOnly cookie, written when the flow starts. The
 * callback arrives as a top-level GET navigation from Google, which
 * `SameSite=Lax` allows, so the cookie is there to read. Keeping them in a
 * cookie rather than a database row means an abandoned sign-in leaves nothing
 * behind to clean up.
 *
 * The `state` check is what makes the callback unforgeable: without it, an
 * attacker can complete the flow with *their* code in *your* browser and
 * silently sign you into their account.
 *
 * ## Account linking
 *
 * A Google identity is linked to an existing user **only when Google says the
 * address is verified**. Without that check, anyone able to make Google issue
 * a token for an unverified address of their choosing could claim the matching
 * CRM account — the classic pre-registration takeover.
 */
const PROVIDER_ID = 'google';

/** Minutes, not hours: this only has to survive one trip to Google. */
export const OAUTH_STATE_COOKIE = 'crm_oauth';
export const OAUTH_STATE_TTL_SECONDS = 600;

export interface GoogleStart {
  readonly url: string;
  /** Opaque; the controller stores it in the state cookie and nowhere else. */
  readonly stateCookie: string;
}

export interface GoogleIdentity {
  readonly accountId: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
  readonly image: string | null;
}

@Injectable()
export class GoogleAuthService {
  constructor(
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
    @Inject(AuthRepository) private readonly repository: AuthRepository,
  ) {}

  get configured(): boolean {
    return googleConfigured(this.env);
  }

  private provider() {
    if (!googleConfigured(this.env)) {
      // A 404 rather than a 500: when Google is not configured the endpoint
      // genuinely does not exist, and saying so is more useful to a caller
      // than a stack trace about a missing environment variable.
      throw new NotFoundError('Google sign-in');
    }
    return google({
      clientId: this.env.GOOGLE_CLIENT_ID,
      clientSecret: this.env.GOOGLE_CLIENT_SECRET,
      redirectURI: this.callbackUrl(),
    });
  }

  private callbackUrl(): string {
    return `${this.env.API_URL}/api/v1/auth/google/callback`;
  }

  async start(): Promise<GoogleStart> {
    const provider = this.provider();
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');

    const url = await provider.createAuthorizationURL({
      state,
      codeVerifier,
      redirectURI: this.callbackUrl(),
      scopes: ['openid', 'email', 'profile'],
    });

    return { url: url.toString(), stateCookie: `${state}.${codeVerifier}` };
  }

  /**
   * Validate the callback and return the Google identity.
   *
   * The state is compared in constant time against the cookie before the code
   * is exchanged: a forged or replayed callback must fail before we spend a
   * network round trip, and certainly before anything is written.
   */
  async complete(input: {
    code: string;
    state: string;
    stateCookie: string;
  }): Promise<GoogleIdentity> {
    const separator = input.stateCookie.indexOf('.');
    const expectedState = separator === -1 ? '' : input.stateCookie.slice(0, separator);
    const codeVerifier = separator === -1 ? '' : input.stateCookie.slice(separator + 1);

    if (expectedState.length === 0 || !secretsMatch(expectedState, input.state)) {
      throw new InvalidTokenError('This sign-in link is no longer valid. Start again.');
    }

    const provider = this.provider();
    const tokens = await provider.validateAuthorizationCode({
      code: input.code,
      codeVerifier,
      redirectURI: this.callbackUrl(),
    });

    const profile = await provider.getUserInfo(tokens);
    const user = profile?.user;
    const email = user?.email;
    if (typeof email !== 'string' || email.length === 0) {
      throw new InvalidTokenError('Google did not return an email address');
    }

    return {
      accountId: String(user?.id ?? email),
      email: email.toLowerCase(),
      emailVerified: user?.emailVerified === true,
      name: typeof user?.name === 'string' && user.name.length > 0 ? user.name : email,
      image: typeof user?.image === 'string' ? user.image : null,
    };
  }

  /**
   * Resolve a Google identity to a user id, linking or creating as needed.
   *
   * Three cases, in order: already linked, same verified address, brand new.
   * The middle one is the dangerous one, and is why `emailVerified` is checked
   * rather than assumed.
   */
  async resolveUser(identity: GoogleIdentity): Promise<{ userId: string; created: boolean }> {
    const linked = await this.repository.findBySocialAccount(PROVIDER_ID, identity.accountId);
    if (linked !== null) return { userId: linked.user_id, created: false };

    const existing = await this.repository.findUserByEmail(identity.email);
    if (existing !== null && existing.deleted_at === null) {
      if (!identity.emailVerified) {
        throw new InvalidTokenError(
          'Google has not verified this address, so it cannot be linked to an existing account.',
        );
      }
      await this.repository.transaction(async (tx) => {
        await this.repository.upsertCredential(
          { userId: existing.id, providerId: PROVIDER_ID, accountId: identity.accountId },
          tx,
        );
        await this.repository.markEmailVerified(existing.id, tx);
      });
      return { userId: existing.id, created: false };
    }

    const userId = await this.repository.transaction(async (tx) => {
      const id = await this.repository.createUser(
        {
          email: identity.email,
          name: identity.name,
          image: identity.image,
          emailVerified: identity.emailVerified,
        },
        tx,
      );
      await this.repository.upsertCredential(
        { userId: id, providerId: PROVIDER_ID, accountId: identity.accountId },
        tx,
      );
      return id;
    });

    return { userId, created: true };
  }
}
