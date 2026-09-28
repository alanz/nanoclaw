---
name: native-proxy-gateway
description: >-
  How credentials work on this install (the native credential proxy). Use when
  a task needs an account, API key or token for an external service, when an
  MCP server or tool asks for a credential, or when the user asks how to give
  you access to a service.
---

# Native credential proxy

Credentials on this install live on the host, in its `.env`, and never enter
your container. A proxy on the host attaches them to requests on the way out —
but only for the services it has been set up for, and only on the routes the
built-in tools use:

| Service | How you use it |
|---------|----------------|
| Model API | Automatic — your own model calls |
| Brave Search | The `brave_web_search` tool (present only when the key is configured) |
| Zotero | The Zotero sync, in the group configured for it |

There is no general gateway. Calling some other API directly gets no
credential added, a placeholder value stays a placeholder, and
`ncl groups connect` has no connection flow to offer.

## When a task needs another service

1. Do not ask the user for the secret in chat, and do not describe an OAuth
   flow or dashboard that does not exist here.
2. Do not install an MCP server and hope a credential appears — it will start
   without one and fail on first use. Putting a key in the server's
   environment is not an option either: the host refuses to start a container
   whose environment carries a secret.
3. Tell the user which service is needed and what kind of credential it uses
   (API key, OAuth token, …), and that the operator has to add it to the
   host's credential proxy.

## What the operator does (for when the user asks)

Adding a service is a host change, not something you can do:

- add the service to the proxy's service list (`PROXIED_SERVICES` in
  `src/credential-proxy.ts`): its upstream URL, the header that carries the
  key, and the `.env` variable it reads;
- put the key in the host `.env`;
- wire whatever will call it (a tool or MCP server) to the proxy's route for
  that service, then restart the service.

The plan for extending the proxy is `docs/native-credential-proxy-plan.md` in
the NanoClaw checkout.
