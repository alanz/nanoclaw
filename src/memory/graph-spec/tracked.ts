/**
 * Much of memory-graph.allium is carried by the main agent's standing
 * instructions, not by code, and those instructions live in the group folder
 * (groups/<folder>/instructions.prepend.md), which is gitignored. An
 * `instructed` claim must cite a tracked file, so such obligations are
 * claimed `unimplemented` instead, with a body that looks for the instruction
 * in every git-tracked source and instruction file — and fails, because only
 * the untracked group file says it.
 *
 * Once the instruction moves into a tracked file (a template under
 * container/skills/, say), the body passes, the expected failure fails, and
 * the claim must become `instructed` against that file.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { expect } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HERE = path.relative(REPO, path.dirname(fileURLToPath(import.meta.url)));

/** The main agent's standing instructions on this install (gitignored). */
export const MAIN_INSTRUCTIONS = 'groups/dm-with-alanz/instructions.prepend.md';
/** The weekly synthesis scan: a scheduled task (recurrence + pre-check script) in a session DB. */
export const SCAN_TASK = "the synthesis-scan task row in the main group's session inbound.db";
/** Not stated anywhere, tracked or not. */
export const NOWHERE = 'no instruction at all';

let corpus: Array<{ file: string; text: string }> | null = null;

/** Every git-tracked text file an instruction could live in; specs, docs and tests excluded. */
function trackedCorpus(): Array<{ file: string; text: string }> {
  if (corpus) return corpus;
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf-8' })
    .split('\0')
    .filter(Boolean)
    .filter((f) => /\.(md|ts|mjs|js|json|sh)$/.test(f))
    .filter((f) => !/\.test\.(ts|mjs|js)$/.test(f))
    .filter((f) => !f.startsWith('specs/') && !f.startsWith('docs/') && !f.startsWith(HERE + '/'))
    .filter((f) => f !== 'CLAUDE.md' && f !== 'AGENTS.md');
  // A tracked file deleted in the working tree has nothing to say.
  corpus = files
    .filter((file) => fs.existsSync(path.join(REPO, file)))
    .map((file) => ({ file, text: fs.readFileSync(path.join(REPO, file), 'utf-8') }));
  return corpus;
}

/**
 * Expect a git-tracked file to state `phrase`. Fails (the point of an
 * `unimplemented` claim) while it is only in `untrackedHome` — the untracked
 * instructions by default, the synthesis-scan task (SCAN_TASK), or nowhere.
 */
/** The git-tracked source and instruction files that state `phrase` verbatim. */
export function trackedFilesStating(phrase: string): string[] {
  return trackedCorpus()
    .filter((f) => f.text.includes(phrase))
    .map((f) => f.file);
}

export function expectTrackedInstruction(phrase: string, untrackedHome: string = MAIN_INSTRUCTIONS): void {
  const hits = trackedFilesStating(phrase);
  expect(hits, `no git-tracked file states "${phrase}" (today it is in: ${untrackedHome})`).not.toEqual([]);
}
