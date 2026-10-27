/**
 * Every obligation in obligations.json is claimed exactly once across the
 * spec/*.test.ts files, and nothing claims an id the spec no longer has
 * (propagate's obligation reconciliation, made a standing check).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { OBLIGATIONS } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CALL = /\b(?:obligation|divergence|unimplemented|covered)\(\s*['"`]([^'"`]+)['"`]/g;

function claims(): string[] {
  return fs
    .readdirSync(here)
    .filter((f) => f.endsWith('.test.ts') && f !== 'reconciliation.test.ts')
    .flatMap((f) => [...fs.readFileSync(path.join(here, f), 'utf-8').matchAll(CALL)].map((m) => m[1]));
}

describe('specialists spec obligations', () => {
  const claimed = claims();
  const known = new Set(OBLIGATIONS.map((o) => o.id));

  it('are each claimed by a test', () => {
    expect(OBLIGATIONS.map((o) => o.id).filter((id) => !claimed.includes(id))).toEqual([]);
  });

  it('are claimed at most once', () => {
    expect(claimed.filter((id, i) => claimed.indexOf(id) !== i)).toEqual([]);
  });

  it('are all still in the spec', () => {
    expect(claimed.filter((id) => !known.has(id))).toEqual([]);
  });
});
