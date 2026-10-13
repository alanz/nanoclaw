# Memory index remediation — proposal

Status: **proposal, for review** (2026-10-13). Nothing below is implemented
except where marked _done_. The spec section is a draft for the owner's
approval; `specs/memory.allium` is unchanged.

## Why

A v1-vs-v2 audit found the per-group memory index (`data/v2-memory/<group>/index.db`,
2.5 GB for Andy) carrying drift nobody could see:

| Finding (live, 2026-10-13)                                                                          | Count                  |
| --------------------------------------------------------------------------------------------------- | ---------------------- |
| `chunks_vec` rows with no chunk                                                                     | 12,334 of 26,238 (47%) |
| `embedding_cache` rows no chunk uses                                                                | 4,907 of 18,781        |
| v1 `meta` rows v2 never reads (`memory_index_meta_v1`, `memory_index_config_v1` with v1 host paths) | 2                      |
| free pages                                                                                          | ~205 MB                |
| central `memory_files` rows stuck at `pending` / `removed` tombstones; `memory_chunks` rows         | 1,412 / 589 / 0        |

Every stored path in `index.db` resolves on disk; the stale paths are only the
589 central tombstones and the v1 `meta` row.

### Where the design came from

Three layers, each a port of the one before:

- **OpenClaw** (v1 commit 55d0190, 2026-03-22, from openclaw 2026.1.30). A
  coherent design: `meta` compared on every sync against model, provider,
  provider key, chunking and vector dims, full re-index on mismatch, built in a
  temp DB and swapped in; vec0 writes as delete-then-`INSERT` (its fix #1151,
  since vec0 does not honour `INSERT OR REPLACE`); `chunks.embedding` is the
  input to a cosine fallback when sqlite-vec is missing, not a source of truth;
  cache pruning existed but was off by default. Its own live index has 0 orphan
  vectors.
- **v1** kept the schema and dropped the upkeep: `meta` never compared; its own
  fingerprint (0c987da) made pointless two days later by a forced full sync at
  every start (82ea92d, meant as "sync now"); `INSERT OR REPLACE` into vec0;
  every vec0 failure in an empty `catch`; no cache pruning; `provider_key`
  always `''`.
- **v2** (cd2defcf, 2026-05-02) ported v1, kept the forced start, dropped the
  fingerprint, and stopped logging a failed sqlite-vec load. Its index was
  seeded by hand from v1's `embeddings.db` on 2026-05-06 (undocumented; the v1
  `meta` rows and v1-format chunk ids are the evidence). v1 had exactly one
  orphan vector; the other ~12.3k were created in v2 when the copied v1 paths
  were dropped and their vector deletes were skipped or swallowed — most likely
  sqlite-vec not loaded at the time. The exact event is not in the logs.
- The central `memory_files` / `memory_chunks` tables were generated from the
  spec (tests first, cde75ec3 / 152c49a1) before the real indexer existed; the
  indexer, written the same day, did its own indexing and calls the central
  rules only as `// Update central DB (spec compliance)`. `FileSynced`
  (pending → indexed), `memory_chunks` and the central get/list handlers were
  never wired. A spec-compliance shim, never the source of truth.

### What OpenClaw does today (main e5f45c0a, release 2026.10.3)

Per-file IMMEDIATE transactions with FTS kept by triggers; vec delete failures
set a persisted "vectors need rebuild" marker that forces a full shadow rebuild;
a fingerprint that adds sources, folder scope, chunking/format versions and
tokenizer (a _config_ mismatch pauses vector search until a manual `--force`);
cache capped at 50,000 by age, pruned after every sync; empty, non-finite and
wrong-dimension vectors rejected; aborting embedding timeouts (60 s query,
2 min batch) and retries on 5xx (×3) and 429 (×5); full re-index built in a
shadow DB and published by ATTACH + table replace in one transaction;
`chunks.embedding` kept, as a binary blob; VACUUM is a manual operator step.

## Decisions taken

- _Done_ (973be244): a full re-index at start only when the index fingerprint
  changed, not on every start.
