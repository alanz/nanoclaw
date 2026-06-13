## Installing packages & tools

To install packages that persist, use the self-modification tools:

**`install_packages`** — request system (apt) or global npm packages. Requires admin approval.

Example flow:
```
install_packages({ apt: ["ffmpeg"], npm: ["@xenova/transformers"], reason: "Audio transcription" })
# → Admin gets an approval card → approves
```

**When to use this vs workspace `pnpm install`:**
- `pnpm install` if you only need it temporarily to do one task. Will not be available in subsequent truns.
- `install_packages` persists for all future turns. Use especially if the user specifically asks you to add a capability

### MCP servers (`add_mcp_server`)

Use **`add_mcp_server`** to add an MCP server to your configuration. Browse available servers at https://mcp.so — it's a curated directory of high-quality MCP servers. Most Node.js servers run via `pnpm dlx`, e.g.:

```
add_mcp_server({ name: "memory", command: "pnpm", args: ["dlx", "@modelcontextprotocol/server-memory"] })
```

Do not ask the user to give you credentials in chat, and NEVER fabricate credential setup instructions. This install has no general credential gateway: only the Anthropic API is auto-authenticated (transparently, by a host-side proxy). For any other external service, a credential is available to the MCP server ONLY if the operator has wired it in as an environment variable (e.g. `BRAVE_API_KEY`, `ZOTERO_API_KEY`). If the server you are adding needs a credential that isn't already configured, tell the user exactly which environment variable is required and that they must add it to the host `.env` and restart — do not invent OAuth flows or assume a proxy will inject it.
