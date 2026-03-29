---
name: add-embedding
description: Configure Gemini-powered semantic embedding and hybrid search for NanoClaw groups. Sets up MEMORY_SEARCH_* vars in .env, verifies sqlite-vec, rebuilds, and confirms indexing is running. Required foundation for add-amem and add-researcher.
---

# Add Embedding (Semantic Memory Search)

This skill configures the Gemini embedding backend that powers `memory_search`, `memory_get`, and `memory_list` inside agent containers. It indexes markdown and org-mode files from group directories and any extra paths you configure, then serves hybrid (semantic + full-text) search results to agents at runtime.

**Principle:** Read current state before touching anything. Only write `.env` keys that aren't already set correctly. Never overwrite a key the user has already customised without asking.

## 1. Check current state

Read `.env` and extract the current `MEMORY_SEARCH_*` values:

```bash
grep -E "^MEMORY_SEARCH_" .env 2>/dev/null || echo "(none set)"
```

- If `MEMORY_SEARCH_ENABLED=true` and `MEMORY_SEARCH_GEMINI_API_KEY` is set → embedding is already configured. Tell the user and offer two options:
  - **Re-configure** — continue through the steps to update settings
  - **Done** — exit the skill

## 2. Get a Gemini API key

If no key is set (or the user chose to re-configure), ask:

> To use semantic search, NanoClaw needs a Google Gemini API key. You can get a free key from https://aistudio.google.com/apikey — the `gemini-embedding-001` model is included in the free tier (100 requests/minute, 1,000 requests/day).
>
> Paste your Gemini API key:

Wait for the user to paste the key. It should start with `AIza`. If it looks like an Anthropic key (`sk-ant-`) or anything else unexpected, point it out and ask again.

## 3. Choose extra paths to index (optional)

The embedding system always indexes the group's own directory (`groups/{folder}/`). It can also index additional directories — useful for org-mode notes, Zotero exports, or any external knowledge base.

AskUserQuestion: Do you want to index any extra directories beyond your group folders?

- **No** — continue
- **Yes** — ask for one or more absolute paths (comma-separated or one per line), e.g.:
  - `~/notes` — personal org/markdown notes
  - `~/Documents/papers` — PDF-extracted text
  - Any path reachable from the host (not inside the container)

  Resolve `~` to `$HOME`. Confirm each path exists:
  ```bash
  ls <path> 2>&1 | head -5
  ```
  Warn (but don't block) if a path doesn't exist yet — it can be created later.

## 4. Configure rate limits

The Gemini free tier allows **100 requests/minute** and **1,000 requests/day**. Paid tiers are higher.

AskUserQuestion: Which Gemini API tier are you on?

- **Free tier** — RPM=100, RPD session budget=800. The session budget is kept under the daily cap so multiple NanoClaw restarts don't exhaust the quota in one day.
- **Paid tier** — ask for their actual RPM quota if they know it; otherwise use RPM=1000, no RPD cap (set budget=99999).
- **Not sure** — use free-tier defaults.

## 5. Write .env

Write the following keys to `.env`. For each key, check if it's already present:
- If present and correct → skip
- If present with a different value → overwrite (show the user what changed)
- If absent → append

```
MEMORY_SEARCH_ENABLED=true
MEMORY_SEARCH_GEMINI_API_KEY=<key from step 2>
MEMORY_SEARCH_MODEL=gemini-embedding-001
MEMORY_SEARCH_EXTRA_PATHS=<comma-separated absolute paths from step 3, or omit if none>
MEMORY_SEARCH_MAX_RESULTS=6
MEMORY_SEARCH_MIN_SCORE=0.35
MEMORY_SEARCH_RPM_LIMIT=<from step 4>
MEMORY_SEARCH_RPD_SESSION_BUDGET=<from step 4>
```

Use a targeted sed/append approach — don't rewrite the entire `.env`. Pattern for each key:

```bash
sed -i '' '/^MEMORY_SEARCH_ENABLED=/d' .env && echo 'MEMORY_SEARCH_ENABLED=true' >> .env
```

Repeat for each key. Show a summary of what was written.

## 6. Build and restart

```bash
npm run build
```

If the build fails, read the error and fix it before proceeding.

Then restart NanoClaw so it picks up the new `.env`:

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw
```

Wait 5 seconds for startup, then tail the log to confirm the memory manager initialised:

```bash
sleep 5 && grep -i "memory\|sqlite-vec\|embed" logs/nanoclaw.log | tail -20
```

Look for:
- `sqlite-vec loaded` — vector search is active (full hybrid mode)
- `Memory index manager initialized` — manager is running and watching files
- `Memory sync complete` — initial index pass finished (may take a minute for large collections)

If you see `sqlite-vec failed to load, using FTS fallback` — that's acceptable. The system falls back to keyword-only search. It still works, just without semantic ranking. Tell the user.

If you see `Memory search enabled but MEMORY_SEARCH_GEMINI_API_KEY not set` — the key wasn't written correctly. Re-check step 5.

## 7. Verify with a test search

Check the index DB directly to confirm files were indexed:

```bash
sqlite3 store/*/embeddings.db "SELECT COUNT(*) FROM chunks;" 2>/dev/null || echo "DB not yet created"
```

- If count > 0 → tell the user how many chunks are indexed.
- If count = 0 and the DB exists → sync may still be in progress. Check logs again in 30 seconds.
- If DB doesn't exist yet → normal within the first minute of startup; the manager runs its first sync shortly after init.

## 8. Done

Tell the user:

- What was configured (key tier, extra paths, rate limits)
- How many chunks are indexed (if available)
- That agents in all groups now have `memory_search`, `memory_get`, and `memory_list` available via MCP
- Next steps: run `/add-amem` to add A-Mem note-writing conventions, or `/add-researcher` to set up the researcher sub-agent

## Troubleshooting

**`MEMORY_SEARCH_GEMINI_API_KEY not set` in logs after restart:**
The key must be in `.env`, not in environment variables. Verify:
```bash
grep MEMORY_SEARCH_GEMINI_API_KEY .env
```

**Rate limit 429 errors in logs:**
Reduce `MEMORY_SEARCH_RPM_LIMIT` (try 50) or `MEMORY_SEARCH_RPD_SESSION_BUDGET` (try 400). Re-run step 5 to update, then restart.

**`sqlite-vec failed to load` on every restart:**
The `sqlite-vec` npm package is pre-installed. If native module load fails, rebuild:
```bash
npm rebuild sqlite-vec
```
Requires Node 18+: `node --version`.

**Indexing stops partway through:**
You've likely hit the daily RPD quota. The system sets `dirty=true` and retries on the next startup automatically. Look for `RPD session budget exhausted` in the logs.