- **Settings change → automatic full re-index** (not upstream's pause-and-warn),
  with logging and visibility on the dashboard (§4, §8).
- **Spec: Option A** — the memory entities are realised by `index.db`; the
  central tables are retired (draft edits below, awaiting approval).

## Proposed changes

Each item is its own commit on the memory patch, with tests that fail first.

### 1. Vector writes that cannot fail silently

- `insertChunk`: `DELETE FROM chunks_vec WHERE id = ?` then plain `INSERT`
  (OpenClaw #1151), replacing `INSERT OR REPLACE`.
- `deleteFileChunks` and the stale pass: no empty `catch`. A failed vec
  delete/insert is logged (`warn`, with path and error) and sets a persisted
  marker `meta.vector_state = needs_repair`.
- `openIndexDb`: log the sqlite-vec load error once (`warn`), and record it for
  the dashboard. While vec is unavailable, writes still record
  `needs_repair`, so vectors are repaired once it loads.

### 2. One transaction per file

`deleteFileChunks` + every `insertChunk` + `upsertFileRecord` for a file run in
one `db.transaction`, as does each stale-path removal. Embedding calls stay
outside the transaction. With `journal_mode=DELETE`, a container's read-only
reader sees each file either before or after, never half-written. Expected side
effect: a full pass becomes much faster (today every chunk row is its own
commit).

### 3. Vector repair pass (row-level, no API calls)

`repairVectors()`:

- deletes `chunks_vec` rows whose id is not in `chunks`;
- inserts the missing vector for any chunk without one, from `chunks.embedding`.

Runs at start when `meta.vector_state` is `needs_repair` or absent (absent =
unverified, so the first start after deploy removes today's 12,334 orphans),
and after every full re-index. Logs counts; sets `vector_state = clean`.
Upstream instead forces a full rebuild; row-level repair is cheaper here and
uses the same data.

### 4. Fingerprint completed; automatic re-index made visible

- Fingerprint gains `provider` (`gemini`), `providerKey` (hash of provider +
  model + endpoint base URL, also written to `embedding_cache.provider_key`
  instead of `''`) and `vectorDims`.
- `chunks_vec` is created with the stored dims; a dims change drops and
  recreates it (the full re-index then refills it).
- On mismatch: `warn` log naming each changed field (`old → new`), then the full
  re-index. Settings come from env/config read at manager start, so checking at
  start is equivalent to checking every sync; a settings change takes a restart.
- Recorded in `meta.last_full_reindex`: reason, started, finished, files,
  result (completed / interrupted — interrupted is retried at the next start, as
  now).
- Progress (files done / total) is exposed for the dashboard while it runs.

### 5. Embedding cache: reject bad vectors, prune what nothing uses

- Reject an embedding that is empty, has non-finite values, or does not match
  the expected dims: the batch fails, the file stays incomplete and is retried
  (never cached, never written).
- Prune cache rows whose hash no chunk uses **and** whose `updated_at` is older
  than 30 days (a grace window so an undone edit still hits the cache). Runs
  after a full re-index and once a day. Needs `CREATE INDEX idx_chunks_hash ON
chunks(hash)`. Rows under an old `provider_key` become unreachable after a
  provider change and age out the same way.
- Not adopted: upstream's age-only cap (it evicts rows still in use).

### 6. Gemini calls: timeouts and transient retries

- `AbortSignal.timeout`: 60 s for a query embed, 120 s for a batch.
- Retry 5xx and network errors up to 3 times, backoff 0.5 s → 8 s with jitter.
  429 handling (token bucket, RPD stop) unchanged.

### 7. One-off cleanup (falls out of 3 and 5, plus two small steps)

1. Back up `index.db` (explicit copy, besides the hourly borg run).
2. Deploy 1–6: the first start's repair pass drops the orphans; the first prune
   drops old unreferenced cache rows.
3. At start, delete the two v1 `meta` keys (logged).
4. VACUUM as a manual operator step while no container reads the index
   (`scripts/memory-vacuum.ts`: refuses while the host runs). Expected ~2.5 →
   ~1.8 GB; a one-time ~1.8 GB borg delta.

### 8. Dashboard (Memory Index panel)

`stats()` and `/api/memory-index` gain, per group:

- vector search: loaded / unavailable (with the load error);
- vector health: `clean` / `needs repair`, last repair (time, removed, added);
- fingerprint: stored vs current; a re-index in progress with files done/total;
  last full re-index (reason, when, result);
- last sync: indexed / skipped / removed / incomplete;
- cache rows (in use / unused), DB size and free pages.

The panel shows a warning line when vectors need repair, sqlite-vec failed to
load, or the last full re-index was interrupted.

## Not now

- **Temp-DB / shadow re-index.** Full re-indexes are now rare and per-file
  transactions + repair cover the drift; revisit if a re-index is ever
  interrupted in practice. If adopted, use upstream's ATTACH + table replace,
  not a file swap (safer for the read-only container mount), plus a sweep of
  leftovers.
- **Store embeddings as binary, not JSON** (upstream schema 23). JSON
  embeddings in `chunks` (699 MB) and the cache (951 MB) dominate the file; a
  float32 blob is ~4× smaller. A schema migration of `index.db`, so its own
  proposal after 1–8 land.

## Spec: the central `memory_files` / `memory_chunks` tables — Option A chosen

**Decision (2026-10-13): Option A** — `MemoryFile` and `MemoryChunk` are
realised by the group's `index.db`; the central tables are retired. Option B
(wire the full lifecycle into a second store nobody reads) was rejected.

Why the tables go: nothing reads them in production; status never reaches
`indexed`; `terminal: removed` (inherited from v1's spec, where no status was
ever stored) means a file re-created at a removed path is never tracked again;
the calls are un-awaited and run for every file on every sync.

### Draft spec edits — for approval, not yet applied to `specs/memory.allium`

1. **Header** (after "Ported from v1 …"), add:
   > MemoryFile and MemoryChunk are realised by the group's index
   > (data/v2-memory/<group>/index.db: `files`, `chunks`, with the FTS and vector
   > rows kept in step per file). There is no central copy. A file is `indexed`
   > when it has a `files` row; `pending` when the watcher or a sync has seen it
   > change but it is not yet (re)written — held in memory, not stored.
2. **Indexed mounts** — the spec never mentions them (ccf3e77b, 2026-10-03).
   Header roots gain: "plus any of the group's additional mounts marked
   `index`, stored under the path the container sees them at,
   `extra/<mount>/…`". `MemoryFilesWithinWorkspace` widens to: a path under
   `groups/<folder>/{memory,zettel,<registered folder>}/` **or**
   `extra/<mount>/…` for a mount marked `index` in the group's container config.
   (Today the org mount: 7,231 of the 8,643 indexed files.)
3. **`removed` stops being a stored status.** `MemoryFile.status: pending |
indexed`; transitions `pending -> indexed`, `indexed -> pending`.
   `FileRemoved` ensures `not exists file` (and its chunks) instead of
   `file.status = removed`; `requires: file.status in {…}` dropped. A file
   re-created at the same path is then discovered afresh by `FileDiscovered`
   (`requires: not exists …` already). `NoChunksForRemovedFiles` is dropped
   (vacuous: chunks belong to an existing file).
4. **Line 109**: the fallback when the vector index is unavailable is an
   in-process cosine scan over the stored embeddings, still hybrid with FTS —
   not keyword-only. (Keyword-only remains the outcome when the _query_ cannot
   be embedded: lines 190, 349, 361, unchanged.)
5. **Lines 132, 175, 318**: embeddings are cached per group (each group has its
   own index) and per model — "across groups" removed.
6. **New rule — settings change re-index** (§4), sketch:
   ```
   -- The index records the settings it was last fully built with: embedding
   -- provider, provider key, model, vector dims, chunk size and overlap, chunker
   -- version. When the host opens a group's index and they differ, every file
   -- returns to pending and is re-indexed; the settings are recorded only when a
   -- full pass reaches every file, so an interrupted pass is repeated at the next
   -- start. Unchanged settings: only files whose content changed are re-indexed.
   rule IndexSettingsChanged {
       when: MemoryIndexOpened(group, settings)
       requires: settings != group.memory_index.built_with
       ensures: for f in group.memory_files: f.status = pending
   }
   ```
   plus a `built_with` field on a per-group `MemoryIndex` entity (or on
   `AgentGroup` via the memory module). Exact shape settled when applied, with
   `allium check` clean.

### Code under A (after the spec edit is approved)

Drop the shim calls in `manager.ts` (`handleWorkspaceFileChanged` /
`handleWorkspaceFileRemoved`), `src/memory/rules.ts`, the central parts of
`src/memory/db.ts`, the dead `handleMemoryGet` / `handleMemoryList` in
`search.ts`, and the group-delete step in `src/modules/memory/group-delete.ts`;
a new central migration drops `memory_chunks` and `memory_files`. The tests
written against the central tables (`memory.test.ts` lifecycle cases) are
rewritten against `index.db`.

## Order

1 → 2 → 3 → 4 → 5 → 6 → 8, then deploy, verify the repair and prune counts
live, then 7.3–7.4. Option A's spec edit can be applied in parallel once
approved; its code removal lands after it.
