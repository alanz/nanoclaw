# Web UI — remaining work

## Bugs

1. **Markdown rendering** (`src/web-ui.ts` `openFile`)
   `mdDiv.innerHTML += parsedDiv.outerHTML` wipes the already-appended frontmatter
   card. Body content doesn't render. Fix: use `mdDiv.appendChild(parsedDiv)`.

2. **Graph node selection / animation** (`loadGroupGraph` / `renderGraph`)
   `pendingGraphSelect` calls `graphCy.animate()` but the Cytoscape instance is
   created with `container: null` so it has no canvas. Node highlighting is a no-op.
   Fix: implement highlight in the D3 SVG layer instead of via Cytoscape.

3. **Messages API — inactive sessions** (`/api/messages` handler)
   Session lookup uses `getActiveSessions()` so sessions with `status != 'active'`
   are not found. Fix: use `getSession(id)` (no status filter).

## Missing features

4. **Extra mounts in file tree**
   Groups can have `additionalMounts` in `container.json`. These aren't shown in the
   file tree. V1 exposed them under `extra/` in the tree. Read `container.json` per
   group and append extra dirs.

5. **Orphan container count in overview**
   Stubbed to 0. V2's container runtime has no list-containers export. Fix: shell out
   to `container ls --format json` (same approach as `cleanupOrphans` in
   `src/container-runtime.ts`) and cross-reference against active session IDs.

## Deferred (not ported from v1)

6. **Specialists section** — v2 has a specialists module but schema wasn't checked.
7. **RSS feeds section** — not confirmed in v2 schema.
8. **Scheduled tasks tab** — v2 has a scheduling module; schema needs checking before porting.
