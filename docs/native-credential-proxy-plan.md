# Plan: OneCLI-aligned native credential proxy (no Docker)

> Status: **PLANNED — not yet built.** Captured 2026-06-13.
>
> Goal: give containers OneCLI-style credential *confidentiality* (the agent
> never sees raw secrets; they're injected at the network boundary) **without**
> OneCLI — because OneCLI forces Docker, and this fork runs on Apple Container
> with a native host-side proxy.
>
> Guiding constraint from the owner: **if we do this, it must architecturally
> align with how OneCLI works** — a transparent HTTPS proxy keyed by
> destination host, not a per-service base-URL override hack.

## Background: how OneCLI works (the reference model)

OneCLI runs a gateway container that:

1. Containers set `HTTPS_PROXY` to the gateway and trust an injected **CA cert**.
2. The gateway **MITMs** outbound TLS: it terminates TLS using its CA, inspects
   the destination host, **injects the matching stored credential** (secrets are
   configured with **host patterns**), and re-originates TLS to the real upstream.
3. The agent uses **normal URLs** (`api.zotero.org`, `api.github.com`, …) and
   **never sees credential values** — works for any client (curl, fetch, SDK)
   with zero per-tool wiring.
4. Optional **egress lockdown**: agents run on a Docker `--internal` network with
   the gateway as the only route out, so a compromised agent can't bypass the
   gateway or exfiltrate to arbitrary hosts. (Docker-specific.)
5. Per-agent **secret modes** (`selective` / `all`) scope which secrets an agent
   may use.

See `docs/onecli-upgrades.md` and the (now-removed) `onecli-gateway` container
skill in git history for the original wiring.

## Current state of THIS fork (baseline before the plan)

- **Credential mode:** native proxy, OAuth (`CLAUDE_CODE_OAUTH_TOKEN` in `.env`;
  no `ANTHROPIC_API_KEY`). See `src/credential-proxy.ts`.
- **What the native proxy does today:** single-upstream **reverse** proxy. The
  container sets `ANTHROPIC_BASE_URL=http://<gateway>:<port>` (plain HTTP, no CA
  needed) and the proxy injects the Anthropic auth header and forwards to
  `https://api.anthropic.com`. OAuth uses a placeholder-token → exchange flow
  (`/api/oauth/claude_cli/create_api_key`). **Only Anthropic is proxied.**
- **Other secrets are injected as plaintext container env vars** at spawn
  (`src/container-runner.ts`, ~line 587): `BRAVE_API_KEY`, `ZOTERO_API_KEY`,
  `ZOTERO_USER_ID`. The agent process can read these (`echo $BRAVE_API_KEY`).
- **Actual container-side credential consumers (audited):**
  - **Brave** — real. `container/agent-runner/src/mcp-tools/search.ts` reads
    `process.env.BRAVE_API_KEY` and calls
    `https://api.search.brave.com/res/v1/web/search` with header
    `X-Subscription-Token`. (`BRAVE_API_KEY` is set in `.env`.)
  - **Zotero — DEAD injection.** All real Zotero API use is **host-side**
    (`src/modules/zotero/pre-check.ts` etc., reading `.env` directly). Nothing in
    `container/` or `groups/` consumes `ZOTERO_API_KEY`. We inject it into every
    container for no consumer → pure downside.

### Immediate cleanup (do regardless of the gateway, low risk)

Stop injecting the dead Zotero secret into containers — remove the
`ZOTERO_API_KEY` / `ZOTERO_USER_ID` `args.push('-e', …)` lines from
`src/container-runner.ts` (host-side Zotero keeps reading `.env`). This removes a
secret from the container attack surface with zero functional impact.

## Target architecture (OneCLI-aligned, native)

Extend `src/credential-proxy.ts` from a single-upstream **reverse** proxy into a
**transparent forward proxy with MITM**, mirroring OneCLI:

1. **Forward proxy.** Handle HTTP `CONNECT`. Container env:
   `HTTPS_PROXY=http://<CONTAINER_HOST_GATEWAY>:<port>` (and `HTTP_PROXY`,
   `NO_PROXY=localhost,127.0.0.1`).
2. **Host CA + on-the-fly leaf certs.** Generate a CA keypair on the host once,
   persist under `data/` (private key **never** leaves host, mode 600). For each
   MITM'd SNI host, mint a leaf cert signed by the CA. Needs a cert lib —
   **`node-forge`** (pure JS, no install build script → OK under the
   `pnpm-workspace.yaml` supply-chain policy, but still respect
   `minimumReleaseAge`; pin deliberately).
3. **Trust injection into the container.** Mount the CA **public** cert read-only
   (Apple Container directory mount), and set:
   `NODE_EXTRA_CA_CERTS`, `CURL_CA_BUNDLE`, `SSL_CERT_FILE`,
   `REQUESTS_CA_BUNDLE` → the mounted CA path. (Covers node / curl / python.)
4. **Host-pattern → secret table** (mirrors OneCLI "secret with host pattern").
   Start with a static config; later move to the DB for per-group scoping:
   ```
   api.search.brave.com  -> header X-Subscription-Token: $BRAVE_API_KEY
   # add more as container-side services appear
   ```
5. **MITM only managed hosts; pass through the rest.** On `CONNECT` to a host
   matching a pattern: terminate TLS with a minted leaf, inject the header,
   re-originate real TLS to upstream. On any other host: blind tunnel
   (passthrough) — no MITM, no cred.
6. **Remove raw secrets from container env.** Drop `BRAVE_API_KEY` (and the dead
   Zotero vars) from the spawn env. `search.ts` no longer needs the key — it
   just calls the normal Brave URL through the proxy; the gate that registers the
   tool changes from "BRAVE_API_KEY present" to "Brave configured on the host."

### Result vs OneCLI

- ✅ **Credential confidentiality** — agent never holds raw secrets; any client
  works without per-tool wiring. Matches OneCLI's core value.
- ✅ **No Docker** — pure host Node process + Apple Container mounts/env.
- ❌ **No egress containment.** Without Docker there is no kernel-enforced
  `--internal` network, so a compromised agent still: (a) can't *read* the raw
  key (good), but (b) can *abuse* the proxy to make authorized calls, and (c) can
  reach arbitrary other hosts directly. This gap is **inherent to "no Docker"**
  and cannot be closed the way OneCLI does. (See `src/egress-lockdown.ts`, left
  dormant — it depends on Docker + a gateway container.)

## Open decisions (resolve at build time)

1. **Anthropic unification.** Two options:
   - **(Recommended, phased)** Leave Anthropic on its current working reverse-proxy
     base-URL path; add transparent MITM for *other* hosts only. Two mechanisms
     temporarily, but the working OAuth path is untouched.
   - **(Fuller alignment, riskier)** Fold `api.anthropic.com` into the unified
     host-pattern model too. Requires careful rework + testing of the OAuth
     placeholder → exchange flow.
2. **Per-group scoping** (OneCLI's selective/all modes). Phase 2: move the
   host-pattern → secret table into the DB and scope per agent group.
3. **Cert lifecycle.** CA rotation/expiry handling; what to do if the CA mount is
   missing (fail closed vs passthrough).

## Worth-it check

Today this protects exactly **one** key (Brave). The full MITM gateway is a real
build for a single secret, justified mainly as the **foundation** for a growing
container-side credentialed surface (agents doing ad-hoc `curl` to authed APIs),
where the transparent model pays off (no per-tool wiring). Until then, the
pragmatic minimum is the **dead-Zotero cleanup** above.

## Touch list (when building)

- `src/credential-proxy.ts` — forward-proxy + MITM + host-pattern injection.
- `src/config.ts` — CA paths, host-pattern config source.
- `src/container-runner.ts` — set `HTTPS_PROXY`/CA env, mount CA, stop injecting
  raw secret env vars.
- `container/agent-runner/src/mcp-tools/search.ts` — drop the key; call the
  normal URL; change the registration gate.
- `package.json` — add `node-forge` (respect supply-chain policy).
- New: CA generation/persistence helper.
- Tests: proxy host-pattern matching + injection; passthrough for unmanaged
  hosts; trust-env wiring.
- Docs: fold the credential model into `docs/` and update the
  `use-native-credential-proxy` skill so updates don't reintroduce OneCLI
  assumptions.
