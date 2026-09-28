# Rebuild onto upstream v2.2 — status and cutover plan

Handover document. Written so a fresh session can pick this up cold.

**Status: cut over 2026-09-28. The live install runs the rebuilt series on
`main`.** Phases 0–4 done; one gap found after cutover and fixed (§6, Phase 4).
Next: rebase the series onto the current `upstream/main`.

---

## 1. What this is

This fork had drifted 141 commits from upstream over five months. Upstream
meanwhile landed four architectural refactors (session driver seam, async
central DB, agent mailbox seam, host lifecycle registry) plus a Node 22
requirement, across 300 commits and 569 files.

A merge was attempted and abandoned: 28 conflicted files, ~60 hunks, and — more
importantly — the conflicts were concentrated in exactly the six files upstream
had rearchitected. Reconciling hunk-by-hunk would have meant merging against
code whose structure no longer existed.

**The chosen approach was to rebuild the fork as a curated patch series on top
of `upstream/main`**, one commit per subsystem, so that future updates are
`git rebase upstream/main` over ~19 commits rather than a patch-pile merge.

The key enabler: upstream now exposes 22 registration seams
(`registerSessionDriver`, `registerGatewayProvider`, `registerMigration`, …).
Most of what this fork used to patch into core files is now a self-registering
module. See §5.

---

## 2. Where everything lives

| Thing | Location |
|---|---|
| Live install | `/Users/alanz/nanoclaw-v2`, branch `main` (the rebuilt series; `main` was hard-reset onto it at cutover) |
| Rebuild worktree | removed at cutover; `rebuild/v2.2-series` deleted |
| Cutover backup of `data/`, `groups/`, `.env`, plist | `~/nanoclaw-backups/cutover-20260928-184833` |
| Pre-cutover agent image | `nanoclaw-agent-v2-f3156ec2:pre-rebuild` |
| Upstream base | `upstream/main` @ `2fb88a78` (remote is `qwibitai/nanoclaw`) |
| Pre-rebuild history archive | tag `archive/pre-rebuild-v2.2` → `25edc781` (also pushed to `origin`) |
| Same history, also | `origin/main`, and `backup/pre-update-25edc781-*` branch+tag |
| Live agent image | `nanoclaw-agent-v2-f3156ec2:latest` |
| Rebuild agent image | `nanoclaw-agent-v2-c4cc12ae:latest` (built, tested) |

The image name is derived from the **checkout path** via
`setup/lib/install-slug.sh`. This is what keeps the two installs isolated —
and it is also a cutover trap, see §6 step 7.

The rebuild worktree currently has **no** `data/`, `groups/` or `.env` — the
Phase-2 rehearsal copies were deleted after teardown. `src/channels/index.ts`
is back to its committed state (deltachat import restored).

---

## 3. The commit series (19)

```
 1. b15ca746 feat(specs): add Allium behaviour specs
 2. a7c1e3a4 feat(channels): add DeltaChat and null-channel adapters
 3. a484af2c refactor(drivers): extract a runtime dialect from the Docker driver
 4. 2aa4ecc3 feat(drivers): add the Apple Container session driver
 5. 9e3efc4b feat(gateway): add the native credential proxy gateway provider
 6. 5658233a feat(drivers): carry the container's last words on a started-then-died failure
 7. 5727297e feat(sessions): container concurrency cap with a FIFO waiting queue
 8. cd322aa5 feat(sessions): bound the failure of a container that cannot start
 9. 2f219e20 feat(memory): semantic memory index and hybrid search
10. 728c0b62 feat(specialists): per-task specialist dispatch with file handover
11. 05bddf20 feat(zotero): Zotero library sync
12. 329a4db7 feat(web-ui): read-only dashboard with memory graph
13. 7e89704c feat(agent): web search, workspace file links, and Apple file-mount handling
14. f5b569d8 feat(setup): Apple Container runtime, DeltaChat, and a launchd PATH that works
15. 2ec80d16 chore: install configuration and operational docs
16. 79d61255 test(boot-crash): cover the two cases the host-sweep version had
17. a74b8473 fix(drivers): tell a prepared Apple container from a dead one
18. f64148c6 test(drivers): exercise the driver against a real runtime
19. 1a6bb38e fix(db): let renamed migrations recognise work they already did
```

