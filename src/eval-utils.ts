/**
 * Shared utilities for skill evaluation.
 * Used by scripts/eval-skill.ts (CLI) and the run_skill_eval IPC handler (chat-triggered evals).
 */

import Anthropic from '@anthropic-ai/sdk';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { RegisteredGroup } from './types.js';

const anthropic = new Anthropic();

export type AssertionResult = {
  text: string;
  passed: boolean | null;
  evidence: string;
};

/**
 * Creates a temp copy of a group folder so runContainerAgent mounts the snapshot
 * rather than the live folder. Eval writes (logs, outputs) are discarded on cleanup.
 *
 * NOTE: if the group folder contains large read-only directories (e.g. zotero-md/)
 * the cpSync can be slow. Consider excluding them if the skill doesn't need them.
 */
export function snapshotGroup(targetGroup: RegisteredGroup): {
  evalGroup: RegisteredGroup;
  snapDir: string;
  cleanup: () => void;
} {
  // Random suffix prevents collisions when two evals run concurrently.
  // Must satisfy isValidGroupFolder(): ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$
  const tempFolder = `eval-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const realDir = resolveGroupFolderPath(targetGroup.folder);
  const snapDir = resolveGroupFolderPath(tempFolder);

  cpSync(realDir, snapDir, { recursive: true });

  // Strip prior eval results so the agent can't see its own test history and
  // alter its responses to match expected outputs.
  const snapEvalsDir = join(snapDir, 'evals');
  if (existsSync(snapEvalsDir))
    rmSync(snapEvalsDir, { recursive: true, force: true });

  const evalGroup: RegisteredGroup = { ...targetGroup, folder: tempFolder };

  const cleanup = () => {
    rmSync(snapDir, { recursive: true, force: true });
    const ipcDir = resolveGroupIpcPath(tempFolder);
    if (existsSync(ipcDir)) rmSync(ipcDir, { recursive: true, force: true });
  };

  return { evalGroup, snapDir, cleanup };
}

/**
 * Grades a list of plain-text assertions against an agent output using an LLM.
 * Returns an AssertionResult per assertion. Falls back to passed=null on error.
 *
 * @param outputsDir  Directory of files written by the agent. Pass '' to skip.
 * @param expectedOutput  Human-readable description of success (for grading context).
 */
export async function gradeAssertions(
  output: string,
  outputsDir: string,
  assertions: string[],
  expectedOutput = '',
): Promise<AssertionResult[]> {
  if (assertions.length === 0) return [];

  const outputFiles =
    outputsDir && existsSync(outputsDir) ? readdirSync(outputsDir) : [];

  const gradingPrompt = `Grade each assertion about an AI assistant's output.
Return a JSON array only, no other text.

Expected output: ${expectedOutput}
Actual output:
${output}
Output files produced: ${outputFiles.length > 0 ? outputFiles.join(', ') : '(none)'}

Assertions:
${assertions.map((a, i) => `${i + 1}. ${a}`).join('\n')}

Return: [{"text":"<assertion>","passed":true/false,"evidence":"<one sentence of concrete evidence>"}]`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: gradingPrompt }],
    });
    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]) as AssertionResult[];
  } catch {
    /* fall through */
  }

  return assertions.map((text) => ({
    text,
    passed: null,
    evidence: 'Grading failed — manual review needed',
  }));
}
