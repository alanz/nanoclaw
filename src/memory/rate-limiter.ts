import { logger } from '../logger.js';
import { EmbeddingRateLimitError } from './embedding-errors.js';

export type RateLimitConfig = {
  /** Requests per minute limit (undefined = no limit) */
  rpmLimit?: number;
  /** Requests per day limit (undefined = no limit) */
  rpdLimit?: number;
  /** Tokens per minute limit (undefined = no limit) */
  tpmLimit?: number;
  /**
   * Per-session RPD budget: stop (do not wait) once this many requests have
   * been issued in the current process.
   */
  rpdSessionBudget?: number;
  /** Account identifier for this rate limiter instance */
  accountKey: string;
  /** Cool-down period in milliseconds after a 429 error (default: 5000ms) */
  coolDownMs?: number;
};

export class TokenBucketRateLimiter {
  private readonly accountKey: string;
  private readonly rpmLimit?: number;
  private readonly rpdLimit?: number;
  private readonly tpmLimit?: number;
  private readonly rpdSessionBudget?: number;
  private readonly coolDownMs: number;

  private rpmTokens: number;
  private rpmLastRefill: number;

  private rpdTokens: number;
  private rpdLastRefill: number;

  private tpmTokens: number;
  private tpmLastRefill: number;

  private rpdSessionUsed: number = 0;
  private coolDownUntil: number = 0;

  constructor(config: RateLimitConfig) {
    this.accountKey = config.accountKey;
    this.rpmLimit = config.rpmLimit;
    this.rpdLimit = config.rpdLimit;
    this.tpmLimit = config.tpmLimit;
    this.rpdSessionBudget = config.rpdSessionBudget;
    this.coolDownMs = config.coolDownMs ?? 5000;

    // Start RPM at half capacity to avoid burst compounding at startup
    this.rpmTokens = (config.rpmLimit ?? 0) / 2;
    this.rpmLastRefill = Date.now();

    this.rpdTokens = config.rpdLimit ?? 0;
    this.rpdLastRefill = Date.now();

    this.tpmTokens = config.tpmLimit ?? 0;
    this.tpmLastRefill = Date.now();

    logger.info(
      {
        accountKey: config.accountKey,
        rpmLimit: config.rpmLimit,
        rpdSessionBudget: config.rpdSessionBudget,
      },
      'memory rate limiter created',
    );
  }

