# Plan: per-group agent providers — a second DeltaChat DM on OpenRouter

> Status: **PLANNED — not yet built.** Captured 2026-08-08.
>
> Goal: run a **second DeltaChat DM** against its own agent group whose container
> talks to **OpenRouter**, while the existing DM (`Andy`) keeps using the OAuth
> credential proxy against `api.anthropic.com`. Two agents, two credential paths,
> one DeltaChat bot.
>
> Two steps, independently useful:
> **Step 1** — alternate *model endpoint*, same `claude` harness.
> **Step 2** — alternate *harness* (OpenCode) for the same group.
>
> Guiding constraint: use the **provider seam upstream already ships** rather than
> inventing a parallel mechanism. The only fork-specific work is teaching the
> spawn path that a provider may bring its own endpoint.

## Background: the seam upstream gives us

Provider is resolved once per spawn (`src/container-runner.ts:563`):

```ts
resolveProviderName(session.agent_provider, containerConfig.provider)
// src/container-runner.ts:500-505 → sessionProvider || containerConfigProvider || 'claude'
```

Two registries, both open — adding a provider is a file plus a barrel import:

| Registry | Where | What it contributes |
|---|---|---|
| `registerProviderContainerConfig(name, fn)` | `src/providers/provider-container-registry.ts` | host-side spawn extras: mounts + env |
| `registerProvider(name, factory)` | `container/agent-runner/src/providers/provider-registry.ts` | the in-container harness |

Granularity available today:

- **Per agent group — the working knob.** `container_configs.provider`, set with
  `ncl groups config update --id <g> --provider <name>`, materialized into
  `groups/<folder>/container.json` at spawn and read by the runner
  (`container/agent-runner/src/index.ts:48`). `model` and `effort` ride the same
  path (`index.ts:119`).
- **Per session — dormant.** `sessions.agent_provider` exists and *wins* over the
  group value, but `src/session-manager.ts:112,140` always writes `null` and
  `ncl sessions` is `list`/`get` only (`src/cli/resources/sessions.ts:45`). Not a
  usable knob; ignore it.

So the unit of provider granularity is **one agent group** — which is exactly the
shape of "a second DM with its own backend".

Note: `--provider` is an unvalidated free-form string on the host
(`src/cli/resources/groups.ts:371`). A typo is only caught in-container, where
`getProviderFactory` throws `Unknown provider: <x>. Registered: claude` and the
container dies. Container logs are lost on exit (`--rm`), so verify the name.

## Current state of THIS fork (baseline before the plan)

- **Credential mode:** native proxy, OAuth. `.env` has `CLAUDE_CODE_OAUTH_TOKEN`
  and **no** `ANTHROPIC_API_KEY`, so `detectAuthMode()` returns `oauth`
  **globally**.
- **The proxy is single-upstream, fixed at host startup**
  (`src/credential-proxy.ts:22-35`):

  ```ts
  const upstreamUrl = new URL(secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  const authMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  ```

  One upstream and one credential set for every container on the host.
- **Every container is pointed at it unconditionally, *after* provider env**
  (`src/container-runner.ts:789-806`):

  ```ts
  if (providerContribution.env) { …push provider env… }          // a provider's ANTHROPIC_BASE_URL
  args.push('-e', `ANTHROPIC_BASE_URL=http://${gateway}:${port}`); // …is then clobbered
  authMode === 'api-key' ? 'ANTHROPIC_API_KEY=placeholder'
                         : 'CLAUDE_CODE_OAUTH_TOKEN=placeholder';
  ```

  This is the blocker. `src/providers/claude.ts` (upstream's
  `ANTHROPIC_BASE_URL` passthrough) is dead here for the same reason, and is not
  even imported — `src/providers/index.ts` is comments only.
- **Plaintext secret env into containers is established practice**
  (`src/container-runner.ts:778-787`): `BRAVE_API_KEY`, `ZOTERO_API_KEY`,
  `ZOTERO_USER_ID`.
- **Agent-runner source is a shared read-only bind mount**
  (`src/container-runner.ts:646` → `/app/src`, exec'd at `:835`). There are **no**
  per-group `agent-runner-src` overlays in `data/v2-sessions/`. Container-side
  provider code therefore takes effect **on respawn with no image rebuild**, and
  the `/add-opencode` skill's step-8 overlay propagation does not apply.
- **Live entities:**

  ```
  mg-1778095437478-60ps0o  deltachat  dc:10  →  ag-1778095451185-c7e2g9  Andy (dm-with-alanz)
  ```

  All `container_configs.provider` values are `NULL` (i.e. `claude`).

## Route choice: why the `claude` harness, not OpenCode

OpenRouter exposes an **"Anthropic Skin"** at `https://openrouter.ai/api` speaking
the native Anthropic Messages protocol — same request shape, model name mapped
server-side, tool use and thinking blocks passed through. Auth is the OpenRouter
key in `ANTHROPIC_API_KEY` with `ANTHROPIC_AUTH_TOKEN` explicitly blank.
**OAuth is not supported** ([integration docs][or-docs], [blog][or-blog]).

