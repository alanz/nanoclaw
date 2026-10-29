/**
 * Propagated from specs/memory-graph.allium — the grow-only note space:
 * BackLinksWritten, SupersedingNoteWritten, MemoryNoteSupersedes,
 * SynthesisNoteSupersedes and the note-graph invariants.
 *
 * All of it is the main agent writing files under its untracked standing
 * instructions; no code writes, links or checks a note. The one code half —
 * search leaving superseded notes out, so they are never offered as link
 * candidates — is in src/memory/superseded.test.ts and ./index.test.ts.
 * (rule-failure.SupersedingNoteWritten.1 is in ./isolation.test.ts.)
 */
import { describe } from 'vitest';

import { unimplemented } from './harness.js';
import { expectTrackedInstruction, NOWHERE } from './tracked.js';

const UNTRACKED = 'only in the untracked groups/dm-with-alanz/instructions.prepend.md';
const NEVER_SET =
  'nothing sets superseded_by on a superseded note: the untracked groups/dm-with-alanz/instructions.prepend.md only allows it ("may be updated"), never directs it';

describe('BackLinksWritten', () => {
  unimplemented('rule-success.BackLinksWritten', UNTRACKED, () =>
    expectTrackedInstruction(
      "read their `links:` field and add the new note's ID — unless the candidate has `superseded_by` set, then leave it unchanged",
    ),
  );
});

describe('SupersedingNoteWritten', () => {
  unimplemented('rule-success.SupersedingNoteWritten', UNTRACKED, () =>
    expectTrackedInstruction('Set `supersedes: [old-id]` on the new note. Do not correct the old note in place.'),
  );

  unimplemented('rule-failure.SupersedingNoteWritten.2', UNTRACKED, () =>
    expectTrackedInstruction('**Corrections are new notes.**'),
  );

  unimplemented(
    'rule-failure.SupersedingNoteWritten.3',
    `nothing checks that a supersedes id names an existing note; the convention is ${UNTRACKED}`,
    () => expectTrackedInstruction('write a *new* note that references the old one'),
  );

  unimplemented('rule-entity-creation.SupersedingNoteWritten.1', UNTRACKED, () =>
    expectTrackedInstruction(
      'create `MEM-2026-04-09-wheat-correction-claim-types` with `supersedes: [MEM-2026-04-06-wheat-technical-decision-framework]` and the corrected content',
    ),
  );
});

describe('MemoryNoteSupersedes', () => {
  unimplemented('rule-success.MemoryNoteSupersedes', NEVER_SET, () =>
    expectTrackedInstruction('These may be updated as new related notes are created or the note is superseded.'),
  );

  unimplemented('rule-failure.MemoryNoteSupersedes.1', UNTRACKED, () =>
    expectTrackedInstruction('Its successor points at it through `supersedes`.'),
  );
});

describe('SynthesisNoteSupersedes', () => {
  unimplemented(
    'rule-success.SynthesisNoteSupersedes',
    `${NEVER_SET}; the synthesis steps do not mention supersedes at all`,
    () => expectTrackedInstruction('**The only mutable frontmatter fields are `links:` and `superseded_by:`.**'),
  );

  unimplemented('rule-failure.SynthesisNoteSupersedes.1', UNTRACKED, () =>
    expectTrackedInstruction('*Grow-only applies to finalised notes only.*'),
  );
});

describe('invariants', () => {
  unimplemented(
    'invariant.LinksResolve',
    `nothing checks links; they hold because notes are never deleted and links come from search results, ${UNTRACKED}`,
    () => expectTrackedInstruction('**Never delete a note.** Supersession is the only retirement mechanism.'),
  );

  unimplemented(
    'invariant.NoNewLinksToSuperseded',
    `code only keeps superseded notes out of link candidates (superseded.test.ts); the rule itself is ${UNTRACKED}`,
    () => expectTrackedInstruction('**A superseded note takes no new links.**'),
  );

  unimplemented(
    'invariant.SynthesisesResolve',
    'no instruction, tracked or not, mentions the synthesises: field, and nothing checks it',
    () => expectTrackedInstruction('`synthesises:`', NOWHERE),
  );

  unimplemented('invariant.SupersessionRecordedOnBothSides', NEVER_SET, () =>
    expectTrackedInstruction('Set `supersedes: [old-id]` on the new note.'),
  );
});
