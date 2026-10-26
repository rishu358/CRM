import { Inject, Injectable } from '@nestjs/common';
import {
  BACKUP_CODE_COUNT,
  findBackupCode,
  generateBackupCodes,
  hashBackupCodes,
  MfaInvalidError,
} from '@crm/core';
import type { MfaEnrolment } from '@crm/contracts';
import { API_ENV_TOKEN, type ApiEnv } from '../config/env.js';
import { AuthRepository } from './auth.repository.js';
import { TOTP_PROVIDER, type TotpProvider } from './crypto/totp.provider.js';

/**
 * TOTP enrolment and verification (MVP_SPEC M1).
 *
 * Two rows per enrolled user: a `totp` factor holding the encrypted secret,
 * and a `backup_codes` factor holding the encrypted list of code hashes. They
 * are separate so that using a backup code can rewrite the code list without
 * touching the TOTP secret.
 *
 * ## Enrolment is two steps on purpose
 *
 * `begin` stores the secret unverified; `activate` only marks it verified once
 * the user has produced a working code. One step would let someone enrol a
 * secret they never successfully scanned, and if the workspace then required
 * MFA they would be locked out of their own account by their own setup.
 */
interface BackupCodeState {
  readonly hashes: string[];
}

@Injectable()
export class MfaService {
  constructor(
    @Inject(AuthRepository) private readonly repository: AuthRepository,
    @Inject(TOTP_PROVIDER) private readonly totp: TotpProvider,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  /** Whether this user has an activated second factor. */
  async isEnrolled(userId: string): Promise<boolean> {
    const factors = await this.repository.listFactors(userId);
    return factors.some((factor) => factor.type === 'totp' && factor.verified_at !== null);
  }

  /**
   * Start enrolment: generate a secret, store it unverified, return it once.
   *
   * Re-enrolling replaces the previous secret and the previous backup codes.
   * The unique index on `(user_id, type)` is what makes that a replacement
   * rather than an accumulation — an old authenticator must stop working.
   */
  async begin(userId: string, email: string): Promise<MfaEnrolment> {
    const secret = this.totp.generateSecret();
    const backupCodes = generateBackupCodes(BACKUP_CODE_COUNT);

    const encryptedSecret = await this.totp.encryptSecret(this.totp.toStoredSecret(secret));
    const encryptedCodes = await this.totp.encryptSecret(
      JSON.stringify({ hashes: hashBackupCodes(backupCodes) } satisfies BackupCodeState),
    );

    await this.repository.transaction(async (tx) => {
      await this.repository.upsertFactor(
        { userId, type: 'totp', secret: encryptedSecret, verified: false },
        tx,
      );
      await this.repository.upsertFactor(
        { userId, type: 'backup_codes', secret: encryptedCodes, verified: true },
        tx,
      );
    });

    return {
      secret,
      otpauthUrl: this.totp.provisioningUrl(secret, this.env.APP_NAME, email),
      backupCodes,
    };
  }

  /** Finish enrolment by proving the authenticator works. */
  async activate(userId: string, code: string): Promise<void> {
    const factors = await this.repository.listFactors(userId);
    const totpFactor = factors.find((factor) => factor.type === 'totp');
    if (totpFactor === undefined) throw new MfaInvalidError();

    const secret = await this.totp.decryptSecret(totpFactor.secret);
    if (!(await this.totp.verify(secret, code))) throw new MfaInvalidError();

    await this.repository.transaction(async (tx) => {
      await this.repository.markFactorVerified(userId, 'totp', tx);
      await this.repository.setMfaEnabled(userId, true, tx);
    });
  }

  /**
   * Check a code at sign-in. Accepts a TOTP code or an unused backup code.
   *
   * A used backup code is **removed** from the stored list, not flagged: the
   * only thing the verification path reads is the list, so removal is the only
   * representation of "used" that cannot be bypassed by a bug elsewhere.
   */
  async verify(userId: string, code: string): Promise<boolean> {
    const factors = await this.repository.listFactors(userId);

    const totpFactor = factors.find(
      (factor) => factor.type === 'totp' && factor.verified_at !== null,
    );
    if (totpFactor !== undefined) {
      const secret = await this.totp.decryptSecret(totpFactor.secret);
      if (await this.totp.verify(secret, code)) {
        await this.repository.markFactorVerified(userId, 'totp');
        return true;
      }
    }

    const backupFactor = factors.find((factor) => factor.type === 'backup_codes');
    if (backupFactor === undefined) return false;

    const state = await this.readBackupCodes(backupFactor.secret);
    if (state === null) return false;

    const index = findBackupCode(state.hashes, code);
    if (index === null) return false;

    const remaining = state.hashes.filter((_, position) => position !== index);
    await this.repository.updateFactorSecret(
      userId,
      'backup_codes',
      await this.totp.encryptSecret(
        JSON.stringify({ hashes: remaining } satisfies BackupCodeState),
      ),
    );
    return true;
  }

  /** How many backup codes are left, for the security screen. */
  async remainingBackupCodes(userId: string): Promise<number> {
    const factors = await this.repository.listFactors(userId);
    const backupFactor = factors.find((factor) => factor.type === 'backup_codes');
    if (backupFactor === undefined) return 0;
    const state = await this.readBackupCodes(backupFactor.secret);
    return state?.hashes.length ?? 0;
  }

  async disable(userId: string): Promise<void> {
    await this.repository.transaction(async (tx) => {
      await this.repository.deleteFactors(userId, tx);
      await this.repository.setMfaEnabled(userId, false, tx);
    });
  }

  /**
   * Decrypt and parse, treating anything unreadable as "no codes".
   *
   * An unparseable blob means the secret was rotated or the row is corrupt.
   * Neither is a reason to 500 on sign-in; both mean this factor cannot
   * authenticate anyone, which is the safe reading.
   */
  private async readBackupCodes(ciphertext: string): Promise<BackupCodeState | null> {
    try {
      const parsed = JSON.parse(await this.totp.decryptSecret(ciphertext)) as unknown;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray((parsed as BackupCodeState).hashes)
      ) {
        return null;
      }
      return { hashes: (parsed as BackupCodeState).hashes.filter((h) => typeof h === 'string') };
    } catch {
      return null;
    }
  }
}
