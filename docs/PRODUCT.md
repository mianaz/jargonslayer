# JargonSlayer Product Design

**One line**: a real-time English meeting comprehension assistant for non-native speakers — transcribes as the meeting happens, and instantly surfaces cards explaining slang, business jargon, metaphorical expressions, and proper nouns; a bilingual summary and study cards are auto-generated after the meeting.

## Target users and scenarios

Chinese and other non-native-English-speaking professionals/researchers who read and write English fine, but often get stuck on two things in live English meetings:

1. **Non-literal expressions**: "move the needle", "boil the ocean", "table this" — every word is familiar, but strung together the meaning is unclear, and by the time you catch up the meeting has moved on.
2. **Proper nouns and acronyms**: ARR, OKR, Series B, internal product codenames — native speakers parse these instantly, while non-native speakers need a few seconds to search their memory.

JargonSlayer's positioning is **the colleague listening in beside you**: it doesn't interrupt the meeting, and tells you "what this sentence actually means" in the sidebar with the fewest possible words.

## Core features

### 1. Real-time transcription (multi-engine, local/cloud labeling)

| Engine | Audio destination | Best for |
|---|---|---|
| Browser recognition (Web Speech API) | Cloud (browser vendor's servers) | Everyday quick use, zero config, best on Chrome/Edge |
| Local Whisper | Local | Privacy-sensitive meetings, faster-whisper sidecar |
| Tab audio | Local | Transcribing the other party's audio in online meetings, no virtual sound card needed |

"演示" (Demo) is a standalone button in the top-right corner (a built-in scripted business-meeting recording that simulates realistic speaking pace), not listed alongside the engines. Each engine's local/cloud attribute is labeled both in the selection UI and in the top bar. Transcription is displayed segmented by speech turn, with timestamps and speaker labels: uploaded recordings go through pyannote batch diarization; live meetings can enable real-time diarization (beta, labels progressively corrected); labels are clickable to rename. Unfinalized interim recognition results trail behind in gray italics.

### 2. Real-time expression detection and explanation

- Context-aware: the most recent ~800 characters are sent to the LLM as context, extraction runs only on newly added text, able to distinguish "table this" (shelve the topic) from the literal meaning of "table".
- Card fields: original expression, category, contextual meaning (English), Chinese explanation, plain-English rewrite, tone annotation, confidence, source sentence.
- Proper nouns/acronyms go through a separate terms channel, displayed as the same card format as expression cards (blue color scheme to distinguish them, gold is for expressions).
- New cards get a gold highlight for about 4 seconds; a repeat of the same expression within 8 minutes only increments +1 on the original card with a light pulse, no feed flooding.
- Expressions detected in the transcript are marked with a gold dashed underline, clickable to jump to the corresponding card.
- Selecting any span of text in the transcript triggers an ad-hoc "look it up" explanation.
- Without an API Key, automatically falls back to the built-in dictionary (370+ entries, 10 topic packs, business/academic etc. enabled as needed; supports installing community packs from GitHub), shown with a "Dictionary Mode" label, works out of the box.

### 3. Post-meeting artifacts (one-click generation)

- **Bilingual summary**: topic / key points / decisions / action items, Chinese-English side by side.
- **Full transcript translation**: paragraph-by-paragraph English-Chinese aligned transcript.
- **Study cards**: expressions detected in real time + one full-transcript "gap-fill" scan, merged and deduplicated, sorted by occurrence count; exportable as Anki TSV.
- **Cornell notes**: parchment-style notes with jargon highlighted in the transcript body + numbered annotations in the right column + a summary at the bottom, exportable as a PNG image / Markdown, suited for review and sharing.
- Export formats: Markdown report, Anki TSV, full JSON data; can be configured with an auto-save-to-disk folder and webhook (agent-native, see AGENT-WORKFLOWS.md).

### 4. Meeting history

- All sessions are stored in browser IndexedDB, never uploaded to any server.
- The history list supports reopening, deleting, and searching (by title or by expressions that have appeared).

### 5. Personal glossary and review (/review)

- **Personal glossary**: select text and "加入我的词典" (Add to My Glossary) (AI forces an explanation + writes an original example + keeps the original meeting sentence), or add manually; entries participate in real-time detection across future meetings, taking priority over the built-in dictionary, and their content is never overwritten by the AI.
- **Review page**: data overview (meeting count / cumulative expressions / Top frequency / new this week) + frequency word cloud (clicking links to the Top 10) + flashcard practice mode (flip cards, mark "mastered/review again").
- **Domain model**: the review object is the personal glossary; mastery state exists only on glossary entries; meeting records are an immutable archive, entering the learning flow via "one-click bookmark this meeting's cards". Heavy-duty spaced repetition is left to Anki (TSV export); the in-app practice is lightweight only.

## Data and account strategy (explicit decisions)

- **No login, no account**: a single-user tool — an account only makes sense once this becomes a multi-user product. The Next.js server is a stateless proxy, storing no user data.
- **Storage**: meetings/glossary/settings all live in browser IndexedDB (about 100–200KB per meeting, no strain at hundreds of meetings); the API Key is stored locally and sent directly with each request; tutorial state is marked in localStorage.
- **Persistence safeguards**: requests `navigator.storage.persist()` on launch (guards against Safari's 7-day eviction and quota cleanup); provides full backup export/import (a single JSON file), which also covers the device-migration scenario.
- **Export-portability first**: Markdown / Anki TSV / JSON / copy-to-clipboard are the primary paths; Obsidian is just a "with frontmatter" toggle on Markdown export, not a standalone dependency.

## Differentiation trade-offs

- **Does not** do word-by-word dictionary lookups (browser extensions already do this well) — only handles "literal meaning ≠ actual meaning" expressions.
- **Does not** build a general-purpose meeting bot (a bot that joins the meeting) — microphone capture + loopback capture already covers the personal-use scenario, with better privacy control.
- Explanation copy is deliberately kept short: Chinese explanation ≤40 characters, plain-English rewrite ≤10 words — there's no time to read paragraphs during a live meeting.
- Real-time detection defaults to Haiku (latency and cost), post-meeting reports use Sonnet (quality); both models are configurable in Settings.

## Cost estimate (60-minute, ~9000-word meeting)

- Real-time detection (Haiku 4.5, with system-prompt caching): ≈ $0.5
- Post-meeting summary + full-transcript translation + gap-fill (Sonnet 5): ≈ $0.3–0.55
- Total about **$1/meeting**; dictionary-only mode is $0.
</content>
