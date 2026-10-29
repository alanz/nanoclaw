/**
 * Propagated from specs/memory-graph.allium — what the memory index does with
 * the Zettelkasten: superseded_by as an optional field the index reads, and
 * the searches the main agent's workflow is built on (the pre-dispatch
 * duplicate check over the whole Zettelkasten, link candidates from
 * zettel/notes/ only).
 *
 * A real MemoryIndexManager over a temporary group folder; only the embedding
 * provider (a constant vector) and the file watcher are faked.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => texts.map(() => new Array(3072).fill(0.01)),
    embedQuery: async () => new Array(3072).fill(0.01),
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));

import { MemoryIndexManager } from '../manager.js';
import { obligation, unimplemented } from './harness.js';
import { expectTrackedInstruction } from './tracked.js';

type WithLimiter = { rateLimiter: { acquirePermit: () => Promise<void> } };

const FOLDER = 'main';

/** A note in the instructions' frontmatter shape; `supersededBy` undefined leaves the field out. */
function note(id: string, supersededBy?: string | null): string {
  const sb = supersededBy === undefined ? '' : `superseded_by: ${supersededBy ?? 'null'}\n`;
  return `---\nid: ${id}\ncreated: 2026-10-01\nkeywords: [aardvark]\ntags: [zoology]\nlinks: []\nsupersedes: null\n${sb}---\n\n# ${id}\n\nAardvarks eat termites.\n`;
}

let root: string;
let manager: MemoryIndexManager | undefined;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-spec-index-')));
});
afterEach(async () => {
  await manager?.close();
  manager = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Index a group folder holding `files` (paths relative to the group folder). */
async function indexed(files: Record<string, string>): Promise<MemoryIndexManager> {
  const groupDir = path.join(root, FOLDER);
  fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'zettel'), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(groupDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(groupDir, rel), text);
  }
  const m = new MemoryIndexManager(
    'ag-main',
    FOLDER,
    path.join(groupDir, 'memory'),
    path.join(root, 'index.db'),
    'key',
    'm',
    [{ dir: path.join(groupDir, 'zettel'), source: 'zettel' }],
  );
  await m.init();
  // init takes the shared, install-wide limiter; no quota to wait on here.
  (m as unknown as WithLimiter).rateLimiter = { acquirePermit: async () => {} };
  await m.sync();
  manager = m;
  return m;
}

const found = (r: { results: Array<{ path: string }> }) => r.results.map((x) => x.path).sort();

// ── superseded_by: optional, null or a note id ──────────────────────────────

describe('superseded_by', () => {
  obligation(
    'entity-optional.MemoryNote.superseded_by',
    async () => {
      const m = await indexed({
        'zettel/notes/MEM-2026-10-01-absent.md': note('MEM-2026-10-01-absent'),
        'zettel/notes/MEM-2026-10-01-null.md': note('MEM-2026-10-01-null', null),
        'zettel/notes/MEM-2026-10-01-old.md': note('MEM-2026-10-01-old', 'MEM-2026-10-02-new'),
        'zettel/notes/MEM-2026-10-02-new.md': note('MEM-2026-10-02-new'),
      });
      const current = found(await m.search('aardvarks termites', { minScore: 0 }));
      const all = found(await m.search('aardvarks termites', { minScore: 0, includeSuperseded: true }));

      // Null (absent or written null) is a current note; a note id marks it superseded.
      expect(current.map((p) => path.basename(p))).toEqual([
        'MEM-2026-10-01-absent.md',
        'MEM-2026-10-01-null.md',
        'MEM-2026-10-02-new.md',
      ]);
      // Superseded is not deleted: it is still indexed, and found on request.
      expect(all.map((p) => path.basename(p))).toEqual([
        'MEM-2026-10-01-absent.md',
        'MEM-2026-10-01-null.md',
        'MEM-2026-10-01-old.md',
        'MEM-2026-10-02-new.md',
      ]);
    },
    20_000,
  );

  obligation(
    'entity-optional.SynthesisNote.superseded_by',
    async () => {
      // A SYN note is read the same way, superseded by a MEM or a later SYN.
      const m = await indexed({
        'zettel/notes/SYN-2026-10-01-current.md': note('SYN-2026-10-01-current', null),
        'zettel/notes/SYN-2026-10-01-by-syn.md': note('SYN-2026-10-01-by-syn', 'SYN-2026-10-05-later'),
        'zettel/notes/SYN-2026-10-01-by-mem.md': note('SYN-2026-10-01-by-mem', '[MEM-2026-10-05-fix]'),
      });
      const current = found(await m.search('aardvarks termites', { minScore: 0 }));
      const all = found(await m.search('aardvarks termites', { minScore: 0, includeSuperseded: true }));

      expect(current.map((p) => path.basename(p))).toEqual(['SYN-2026-10-01-current.md']);
      expect(all).toHaveLength(3);
    },
    20_000,
  );
});

