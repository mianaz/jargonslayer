# JargonSlayer Technical Architecture

## Overview

```
Browser (Next.js client)
│
│  ┌─ Audio/Transcription layer ─────────────────────────┐
│  │ demo.ts        built-in scripted playback (no audio)│
│  │ webSpeech.ts   Web Speech API                       │
│  │ whisperSocket  mic→AudioWorklet(16k                 │
│  │                int16)→ ws://localhost:8765          │──► sidecar/whisper_server.py
│  └──────────────┬──────────────────────────────────────┘    (faster-whisper + energy-based VAD)
│                 │ onInterim / onFinal
│                 ▼
│        zustand store (the single bus)
│   segments · interim · cards · terms
│   summary · settings · sessions
│                 │ pushSegment(seg)
│                 ▼
│  ┌─ Detection layer ─────────────────────────────────────────┐
│  │ scheduler.ts  batch triggers(140 chars/3.5s/sentence end) │
│  │               ≤2 concurrent · drop out-of-order · fallback│──► POST /api/detect ──► Anthropic
│  │ dictionary.ts offline dictionary fallback                 │      (Haiku, structured output)
│  │ dedupe.ts     8-min TTL dedup · count merge               │
│  └───────────────────────────────────────────────────────────┘
│                 │ applyDetection
│                 ▼
│        UI (TranscriptPanel / CardsPanel / SummaryPanel / …)
│
└─ Post-meeting: POST /api/summarize ──► summary×1 + chunked parallel translation(≤4) + gap-fill×1 ──► SummaryResult
        History: IndexedDB (idb-keyval)          Export: Markdown / Anki TSV / JSON
```

## Module boundaries (file ownership)

| Layer | File | Responsibility |
|---|---|---|
| Contract | `src/lib/types.ts` | All cross-module types; LLM JSON field names are a wire contract |
| Contract | `src/lib/store.ts` | zustand bus; the STT layer and detection layer never import each other, only via the store |
| Contract | `src/lib/llm/prompts.ts` | 4 system prompts (detection/summary/translation/gap-fill) managed centrally |
| Transcription | `src/lib/stt/*`, `src/lib/audio/*`, `public/worklets/*` | All three engines implement the unified `STTEngine` interface |
| Transcription | `src/hooks/useMeeting.ts` | Lifecycle orchestration between engines and the scheduler |
| Detection | `src/lib/detect/scheduler.ts` | Real-time batching and fallback state machine (details below) |
| Detection | `src/lib/detect/dedupe.ts` | Pure-function merging: TTL dedup, counting, dictionary→LLM content upgrade |
| Detection | `src/lib/detect/dictionary.ts` | Offline dictionary (371 entries across 10 topic packs, including an academic-meeting pack; supports remote community packs) |
| Server | `src/app/api/detect/route.ts` | Validate → call Haiku → anti-hallucination filter (expression must appear verbatim in the source text) → cap output |
| Server | `src/app/api/summarize/route.ts` | Three-stage orchestration: summary → chunked translation (index-aligned + retry on gaps) → gap-fill |
| Storage | `src/lib/history/*` | IndexedDB session persistence; Markdown/Anki/JSON export |
| UI | `src/components/*`, `src/app/page.tsx` | Dark theme; page.tsx handles only layout and overlay orchestration |
| Local STT | `sidecar/whisper_server.py` | Real-time ws (16k int16→energy-based VAD→faster-whisper) + HTTP job endpoint (recording upload for batch transcription + pyannote speaker diarization) |
| Glossary/Review | `src/lib/history/glossary.ts`, `src/app/review/*` | Personal glossary (cross-meeting highlighting, mastery state) and learning center |
| Agent export | `src/lib/history/autoExport.ts` | Auto-save to disk (File System Access), webhook, full backup |

## Key decisions in the real-time detection pipeline

