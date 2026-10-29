/**
 * Tests propagated from a specs/*.allium file, one per test obligation.
 *
 * Each suite lives in a `spec/` directory holding obligations.json (the list
 * `allium plan` derives from the spec), a harness.ts that calls specHarness()
 * on that directory, a reconciliation.test.ts that calls reconcileSpec(), and
 * the *.test.ts files that claim the obligations. After the spec changes,
 * refresh obligations.json and re-propagate:
 *
 *   allium plan specs/<name>.allium \
 *     | jq '[.obligations[] | {id, category, construct: .source_construct, description}]' \
 *     > <suite>/spec/obligations.json
 *
 * Every obligation is claimed by exactly one call, in one of the suite's
 * *.test.ts files; the reconciliation fails otherwise. Use a literal id in
 * each call (no loops) so the reconciliation can find it.
 *
 * - obligation:    the code meets it; an ordinary test.
 * - divergence:    the code knowingly differs from the spec. Runs as an
 *                  expected failure with its reason in the title, so the suite
 *                  stays green; once the code is fixed it passes, the expected
 *                  failure fails, and the marker must come off.
 * - unimplemented: the same, for behaviour the code does not have yet.
 * - covered:       an existing hand-written test already covers it; checked to
 *                  still exist by name rather than duplicated here. Any test
 *                  file in the repo, including bun tests under container/.
 * - instructed:    no code enforces it; the agent's instructions do. Checked
 *                  that the instruction file still says it, verbatim.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

export interface Obligation {
  id: string;
  category: string;
  construct: string;
  description: string;
}

type Body = () => void | Promise<void>;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadObligations(specDir: string): Obligation[] {
  return JSON.parse(fs.readFileSync(path.join(specDir, 'obligations.json'), 'utf-8'));
}

function expectInFile(file: string, text: string, what: string): void {
  const source = fs.readFileSync(path.join(REPO, file), 'utf-8');
  expect(source, `${file} no longer has the ${what} "${text}"`).toContain(text);
}

/** `specDir` is the suite's spec/ directory (pass the harness file's own dirname). */
export function specHarness(specDir: string) {
  const OBLIGATIONS = loadObligations(specDir);
  const byId = new Map(OBLIGATIONS.map((o) => [o.id, o]));

  function title(id: string): string {
    const o = byId.get(id);
    if (!o) throw new Error(`unknown obligation id: ${id} (not in spec/obligations.json)`);
    return `${id} — ${o.description}`;
  }

  return {
    OBLIGATIONS,

    obligation(id: string, fn: Body, timeout?: number): void {
      it(title(id), fn, timeout);
    },

    divergence(id: string, reason: string, fn: Body, timeout?: number): void {
      it.fails(`${title(id)} [DIVERGENCE: ${reason}]`, fn, timeout);
    },

    unimplemented(id: string, reason: string, fn: Body, timeout?: number): void {
      it.fails(`${title(id)} [UNIMPLEMENTED: ${reason}]`, fn, timeout);
    },

    /** `file` is repo-relative; `testName` is the covering test's title, verbatim. */
    covered(id: string, file: string, testName: string): void {
      it(`${title(id)} [covered by ${file} > ${testName}]`, () => expectInFile(file, testName, 'test'));
    },

    /** `file` is the repo-relative instruction file; `instruction` is quoted from it verbatim. */
    instructed(id: string, file: string, instruction: string): void {
      it(`${title(id)} [instructed in ${file}]`, () => expectInFile(file, instruction, 'instruction'));
    },
  };
}

const CALL = /\b(?:obligation|divergence|unimplemented|covered|instructed)\(\s*['"`]([^'"`]+)['"`]/g;

/**
 * Every obligation is claimed exactly once across the suite's *.test.ts files,
 * and nothing claims an id the spec no longer has (propagate's obligation
 * reconciliation, made a standing check).
 */
export function reconcileSpec(specDir: string, name: string): void {
  const claimed = fs
    .readdirSync(specDir)
    .filter((f) => f.endsWith('.test.ts') && f !== 'reconciliation.test.ts')
    .flatMap((f) => [...fs.readFileSync(path.join(specDir, f), 'utf-8').matchAll(CALL)].map((m) => m[1]));
  const ids = loadObligations(specDir).map((o) => o.id);
  const known = new Set(ids);

  describe(`${name} spec obligations`, () => {
    it('are each claimed by a test', () => {
      expect(ids.filter((id) => !claimed.includes(id))).toEqual([]);
    });

    it('are claimed at most once', () => {
      expect(claimed.filter((id, i) => claimed.indexOf(id) !== i)).toEqual([]);
    });

    it('are all still in the spec', () => {
      expect(claimed.filter((id) => !known.has(id))).toEqual([]);
    });
  });
}
