---
name: add-amem
description: Set up A-MEM agentic memory note-taking for a NanoClaw group. Creates memory/notes/ directory, verifies embedding is configured, and activates the amem container skill. Requires add-embedding to be run first.
---

# Add A-MEM Note-Taking

This skill activates A-MEM for a group. Once set up, the agent inside that group will:
- Write structured notes to `memory/notes/MEM-YYYY-MM-DD-{slug}.md`
- Search for related notes before creating new ones (deduplication + link graph)
- Apply quality conventions: original sources, falsification conditions, verbatim rationale

The `amem` container skill is already built into NanoClaw — this skill just ensures the directory and index are ready.

## 1. Check prerequisite: embedding

```bash
grep -E "^MEMORY_SEARCH_ENABLED=true" .env 2>/dev/null && grep -E "^MEMORY_SEARCH_GEMINI_API_KEY=.+" .env 2>/dev/null && echo "OK" || echo "NOT CONFIGURED"
```

If not configured → tell the user to run `/add-embedding` first, then stop.

## 2. Choose target group

List available groups:

```bash
ls groups/
```

AskUserQuestion: Which group do you want to enable A-MEM for? (Show the list of folders. Allow "all" to set up every group at once.)

## 3. Create memory/notes directory

For each target group, create the notes directory if it doesn't exist:

```bash
mkdir -p groups/<folder>/memory/notes
```

Check if any notes already exist:

```bash
ls groups/<folder>/memory/notes/ 2>/dev/null | head -10 || echo "(empty)"
```

If notes already exist, tell the user how many and continue.

## 4. Verify the container skill is present

```bash
ls container/skills/amem/SKILL.md
```

If missing — this is unexpected. The skill file should be part of the repo. Check if it got removed:

```bash
git log --oneline -- container/skills/amem/SKILL.md | head -5
```

If it was deleted, restore it:

```bash
git checkout HEAD -- container/skills/amem/SKILL.md
```

## 5. Check indexing

Verify the group directory is being watched by the memory index. Check the running index DB:

```bash
sqlite3 store/<folder>/embeddings.db "SELECT COUNT(*) FROM files WHERE path LIKE 'memory/notes/%';" 2>/dev/null || echo "DB not yet initialised"
```

- If notes exist but count is 0 → the index hasn't caught up yet. Tell the user indexing runs within a few seconds of file changes; they can trigger a re-check by restarting NanoClaw or waiting for the next periodic sync (daily).
- If DB doesn't exist yet → normal on first use. It initialises on the next agent session.

## 6. Done

Tell the user:

- A-MEM is active for the group(s). The `amem` skill loads automatically when the agent container starts.
- Notes will appear in the dashboard graph view under Groups → {group name} → Graph tab once any notes exist.
- The agent will search `memory/notes/` before creating new notes and maintain bidirectional links.
- Next step: run `/add-researcher` to set up the researcher sub-agent with its own identity files and isolated intake group.

## Notes on the web UI graph

The dashboard graph tab (`/api/notes-graph?group=<folder>`) reads all `memory/notes/MEM-*.md` files and renders them as a force-directed graph. Nodes are colour-coded by dominant tag; edges come from the `links:` frontmatter field. No extra configuration needed — it activates as soon as notes exist.
