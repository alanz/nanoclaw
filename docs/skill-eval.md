# Skill Evaluation

NanoClaw's eval system lets you measure whether a container skill improves agent behaviour. Each eval case runs once **with** the skill and once **without**, then grades the output against plain-text assertions using an LLM grader. The result is a `benchmark.json` that summarises pass-rates, latency, and token counts for both variants.

Evals run inside the real NanoClaw container environment (custom prompts, MCP tools, `allowed-tools`) on an isolated snapshot of the target group folder, so results reflect production behaviour accurately.

## Writing evals

Create `container/skills/<skill-name>/evals/evals.json`:

```json
{
  "evals": [
    {
      "id": "basic",
      "prompt": "Summarise the document at /workspace/group/eval-inputs/doc.txt in three bullet points.",
      "expected_output": "Three concise bullet points covering the main topics of the document.",
      "assertions": [
        "Output contains exactly three bullet points",
        "Each bullet point is one sentence or fewer",
        "Output does not include raw markdown headers"
      ],
      "files": ["doc.txt"]
    }
  ]
}
```

**Fields:**

| Field             | Required | Description                                                      |
| ----------------- | -------- | ---------------------------------------------------------------- |
| `id`              | Yes      | Unique identifier for the case — used in output paths            |
| `prompt`          | Yes      | Prompt sent to the agent                                         |
| `expected_output` | No       | Human-readable success description, used as grading context      |
| `assertions`      | No       | Plain-text statements graded true/false by the LLM grader        |
| `files`           | No       | Files to place at `/workspace/group/eval-inputs/` before the run |

Input files are resolved relative to the skill's own directory (`container/skills/<skill-name>/`), or as absolute paths. The agent can read them at `/workspace/group/eval-inputs/` and write results to `/workspace/group/eval-outputs/`.

## Running evals from the CLI

```bash
npx tsx scripts/eval-skill.ts --skill <name>
```

Options:

| Flag               | Default             | Description                                    |
| ------------------ | ------------------- | ---------------------------------------------- |
| `--skill <name>`   | (required)          | Skill directory name under `container/skills/` |
| `--group <folder>` | main group          | Group folder to snapshot for the run           |
| `--output <dir>`   | `groups/main/evals` | Base directory for results                     |
| `--iteration <n>`  | auto-increment      | Force a specific iteration number              |

Each run appends an `iteration-N` directory rather than overwriting previous results.

## Understanding the output

```
groups/main/evals/<skill>/
  iteration-1/
    benchmark.json          ← aggregate pass-rates, timing, tokens
    feedback.json           ← empty slots for human review notes
    eval-<id>/
      with_skill/
        grading.json        ← per-assertion pass/fail + evidence
        timing.json         ← duration_ms, total_tokens
        outputs/            ← files the agent wrote to eval-outputs/
      without_skill/
        grading.json
        timing.json
        outputs/
```

**`benchmark.json` summary block:**

```json
{
  "run_summary": {
    "with_skill":    { "pass_rate": { "mean": 0.9, "stddev": 0.1 }, ... },
    "without_skill": { "pass_rate": { "mean": 0.5, "stddev": 0.2 }, ... },
    "delta":         { "pass_rate": 0.4, "time_seconds": -2.1, "tokens": 800 }
  }
}
```

A positive `delta.pass_rate` means the skill improved correctness. A negative `delta.time_seconds` means it made the agent faster.

## Running evals from chat (skill_eval MCP tool)

The `skill_eval` tool is available inside the main group container agent. Ask your assistant to evaluate a skill directly from chat:

> "Evaluate the `summarise` skill with prompt: 'Summarise doc.txt in three bullets.' Assert: output has exactly three bullets."

The agent calls `skill_eval` with:

- `skill_name` — name of the skill to test
- `case_id` — a label for this run
- `prompt` — the test prompt
- `with_skill` — `true` runs with the skill; `false` runs the baseline without it
- `assertions` — array of `{ text: "..." }` objects
- `timeout_ms` — optional, default 120 000 ms

The tool fires off a container run via IPC and returns the graded results once complete (up to 180 s). Results are **not** written to the group's `evals/` directory — they are returned inline. Use the CLI script for persistent, versioned eval records.

## Iteration workflow

1. Write initial `evals.json` for your skill.
2. Run `npx tsx scripts/eval-skill.ts --skill <name>` (creates `iteration-1`).
3. Review `benchmark.json`. Fill in `feedback.json` with any observations.
4. Improve the skill's `SKILL.md` based on failing cases.
5. Re-run — the script auto-increments to `iteration-2`, preserving the history.
6. Compare iterations to confirm the skill is improving.

If [skill-creator](https://claude.com/plugins/skill-creator) is installed, its `grader`, `comparator`, and `analyzer` agents can process the iteration directory automatically.
