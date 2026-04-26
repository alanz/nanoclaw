# Upstream Update Notes: v1.2.53 → v2.0.13

439 commits, 518 files changed. Upstream went through a near-complete architectural rewrite for the 2.0.x series.

## What Changed Upstream

### 1. Entity model rewrite

v1 had flat channel-centric privilege. v2 introduces first-class `users`, `roles`, `agent_groups`, `messaging_groups`, and a join table (`messaging_group_agents`) that configures how each channel wires to agents (engage mode, session mode, sender scope, etc.).

### 2. Two-DB session split

v1 had one shared session DB. v2 uses two: `inbound.db` (host writes, container read-only) and `outbound.db` (container writes, host read-only). Session folders moved to `data/v2-sessions/<agent_group_id>/<session_id>/`. Enforced at mount level.

### 3. Channels are self-registering plugins

Only the `cli` channel ships in trunk. All others (WhatsApp, Telegram, Slack, Discord, etc.) are on the `channels` branch and installed via `/add-<channel>` skills. Each must implement a `ChannelAdapter` interface.

### 4. Pluggable AI providers

Same pattern: only Claude ships in trunk. Alternatives live on the `providers` branch.

### 5. DB schema reorganized

`src/db.ts` is gone — replaced by a modular `src/db/` directory with schema, migrations, session-db, agent-groups, messaging-groups, etc.

### 6. Self-registering modules

`src/index.ts` is no longer monolithic. Subsystems (approvals, interactive, scheduling, permissions, agent-to-agent, self-mod) load via barrel imports as self-registering modules.

### 7. New install flow

`nanoclaw.sh` is the new entry point; hands off to `pnpm run setup:auto` for an interactive @clack/prompts UI. The old `/setup` skill is replaced.

### 8. Container agent-runner moved to Bun

Host stays Node/pnpm; containers now use Bun runtime.

## What's Local-Only (needs preserving)

**20 Allium spec files** in `docs/project/specs/` — not present upstream. Carry forward as pure documentation with no merge conflicts.

**2 minimal src/ changes** (~3 lines total):
- `src/index.ts`: forces `requiresTrigger: false` for main groups
- `src/config.ts`: comment clarification on `THROWAWAY_CONTEXT_LIMIT_TOKENS`

**5 specialist agent groups** in `groups/specialists/` (coder, memory, researcher, reviewer) plus deltachat groups and emacs symlink. Upstream only ships `groups/global/` and `groups/main/`.

**35+ installed skills** in `.claude/skills/` — most from skill branches that also exist upstream; they'd be reinstalled.

## Why This Is Hard

The v1→v2 migration is not a cherry-pick situation — the DB schema is incompatible, the channel registration model changed fundamentally, and the session folder layout is different. Upstream ships a `/migrate-nanoclaw` skill specifically for this.

## Migration Path

1. **Run `/migrate-nanoclaw`** — extracts customizations, generates a replayable guide, upgrades to the new base. This is upstream's intended upgrade path for v1 forks.
2. **Preserve the specs** — copy `docs/project/specs/` wholesale after migration; no conflicts.
3. **Reapply the 2 src/ changes** — trivial cherry-picks after migration lands.
4. **Reinstall channels** — `/add-whatsapp`, `/add-telegram`, `/add-slack`, `/add-discord`, `/add-gmail`, etc.
5. **Verify specialist groups** — folder structure changes but `CLAUDE.md` and memory content should survive.
6. **Rebuild the container** — agent-runner is now Bun-based.

The local src/ customizations are tiny (3 lines) and the specs are conflict-free. The practical effort is: run the skill, verify channels reinstall correctly, reapply the spec files and 2-line src patch, rebuild the container.