  async acquirePermit(
    requestCount: number,
    maxWaitMs = 600_000,
    tokenCount = 0,
  ): Promise<void> {
    if (requestCount <= 0 && tokenCount <= 0) return;

    const LOG_THROTTLE_MS = 30_000;
    let lastCoolDownLogAt = 0;
    let lastQuotaLogAt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();

      if (
        this.rpdSessionBudget !== undefined &&
        this.rpdSessionUsed >= this.rpdSessionBudget
      ) {
        logger.warn(
          {
            accountKey: this.accountKey,
            rpdSessionBudget: this.rpdSessionBudget,
            rpdSessionUsed: this.rpdSessionUsed,
          },
          'memory rate limiter: RPD session budget exhausted',
        );
        throw new EmbeddingRateLimitError(
          `RPD session budget of ${this.rpdSessionBudget} requests exhausted ` +
            `(${this.rpdSessionUsed} used this run).`,
          'rpd',
          null,
        );
      }

      if (this.coolDownUntil > now) {
        const waitMs = this.coolDownUntil - now;
        if (now - lastCoolDownLogAt >= LOG_THROTTLE_MS) {
          logger.warn(
            { accountKey: this.accountKey, waitMs: Math.round(waitMs) },
            'memory rate limiter: in cool-down after 429',
          );
          lastCoolDownLogAt = now;
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        this.coolDownUntil = 0;
        continue;
      }

      if (this.rpmLimit !== undefined) {
        const tokensToAdd =
          ((now - this.rpmLastRefill) / 60_000) * this.rpmLimit;
        this.rpmTokens = Math.min(this.rpmLimit, this.rpmTokens + tokensToAdd);
        this.rpmLastRefill = now;
      }
      if (this.rpdLimit !== undefined) {
        const tokensToAdd =
          ((now - this.rpdLastRefill) / 86_400_000) * this.rpdLimit;
        this.rpdTokens = Math.min(this.rpdLimit, this.rpdTokens + tokensToAdd);
        this.rpdLastRefill = now;
      }
      if (this.tpmLimit !== undefined) {
        const tokensToAdd =
          ((now - this.tpmLastRefill) / 60_000) * this.tpmLimit;
        this.tpmTokens = Math.min(this.tpmLimit, this.tpmTokens + tokensToAdd);
        this.tpmLastRefill = now;
      }

      const rpmAvailable =
        this.rpmLimit === undefined || this.rpmTokens >= requestCount;
      const rpdAvailable =
        this.rpdLimit === undefined || this.rpdTokens >= requestCount;
      const tpmAvailable =
        this.tpmLimit === undefined || this.tpmTokens >= tokenCount;

      if (rpmAvailable && rpdAvailable && tpmAvailable) {
        if (this.rpmLimit !== undefined) this.rpmTokens -= requestCount;
        if (this.rpdLimit !== undefined) this.rpdTokens -= requestCount;
        if (this.tpmLimit !== undefined) this.tpmTokens -= tokenCount;
        if (this.rpdSessionBudget !== undefined)
          this.rpdSessionUsed += requestCount;
        return;
      }

      let waitMs = 0;
      let limitType: 'rpm' | 'rpd' | 'tpm' | null = null;

      if (!rpmAvailable && this.rpmLimit !== undefined) {
        const rpmWait =
          (requestCount - this.rpmTokens) * (60_000 / this.rpmLimit);
        if (rpmWait > waitMs) {
          waitMs = rpmWait;
          limitType = 'rpm';
        }
      }
      if (!rpdAvailable && this.rpdLimit !== undefined) {
        const rpdWait =
          (requestCount - this.rpdTokens) * (86_400_000 / this.rpdLimit);
        if (rpdWait > waitMs) {
          waitMs = rpdWait;
          limitType = 'rpd';
        }
      }
      if (!tpmAvailable && this.tpmLimit !== undefined) {
        const tpmWait =
          (tokenCount - this.tpmTokens) * (60_000 / this.tpmLimit);
        if (tpmWait > waitMs) {
          waitMs = tpmWait;
          limitType = 'tpm';
        }
      }

      waitMs = Math.max(100, waitMs);

      if (waitMs > maxWaitMs) {
        throw new Error(
          `Rate limit quota exhausted (${limitType}). ` +
            `Would need to wait ${Math.ceil(waitMs / 60_000)} minutes. ` +
            `Please try again later.`,
        );
      }

      if (now - lastQuotaLogAt >= LOG_THROTTLE_MS) {
        logger.warn(
          {
            accountKey: this.accountKey,
            limitType,
            waitMs: Math.round(waitMs),
          },
          `memory rate limiter: ${limitType?.toUpperCase()} quota, waiting`,
        );
        lastQuotaLogAt = now;
      }

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  depleteQuotaForType(
    quotaType: 'rpm' | 'rpd' | 'tpm' | 'unknown',
    coolDownOverrideMs?: number | null,
  ): void {
    if (quotaType === 'rpm' || quotaType === 'unknown') this.rpmTokens = 0;
    if (quotaType === 'rpd') this.rpdTokens = 0;
    if (quotaType === 'tpm') this.tpmTokens = 0;

    const baseCoolDownMs =
      coolDownOverrideMs != null && coolDownOverrideMs > 0
        ? coolDownOverrideMs
        : quotaType === 'rpd'
          ? 60_000
          : this.coolDownMs;

    const jitter = 0.8 + Math.random() * 0.4;
    this.coolDownUntil = Date.now() + Math.round(baseCoolDownMs * jitter);

    logger.warn(
      { accountKey: this.accountKey, quotaType, baseCoolDownMs },
      'memory rate limiter: quota depleted, entering cool-down',
    );
  }

  depleteQuota(): void {
    this.depleteQuotaForType('unknown');
  }
}
