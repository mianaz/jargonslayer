# JargonSlayer × Agent Workflows

> **Languages:** English · [简体中文](zh/AGENT-WORKFLOWS.md)

**Design stance**: JargonSlayer does not bundle third-party OAuth connectors. It delivers data in agent-friendly formats to the **filesystem** and **webhooks**; orchestration happens in your own harness (Claude Code, n8n, cron, any MCP client). Bundling N vendor connectors means maintaining N sets of APIs and token lifecycles, and a power user's own orchestration layer is already better at this than we could be. Data format contracts are in [SCHEMA.md](SCHEMA.md).

## Data exits (four, all account-free)

| Exit | Trigger | Form |
|---|---|---|
| Auto-save to disk | Every session save | `{date}-jargonslayer.md` (frontmatter) + `.json` in a designated folder |
| Webhook | Every session save | POST `{event: "meeting.saved", session}` to a custom URL |
| Manual export | Button | Markdown report / Anki TSV / JSON / clipboard |
| Full backup | Settings page | A single JSON (sessions + glossary + settings) |

## Recipes

### 1. Claude Code: meeting summary → weekly-sync slides

With the auto-save-to-disk directory set to a repo/folder:

```bash
cd ~/meetings
claude "Use the pptx skill to turn 2026-07-06-1430-jargonslayer.md into a 5-slide
weekly sync deck: topic slide, key points, decisions, action items (grouped by owner),
next-week placeholder"
```

Similarly you can do: cross-meeting comparison ("across these three meetings, how are action items tracking to closure"), or a monthly progress digest for your advisor.

### 2. Obsidian: the vault as an inbox

Point the auto-save-to-disk directory straight at a vault subfolder (e.g. `vault/Meetings/`). The frontmatter is naturally queryable by Dataview:

```dataview
TABLE duration_min AS "Minutes", length(expressions) AS "New expressions"
FROM "Meetings" WHERE source = "jargonslayer" SORT date DESC
```

### 3. n8n / automation platforms: webhook fan-out

Point the webhook URL at n8n's Webhook node; a typical flow: `Webhook → extract session.summary → create a Notion page via API + post a card to a Feishu bot`. Payload structure is in SCHEMA.md §3; the receiving end should return 200 immediately and process asynchronously (the client has an 8s timeout with no retry).

### 4. Command-line batch analysis

```bash
# Top 20 most frequent expressions across meetings
jq -r '.session.cards[].expression' *.json | sort | uniq -c | sort -rn | head -20

# All action items for a given speaker
jq -r '.session.summary.summary.action_items[] | select(.owner=="Mike") | .en' *.json
```

### 5. Heavy-duty review in Anki

Export TSV from the summary page → Anki File → Import (tab-separated, field 1 = front, field 2 = back, HTML allowed). The in-app practice mode is lightweight flashcard flipping only; the right tool for spaced repetition is Anki.

## Connector design blueprint (not implemented, interface already in place)

A build guide for anyone who wants to extend this (or for us, later):

1. **MCP server (`jargonslayer-mcp`)**: a stdio MCP that reads the auto-save-to-disk directory — resources expose each meeting, tools provide `search_expressions(query)` / `get_summary(date)`. Since the data is just JSON on disk, this needs zero contact with the app itself; achievable in ~150 lines. Drop-in with Claude Desktop/Code.
2. **Real-time cloud STT adapter**: the `STTEngine` interface (`src/lib/types.ts`) is the extension point — implement `start(events, settings)/stop()`, map Deepgram/AssemblyAI's ws stream onto `onInterim/onFinal`, and register it into the engine factory. Cloud transcription for the upload path (OpenAI-compatible `/audio/transcriptions`) is already built in and can serve as a reference implementation.
3. **Push orchestration**: webhook → Feishu/DingTalk/Slack bot. Suggested template: card title = meeting topic (zh), fields = action item list, button = open the saved `.md` file. All logic lives on the receiving end.
4. **Calendar integration (roadmap)**: pre-fill the session title from a meeting title pulled from CalDAV/Google Calendar before the meeting; this is "reading external data" rather than "writing external data", so even building it into the app itself wouldn't violate the no-account principle (a local ICS file is enough to start).
5. **Community dictionary pack repository**: publish JSON to GitHub per SCHEMA.md §5; users paste the raw link into Settings → Pack Sources to install. A version bump alone triggers an update. Suggested repo layout: `packs/<id>/pack.json` + a PR intake process.

## Privacy reminder

Both auto-save-to-disk and webhooks send meeting content out of the browser sandbox (the former to local disk, the latter to a server you specify). Enabling either is treated as informed consent; "dictionary-only mode + no configured exit" = data never leaves the browser.
</content>