Commit messages carry the reasoning; read them rather than re-deriving it.

### Upstreamable independently

Four commits are not fork-specific and could go to upstream as PRs. Each one
that lands removes itself from the rebase burden:

- **3** `a484af2c` — dialect refactor. Behaviour-preserving; upstream's own
  driver tests pass unmodified.
- **6** `5658233a` — stderr tail on `started-then-died`. The driver already
  captured it and only logged it.
- **18** `f64148c6` (part) — the conformance suite had three cases seeding raw
  `ps -a` text, which made them Docker-only inside a file that claims to be
  driver-neutral.
- **14** `f5b569d8` (part) — `setup/container.ts` called
  `reconcileDerivedImages()` without awaiting it, so `reconciled.cleared` was
  `undefined` and the `.length` read threw inside a `try/catch` that swallowed
  it. `setup/` is not in `tsconfig`, which is how it shipped.

---

## 4. Bugs found along the way

Three were live problems, not artefacts of the port.

**Credential proxy bound to `0.0.0.0` with no authentication.** It holds the
install's real OAuth token and attached it to *any* request that reached port
3002. Commit `9fc60f6a` had fixed this once (bind to the bridge IP) and the fix
was later lost when the setting moved to `config.ts` and reverted to
`'0.0.0.0'`. The bridge-IP approach was fragile anyway — `bridge100` does not
exist until the container VM network is up, so a host that starts first cannot
bind to it (`EADDRNOTAVAIL`). **Fixed differently**: the placeholder token
handed to containers is now a persisted 32-byte per-install secret, compared in
constant time, and the real credential is attached only to a request presenting
it. Everything else proxies verbatim. Reachability stops being the boundary.
Verified live in the rehearsal — an unauthenticated request got 401.

**Apple Container cannot bind a single file.** Upstream composes exactly one
file mount (`container/CLAUDE.md` → `/app/CLAUDE.md`), so every spawn on the
Apple driver would have failed. The dialect now owns `mountArgs` and drops file
mounts (logged, not silent); the image carries a baked copy via `COPY CLAUDE.md`.

**launchd inherits no shell PATH.** The plist hardcoded
`/usr/local/bin:/usr/bin:/bin:~/.local/bin`, omitting `/opt/homebrew/bin` where
`container` lives on Apple Silicon. The host would start cleanly and then fail
every spawn with "binary does not exist".

---

## 5. What the fork now costs to maintain

The point of the exercise. Core files carrying fork patches:

| File | Patch |
|---|---|
| `src/index.ts` | **none** |
| `src/host-sweep.ts` | **none** |
| `src/router.ts` | **none** |
| `src/container-runner.ts` | three seams: `setWakeGate`, `registerSessionExitHook`, `registerSessionContributor` |
| `src/types.ts` | `Session.processing_state` + `ProcessingState` |
| `src/drivers/*` | the dialect refactor (upstreamable) |
| `src/mailbox/*` | `failPendingMessages()` on `InboundMailbox` |

Everything else is a self-registering module under `src/modules/`, an adapter
under `src/channels/`, or a new file. See the "This install's local modules"
table in `CLAUDE.md`.

Couplings deliberately inverted during the port, so the dependency graph points
the right way:

- memory no longer asks the specialists module anything —
  `registerMemoryGroupExclusion`, and specialists declares its own groups
- boot-crash bounding stands down for specialist sessions via
  `registerBootCrashExemption` rather than knowing what a specialist is
- `agent_groups.is_main` moved from the specialists migration to the
  concurrency module: it is a property of an agent group, and both read it

