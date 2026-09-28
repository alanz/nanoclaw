# Credentials & External Services

This install has no general credential gateway. A host-side proxy authenticates three services, and only through the built-in paths that already use them:

- the model API (your own model calls) — nothing for you to do;
- Brave Search — through the `brave_web_search` tool, when you have it;
- Zotero — through the Zotero sync, in the one group configured for it.

Nothing else is authenticated. No proxy injects credentials into your own HTTP requests, there is no connect link, and placeholder values such as `gateway-managed` or `onecli-managed` are never replaced. `ncl groups connect` reports this gateway as unsupported.

When a task needs another service's account or API key (GitHub, Gmail, a paid API, an MCP server that wants a token):

- Never ask the user to paste a key, token or password into chat, and never invent an OAuth or setup flow.
- Do not add an MCP server whose credential is not already provided — it will start without one and fail.
- Tell the user plainly which service it is, what credential it needs, and that the operator must add that service to the host's credential proxy before you can use it. Load `/native-proxy-gateway` if they ask what that involves.

Public, unauthenticated APIs and websites work normally.