1. **Batch trigger**: unanalyzed text ≥140 characters, or 3.5s since the first unanalyzed segment, or sentence end (`.?!`) with ≥60 characters — whichever fires first. Hard cap of 1200 characters to prevent long monologues from overloading a batch. In practice most cards appear 2–5 seconds after the speaker finishes.
2. **Concurrency and out-of-order handling**: at most 2 requests in flight; each batch records the character offset range of the transcript stream, and if that range has already been superseded by a later batch's response by the time a response comes back, the whole response is dropped. Card order is determined by detection time, not response arrival order.
3. **Background throttling**: browsers throttle background-tab timers down to once-a-minute granularity, so flushing is driven by "segment arrival" events, forced on `visibilitychange`, with the timer only as a fallback.
4. **Fallback chain**: no Key (401) → dictionary mode; 2 consecutive upstream failures → dictionary mode; 429 → single jittered retry. Fallback only toasts once; the UI persistently shows a "Dictionary Mode" badge.
5. **Dedup semantics**: expressions are deduplicated by a normalized key (lowercased, edge punctuation stripped, light lemmatization on the last word); a repeat within an 8-minute TTL → the original card's count +1 with a brief pulse; when a dictionary card is later matched by the LLM, its content is **upgraded in place** (contextual explanation replaces the template explanation), count is preserved.
6. **Anti-hallucination**: the server drops any expression that doesn't appear verbatim in `new_text`; the prompt requires `source_sentence` to quote the original text exactly.
7. **Structured output**: prefers `messages.parse` + `zodOutputFormat` to enforce the schema; falls back to a plain call + bracket-balance scanning when the model doesn't support it. Both paths go through zod validation.
8. **Cost control**: the system prompt uses `cache_control` caching (saves about 65% of input tokens per call); a 60-minute meeting makes about 300 calls ≈ $0.5.

## Post-meeting pipeline

Clicking "生成会议报告" (Generate Meeting Report) fires a single `/api/summarize` request; the server orchestrates internally:

1. **Summary** (1 call, Sonnet): full transcript → bilingual JSON `{topic, key_points, decisions, action_items}`.
2. **Translation** (parallel chunks): each chunk ≤25 segments and ≤500 words, concurrency 4; both input and output carry segment index `i`, validated index-by-index; missing indices are batched into one repair call, any still missing get a placeholder — a single chunk failing doesn't take down the whole job.
3. **Gap-fill** (1 call): full transcript + an exclusion list of already-captured expressions → supplements missed items (≤10 expressions/≤6 terms).
4. **Flashcards**: assembled in code (not left to the LLM to format) — real-time cards + gap-fill results, deduplicated and merged.

## Privacy design

- Audio path: local Whisper stays entirely on 127.0.0.1; Web Speech goes through the browser vendor's service (disclosed in the UI and docs).
- Text path: AI detection/summarization is proxied through a Next.js route to Anthropic; under "dictionary-only mode", zero data leaves the machine.
- Persistence: everything lives in browser IndexedDB; the API Key is stored locally and sent directly with each request via the `x-jargonslayer-key` header, never persisted server-side.
- The server route is stateless and can run entirely offline (dictionary mode).

## Real-time speaker diarization (beta)

The answer to "pyannote's streaming latency is unacceptable" isn't a streaming model — it's **tail-window batch re-diarization**: the ws connection buffers all 16k PCM audio in a per-connection buffer, and roughly every ~20s (when new finals exist) runs a full pyannote pipeline pass on the most recent ≤600s window on a background thread, then writes stable labels back onto already-sent `final`s by time overlap (`speaker_update` message, addressed by `seg_id`, only sending changed items). Key design points:

- **Label stability**: the connection maintains a speaker registry (stable id → previous round's turns); each new clustering round is greedily one-to-one matched against the registry by turn overlap seconds (threshold 2s) — a match reuses the id, and only unmatched speech ≥3s mints a new id. IDs only increase, never swap, so pyannote's internal per-round numbering shuffle never leaks into the UI.
- **Rename always wins**: the frontend store maintains `speakerAliases` (stable id → user display name); auto-write-back always applies the alias mapping first, so after a user renames a speaker, every subsequent round's update re-applies the rename.
- **Fallback**: a single-flight lock (skip a round if it can't keep up — labels arrive late but transcription is never blocked); if pyannote is unavailable, it sends one `diar_status` message then goes silent for good; the shared pipeline singleton's loading and inference are both locked (mutual exclusion between the ws thread and the HTTP job thread).
- The timeline is wall-clock based, which naturally aligns with the audio buffer at 1x real-time; replay faster than real-time should go through the HTTP job endpoint (which diarizes by audio timestamp instead).

## Known limitations

- Web Speech API final results occasionally get revised (especially on Safari) — v1 treats finals as immutable, so detection offsets are anchored to the first final.
- Real-time diarization is beta: the first round pays the pipeline-loading cost (labels arrive 5-15s late), and a speaker who's been silent longer than the 600s window may get a new id when they speak again.
- The browser recognition engine doesn't support selecting a microphone device (an API limitation); the virtual-sound-card approach requires local Whisper.
</content>