// ── DuplicateCheckPerformed ──────────────────────────────────────────────────

describe('DuplicateCheckPerformed', () => {
  // The search it needs exists (below); running it before every dispatch and
  // surfacing the candidates is the main agent's instruction, untracked.
  unimplemented(
    'rule-success.DuplicateCheckPerformed',
    'the duplicate check before dispatch is only in the untracked groups/dm-with-alanz/instructions.prepend.md',
    () => expectTrackedInstruction('memory_search({query: subject, source: "zettel", top_k: 5, min_score: 0.5})'),
  );

  it('(support) source "zettel" searches the whole Zettelkasten — notes, reports and drafts — and nothing else', async () => {
    const m = await indexed({
      'zettel/notes/MEM-2026-10-01-aardvark.md': note('MEM-2026-10-01-aardvark'),
      'zettel/reports/2026-10-01-aardvark.md': '# Aardvark report\n\nAardvarks eat termites.\n',
      'zettel/drafts/DRAFT-SYN-2026-10-01-aardvark-v1.md': '# Draft\n\nAardvarks eat termites.\n',
      'memory/aardvark.md': '# Memory\n\nAardvarks eat termites.\n',
    });
    const r = await m.search('aardvarks termites', { minScore: 0, source: 'zettel', maxResults: 5 });
    expect(found(r).map((p) => p.replace(/^.*?zettel\//, 'zettel/'))).toEqual([
      'zettel/drafts/DRAFT-SYN-2026-10-01-aardvark-v1.md',
      'zettel/notes/MEM-2026-10-01-aardvark.md',
      'zettel/reports/2026-10-01-aardvark.md',
    ]);
  }, 20_000);

  it('(support) the link-candidate prefix groups/<folder>/zettel/notes/ finds notes only, current ones only', async () => {
    const m = await indexed({
      'zettel/notes/MEM-2026-10-01-aardvark.md': note('MEM-2026-10-01-aardvark'),
      'zettel/notes/SYN-2026-10-01-aardvark.md': note('SYN-2026-10-01-aardvark'),
      'zettel/notes/MEM-2026-09-01-aardvark.md': note('MEM-2026-09-01-aardvark', 'MEM-2026-10-01-aardvark'),
      'zettel/reports/2026-10-01-aardvark.md': '# Aardvark report\n\nAardvarks eat termites.\n',
    });
    // The index stores paths as the host sees them from its working directory
    // (groups/<folder>/… on a live install); here the group folder is a temp dir.
    const notes = path.relative(process.cwd(), path.join(root, FOLDER, 'zettel', 'notes')) + '/';
    const r = await m.search('aardvarks termites', { minScore: 0, pathPrefix: notes, maxResults: 10 });
    expect(found(r)).toEqual([`${notes}MEM-2026-10-01-aardvark.md`, `${notes}SYN-2026-10-01-aardvark.md`]);
  }, 20_000);
});