That makes the baked-in `claude` harness sufficient:

| | `claude` harness + Anthropic Skin | `/add-opencode` |
|---|---|---|
| Container code | ~4-line alias module | new provider + `@opencode-ai/sdk@1.4.17` |
| Image rebuild | **none** (bind-mounted src) | yes — `opencode-ai` CLI in the Dockerfile |
| Credentials | one env var | skill assumes OneCLI end-to-end; needs rework here |
| Model reach | any OpenRouter model over the Anthropic protocol | any, via OpenCode config |
| Version traps | none | SDK and CLI must both be 1.4.x; 1.14.x breaks session ids |

OpenCode earns its cost only when a genuinely non-Anthropic-protocol harness is
wanted. For "second agent on OpenRouter" — including the open GLM-5.2 question —
the Skin is a fraction of the surface.

The container `claude` provider reads **no** auth env of its own (the Agent SDK
does it), so controlling env at spawn is sufficient. `ClaudeProvider` is exported
(`container/agent-runner/src/providers/claude.ts:462`) and self-registers at
`:647`, so a sibling name can reuse the class directly.

## Target design

A second provider **name** that maps to the same harness but a different
host-side credential contribution. Provider config is keyed by name, so two
groups both running `claude` cannot differ — a distinct name is what creates the
fork in the spawn path.

### 1. Host provider — new `src/providers/claude-openrouter.ts`

```ts
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('claude-openrouter', () => {
  const e = readEnvFile(['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL']);
  if (!e.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing from .env');
  return {
    env: {
      ANTHROPIC_BASE_URL: e.OPENROUTER_BASE_URL || 'https://openrouter.ai/api',
      ANTHROPIC_API_KEY: e.OPENROUTER_API_KEY,
      ANTHROPIC_AUTH_TOKEN: '',
    },
  };
});
```

Append `import './claude-openrouter.js';` to `src/providers/index.ts`.

### 2. Container alias — new `container/agent-runner/src/providers/claude-openrouter.ts`

```ts
import { ClaudeProvider } from './claude.js';
import { registerProvider } from './provider-registry.js';

registerProvider('claude-openrouter', (opts) => new ClaudeProvider(opts));
```

Append `import './claude-openrouter.js';` to
`container/agent-runner/src/providers/index.ts`.

### 3. Let a provider opt out of the proxy — `src/container-runner.ts:796-806`

Gate the **whole** credential-proxy block on
`!providerContribution.env?.ANTHROPIC_BASE_URL`.

Gating the whole block, not just the base-URL line, is load-bearing: the fork is
in global `oauth` mode, so the block would otherwise also push
`CLAUDE_CODE_OAUTH_TOKEN=placeholder` into a container that must present an API
key to an endpoint that rejects OAuth. Gate it explicitly rather than relying on
last-`-e`-wins ordering, which is a Docker behaviour this fork does not run on.

### Trade-off (accepted, with eyes open)

The OpenRouter key lands in that container's environment, breaking the
"containers never hold credentials" invariant the proxy exists to enforce. Two
things make it acceptable for an experiment: the fork already injects
`BRAVE_API_KEY` the same way (`container-runner.ts:778-787`), and an OpenRouter
key is independently scopable, rate-limitable and revocable. It is a per-group
weakening, not a global one — `Andy` is untouched.

### Phase 2 (only if the experiment sticks): per-profile proxy routing