---

## 6. The plan

### Phase 0 — blockers ✅ DONE (commit 19)

Six migrations were renamed to satisfy `registerMigration`'s
`module:<owner>:<id>` format. The runner decides what is pending **by name**, so
on this install they all looked unapplied and would have re-run their DDL
against objects that already exist → **host fails to start**. They are pure DDL,
so nothing was at risk of corruption; the failure mode was a dead startup.

Guarded (`IF NOT EXISTS`, `addColumnIfMissing`) rather than rewriting
`schema_version`. See `src/db/migrations/legacy-names.ts`.

Two of the six were only found by rehearsing: the new concurrency migration adds
`is_main`, which this install already has from when the column lived in
specialists; and one `CREATE UNIQUE INDEX` a blanket edit missed.

### Phase 1 — offline DB validation ✅ DONE

```bash
cp data/v2.db /tmp/probe.db
pnpm run check-migrations /tmp/probe.db     # scripts/check-migrations.ts
```

Result: all 8 migrations apply; row counts unchanged across 12 tables;
`is_main` preserved (Andy still flagged main). The script refuses a path under
`data/` so it cannot be aimed at live state.

### Phase 2 — rehearsal on copied state ✅ DONE

Ran the real host in `/Users/alanz/nanoclaw-rebuild` against a snapshot of live
data, with the live install still running. Ports moved (3012/3014), memory and
dashboard off, **DeltaChat import commented out** (it would otherwise connect as
the same account as the live bot and the two would contend for one mailbox).

Proven: migrations → `driver="apple"` → `gatewayProvider="native-proxy"` →
credential proxy up → container spawned (`ncl-c4cc12ae-…`, bridge IP
`192.168.64.28`, gateway `192.168.64.1`) → **agent replied `REHEARSAL OK`** →
web UI HTTP 200 → proxy returns 401 to an unauthenticated caller.

**This phase found the third blocker**: the host refused to start with
`Upgrade tripwire: install not on the sanctioned path`. Upstream now refuses to
run an install that did not arrive via a supported update flow. The live marker
records `2.1.54`; the rebuild is `2.2.0` with a commit/tree, so copying it
forward does not help. Fix is one command, and it must happen at cutover — see
step 8 below.

To repeat this phase, see §7.

### Phase 3 — cutover ✅ DONE 2026-09-28

As planned below, with three deviations: `main` was hard-reset onto the
series rather than checking out the branch (the worktree held it); the plist
was kept, not regenerated — it already had `/opt/homebrew/bin`, and the
generator derives the label from the checkout path, which is not this
install's `com.nanoclaw.v2`; and the hourly `com.nanoclaw.v2.backup` job was
unloaded for the window, since it reads `data/` on the hour.

Downtime starts here. Budget 15–30 minutes.

```bash
cd /Users/alanz/nanoclaw-v2

# 1. Stop the service
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.v2.plist

# 2. Wait for in-flight containers to exit
container ls --all | grep f3156ec2

# 3. RETAG THE OLD IMAGE so rollback survives step 7 overwriting it
container image tag nanoclaw-agent-v2-f3156ec2:latest nanoclaw-agent-v2-f3156ec2:pre-rebuild

# 4. Back up mutable state — this is what git cannot restore
cp -a data /path/to/backup/data-$(date +%Y%m%d-%H%M%S)
cp -a groups /path/to/backup/groups-$(date +%Y%m%d-%H%M%S)
cp .env /path/to/backup/env-$(date +%Y%m%d-%H%M%S)

# 5. Switch the checkout
git checkout rebuild/v2.2-series

# 6. Add the two settings the rebuild requires (see §8)
#    NANOCLAW_RUNTIME_DRIVER=apple
#    NANOCLAW_GATEWAY_PROVIDER=native-proxy

# 7. Dependencies, build, image — image MUST be built from THIS checkout so it
#    gets the f3156ec2 name the live install resolves to
pnpm install --frozen-lockfile
pnpm run build
CONTAINER_RUNTIME=container ./container/build.sh

# 8. Stamp the upgrade marker, or the tripwire refuses to start the host
pnpm exec tsx scripts/upgrade-state.ts set "" rebuild-onto-upstream

# 9. Regenerate the launchd plist so it picks up the /opt/homebrew/bin PATH fix,
#    then load and start
```

