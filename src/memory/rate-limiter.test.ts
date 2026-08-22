import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { isEmbeddingRateLimitError } from './embedding-errors.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

async function rpdRefusal(limiter: TokenBucketRateLimiter): Promise<boolean> {
  try {
    await limiter.acquirePermit(1);
    return false;
  } catch (err) {
    return isEmbeddingRateLimitError(err) && err.quotaType === 'rpd';
  }
}

describe('daily quota (RPD) stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lifts 24h after a provider 429, not only on restart', async () => {
    const limiter = new TokenBucketRateLimiter({ accountKey: 'k' });
    limiter.depleteQuotaForType('rpd');

    expect(limiter.rpdResumeInMs()).toBe(DAY_MS);
    expect(await rpdRefusal(limiter)).toBe(true);

    vi.setSystemTime(Date.now() + DAY_MS - 1);
    expect(await rpdRefusal(limiter)).toBe(true);

    vi.setSystemTime(Date.now() + 1);
    expect(limiter.rpdResumeInMs()).toBe(0);
    expect(await rpdRefusal(limiter)).toBe(false);
  });

  it('keeps the original end when a stop is reported again while in force', async () => {
    const limiter = new TokenBucketRateLimiter({ accountKey: 'k' });
    limiter.depleteQuotaForType('rpd');
    vi.setSystemTime(Date.now() + 12 * HOUR_MS);
    limiter.depleteQuotaForType('rpd');

    expect(limiter.rpdResumeInMs()).toBe(12 * HOUR_MS);
  });

  it('gives the request budget back 24h after it ran out', async () => {
    const limiter = new TokenBucketRateLimiter({ accountKey: 'k', rpdSessionBudget: 2 });
    await limiter.acquirePermit(1);
    await limiter.acquirePermit(1);
    expect(await rpdRefusal(limiter)).toBe(true);

    // The manager reacts to the refusal by recording the stop.
    limiter.depleteQuotaForType('rpd');
    vi.setSystemTime(Date.now() + DAY_MS);

    await limiter.acquirePermit(1);
    await limiter.acquirePermit(1);
    expect(await rpdRefusal(limiter)).toBe(true);
  });

  it('counts the budget per 24h window, not per process lifetime', async () => {
    const limiter = new TokenBucketRateLimiter({ accountKey: 'k', rpdSessionBudget: 2 });
    await limiter.acquirePermit(1);
    vi.setSystemTime(Date.now() + 23 * HOUR_MS);
    await limiter.acquirePermit(1);

    // The window opened at the first request, so an hour later both are forgotten.
    vi.setSystemTime(Date.now() + HOUR_MS);
    await limiter.acquirePermit(1);
    await limiter.acquirePermit(1);
    expect(await rpdRefusal(limiter)).toBe(true);
  });
});
