import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmbeddingRateLimitError } from './embedding-errors.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

describe('TokenBucketRateLimiter.depleteQuotaForType', () => {
  beforeEach(() => {
    // Use real timers; tests rely on timing of the limiter state itself
  });

  afterEach(() => {});

  it("depleteQuota() delegates to depleteQuotaForType('unknown')", () => {
    const limiter = new TokenBucketRateLimiter({
      rpmLimit: 100,
      rpdLimit: 1000,
      tpmLimit: 28000,
      accountKey: 'test-key',
      coolDownMs: 5000,
    });

    // depleteQuota() should not throw
    expect(() => limiter.depleteQuota()).not.toThrow();
  });

  it('depleteQuotaForType with various types does not throw', () => {
    const limiter = new TokenBucketRateLimiter({
      rpmLimit: 100,
      rpdLimit: 1000,
      tpmLimit: 28000,
      accountKey: 'test-key',
      coolDownMs: 5000,
    });

    expect(() => limiter.depleteQuotaForType('rpm')).not.toThrow();
    expect(() => limiter.depleteQuotaForType('rpd')).not.toThrow();
    expect(() => limiter.depleteQuotaForType('tpm')).not.toThrow();
    expect(() => limiter.depleteQuotaForType('unknown')).not.toThrow();
  });

  it('depleteQuotaForType accepts optional coolDownOverrideMs', () => {
    const limiter = new TokenBucketRateLimiter({
      rpmLimit: 100,
      accountKey: 'test-key',
      coolDownMs: 5000,
    });

    expect(() => limiter.depleteQuotaForType('rpm', 31_000)).not.toThrow();
    expect(() => limiter.depleteQuotaForType('rpd', null)).not.toThrow();
  });
});

describe('TokenBucketRateLimiter.rpdSessionBudget', () => {
  it('throws EmbeddingRateLimitError(rpd) once session budget is reached', async () => {
    const limiter = new TokenBucketRateLimiter({
      rpdSessionBudget: 3,
      accountKey: 'test-session-budget',
    });

    // First 3 permits should succeed
    await limiter.acquirePermit(1);
    await limiter.acquirePermit(1);
    await limiter.acquirePermit(1);

    // 4th should throw immediately as an RPD rate limit error
    await expect(limiter.acquirePermit(1)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EmbeddingRateLimitError && err.quotaType === 'rpd',
    );
  });

  it('session budget stop is immediate — does not wait for RPD bucket refill', async () => {
    const limiter = new TokenBucketRateLimiter({
      rpdLimit: 1000,
      rpdSessionBudget: 2,
      accountKey: 'test-session-no-wait',
    });

    await limiter.acquirePermit(1);
    await limiter.acquirePermit(1);

    const start = Date.now();
    await expect(limiter.acquirePermit(1)).rejects.toBeInstanceOf(
      EmbeddingRateLimitError,
    );
    // Should throw synchronously (within a single tick), not sleep for 86s
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('throws EmbeddingRateLimitError with rpd quotaType on budget exhaustion', async () => {
    const limiter = new TokenBucketRateLimiter({
      rpdSessionBudget: 1,
      accountKey: 'test-quota-type',
    });

    await limiter.acquirePermit(1);

    try {
      await limiter.acquirePermit(1);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EmbeddingRateLimitError);
      expect((err as EmbeddingRateLimitError).quotaType).toBe('rpd');
    }
  });
});

describe('TokenBucketRateLimiter basic behavior', () => {
  it('allows permits when no limits configured', async () => {
    const limiter = new TokenBucketRateLimiter({
      accountKey: 'unlimited',
    });

    // Should not throw
    await expect(limiter.acquirePermit(1)).resolves.toBeUndefined();
    await expect(limiter.acquirePermit(10)).resolves.toBeUndefined();
  });

  it('no-op when requestCount is 0', async () => {
    const limiter = new TokenBucketRateLimiter({
      rpmLimit: 100,
      accountKey: 'test-noop',
    });

    await expect(limiter.acquirePermit(0)).resolves.toBeUndefined();
  });

  it('throws when maxWaitMs is exceeded for RPD limit', async () => {
    // Create limiter with very small rpdLimit so it runs out immediately
    const limiter = new TokenBucketRateLimiter({
      rpdLimit: 1,
      accountKey: 'test-rpd-exhausted',
      coolDownMs: 0,
    });

    // Use up the RPD tokens
    await limiter.acquirePermit(1);

    // Next permit should fail because RPD is 0 and wait time is ~86400s >> maxWaitMs=1ms
    await expect(limiter.acquirePermit(1, 1)).rejects.toThrow(
      /quota exhausted/i,
    );
  });
});