### Phase 4 — post-cutover verification ✅ DONE

All six passed — after one fix. The port had dropped every per-session
addition the old runner patched into spawn: the memory index mount (+
`NANOCLAW_MEMORY_ENABLED`), `BRAVE_API_KEY`, the Zotero keys, and the
specialist invocation (ipc mounts + `invocations` row). Nothing failed
loudly: the tools just never registered, and a specialist's report file was
dropped with only a WARN. Restored through a new `registerSessionContributor`
seam (commit `fix(sessions): restore the per-session container wiring…`).
The rehearsal missed it because memory was off and "the agent replied" does
not check which tools the agent has — a future rehearsal should ask the agent
to list its MCP tools and run a specialist dispatch that returns a file.

Original checklist:

In order; stop at the first failure and go to Phase 5.

1. Process alive; `data/ncl.sock` exists; `bin/ncl groups list` answers
2. Log lines: `driver="apple"`, `gatewayProvider="native-proxy"`,
   `Credential proxy started`, `Channel adapter started channel="deltachat"`
3. **Send yourself a DeltaChat message** — the first real round trip
4. A specialist dispatch (exercises null-channel, concurrency cap, file handover)
5. Memory search returns results (needs `MEMORY_SEARCH_GEMINI_API_KEY`)
6. Web UI loads on `WEB_UI_PORT`

### Phase 5 — rollback (not needed)

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.v2.plist
cd /Users/alanz/nanoclaw-v2
git checkout main                       # or: git reset --hard archive/pre-rebuild-v2.2
rm -rf data groups && cp -a /path/to/backup/data-… data && cp -a /path/to/backup/groups-… groups
cp /path/to/backup/env-… .env
container image tag nanoclaw-agent-v2-f3156ec2:pre-rebuild nanoclaw-agent-v2-f3156ec2:latest
pnpm install --frozen-lockfile && pnpm run build
launchctl load ~/Library/LaunchAgents/com.nanoclaw.v2.plist
```

The `data/` restore is the part git cannot do: migrations will have run, and the
old code does not know the `module:` migration names.

---

## 7. Repeating the Phase-2 rehearsal

```bash
cd /Users/alanz/nanoclaw-rebuild

# Consistent DB snapshot (the live WAL is active; plain cp can tear)
node -e "const D=require('./node_modules/better-sqlite3');
  const s=new D('/Users/alanz/nanoclaw-v2/data/v2.db',{readonly:true});
  s.backup('data/v2.db').then(()=>{s.close();console.log('ok')})"

cp -a /Users/alanz/nanoclaw-v2/data/v2-sessions data/
cp -a /Users/alanz/nanoclaw-v2/data/v2-transfers data/
cp -a /Users/alanz/nanoclaw-v2/groups .
# Skip data/v2-memory — 1.8G, and memory stays off for a rehearsal.

# .env: TZ, CLAUDE_CODE_OAUTH_TOKEN, the two NANOCLAW_* settings,
#       CREDENTIAL_PROXY_PORT=3012, WEB_UI_PORT=3014.
#       Omit MEMORY_SEARCH_*, DASHBOARD_*, ZOTERO_*.

# Comment out `import './deltachat.js';` in src/channels/index.ts.
# REVERT THIS BEFORE COMMITTING ANYTHING.