Keep the key out of containers by teaching `src/credential-proxy.ts` **named
upstream profiles**: container gets `ANTHROPIC_BASE_URL=http://<gw>:<port>/g/<groupId>`,
the proxy strips the prefix and selects that profile's upstream + credential.
Selection needs a new `container_configs.credential_profile` column + migration
and an `ncl groups config update --credential-profile` flag. This is the same
per-group scoping listed as "Phase 2" in
[docs/native-credential-proxy-plan.md](native-credential-proxy-plan.md) — build
them together, not twice.

## Wiring the second DeltaChat DM

Each DeltaChat chat is its own platform id (`dc:{chatId}`,
`src/channels/deltachat.ts:53`) and DMs set `isMention: true` (`:158`). So a DM
from a **second DeltaChat address** produces a new chat id and a new messaging
group — no second bot account needed.

`src/router.ts:197-234` auto-creates the `dc:<newId>` row with
`unknown_sender_policy` from the channel fallback (`request_approval` — the fork's
DeltaChat adapter declares no `ChannelDefaults`). It arrives with
`agentCount = 0`, so it is **not** auto-wired to `Andy`: the message is recorded
in `dropped_messages` and a channel-registration card is raised
(`src/router.ts:238-275`). Ignore the card and wire deliberately:

```bash
# after the second address has sent one message to the bot
ncl messaging-groups list                      # find the new dc:<id> row

ncl groups create --name Nova --folder dm-nova
ncl groups config update --id <nova-id> \
    --provider claude-openrouter \
    --model 'anthropic/claude-sonnet-latest'   # or any OpenRouter model id

ncl wirings create --messaging-group-id <new-mg-id> --agent-group-id <nova-id> \
    --session-mode shared --engage-mode pattern --engage-pattern .

ncl users create …                             # register the second address
ncl groups restart --id <nova-id> --message 'hello from openrouter'
```

`Andy` stays on OAuth through the proxy; `Nova` goes direct to OpenRouter.

### Gotchas

1. **Unknown sender.** The second address is not a registered user; under
   `request_approval` nothing reaches the agent until it is registered or
   approved.
2. **Memory does not carry across providers.** `/migrate-memory` exists for this;
   irrelevant for a fresh group, relevant if `Andy` is ever switched.
3. **Provider-name typos die silently.** See the `Unknown provider` note above —
   `--rm` discards the container log.
4. **Model id format.** OpenRouter accepts `anthropic/claude-opus-5`,
   tilde-prefixed `~anthropic/claude-sonnet-latest`, and aliases like
   `openrouter/auto`.

## Open decisions (resolve at build time)

1. **Provider name.** `claude-openrouter` is explicit but hard-codes one vendor
   into a name. A generic `claude-byo` (endpoint + key purely from `.env`) covers
   GLM and any other Anthropic-protocol gateway without another module — at the
   cost of only one such endpoint per install.
2. **Header form.** The docs specify the key in `ANTHROPIC_API_KEY` (sent by the
   SDK as `x-api-key`) while describing it as bearer auth. If the Skin rejects
   `x-api-key`, fall back to `ANTHROPIC_AUTH_TOKEN=<key>` with a blank
   `ANTHROPIC_API_KEY`. Cheap to determine empirically on first exchange.
3. **Fail-closed on missing key.** The sketch throws at spawn. Confirm a throw in
   a provider config fn surfaces usefully rather than wedging the session.
4. **Whether Phase 2 is worth it** before more container-side credentialed
   surface exists — same worth-it question as the native-proxy plan.

## Touch list (when building)

- New: `src/providers/claude-openrouter.ts` + barrel import in
  `src/providers/index.ts`.
- New: `container/agent-runner/src/providers/claude-openrouter.ts` + barrel
  import in `container/agent-runner/src/providers/index.ts`.
- `src/container-runner.ts:796-806` — gate the credential-proxy block on the
  provider not supplying its own `ANTHROPIC_BASE_URL`.
- `.env` / `.env.example` — `OPENROUTER_API_KEY`, optional `OPENROUTER_BASE_URL`.
- Tests: host registration guard (`listProviderContainerConfigNames()` contains
  `claude-openrouter`); container registration guard (`listProviderNames()`);
  a `buildContainerArgs` case asserting the proxy env is **absent** when the
  provider brings its own endpoint, and present otherwise.
