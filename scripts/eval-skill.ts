#!/usr/bin/env npx tsx
/**
 * Skill evaluator for NanoClaw.
 * Runs eval cases through runContainerAgent so each case executes in the real
 * NanoClaw container environment (custom prompts, MCP tools, allowed-tools, etc.).
 *
 * Each run gets a cpSync snapshot of the target group folder so the real folder
 * is never touched. Snapshots are deleted after each run.
 *
 * Output format is compatible with skill-creator's grader/comparator agents.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ChildProcess } from 'child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { runContainerAgent, ContainerInput } from '../src/container-runner.js';
import { getAllRegisteredGroups } from '../src/db.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from '../src/group-folder.js';
import { RegisteredGroup } from '../src/types.js';

const SKILLS_DIR = join(process.cwd(), 'container', 'skills');
const anthropic = new Anthropic();

// --- Helpers ---

function loadEvals(skillName: string) {
  const p = join(SKILLS_DIR, skillName, 'evals', 'evals.json');
  if (!existsSync(p)) throw new Error(`No evals found at ${p}`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function nextIteration(baseDir: string): number {
  let i = 1;
  while (existsSync(join(baseDir, `iteration-${i}`))) i++;
  return i;
}

function mean(arr: number[]): number | null {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr)!;
  return Math.sqrt(arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / arr.length);
}

// --- Group snapshot ---

// Creates a temp copy of the target group folder under GROUPS_DIR so that
// runContainerAgent mounts the snapshot, not the real folder. Temp folder name
// must satisfy isValidGroupFolder(): ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$
//
// NOTE: if the group folder contains large directories (e.g. zotero-md/ with
// 675+ files), the cpSync can be slow and disk-heavy. Consider excluding bulk
// read-only data directories that the skill under test doesn't need.
function snapshotGroup(targetGroup: RegisteredGroup): {
  evalGroup: RegisteredGroup;
  snapDir: string;
  cleanup: () => void;
} {
  // Include a random suffix to avoid collisions if two evals run concurrently
  const tempFolder = `eval-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const realDir = resolveGroupFolderPath(targetGroup.folder);
  const snapDir = resolveGroupFolderPath(tempFolder); // validated, within GROUPS_DIR

  cpSync(realDir, snapDir, { recursive: true });

  // Strip eval results from the snapshot. The agent must not see its own test
  // history during a run — previous grading.json / feedback.json files could
  // influence its responses and invalidate the eval.
  const snapEvalsDir = join(snapDir, 'evals');
  if (existsSync(snapEvalsDir)) rmSync(snapEvalsDir, { recursive: true, force: true });

  const evalGroup: RegisteredGroup = { ...targetGroup, folder: tempFolder };

  const cleanup = () => {
    rmSync(snapDir, { recursive: true, force: true });
    // Clean up any IPC state the container created under data/ipc/<tempFolder>/
    const ipcDir = resolveGroupIpcPath(tempFolder);
    if (existsSync(ipcDir)) rmSync(ipcDir, { recursive: true, force: true });
  };

  return { evalGroup, snapDir, cleanup };
}

// --- Eval execution ---

async function runEvalCase(
  targetGroup: RegisteredGroup,
  prompt: string,
  skillName: string,
  withSkill: boolean,
  inputFiles: string[],
  outputsDir: string,
): Promise<{ output: string; durationMs: number; totalTokens?: number }> {
  // Input files and outputs must live inside the snapshot — it's the only
  // writable path the container has (/workspace/group/ → snapDir).
  // Host paths outside the snapshot (e.g. a bare tmpdir) are not mounted.
  const { evalGroup, snapDir, cleanup } = snapshotGroup(targetGroup);
  mkdirSync(outputsDir, { recursive: true });

  const snapInputsDir = join(snapDir, 'eval-inputs');
  const snapOutputsDir = join(snapDir, 'eval-outputs');
  mkdirSync(snapInputsDir, { recursive: true });
  mkdirSync(snapOutputsDir, { recursive: true });

  // Reserved for potential timeout cleanup (e.g. sending SIGTERM on deadline).
  let _containerProc: ChildProcess | undefined; // eslint-disable-line @typescript-eslint/no-unused-vars

  try {
    // Place input files under snapDir so they appear at /workspace/group/eval-inputs/
    for (const filePath of inputFiles) {
      const src = [filePath, join(SKILLS_DIR, skillName, filePath)].find(existsSync);
      if (src) copyFileSync(src, join(snapInputsDir, basename(filePath)));
    }

    const input: ContainerInput = {
      prompt: `${prompt}\n\nInput files are in /workspace/group/eval-inputs/. Save output files to /workspace/group/eval-outputs/.`,
      groupFolder: evalGroup.folder,
      chatJid: 'eval-internal',
      isMain: false, // isolated — no elevated privileges
      // no sessionId → fresh context, no chat history
      evalSkipSkills: withSkill ? [] : [skillName],
    };

    const start = Date.now();
    const containerOutput = await runContainerAgent(
      evalGroup,
      input,
      (proc, _containerName) => { _containerProc = proc; },
    );
    const durationMs = Date.now() - start;

    // Copy files the agent wrote to /workspace/group/eval-outputs/ to the real outputsDir.
    // Must happen before cleanup() deletes the snapshot.
    if (existsSync(snapOutputsDir)) {
      for (const f of readdirSync(snapOutputsDir)) {
        const src = join(snapOutputsDir, f);
        if (statSync(src).isFile()) copyFileSync(src, join(outputsDir, f));
      }
    }

    const output = containerOutput.result ?? containerOutput.error ?? '[no output]';
    return { output, durationMs, totalTokens: containerOutput.totalTokens };
  } finally {
    cleanup(); // delete snapshot + IPC dir (output copy already done above)
  }
}

// --- Assertion grading ---

async function gradeAssertions(
  output: string,
  outputsDir: string,
  assertions: string[],
  expectedOutput: string,
) {
  if (assertions.length === 0) return [];

  const outputFiles = existsSync(outputsDir) ? readdirSync(outputsDir) : [];

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
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch {
    /* fall through */
  }

  return assertions.map((text) => ({
    text,
    passed: null,
    evidence: 'Grading failed — manual review needed',
  }));
}