pnpm exec tsx scripts/upgrade-state.ts set "" rebuild-onto-upstream
pnpm run dev > logs/rehearsal.log 2>&1
```

Teardown: `pkill -f "nanoclaw-rebuild.*src/index.ts"`, `container rm --force
ncl-c4cc12ae-…`, `git checkout src/channels/index.ts`, `rm -rf data groups .env`.

---

## 8. Settings the rebuild needs that the live `.env` lacks

```bash
NANOCLAW_RUNTIME_DRIVER=apple          # else defaults to docker, which is not installed
NANOCLAW_GATEWAY_PROVIDER=native-proxy # else defaults to onecli, which is not installed
```

Both default to something this install does not have, so omitting them is a hard
failure at first spawn, not a degraded mode. Everything else in `.env.example`
is optional and documented there.

---

## 9. Testing

```bash
pnpm test                                    # 2352 pass, 8 skipped, 4 pre-existing failures
pnpm exec tsc --noEmit                       # clean
cd container/agent-runner && bun test        # 358 pass
allium check specs/                          # 0 errors, 4 warnings (routing.allium)
pnpm run check-migrations <db-copy>          # migration rehearsal
NANOCLAW_LIVE_RUNTIME=apple \
  NANOCLAW_LIVE_IMAGE=nanoclaw-agent-v2-c4cc12ae:latest \
  pnpm run test:live                         # 8 pass — driver vs REAL runtime
```

**The 4 failures are pre-existing upstream**, in
`scripts/update/transaction.e2e.test.ts`. Verified by running that file on an
untouched `upstream/main` worktree — same 4 fail. They reject running from a git
worktree ("mismatched or unsafe paths"). Do not chase them.

`test:live` is the tier that matters for driver work: it spawns real containers
(named `ncl-live-<pid>-*`, throwaway install label, removed in `afterAll`) and
proves the runtime accepts the argv the driver emits. It is skipped unless both
env vars are set. It was written after the fake CLI failed to catch the
prepared-vs-dead bug (commit 17), and it has been verified to fail if that bug
is reintroduced.

---

## 10. Facts a fresh session will otherwise rediscover the hard way

- **Apple Container binds directories only.** A new file-level mount will be
  silently dropped by the Apple dialect. Bake it into the image instead.
- **`container create` reports state `stopped`**, identical to a container that
  ran and exited. `status.startedDate` is the discriminator — absent until it
  runs. Getting this wrong makes the residue sweep reap containers between
  `prepare()` and `start()`.
- **launchd inherits no shell PATH.** `/opt/homebrew/bin` must be in the plist.
- **The agent image name comes from the checkout path.** Two worktrees produce
  two images; that is the isolation, and also the cutover trap.
- **`--rm` means a container that dies at boot leaves no logs.** That is why the
  boot-crash module exists and why `test:live` is worth having.
- **`setup/` is not in `tsconfig`.** Ad-hoc `tsc` on those files reports errors
  that also appear on pristine upstream; diff against a stash before believing
  any of them.
- **The builder VM needs `--memory 8g`.** `container/build.sh` now sets it; the
  default dies with a bare "Killed" that reads like a build error.
- **`specs/*.allium` are read-only** without the owner's explicit approval.
- **A module that needs something inside the agent container** (a mount, an
  env var) registers a `registerSessionContributor`. Upstream's runner has no
  other way in, and a feature wired any other way silently vanishes on the
  next rebase.

---

## 11. Decisions (settled 2026-09-28)

- **`main` moved onto the series.** It is now a patch stack on upstream:
  update by `git rebase upstream/main` + force-push, never by merging
  upstream in. New work belongs folded into its subsystem commit
  (`--fixup` + autosquash) so the stack stays curated. Rollback target is
  the `archive/pre-rebuild-v2.2` tag.
- **The four PR-ready commits stay in the fork**; not sent upstream.
- **Upgrade marker `via` stays `rebuild-onto-upstream`.**
- **Follow-up:** move `BRAVE_API_KEY` and the Zotero keys out of container env
  and behind the native credential proxy.
