/**
 * Propagated from specs/memory-graph.allium — the synthesis workflow:
 * SynthesisCandidatesScanned, SynthesisCandidateDeclined,
 * SynthesisDraftCreated, SynthesisNoteFinalised,
 * SynthesisCandidateSynthesised and the SynthesisCandidate.disposition graph.
 *
 * None of it is code. The weekly scan is a scheduled task whose pre-check
 * script (ranking, thresholds, resurfacing, recording `surfaced`) is stored
 * in the main group's session DB; the dispositions the operator gives, the
 * drafts and the final note are the main agent's untracked standing
 * instructions. Every claim is `unimplemented` (see ./tracked.ts).
 * (rule-failure.SynthesisCandidatesScanned.1 is in ./isolation.test.ts.)
 */
import { describe } from 'vitest';

import { unimplemented } from './harness.js';
import { expectTrackedInstruction, NOWHERE, SCAN_TASK } from './tracked.js';

const UNTRACKED = 'only in the untracked groups/dm-with-alanz/instructions.prepend.md';
const SCAN_SCRIPT =
  "only in the synthesis-scan task's pre-check script, stored in the main group's session inbound.db (not tracked)";
const NO_SYN_FORMAT =
  'no instruction, tracked or not, gives the SYN note format (synthesises:, the "synthesis" tag, sources unsuperseded); the untracked groups/dm-with-alanz/instructions.prepend.md names only its path';

describe('SynthesisCandidate.disposition', () => {
  unimplemented('transition-edge.SynthesisCandidate.surfaced.declined', UNTRACKED, () =>
    expectTrackedInstruction('he declines a candidate (not worth a synthesis, or not now and not later)'),
  );

  unimplemented('transition-edge.SynthesisCandidate.surfaced.synthesised', UNTRACKED, () =>
    expectTrackedInstruction('- a SYN note is finalised for a candidate → `synthesised`'),
  );

  unimplemented('transition-edge.SynthesisCandidate.synthesised.surfaced', SCAN_SCRIPT, () =>
    expectTrackedInstruction('offered again only once it has grown by half', SCAN_TASK),
  );

  unimplemented('transition-rejected.SynthesisCandidate.disposition', SCAN_SCRIPT, () =>
    expectTrackedInstruction('const REGROWTH = 1.5;', SCAN_TASK),
  );

  unimplemented('transition-terminal.SynthesisCandidate.disposition', SCAN_SCRIPT, () =>
    expectTrackedInstruction('declined    — Alan said no; never offered again', SCAN_TASK),
  );
});

describe('SynthesisCandidatesScanned', () => {
  unimplemented('rule-success.SynthesisCandidatesScanned', SCAN_SCRIPT, () =>
    expectTrackedInstruction('// Weekly synthesis-candidate scan — pre-task gate.', SCAN_TASK),
  );

  unimplemented('rule-failure.SynthesisCandidatesScanned.2', SCAN_SCRIPT, () =>
    expectTrackedInstruction('Wakes the agent only when something is eligible.', SCAN_TASK),
  );
});

describe('SynthesisCandidateDeclined', () => {
  unimplemented('rule-success.SynthesisCandidateDeclined', UNTRACKED, () =>
    expectTrackedInstruction('`declined`; it is never offered again'),
  );

  unimplemented(
    'rule-failure.SynthesisCandidateDeclined.1',
    `nothing requires a record to exist before declining; the jq recipe that writes one is ${UNTRACKED}`,
    () => expectTrackedInstruction("'.items[$k] = ((.items[$k] // {}) + {disposition: $d, at: $at})'"),
  );

  unimplemented(
    'rule-failure.SynthesisCandidateDeclined.2',
    `nothing requires the record to be surfaced before declining; ${UNTRACKED}`,
    () => expectTrackedInstruction('When Alan answers a scan, record his decision:'),
  );
});

describe('SynthesisDraftCreated', () => {
  unimplemented('rule-success.SynthesisDraftCreated', UNTRACKED, () =>
    expectTrackedInstruction('1. **Draft** — write to `zettel/drafts/DRAFT-SYN-YYYY-MM-DD-{slug}-v1.md`.'),
  );

  unimplemented(
    'rule-failure.SynthesisDraftCreated.1',
    `nothing checks that the source notes exist; drafting is ${UNTRACKED}`,
    () => expectTrackedInstruction('*Naming:* `DRAFT-SYN-YYYY-MM-DD-{slug}-v{N}.md`'),
  );
});

describe('SynthesisNoteFinalised', () => {
  unimplemented('rule-success.SynthesisNoteFinalised', UNTRACKED, () =>
    expectTrackedInstruction('3. **Finalise** — once Alan approves, write the final note to'),
  );

  unimplemented(
    'rule-failure.SynthesisNoteFinalised.1',
    `nothing checks that the source notes exist; finalising is ${UNTRACKED}`,
    () => expectTrackedInstruction('2. **Review** — share the draft with Alan in chat.'),
  );

  unimplemented('rule-failure.SynthesisNoteFinalised.2', NO_SYN_FORMAT, () =>
    expectTrackedInstruction('synthesis sources must not be superseded', NOWHERE),
  );

  unimplemented('rule-entity-creation.SynthesisNoteFinalised.1', NO_SYN_FORMAT, () =>
    expectTrackedInstruction('id: SYN-YYYY-MM-DD-{slug}', NOWHERE),
  );
});

describe('SynthesisCandidateSynthesised', () => {
  unimplemented('rule-success.SynthesisCandidateSynthesised', UNTRACKED, () =>
    expectTrackedInstruction('a SYN note is finalised for a candidate → `synthesised`'),
  );

  unimplemented(
    'rule-failure.SynthesisCandidateSynthesised.1',
    `a synthesis asked for outside a scan touches no record only by ${UNTRACKED}`,
    () => expectTrackedInstruction('records each candidate the scan has dealt with'),
  );

  unimplemented(
    'rule-failure.SynthesisCandidateSynthesised.2',
    `nothing requires a record to exist; the jq recipe creates one (${UNTRACKED})`,
    () => expectTrackedInstruction('Keep any `count` already in the entry.'),
  );

  unimplemented(
    'rule-failure.SynthesisCandidateSynthesised.3',
    `nothing requires the record to be surfaced (a declined one can be overwritten); ${UNTRACKED}`,
    () => expectTrackedInstruction("Never edit the file's `offered` field."),
  );
});