- Validation: `pnpm run build`, `pnpm test`,
  `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`. **No image
  rebuild** — `/app/src` is bind-mounted.
- Specs: none. Provider selection is not covered by any `specs/*.allium` file;
  if that changes, propose the spec edit rather than writing it
  (see CLAUDE.md).

---

# Step 2: an alternate harness (OpenCode)

> Status: **PLANNED — not yet built.** Captured 2026-08-08. Depends on Step 1
> only for the spawn-path gate, and on Phase 2 of
> [docs/native-credential-proxy-plan.md](native-credential-proxy-plan.md) for
> credentials. Read the "Sequencing" section before starting.

Step 1 swaps the *endpoint* while keeping the Claude Agent SDK as the harness.
Step 2 swaps the **harness itself** — a different agent loop, different tool
orchestration, different session model — for one agent group.

## What upstream ships

Three real harnesses (plus `mock`, tests only). `claude` is baked into trunk; the
other two live on the `upstream/providers` carrier branch:

| Harness | Container deps | Steerable to a custom endpoint? |
|---|---|---|
| `claude` | — (baked in) | yes, via `ANTHROPIC_BASE_URL` |
| `opencode` | `@opencode-ai/sdk@1.4.17` | yes, `baseURL` in its generated config |
| `codex` | none (drives `codex app-server` over stdio JSON-RPC) | **no** — see "Why not codex first" |

The contract is small (`container/agent-runner/src/providers/types.ts`):
`query()`, `isSessionInvalid()`, `supportsNativeSlashCommands`,
`registerMemorySessionHook()`, plus optional `onExchangeComplete` and
`maybeRotateContinuation`.

> **Do not copy `types.ts` from the providers branch.** That branch is a
> *carrier*, not a buildable tree — its own `types.ts` is stale (no
> `ProviderExchange`, no `model`/`effort`) while `codex.ts` on the same branch
> uses those symbols. The provider files target **trunk's** interface, which this
> fork already matches. Copy provider files only.

## Fork readiness (good news first)

All the modern seams are already merged here:

- `container/cli-tools.json` + `container/install-cli-tools.sh` — the json-merge
  CLI manifest that replaced hand-edited Dockerfile layers.
- `DEFAULT_AGENT_PROVIDER` (`src/config.ts:42`, `src/db/container-configs.ts:66`).
- `setup/providers/` registry + empty barrel.
- `providerProvidesAgentSurfaces` consumed at `src/group-init.ts:68`.

`opencode.ts` needs only `mcp-to-opencode.ts` and `../destinations.js` (present),
and implements `supportsNativeSlashCommands`, `registerMemorySessionHook`,
`isSessionInvalid`, `query` — conformant against trunk's interface. It does **not**
need `exchange-archive.ts` (that is codex-only).

## The decisive difference from Step 1: credentials

Step 1 worked because the Claude SDK reads a key from the environment, so putting
the OpenRouter key in `ANTHROPIC_API_KEY` was enough.

**OpenCode has no such escape hatch.** The container provider hardcodes the
credential:

```ts
// upstream/providers:container/agent-runner/src/providers/opencode.ts:282
options: { apiKey: 'placeholder', baseURL: proxyUrl },
```

`options.model` and `options.effort` are never read either — the whole config
comes from `OPENCODE_*` env. The design assumes **something injects the real
credential on the wire**; upstream that was OneCLI's MITM gateway, which this fork
removed.

Since `baseURL` *is* steerable, this fork's existing **reverse** proxy is the
right shape — point `baseURL` at it and let the proxy inject. What is missing is
per-group routing, i.e. Phase 2 of the credential-proxy plan. That is the whole
credential story for OpenCode: no new proxy architecture, just profiles.

### Interaction with Step 1's gate — revise it

Step 1 gates the credential-proxy block on
`!providerContribution.env?.ANTHROPIC_BASE_URL`. The host OpenCode provider
contributes `ANTHROPIC_BASE_URL` from `.env` (it is in its `PASSTHROUGH_KEYS`), so
that sniffing gate would **silently opt OpenCode out of the proxy** — the exact
opposite of what OpenCode needs.

Fix the gate to be explicit rather than inferred: add a
`bringsOwnCredentials?: boolean` capability to `ProviderHostCapabilities`
(`src/providers/provider-container-registry.ts`, alongside
`providesAgentSurfaces`) and gate on that.

