/**
 * Propagated from specs/memory-graph.allium — entity shapes and config.
 *
 * No code models a note: MemoryNote, SynthesisNote and NoteSource are files
 * the main agent writes in the format its standing instructions give, and
 * those instructions are untracked (groups/<folder>/instructions.prepend.md).
 * The synthesis scan's thresholds live in its scheduled task's pre-check
 * script, which is stored in the main group's session DB, not in the repo.
 * Every claim here is `unimplemented` until that text is in a tracked file
 * (see ./tracked.ts). superseded_by, the one field code reads, is in
 * index.test.ts.
 */
import { describe, expect } from 'vitest';

import { obligation, unimplemented } from './harness.js';
import { expectTrackedInstruction, SCAN_TASK, trackedFilesStating } from './tracked.js';

const UNTRACKED = 'only in the untracked groups/dm-with-alanz/instructions.prepend.md';
const SCAN_SCRIPT =
  "only in the synthesis-scan task's pre-check script, stored in the main group's session inbound.db (not tracked)";

describe('NoteSource', () => {
  unimplemented('value-equality.NoteSource', `no code models a note source; its shape is ${UNTRACKED}`, () =>
    expectTrackedInstruction('  - type: file          # file | url | conversation'),
  );

  unimplemented('entity-fields.NoteSource', `the sources format is ${UNTRACKED}`, () =>
    expectTrackedInstruction('*Sources field* — always populate `sources:` with the origin of the note material.'),
  );
});

describe('MemoryNote', () => {
  unimplemented('entity-fields.MemoryNote', `the note format is ${UNTRACKED}`, () =>
    expectTrackedInstruction('id: MEM-YYYY-MM-DD-{slug}\ncreated: YYYY-MM-DD\nkeywords: [term1, term2]'),
  );
});

describe('SynthesisNote', () => {
  unimplemented(
    'entity-fields.SynthesisNote',
    'no instruction, tracked or not, gives the SYN note format (synthesises:, the "synthesis" tag); the untracked groups/dm-with-alanz/instructions.prepend.md names only its path',
    () => expectTrackedInstruction('`zettel/notes/SYN-YYYY-MM-DD-{slug}.md`'),
  );
});

describe('SynthesisCandidate', () => {
  unimplemented(
    'entity-fields.SynthesisCandidate',
    `the candidate record (.synthesis-scan-state.json) is ${UNTRACKED} and the scan script`,
    () =>
      expectTrackedInstruction(
        'records each candidate the scan has dealt with, keyed `tag:<tag>` (tag\nlower-cased) or `hub:<MEM-id>`',
      ),
  );
});

describe('config', () => {
  obligation('config-default.researcher_folder', () => {
    // No default: the researcher's folder is set per install, so no tracked
    // code or instruction may name one.
    expect(trackedFilesStating('specialists-researcher')).toEqual([]);
  });

  unimplemented('config-default.link_candidates_limit', UNTRACKED, () =>
    expectTrackedInstruction('path_prefix: "groups/dm-with-alanz/zettel/notes/", top_k: 10'),
  );

  unimplemented('config-default.back_link_limit', UNTRACKED, () => expectTrackedInstruction('4. For top 3 candidates'));

  unimplemented('config-default.min_link_score', UNTRACKED, () =>
    expectTrackedInstruction('path_prefix: "groups/dm-with-alanz/zettel/notes/", top_k: 10, min_score: 0.5'),
  );

  unimplemented('config-default.duplicate_check_limit', UNTRACKED, () =>
    expectTrackedInstruction('source: "zettel", top_k: 5'),
  );

  unimplemented('config-default.duplicate_check_score', UNTRACKED, () =>
    expectTrackedInstruction('source: "zettel", top_k: 5, min_score: 0.5'),
  );

  unimplemented('config-default.duplicate_check_source', UNTRACKED, () =>
    expectTrackedInstruction('memory_search({query: subject, source: "zettel"'),
  );

  unimplemented(
    'config-default.synthesis_scan_schedule',
    "only the synthesis-scan task's recurrence in the main group's session inbound.db (not tracked)",
    () => expectTrackedInstruction('3 9 * * 6', SCAN_TASK),
  );

  unimplemented('config-default.synthesis_dense_tag_min', SCAN_SCRIPT, () =>
    expectTrackedInstruction('const MIN_TAG_NOTES = 10;', SCAN_TASK),
  );

  unimplemented('config-default.synthesis_dense_link_min', SCAN_SCRIPT, () =>
    expectTrackedInstruction('const MIN_HUB_LINKS = 8;', SCAN_TASK),
  );

  unimplemented('config-default.synthesis_max_candidates', SCAN_SCRIPT, () =>
    expectTrackedInstruction('const MAX_OFFERED = 5;', SCAN_TASK),
  );

  unimplemented('config-default.synthesis_resurface_growth', SCAN_SCRIPT, () =>
    expectTrackedInstruction('const REGROWTH = 1.5;', SCAN_TASK),
  );
});