// --- Main loop ---

async function runEvals(
  skillName: string,
  targetGroup: RegisteredGroup,
  baseOutputDir: string,
  forceIteration?: number,
) {
  const { evals: cases = [] } = loadEvals(skillName);
  const iteration = forceIteration ?? nextIteration(baseOutputDir);
  const iterDir = join(baseOutputDir, `iteration-${iteration}`);

  console.log(
    `\nEvaluating skill '${skillName}' in group '${targetGroup.folder}' — iteration ${iteration}`,
  );
  console.log(`Output: ${iterDir}\n`);

  const withPassRates: number[] = [],
    withoutPassRates: number[] = [];
  const withTimes: number[] = [],
    withoutTimes: number[] = [];
  const withTokens: number[] = [],
    withoutTokens: number[] = [];

  for (const evalCase of cases) {
    const {
      id: caseId,
      prompt,
      expected_output: expectedOutput = '',
      assertions = [],
      files: inputFiles = [],
    } = evalCase;

    const caseDir = join(iterDir, `eval-${caseId}`);
    console.log(`Case ${caseId}`);

    for (const variant of ['with_skill', 'without_skill'] as const) {
      const isWith = variant === 'with_skill';
      const variantDir = join(caseDir, variant);
      const outputsDir = join(variantDir, 'outputs');

      process.stdout.write(`  ${variant}... `);
      const { output, durationMs, totalTokens } = await runEvalCase(
        targetGroup,
        prompt,
        skillName,
        isWith,
        inputFiles,
        outputsDir,
      );

      const assertionResults = await gradeAssertions(
        output,
        outputsDir,
        assertions,
        expectedOutput,
      );
      const passed = assertionResults.filter((r: { passed: boolean | null }) => r.passed === true).length;
      const failed = assertionResults.filter((r: { passed: boolean | null }) => r.passed === false).length;
      const total = assertionResults.length;
      const passRate = total > 0 ? passed / total : null;

      writeFileSync(
        join(variantDir, 'grading.json'),
        JSON.stringify(
          {
            assertion_results: assertionResults,
            summary: { passed, failed, total, pass_rate: passRate },
          },
          null,
          2,
        ),
      );

      writeFileSync(
        join(variantDir, 'timing.json'),
        JSON.stringify(
          {
            total_tokens: totalTokens ?? null,
            duration_ms: Math.round(durationMs),
          },
          null,
          2,
        ),
      );

      if (passRate !== null) {
        if (isWith) {
          withPassRates.push(passRate);
          withTimes.push(durationMs / 1000);
        } else {
          withoutPassRates.push(passRate);
          withoutTimes.push(durationMs / 1000);
        }
      }
      if (totalTokens != null) {
        if (isWith) withTokens.push(totalTokens);
        else withoutTokens.push(totalTokens);
      }

      console.log(passRate !== null ? `${(passRate * 100).toFixed(0)}% pass` : 'no assertions');
    }
  }

  const benchmark = {
    skill: skillName,
    group: targetGroup.folder,
    iteration,
    run_at: new Date().toISOString(),
    total_cases: cases.length,
    run_summary: {
      with_skill: {
        pass_rate: { mean: mean(withPassRates), stddev: stddev(withPassRates) },
        time_seconds: { mean: mean(withTimes), stddev: stddev(withTimes) },
        tokens: { mean: mean(withTokens), stddev: stddev(withTokens) },
      },
      without_skill: {
        pass_rate: { mean: mean(withoutPassRates), stddev: stddev(withoutPassRates) },
        time_seconds: { mean: mean(withoutTimes), stddev: stddev(withoutTimes) },
        tokens: { mean: mean(withoutTokens), stddev: stddev(withoutTokens) },
      },
      delta: {
        pass_rate:
          mean(withPassRates) !== null && mean(withoutPassRates) !== null
            ? mean(withPassRates)! - mean(withoutPassRates)!
            : null,
        time_seconds:
          mean(withTimes) !== null && mean(withoutTimes) !== null
            ? mean(withTimes)! - mean(withoutTimes)!
            : null,
        tokens:
          mean(withTokens) !== null && mean(withoutTokens) !== null
            ? mean(withTokens)! - mean(withoutTokens)!
            : null,
      },
    },
  };
  writeFileSync(join(iterDir, 'benchmark.json'), JSON.stringify(benchmark, null, 2));
  writeFileSync(
    join(iterDir, 'feedback.json'),
    JSON.stringify(
      Object.fromEntries(cases.map((c: { id: string }) => [c.id, ''])),
      null,
      2,
    ),
  );

  const w = benchmark.run_summary.with_skill.pass_rate.mean;
  const wo = benchmark.run_summary.without_skill.pass_rate.mean;
  const d = benchmark.run_summary.delta.pass_rate;
  console.log(`\nDone. Results: ${iterDir}`);
  if (w !== null && wo !== null && d !== null) {
    const sign = d >= 0 ? '+' : '';
    console.log(
      `Pass rate: ${(w * 100).toFixed(0)}% with skill vs ${(wo * 100).toFixed(0)}% without (Δ ${sign}${(d * 100).toFixed(0)}%)`,
    );
  }
  console.log(`\nNext steps:`);
  console.log(`  1. Fill in feedback.json with human review notes`);
  console.log(
    `  2. If skill-creator is installed, run its grader/comparator agents on ${iterDir}`,
  );
  console.log(
    `  3. Iterate: update SKILL.md, rerun (auto-increments to iteration-${iteration + 1})`,
  );
}

// --- CLI ---

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    skill: { type: 'string' },
    group: { type: 'string' }, // group folder name; defaults to main group
    output: { type: 'string', default: 'groups/main/evals' },
    iteration: { type: 'string' },
  },
});

if (!values.skill) {
  console.error(
    'Usage: npx tsx scripts/eval-skill.ts --skill <name> [--group <folder>] [--output <dir>] [--iteration <n>]',
  );
  process.exit(1);
}

// Resolve output to an absolute path so it works regardless of cwd
const outputBase = resolve(
  isAbsolute(values.output!) ? values.output! : join(process.cwd(), values.output!),
);

const allGroups = getAllRegisteredGroups();
const targetGroup = values.group
  ? Object.values(allGroups).find((g) => g.folder === values.group)
  : Object.values(allGroups).find((g) => g.isMain);

if (!targetGroup) {
  console.error(`Group '${values.group ?? 'main'}' not found in DB`);
  process.exit(1);
}

runEvals(
  values.skill!,
  targetGroup,
  join(outputBase, values.skill!),
  values.iteration ? parseInt(values.iteration, 10) : undefined,
).catch((err) => {
  console.error(err);
  process.exit(1);
});
