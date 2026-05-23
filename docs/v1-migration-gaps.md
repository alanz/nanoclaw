# V1 → V2 Migration Gaps

Features present in v1 (`~/nanoclaw`) that have not yet been brought over to v2.

---

## 1. RSS Feed Monitoring — Missing Entirely

**v1:** `src/rss-monitor.ts` — full RSS/Atom feed subscription system:
- Scheduled feed checking (cron or interval)
- Interest-based relevance filtering
- Feed state persistence and version tracking, max 500 GUIDs
- Integrated with task scheduler

**v2:** No equivalent module.

---

## 2. Session Warm-Start & User Profiling — Missing Entirely

**v1:** `src/session-warm-start.ts` — context assembly before each session:
- User profile lifecycle: absent → current → stale (8-day staleness threshold)
- Profile generation prompt + persistence at `/data/user-profile.json`
- Injects recent A-MEM notes by recency (Phase 2)
- Prior-session tail hybrid search for continuity (Phase 3)

**v2:** Not implemented anywhere in host or container setup.

---

## 3. Session Archiving (Throwaway Sessions) — Missing Entirely

**v1:** `src/ipc.ts` + `src/session-archiving.test.ts`:
- `spawnThrowaway()` spawns a summarisation agent when sessions grow long
- JSONL session storage and archive writing
- Retry logic: `MAX_THROWAWAY_RETRIES` (3), `THROWAWAY_CONTEXT_LIMIT_TOKENS` (80k), `THROWAWAY_MAX_INPUT_FRACTION` (0.33)
- DB-backed `ThrowawaySession` persistence

**v2:** No equivalent system.

---

## 4. Remote Control — Missing/Disabled

**v1:** `src/remote-control.ts`:
- `startRemoteControl()` / `stopRemoteControl()` / `restoreRemoteControl()`
- MCP tools: `start_remote_control`, `stop_remote_control`

**v2:** Only a stub reference in `command-gate.ts`; feature appears disabled.

---

## 5. Zotero Sync — Stub Only

**v1:** `src/zotero-monitor.ts` — full implementation:
- Scheduled polling (`ZOTERO_POLL_INTERVAL`)
- Config: `ZOTERO_GROUP_FOLDER`, `ZOTERO_CHAT_JID`, `ZOTERO_OUTPUT_DIR`
- Version tracking and state management

**v2:** `src/modules/zotero/` exists but only contains stubs (monitor, notify, schedule). No actual sync logic.

---

## 6. Advanced Memory System — Reduced

**v1:** `src/memory/` — hybrid memory with:
- Gemini embeddings (`embeddings-gemini.ts`, model `gemini-embedding-001`)
- BM25 + vector hybrid search
- Query expansion (`query-expansion.ts`)
- Org-mode chunking (`org-chunking.ts`)
- TPM/RPM rate limiting (`rate-limiter.ts`)
- Config: `MEMORY_SEARCH_ENABLED`, `MEMORY_SEARCH_GEMINI_API_KEY`, `MEMORY_SEARCH_MODEL`, `MEMORY_SEARCH_OUTPUT_DIMS` (3072), `MEMORY_SEARCH_TPM_LIMIT`, `MEMORY_SEARCH_RPM_LIMIT`, `MEMORY_SEARCH_GROUPS`

**v2:** `src/memory/` — basic embedding and chunking, no Gemini integration, no query expansion, no rate limiting.

---

## 7. MCP Tools — ~16 Missing

Tools in v1 (`container/agent-runner/src/ipc-mcp-stdio.ts`) not found in v2:

| Tool | Purpose |
|------|---------|
| `query_memory` | Hybrid memory query (BM25 + vector) |
| `memory_list` | List memory files |
| `submit_raw_memory` | Write raw memory entries |
| `search_zotero` | Search Zotero library |
| `list_failed_summaries` | List sessions that failed summarisation |
| `retry_session_summary` | Retry a failed session summary |
| `report_session` | Report session status to main group |
| `skill_eval` | Evaluate a skill |
| `webxdc_send_image` | Send image via WebXDC |
| `webxdc_update` | Update a WebXDC message |
| `query_transcript` | Advanced transcript querying |

v2 currently has ~20 tools across `core.ts`, `scheduling.ts`, `interactive.ts`, `agents.ts`, `memory.ts`, `specialists.ts`, `self-mod.ts`, `search.ts`.

---

## 8. Ollama Provider — Removed

**v1:** `container/agent-runner/src/ollama-mcp-stdio.ts` + `OLLAMA_ADMIN_TOOLS` config flag.

**v2:** Provider system is modular (`src/providers/`) but only ships `claude.ts` and `mock.ts`. The `/add-ollama-provider` skill exists but the provider branch content hasn't been verified to be complete.

---

## 9. Configuration Options — Removed or Hardcoded

v1 config options with no v2 equivalent:

| Option | Purpose |
|--------|---------|
| `GROUPS_DIR` | Group directory (v2 hardcodes) |
| `STORE_DIR` | Store directory (v2 hardcodes) |
| `MEMORY_SEARCH_*` (9 options) | Memory search config |
| `OLLAMA_ADMIN_TOOLS` | Ollama toggle |
| `IPC_POLL_INTERVAL` | IPC polling interval |
| `CYCLE_TIMEOUT` | Orchestration cycle timeout |
| `MAX_DISPATCH_DEPTH` | Max specialist dispatch depth |
| `SPECIALIST_CONTAINER_TIMEOUT` | Specialist-specific timeout |
| `MAX_THROWAWAY_RETRIES` | Throwaway retry count |
| `THROWAWAY_CONTEXT_LIMIT_TOKENS` | Throwaway input token cap |
| `THROWAWAY_MAX_INPUT_FRACTION` | Throwaway input fraction cap |

---

## 10. Intentionally Removed (Lower Priority)

These were removed in the v2 rewrite and are unlikely to need porting:

- **WebXDC channel** — web chat UI framework (`src/channels/webxdc-store.ts`, WebXDC build scripts)
- **Emacs channel** — direct Emacs chat integration (`src/channels/emacs.ts`)
- **Direct Telegram adapter** — v1 had `src/channels/telegram.ts`; v2 uses the Chat SDK bridge instead

---

## Priority Order (Suggested)

1. **Session warm-start + archiving** — directly affects conversation quality and memory continuity
2. **Zotero sync** — partially scaffolded; needs the actual polling/sync logic
3. **RSS feed monitoring** — self-contained, medium complexity
4. **Advanced memory** — Gemini embeddings + hybrid search is a larger lift
5. **Remote control** — lower urgency
6. **Missing MCP tools** — add incrementally as the above features land
