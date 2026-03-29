---
name: add-researcher
description: Set up an intake group — a quarantined NanoClaw group that produces unbiased summaries of external items (RSS, URLs, Zotero, digests) without access to existing memory. The main agent sends items to it via schedule_task and receives staged summaries via deliver_result. Requires a messaging channel to be configured.
---

# Add Researcher (Intake Group)

The intake group is an isolated NanoClaw group with its own container and filesystem. Because it has no access to the main group's memory or notes, its summaries are unbiased — it reports what the source says, not what it means relative to existing knowledge. The main agent then decides what to synthesise into the A-MEM graph.

The pattern: main agent sends an item → intake group summarises faithfully → writes staging file → calls `deliver_result` → main agent synthesises into `memory/notes/`.

## 1. Check prerequisites

A messaging channel must already be configured — intake needs its own chat JID.

```bash
grep -E "^(WHATSAPP_|TELEGRAM_BOT_TOKEN|SLACK_|DISCORD_|DELTACHAT_)" .env 2>/dev/null | sed 's/=.*//' | head -5 || echo "No channel keys found"
```

If no channel is configured, tell the user to run the relevant channel skill first (`/add-whatsapp`, `/add-telegram`, etc.).

## 2. Choose channel and group name

AskUserQuestion: Which channel will the intake group use?
- Same channel as the main group (user needs to create a new chat/group there)
- A different channel

The folder name follows the convention `{channel}_{name}`, e.g. `deltachat_intake`, `telegram_intake`, `whatsapp_intake`. Ask the user to confirm the name or accept the default: `{channel}_intake`.

## 3. Create the group directory

```bash
FOLDER=<chosen folder>
mkdir -p groups/$FOLDER/intake
```

Check if it already exists:

```bash
ls groups/$FOLDER/CLAUDE.md 2>/dev/null && echo "EXISTS" || echo "NEW"
```

If it exists: AskUserQuestion — overwrite CLAUDE.md or skip?

## 4. Write CLAUDE.md

Write `groups/$FOLDER/CLAUDE.md`:

```markdown
# Intake Agent

You are {ASSISTANT_NAME}, operating in the **Intake group** — a quarantined
processing environment for external data sources.

## Purpose

This group receives and processes raw external input: RSS feeds, articles,
Zotero additions, digests, and other inbound data. Your job is to summarise
faithfully what the source says — not to interpret it relative to other
knowledge, make connections to existing notes, or update any knowledge graph.

## What You Do Here

- Summarise external content accurately and objectively
- Note what the source claims, its key data points, and any links
- Write structured output to `/workspace/group/intake/` as staging files
- Send a brief summary to the user in this chat

## What You Do NOT Do Here

- Connect findings to existing memory notes or research topics
- Apply A-MEM note-writing instructions — those apply only in the main group
- Make judgements about relevance to ongoing work

## Output Format

Write intake files to `/workspace/group/intake/YYYY-MM-DD-{source}-{slug}.md`.

Once written, send a brief message with the title and a one-sentence summary.
The main {ASSISTANT_NAME} instance decides what to synthesise into the knowledge graph.

## Completion

After writing the intake file and sending the summary message, call
`deliver_result` with a one-line completion notice — the filename and
one-sentence summary. This notifies the main {ASSISTANT_NAME} instance that
new staged content is ready for synthesis.

## Messaging Formatting

Do NOT use markdown headings (##) in messages. Only use *Bold*, _Italic_, • Bullets.
```

Replace `{ASSISTANT_NAME}` with the value from `grep -E "^ASSISTANT_NAME=" .env` (default: `Andy`).

## 5. Register the group with NanoClaw

The intake group needs a real chat JID. Walk the user through creating one:

**DeltaChat:** Create a new group chat in DeltaChat (e.g. named "Intake"). Add the bot address as a member.

**Telegram:** Create a new group, add the bot, then get the chat ID:
```bash
# After adding bot, check recent updates for the chat_id
curl -s "https://api.telegram.org/bot$(grep TELEGRAM_BOT_TOKEN .env | cut -d= -f2)/getUpdates" | grep -o '"id":-\?[0-9]*' | head -5
```

**Slack/Discord:** Create a new channel and note the channel ID from the URL or settings.

Once the user has the JID, register via `register_group`. The simplest way is to tell the user to send this message to their main registered group:

> `register group jid={JID} name=Intake folder={FOLDER}`

Or register directly via the NanoClaw database if the main agent is available:

```bash
npx tsx -e "
import { db } from './src/db.js';
db.prepare('INSERT OR REPLACE INTO groups (jid, name, folder, trigger, trusted) VALUES (?,?,?,?,?)').run(
  '{JID}', 'Intake', '{FOLDER}', '@{ASSISTANT_NAME}', 0
);
console.log('Registered');
"
```

Note the JID for confirmation:

```bash
sqlite3 store/nanoclaw.db "SELECT jid, name, folder FROM groups WHERE folder = '{FOLDER}';"
```

## 6. Done

Tell the user:

- The intake group is registered at `groups/{FOLDER}/` with JID `{JID}`
- The main agent can send items to it via `schedule_task` with `target_group_jid: "{JID}"`
- Staged files appear in `groups/{FOLDER}/intake/` and in the dashboard Files tab
- After the intake agent calls `deliver_result`, the main agent sees the summary and can choose to synthesise it into `memory/notes/` using the A-MEM protocol

Example invocation the main agent would use:
```
schedule_task({
  prompt: "Summarise this RSS item: {url or content}",
  schedule_type: "once",
  context_mode: "isolated",
  target_group_jid: "{JID}"
})
```
