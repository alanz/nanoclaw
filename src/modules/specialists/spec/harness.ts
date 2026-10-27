/**
 * Tests propagated from specs/specialists.allium, one per test obligation.
 *
 * obligations.json is the obligation list `allium plan` derives from the spec.
 * After the spec changes, refresh it and re-propagate the tests:
 *
 *   allium plan specs/specialists.allium \
 *     | jq '[.obligations[] | {id, category, construct: .source_construct, description}]' \
 *     > src/modules/specialists/spec/obligations.json
 *
 * Every obligation is claimed by exactly one call below, in one of the
 * spec/*.test.ts files; reconciliation.test.ts fails otherwise. Use a literal
 * id in each call (no loops) so the reconciliation can find it.
 *
 * - obligation:    the code meets it; an ordinary test.
 * - divergence:    the code knowingly differs from the spec. Runs as an
 *                  expected failure with its reason in the title, so the suite
 *                  stays green; once the code is fixed it passes, the expected
 *                  failure fails, and the marker must come off.
 * - unimplemented: the same, for behaviour the code does not have yet.
 * - covered:       an existing hand-written test already covers it; checked to
 *                  still exist by name rather than duplicated here.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { expect, it } from 'vitest';

interface Obligation {
  id: string;
  category: string;
  construct: string;
  description: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../../..');

export const OBLIGATIONS: Obligation[] = JSON.parse(fs.readFileSync(path.join(here, 'obligations.json'), 'utf-8'));
const byId = new Map(OBLIGATIONS.map((o) => [o.id, o]));

function title(id: string): string {
  const o = byId.get(id);
  if (!o) throw new Error(`unknown obligation id: ${id} (not in spec/obligations.json)`);
  return `${id} — ${o.description}`;
}

type Body = () => void | Promise<void>;

export function obligation(id: string, fn: Body, timeout?: number): void {
  it(title(id), fn, timeout);
}

export function divergence(id: string, reason: string, fn: Body, timeout?: number): void {
  it.fails(`${title(id)} [DIVERGENCE: ${reason}]`, fn, timeout);
}

export function unimplemented(id: string, reason: string, fn: Body, timeout?: number): void {
  it.fails(`${title(id)} [UNIMPLEMENTED: ${reason}]`, fn, timeout);
}

/** `file` is repo-relative; `testName` is the covering test's title, verbatim. */
export function covered(id: string, file: string, testName: string): void {
  it(`${title(id)} [covered by ${file} > ${testName}]`, () => {
    const source = fs.readFileSync(path.join(REPO, file), 'utf-8');
    expect(source, `${file} no longer has the test "${testName}"`).toContain(testName);
  });
}
