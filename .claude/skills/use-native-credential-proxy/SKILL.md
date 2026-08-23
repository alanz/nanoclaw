---
name: use-native-credential-proxy
description: Supply Anthropic credentials from .env instead of the OneCLI vault. Selects the native-proxy gateway provider — the host holds the credential and containers reach Anthropic through a local proxy, never holding a credential themselves. Use when you want simple .env credential management without the OneCLI agent vault.
---

# Use the native credential proxy

An install has to get an Anthropic credential into every agent session without
letting the session hold one. NanoClaw's default answer is the OneCLI vault,
which injects per request. This is the other answer: the credential stays in
`.env`, the host runs a small proxy in front of `api.anthropic.com`, and
containers are pointed at the proxy with a placeholder token.

The container never holds a real credential either way. That property is not
negotiable — it is what the session spec's admission rules enforce, and this
path satisfies them by construction rather than by exemption.

> **This replaces an older, worse version of this skill.** That one threaded
> the real key into container env with `-e ANTHROPIC_API_KEY=…` and described
> the inversion as the point. Do not reintroduce it: a credential in container
> env is readable by anything the agent runs, and the spawn now refuses it.

## How it works

- The host runs `src/credential-proxy.ts` on `CREDENTIAL_PROXY_PORT`
  (default 3002), started on first use and closed on shutdown.
- `src/gateway-providers/native-proxy.ts` registers a gateway provider. At
  spawn it contributes two env values: `ANTHROPIC_BASE_URL` pointing at the
  proxy, and a placeholder in whichever slot the auth mode uses.
- The placeholder is a persisted 32-byte per-install secret, not a literal.
  The proxy attaches the real credential **only** to a request presenting it,
  compared in constant time. Everything else is proxied verbatim — an unknown
  key is Anthropic's to reject, and a temp key from the OAuth exchange keeps
  working.

That last point is why the listener can bind broadly. The Apple Container
bridge does not exist when the host starts, so binding to it is not an option
(this was tried, in `9fc60f6a`, and reverted). Reachability is therefore not
the security boundary; the secret is.

## Enable it

Set the gateway provider in `.env`:

```bash
NANOCLAW_GATEWAY_PROVIDER=native-proxy
```

Then supply exactly one credential, also in `.env`:

```bash
# A Claude subscription token — run setup/register-native-token.sh to obtain one:
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…

# …or a plain API key:
ANTHROPIC_API_KEY=sk-ant-…
```

Restart the host. Confirm the selection in `logs/nanoclaw.log`:

```
Gateway provider selected  gatewayProvider=native-proxy
Credential proxy started   port=3002 authMode=oauth
```

## Settings

| Variable | Default | What it does |
|---|---|---|
| `CREDENTIAL_PROXY_PORT` | `3002` | Port the proxy listens on |
| `CREDENTIAL_PROXY_HOST` | `0.0.0.0` | Bind address |
| `CREDENTIAL_PROXY_GATEWAY` | detected | Address containers use to reach the host. Detected from the bridge interface; set it when detection is wrong |

The generated secret lives at `data/credential-proxy.secret`, mode 0600. It
persists across restarts on purpose — minting a new one would 401 every
container still holding the old placeholder.

## Going back to the vault

Remove `NANOCLAW_GATEWAY_PROVIDER` from `.env` (or set it to `onecli`) and
restart. Nothing else is patched, so there is nothing else to undo. Move the
credential into the vault before you do, or sessions will start without one.
