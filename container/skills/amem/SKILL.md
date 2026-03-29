---
name: amem
description: A-MEM agentic memory protocol. Write structured notes to memory/notes/ with frontmatter, links, and quality conventions. Use memory_search before creating notes to avoid duplication and build the knowledge graph.
allowed-tools: Edit, Write, mcp__nanoclaw__memory_search, mcp__nanoclaw__memory_get, mcp__nanoclaw__memory_list, mcp__nanoclaw__get_file_url, mcp__nanoclaw__get_file_path
---

# A-MEM Note Protocol

Notes live at `memory/notes/MEM-YYYY-MM-DD-{slug}.md` in your workspace. The embedding index picks up new files within 3 seconds.

## Creating a note (4 steps)

1. **Draft** content
2. **Search** for existing notes before writing:
   ```
   memory_search({ query: <draft content>, path_prefix: "memory/notes/", limit: 10, min_score: 0.6 })
   ```
   If a note already covers the same claim, extend or supersede it rather than creating a duplicate.
3. **Write** the note with `links:` populated from search candidates
4. **Back-link**: for the top 3 search candidates, `memory_get({ path })`, read their `links:` field, and add this note's ID to each

## Note format

```
---
id: MEM-YYYY-MM-DD-{slug}
created: YYYY-MM-DD
keywords: [term1, term2, term3]
tags: [tag1, tag2]
links: [MEM-other-id]
supersedes: null
sources:
  - type: file          # file | url | conversation
    path: memory/reports/YYYY-MM-DD-{slug}.md
    mtime: YYYY-MM-DDTHH:MM:SSZ
  # - type: url
  #   url: https://example.com/article
  #   last_fetched: YYYY-MM-DDTHH:MM:SSZ
  # - type: conversation
  #   date: YYYY-MM-DD
---

Body text. Preserve reasoning verbatim.

## References

- [Author Year — Title](dashboard-url)
- [Related report](dashboard-url)
```

- `id` — matches the filename, used for machine traversal
- `keywords` — specific terms for BM25 recall
- `tags` — broad categories for graph filtering in the dashboard
- `links` — bare note IDs only (no URLs); the graph is built from these
- `supersedes` — ID of the note this one replaces, or `null`
- `sources` — always populate with the origin of the note material. For `type: file`, record `mtime` at creation time so a future sweep can detect when source material has changed. For `type: url`, record `last_fetched`. For `type: conversation`, record the `date`.

## Reference URLs

Use `mcp__nanoclaw__get_file_url` to generate all dashboard links — never construct URLs manually:

```
get_file_url({ file_path: "/workspace/group/memory/notes/MEM-2026-01-01-foo.md" })
```

- **Other notes** → bare ID in `links:` frontmatter; optionally a descriptive link in the body
- **Local files** (reports, Zotero exports) → `get_file_url` with the absolute container path
- **External URLs** → full markdown link syntax: `[Title](https://...)` — bare domains don't render as links
- **Original sources** → always link in the `## References` section, even for informal sources like podcasts

To reverse a dashboard URL back to a local path: `get_file_path({ url })` returns the absolute container path (e.g. `/workspace/group/memory/notes/foo.md`). For `memory_get`, strip the `/workspace/group/` prefix to get the relative path.

## Reporting notes to the user

When reporting a newly created note to the user, always include the web UI link to it. Use `get_file_url` to generate the link.

## Quality conventions

**Original sources** — every note must link to its source in `## References`. Never omit it.

**Falsification conditions** — every prescriptive or empirical claim needs a specific condition that would falsify or supersede it. Without this, consolidation silently expands claims.

> Instead of: "retrieval precision degrades with scale"
> Write: "retrieval precision degrades with scale _unless_ the index is partitioned by recency and topic — in which case it holds up to ~10k notes (see [source])"

**Verbatim rationale** — preserve reasoning verbatim, not summarised. "Timing attacks are possible if requests arrive out of order" carries its own justification; "Don't do X" loses it. The verbatim form survives context compression; the summarised form does not.

## Superseding notes

When a note is no longer accurate, create a replacement note with:

- `supersedes: MEM-old-id`

Then update the old note's `supersedes` field to `null → MEM-new-id` and add a comment at the top of the old note body:

```
> Superseded by [MEM-new-id](dashboard-url) — YYYY-MM-DD
```

## Searching existing notes

Use `memory_search` proactively when the topic seems knowledge-base-relevant — you don't need to announce it:

```
memory_search({ query: "...", path_prefix: "memory/notes/", limit: 6 })
memory_list({ path_prefix: "memory/notes/", order_by: "mtime", limit: 20 })
memory_get({ path: "memory/notes/MEM-2026-01-01-foo.md", parse_frontmatter: true })
```

Pass `include_content: true` to `memory_search` to get full file text in a single call (limit capped at 10).