- `claude-openrouter` → `bringsOwnCredentials: true` (key in env, skip the proxy).
- `opencode` → default `false` (keep the proxy; it supplies the credential).

If Step 1 is already built when Step 2 starts, this is a small refactor of that
gate — not new work. If Step 2 is on the roadmap, build Step 1's gate this way
from the start.

## Sequencing

**Phase 2 of the credential-proxy plan first, then OpenCode as its first
consumer.** Building OpenCode first means shipping a container-side patch to that
`apiKey: 'placeholder'` line — a file owned wholesale by the install skill, so the
patch is drift that a re-run silently reverts, and it is deleted again once
profiles land. The only reason to invert the order is a throwaway spike to see
OpenCode answer a message at all; if so, label it a spike and revert it.

This also settles the credential-proxy plan's own "worth-it check", which
concluded the work protected exactly one key (Brave). OpenCode adds a second
consumer, and codex would add a third.

## Blockers specific to this fork

1. **An image rebuild is now required** — unlike Step 1. `/app/node_modules` is
   baked from `agent-runner/bun.lock` at build time (`container/Dockerfile:73-81`,
   recorded in the `dev.nanoclaw.agent-runner-lock-sha256` label), so adding
   `@opencode-ai/sdk` means a rebuild. `/app/src` being bind-mounted does not help
   here. Pre-start the Apple Container builder with `--memory 8g` or the build is
   Killed; `container/build.sh:152` only starts it if not already running.
2. **Supply-chain asymmetry.** The agent-runner tree is Bun, so
   `minimumReleaseAge` does **not** apply to `bun add @opencode-ai/sdk@1.4.17` —
   pin deliberately, never `bun update`. The `opencode-ai` **CLI** goes through
   `cli-tools.json` → `pnpm install -g`, where the policy *does* apply. If the CLI
   turns out to need a postinstall, `"onlyBuilt": true` requires explicit owner
   sign-off per CLAUDE.md — do not add it unilaterally.
3. **SDK and CLI versions must match exactly (1.4.x).** 1.14.x changes session ids
   (`ses_` prefix) and is incompatible with SDK 1.4.x. Never `latest`.

## Corrections to the bundled `add-opencode` skill

The copy at `.claude/skills/add-opencode/SKILL.md` predates seams this fork now
has. Do not follow it literally:

| Skill step | Reality here |
|---|---|
| 5 — add `ARG OPENCODE_VERSION` + a `RUN pnpm install -g` block to the Dockerfile | The Dockerfile has no per-CLI blocks; add one `{ "name": "opencode-ai", "version": "1.4.17" }` entry to `container/cli-tools.json` |
| 6 — copy `opencode-dockerfile.test.ts` | That guard asserts the `ARG` exists and **fails** against the cli-tools.json Dockerfile. Replace it with a manifest-entry assertion or drop it |
| 8 — propagate to per-group `agent-runner-src` overlays | No overlays exist here; `/app/src` is one shared RO mount (`src/container-runner.ts:646`). No-op |
| Credentials via `onecli secrets create` | No OneCLI in this fork — see the credential section above |

Steps 1–4 and 7 (fetch, copy files, wire barrels, `bun add`, validate) are sound.

## Limitations you inherit (accept or fix deliberately)

- **`--model` / `--effort` are ignored.** OpenCode reads `OPENCODE_MODEL` /
  `OPENCODE_SMALL_MODEL` from host `.env`, and never `options.model`. Those are
  **host-global**, so every OpenCode group shares one model — per-group model
  selection, which Step 1 gives you for free, does not exist here without
  patching the provider. Fine for one experimental group; a real limit if OpenCode
  spreads.
- **No `conversations/` archive.** OpenCode keeps no on-disk transcript and does
  not implement `onExchangeComplete`, so an OpenCode group produces no markdown
  exchange archive the way a `claude` group does
  (`container/agent-runner/src/providers/claude.ts:309`). Anything in this fork
  that reads `conversations/` sees nothing for that group.
- **Memory does not carry across a harness switch.** Same caveat as Step 1 —
  `/migrate-memory` exists for moving an existing group.
