# Plan: per-group agent providers — a second DeltaChat DM on OpenRouter

> Status: **PLANNED — not yet built.** Captured 2026-08-08.
>
> Goal: run a **second DeltaChat DM** against its own agent group whose container
> talks to **OpenRouter**, while the existing DM (`Andy`) keeps using the OAuth
> credential proxy against `api.anthropic.com`. Two agents, two credential paths,
> one DeltaChat bot.
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

[or-docs]: https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration
[or-blog]: https://openrouter.ai/blog/tutorials/claude-code-openrouter/
