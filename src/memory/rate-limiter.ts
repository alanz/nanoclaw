import { log } from '../log.js';
import { EmbeddingRateLimitError } from './embedding-errors.js';

export type RateLimitConfig = {
  rpmLimit?: number;
  rpdLimit?: number;
  tpmLimit?: number;
  rpdSessionBudget?: number;
  accountKey: string;
  coolDownMs?: number;
};

const DAY_MS = 86_400_000;

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
  // The daily request budget is counted over a 24h window that opens with the
  // first request it counts, so a long-running host gets a fresh budget each
  // day rather than one per process.
  private rpdSessionUsed = 0;
  private rpdWindowStart: number | null = null;
  private coolDownUntil = 0;
  // A daily quota stop (a 429 or the budget running out) holds for 24h, then
  // lifts on its own; before, it held until the host restarted.
  private rpdExhaustedUntil = 0;

  constructor(config: RateLimitConfig) {
    this.accountKey = config.accountKey;
    this.rpmLimit = config.rpmLimit;
    this.rpdLimit = config.rpdLimit;
    this.tpmLimit = config.tpmLimit;
    this.rpdSessionBudget = config.rpdSessionBudget;
    this.coolDownMs = config.coolDownMs ?? 5000;

    this.rpmTokens = 0;
    this.rpmLastRefill = Date.now();
    this.rpdTokens = config.rpdLimit ?? 0;
    this.rpdLastRefill = Date.now();
    this.tpmTokens = (this.tpmLimit ?? 0) / 2;
    this.tpmLastRefill = Date.now();

    log.info('Memory rate limiter created', {
      accountKey: config.accountKey,
      rpmLimit: config.rpmLimit,
      rpdSessionBudget: config.rpdSessionBudget,
    });
  }

  async acquirePermit(requestCount: number, maxWaitMs = 600_000, tokenCount = 0): Promise<void> {
    if (requestCount <= 0 && tokenCount <= 0) return;

    this.rollRpdWindow(Date.now());
    if (this.rpdExhaustedUntil > 0) {
      throw new EmbeddingRateLimitError(
        `RPD quota exhausted until ${new Date(this.rpdExhaustedUntil).toISOString()}.`,
        'rpd',
        null,
      );
    }

    // A request bigger than a bucket's whole capacity can never be granted:
    // the bucket refills only to its limit, so the loop below would sleep and
    // re-check forever (each wait shorter than maxWaitMs, so that guard never
    // fires). Seen live: a 22k-token embedding batch against a 15k TPM bucket
    // stalled a memory sync indefinitely. Refuse it so the caller splits it.
    if (this.tpmLimit !== undefined && tokenCount > this.tpmLimit) {
      throw new Error(
        `Request of ${tokenCount} tokens exceeds the ${this.tpmLimit} tokens-per-minute limit and can never be granted; split it.`,
      );
    }
    if (this.rpmLimit !== undefined && requestCount > this.rpmLimit) {
      throw new Error(
        `Request of ${requestCount} requests exceeds the ${this.rpmLimit} requests-per-minute limit and can never be granted; split it.`,
      );
    }

    const LOG_THROTTLE_MS = 30_000;
    let lastCoolDownLogAt = 0;
    let lastQuotaLogAt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();

      if (this.rpdSessionBudget !== undefined && this.rpdSessionUsed >= this.rpdSessionBudget) {
        log.warn('Memory rate limiter: RPD session budget exhausted', {
          accountKey: this.accountKey,
          rpdSessionBudget: this.rpdSessionBudget,
          rpdSessionUsed: this.rpdSessionUsed,
        });
        throw new EmbeddingRateLimitError(
          `RPD budget of ${this.rpdSessionBudget} requests exhausted (${this.rpdSessionUsed} used in this 24h window).`,
          'rpd',
          null,
        );
      }

      if (this.coolDownUntil > now) {
        const waitMs = this.coolDownUntil - now;
        if (now - lastCoolDownLogAt >= LOG_THROTTLE_MS) {
          log.warn('Memory rate limiter: in cool-down after 429', {
            accountKey: this.accountKey,
            waitMs: Math.round(waitMs),
          });
          lastCoolDownLogAt = now;
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        this.coolDownUntil = 0;
        continue;
      }

      if (this.rpmLimit !== undefined) {
        const add = ((now - this.rpmLastRefill) / 60_000) * this.rpmLimit;
        this.rpmTokens = Math.min(this.rpmLimit, this.rpmTokens + add);
        this.rpmLastRefill = now;
      }
      if (this.rpdLimit !== undefined) {
        const add = ((now - this.rpdLastRefill) / 86_400_000) * this.rpdLimit;
        this.rpdTokens = Math.min(this.rpdLimit, this.rpdTokens + add);
        this.rpdLastRefill = now;
      }
      if (this.tpmLimit !== undefined) {
        const add = ((now - this.tpmLastRefill) / 60_000) * this.tpmLimit;
        this.tpmTokens = Math.min(this.tpmLimit, this.tpmTokens + add);
        this.tpmLastRefill = now;
      }

      const rpmAvailable = this.rpmLimit === undefined || this.rpmTokens >= requestCount;
      const rpdAvailable = this.rpdLimit === undefined || this.rpdTokens >= requestCount;
      const tpmAvailable = this.tpmLimit === undefined || this.tpmTokens >= tokenCount;

      if (rpmAvailable && rpdAvailable && tpmAvailable) {
        if (this.rpmLimit !== undefined) this.rpmTokens -= requestCount;
        if (this.rpdLimit !== undefined) this.rpdTokens -= requestCount;
        if (this.tpmLimit !== undefined) this.tpmTokens -= tokenCount;
        if (this.rpdSessionBudget !== undefined) {
          this.rpdWindowStart ??= now;
          this.rpdSessionUsed += requestCount;
        }
        return;
      }

      let waitMs = 0;
      let limitType: 'rpm' | 'rpd' | 'tpm' | null = null;

      if (!rpmAvailable && this.rpmLimit !== undefined) {
        const w = (requestCount - this.rpmTokens) * (60_000 / this.rpmLimit);
        if (w > waitMs) {
          waitMs = w;
          limitType = 'rpm';
        }
      }
      if (!rpdAvailable && this.rpdLimit !== undefined) {
        const w = (requestCount - this.rpdTokens) * (86_400_000 / this.rpdLimit);
        if (w > waitMs) {
          waitMs = w;
          limitType = 'rpd';
        }
      }
      if (!tpmAvailable && this.tpmLimit !== undefined) {
        const w = (tokenCount - this.tpmTokens) * (60_000 / this.tpmLimit);
        if (w > waitMs) {
          waitMs = w;
          limitType = 'tpm';
        }
      }

      waitMs = Math.max(100, waitMs);
      if (waitMs > maxWaitMs) {
        throw new Error(
          `Rate limit quota exhausted (${limitType}). Would need to wait ${Math.ceil(waitMs / 60_000)} minutes. Please try again later.`,
        );
      }

      if (now - lastQuotaLogAt >= LOG_THROTTLE_MS) {
        log.warn(`Memory rate limiter: ${limitType?.toUpperCase()} quota, waiting`, {
          accountKey: this.accountKey,
          limitType,
          waitMs: Math.round(waitMs),
        });
        lastQuotaLogAt = now;
      }

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  depleteQuotaForType(quotaType: 'rpm' | 'rpd' | 'tpm' | 'unknown', coolDownOverrideMs?: number | null): void {
    if (quotaType === 'rpm' || quotaType === 'unknown') this.rpmTokens = 0;
    if (quotaType === 'rpd') {
      this.rpdTokens = 0;
      // A sync that runs into a stop already in force gets an 'rpd' refusal
      // too; that must not push the stop out another day.
      if (this.rpdExhaustedUntil > Date.now()) return;
      this.rpdExhaustedUntil = Date.now() + DAY_MS;
      log.warn('Memory rate limiter: RPD exhausted, stopping for 24h', {
        accountKey: this.accountKey,
        resumeAt: new Date(this.rpdExhaustedUntil).toISOString(),
      });
      return;
    }
    if (quotaType === 'tpm') this.tpmTokens = 0;

    const baseCoolDownMs =
      coolDownOverrideMs != null && coolDownOverrideMs > 0
        ? coolDownOverrideMs
        : quotaType === 'rpm' || quotaType === 'unknown'
          ? 15_000
          : this.coolDownMs;

    const jitter = 0.8 + Math.random() * 0.4;
    this.coolDownUntil = Date.now() + Math.round(baseCoolDownMs * jitter);
    log.warn('Memory rate limiter: quota depleted, entering cool-down', {
      accountKey: this.accountKey,
      quotaType,
      baseCoolDownMs,
    });
  }

  /** Milliseconds until a daily quota stop lifts; 0 when not stopped. */
  rpdResumeInMs(now = Date.now()): number {
    return Math.max(0, this.rpdExhaustedUntil - now);
  }

  private rollRpdWindow(now: number): void {
    if (this.rpdWindowStart !== null && now - this.rpdWindowStart >= DAY_MS) {
      this.rpdWindowStart = null;
      this.rpdSessionUsed = 0;
    }
    if (this.rpdExhaustedUntil > 0 && now >= this.rpdExhaustedUntil) {
      this.rpdExhaustedUntil = 0;
      this.rpdWindowStart = null;
      this.rpdSessionUsed = 0;
      log.info('Memory rate limiter: RPD stop lifted after 24h', { accountKey: this.accountKey });
    }
  }

  depleteQuota(): void {
    this.depleteQuotaForType('unknown');
  }
}