- **`NO_PROXY` for localhost matters.** The host provider merges
  `127.0.0.1,localhost` into `NO_PROXY`/`no_proxy` so the in-container OpenCode
  client can reach its own `opencode serve`. Keep that if the MITM forward proxy
  from Phase 2 ever sets `HTTPS_PROXY`.

## Why not codex first

Codex is the more interesting harness (server-side history, no on-disk
transcript) and the more expensive one here, for reasons unrelated to its quality:

- **Not steerable to a custom endpoint at all.** `writeCodexConfigToml` emits
  `sandbox_mode`, `model`, `effort` and MCP servers but **no `model_providers` /
  `base_url` block**, and `CODEX_ENV_ALLOWLIST`
  (`codex-app-server.ts:82`) omits `OPENAI_API_KEY` while admitting `HTTPS_PROXY`,
  `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`. That list is a
  forward-MITM shopping list: codex only works behind the *full* proxy from the
  credential-proxy plan, not the reverse-proxy half OpenCode needs.
- **It mounts a single file.** The host contribution RO-mounts a composed
  `AGENTS.md` at `/workspace/agent/AGENTS.md`, and Apple Container has no
  file-level bind mounts (`src/container-runner.ts:639`) — the same wall already
  worked around for `container.json` (`:618-621`).
- **`buildMounts` lacks the surfaces gate.** Upstream gates default Claude
  surfaces at `container-runner.ts:303`
  (`defaultSurfaces = !providerProvidesAgentSurfaces(provider)`); this fork's
  `buildMounts` does not take `provider` at all and syncs Claude skill symlinks
  unconditionally. Codex declares `providesAgentSurfaces: true`, so it would get
  both surface sets mounted. Fork drift from the Apple Container rewrite; a
  prerequisite for codex, irrelevant to OpenCode.

None of this blocks OpenCode. Revisit codex once Phase 2's forward proxy exists.

## Touch list (when building)

- `container/cli-tools.json` — add `opencode-ai` pinned to `1.4.17`.
- `container/agent-runner/package.json` + `bun.lock` — `bun add
  @opencode-ai/sdk@1.4.17` (run `bun install` in that tree, never `pnpm`).
- Copy from `upstream/providers`: `src/providers/opencode.ts`,
  `container/agent-runner/src/providers/opencode.ts`, `mcp-to-opencode.ts`, and
  the registration/factory/mcp tests. **Not** `types.ts`, **not**
  `exchange-archive.ts`, **not** `opencode-dockerfile.test.ts`.
- Barrel imports in `src/providers/index.ts` and
  `container/agent-runner/src/providers/index.ts`.
- `src/providers/provider-container-registry.ts` — add `bringsOwnCredentials` to
  `ProviderHostCapabilities`; re-point Step 1's gate at it.
- `.env` — `OPENCODE_PROVIDER=openrouter`, `OPENCODE_MODEL`,
  `OPENCODE_SMALL_MODEL`. Comments on their own lines: a `#` inside a value is
  kept verbatim and breaks model ids.
- Tests: both registration guards; a `buildContainerArgs` case asserting an
  OpenCode group **keeps** the proxy env (the mirror of Step 1's assertion).
- Validation: `pnpm run build`, `pnpm test`,
  `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`, then
  `./container/build.sh` — **a rebuild is required this time**.
- Verify with `ncl groups config update --id <g> --provider opencode` +
  `ncl groups restart`. A clean round-trip shows no `Unknown provider: opencode`
  and no UUID/session warnings.

## Open decisions (Step 2)

1. **Phase 2 scope.** OpenCode needs only the *reverse*-proxy half (per-group
   upstream + credential). Build just that, or the full forward MITM at once
   because codex will need it anyway?
2. **Per-group model.** Accept the host-global `OPENCODE_MODEL` limitation, or
   patch the provider to honour `options.model` (a skill-owned file — drift) or
   move the `OPENCODE_*` values into the host provider's per-group contribution?
3. **Exchange archiving.** Leave OpenCode groups without a `conversations/`
   archive, or implement `onExchangeComplete` for it using the codex payload's
   `exchange-archive.ts` as the model?
4. **Keep or drop the stale skill.** Correct
   `.claude/skills/add-opencode/SKILL.md` in place, or treat this doc as the
   install procedure and leave the skill unused?

[or-docs]: https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration
[or-blog]: https://openrouter.ai/blog/tutorials/claude-code-openrouter/
