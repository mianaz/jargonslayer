# JargonSlayer · Real-Time English Meeting Comprehension Assistant

*英文会议实时理解助手*

The product UI is Simplified Chinese, built for non-native English speakers. It listens in on your English meetings and turns **business slang, metaphors, indirect phrasing, and jargon** into short Chinese cards in real time; when the meeting ends, one click generates a **bilingual summary + full transcript translation + study cards**. All data stays on your machine.

English caption: the mock below shows the actual product UI (Simplified Chinese) — live transcript on the left, real-time explanation cards on the right.

```
┌──────────────────────────────┬──────────────────────┐
│  实时转录（分段/说话人/时间戳）  │  实时解释卡片          │
│                              │  · move the needle   │
│  Sarah: We need something    │    产生实质性影响…     │
│  that can really move the    │  · 术语: ARR OKR …    │
│  needle this quarter.        │  ────────────────    │
│                              │  纪要与导出            │
└──────────────────────────────┴──────────────────────┘
```

## Feature overview

- **Real-time transcription**: browser recognition (cloud) / local Whisper / tab audio (the latter two never leave the machine), each engine labeled "local / cloud" for data destination; a built-in zero-dependency demo shows the full flow.
- **Real-time expression detection**: an LLM uses surrounding context to explain only expressions where "literal meaning ≠ actual meaning"; proper nouns/acronyms get their own term entries. Without an API Key it falls back to a built-in dictionary (370+ entries, 10 optional topic packs including business/academic), and can also install community dictionary packs from GitHub. Explanation language can be switched to Chinese or English.
- **Card experience**: gold-bordered expression cards and blue-bordered term cards share one card style; the newest card expands while others stay collapsible; repeat occurrences only increment a counter instead of flooding the feed; gold dashed underlines in the transcript are clickable to jump to a card; selecting any text triggers an ad-hoc lookup, one click away from being added to "My Glossary".
- **Speakers**: upload a recording for automatic transcription + speaker diarization (background progress, auto-loads on completion); real-time diarization (beta, runs locally, labels are progressively corrected as the meeting proceeds); click a speaker label to rename it.
- **Post-meeting artifacts**: bilingual summary (topic/key points/decisions/action items), paragraph-aligned full transcript, study cards, **Cornell notes** (body highlights + right-column annotations + summary, exportable as PNG image/Markdown); plus Markdown / Anki TSV / JSON export with auto-save-to-disk and webhook support.
- **Learning center**: the `/review` page has stats, a frequency Top 10, a word cloud, and flashcard practice; your personal glossary feeds into detection in subsequent meetings.
- **BYOK / multi-model**: direct Anthropic access or any OpenAI-compatible endpoint (DeepSeek/Qwen/OpenRouter/Ollama); the Key is stored locally in the browser only.
- **Meeting history**: everything is stored in browser IndexedDB, no account, with search across past expressions; one-click full backup/restore.

## Quickstart

```bash
cd jargonslayer
npm install
npm run dev
# Open http://localhost:3000
```

On first launch, an onboarding tour pops up. **Click "演示" (Demo) in the top-right first** — no microphone or API Key needed to see the full transcription → detection → cards → post-meeting report flow (without a Key, the demo runs on the built-in dictionary).

## Configure an API Key (unlocks AI detection and post-meeting reports)

The built-in dictionary can only match fixed phrases; adding an Anthropic API Key unlocks context-aware AI detection (able to tell whether "table this" means "shelve the topic" or literally putting something on a table) plus post-meeting summaries/translation. Two options:

1. **Fill it in via the UI** (recommended for personal use): top-right ⚙ Settings → AI Detection → API Key. The Key is stored only in your local browser and sent directly with each request — never written to any server.
2. **Environment variable**: create `.env.local` in the project root:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   Then restart `npm run dev`.

Get a Key from [console.anthropic.com](https://console.anthropic.com/). Default models: `claude-haiku-4-5` for real-time detection (fast, cheap), `claude-sonnet-5` for post-meeting reports (quality) — both are configurable in Settings.

**Cost reference**: for a 60-minute, ~9000-word meeting — real-time detection is about $0.5, post-meeting reports about $0.3–0.55, roughly $1/meeting combined; dictionary-only mode is $0.

## Transcription engines

| | Setup cost | Audio destination | Recommended use |
|---|---|---|---|
| Browser recognition | None | Browser vendor's speech service (**cloud**) | Daily, non-sensitive meetings (Chrome/Edge) |
| Local Whisper | One-time Python environment setup | **Never leaves the machine** | Sensitive content, offline use, wants more stable recognition |
| Tab audio | Same as above (via local sidecar) | **Never leaves the machine** | Transcribing the other party's audio in online meetings (no virtual sound card needed) |

Every engine in the UI carries a "local / cloud" label; the current engine's data destination is visible at a glance in the top bar. "演示" (Demo) is not an engine — it's a button in the top-right corner that shows the full flow with no microphone and no Key required.

### Local Whisper (privacy mode)

```bash
cd sidecar
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python whisper_server.py --model small
# Once you see "ws://127.0.0.1:8765 等待连接" (waiting for connection),
# go back to the web page: Settings → Transcription Engine → Local Whisper → Start Listening
```

Model recommendations (measured on Apple Silicon):

| Model | Quality | Speed | Best for |
|---|---|---|---|
| `tiny` / `base` | Basic | Very fast | Trying it on low-spec machines |
| `small` (default) | Good | Real-time, no strain | **Recommended for daily use** |
| `medium` | Better | Near real-time | Heavy accents, technical vocabulary |
| `large-v3` | Best | Slower | Post-meeting re-transcription, not recommended for real-time |

Common flags: `--language en` (default), `--partials` (also emits gray interim results while speaking, more CPU-intensive), `--save-audio meeting.wav` (keeps the recording for post-meeting speaker diarization).

### ⚠️ Transcribing "the other party's audio" (must-read for online meetings)

The microphone can only hear **you**. In Zoom/Teams/Meet, the other party's audio comes out of your speakers, so you need to turn **system audio** into an "input device":

- **macOS**: install [BlackHole](https://github.com/ExistentialAudio/BlackHole) (free virtual sound card) → in System Settings create a "Multi-Output Device" (headphones + BlackHole, so you still hear audio normally) → in JargonSlayer settings, set the microphone to BlackHole, and use **Local Whisper** as the engine (the browser recognition engine doesn't respect virtual device selection — it always uses the system default input).
- **Windows**: VB-Cable works the same way.
- To transcribe both you and the other party simultaneously: on macOS, an "Aggregate Device" can combine microphone + BlackHole into one input.

## Usage flow

1. Pick an engine → "开始监听" (Start Listening) (the browser will request microphone permission).
2. Watch the transcript on the left, "实时解释" (Real-Time Explanations) cards on the right; expressions with a gold dashed underline are clickable; selecting a span of text pops up an ad-hoc explanation.
3. "停止" (Stop) → automatically saved to history → right side "纪要与导出" (Summary & Export) → "生成会议报告" (Generate Meeting Report).
4. Export a Markdown report / Anki cards (TSV can be imported directly into Anki: File → Import, fields tab-separated).
5. 🕘 In history, reopen any past meeting, searchable by expression ("哪次会说过 boil the ocean?" — which meeting mentioned "boil the ocean"?).

## Speaker diarization (optional)

Both paths are already built into the UI — no scripting required. Shared one-time setup:

1. `pip install pyannote.audio` (into the sidecar's `.venv`);
2. Free HuggingFace account → accept the usage terms for three models in order: [segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0), [speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1), [speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) (a new dependency added in pyannote 4.x — skipping it causes a 403);
3. Create a Read-scoped token, fill it into Settings → Speaker Diarization (or pass `--hf-token` when starting the sidecar).

**Upload-a-recording auto-diarization**: 🕘 History → "导入录音" (Import Recording), pick an audio file (m4a/mp3/wav); it transcribes + diarizes in the background and auto-loads on completion, with speakers shown as colored labels — click a label to rename it (e.g. SPEAKER_1 → Elena).

**Real-time diarization (beta)**: Settings → Speaker Diarization → "实时说话人分离（beta）" (Real-Time Speaker Diarization (beta)). During a meeting, labels appear a few seconds late and are progressively corrected as the meeting proceeds; this uses more CPU, but transcription itself is unaffected.

> Note: the sidecar's `.venv` contains absolute paths — **after moving or renaming the project directory, you must delete and rebuild it** (`rm -rf .venv && python3 -m venv .venv && pip install -r requirements.txt`), otherwise you'll get a "bad interpreter" error. A future release plans to fold this step into the UI.

## Privacy boundaries (stated explicitly)

| Data | Destination |
|---|---|
| Audio (local Whisper) | Local only, websocket via 127.0.0.1 |
| Audio (browser recognition) | Browser vendor's speech service (Google/Apple) |
| Transcript text (AI detection enabled) | Sent to the Anthropic API for detection/summarization |
| Transcript text (dictionary mode) | Local only |
| Meeting history, settings, API Key | Local browser only (IndexedDB / localStorage) |

To keep all text from ever leaving the machine: enable "仅词典模式" (Dictionary-Only Mode) in Settings.

## FAQ

- **"浏览器不支持语音识别" (browser doesn't support speech recognition)**: Safari/Firefox have poor Web Speech API support — use Chrome/Edge, or switch to local Whisper.
- **Can't connect to Whisper**: confirm the sidecar terminal is still open and the address is `ws://localhost:8765`; make sure your firewall allows the local port.
- **Too few / too many cards**: adjust the "置信度阈值" (Confidence Threshold) in Settings (lower = more), or switch detection models.
- **Detection slows down while the meeting tab is in the background**: expected — browsers throttle background timers; switching back triggers an immediate catch-up check. This has already been mitigated as much as possible with event-driven flushing.
- **Report generation is slow**: full-transcript translation for long meetings runs in parallel chunks, so 1–2 minutes is normal; if you only want the cards, you can skip report generation and export directly.

## Tech stack and architecture

Next.js 15 (App Router) + TypeScript + Tailwind + zustand + IndexedDB; LLM calls go through the Anthropic Messages API (server-side route proxy, supports structured output); local transcription via a faster-whisper sidecar (websocket + energy-based VAD). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/PRODUCT.md](docs/PRODUCT.md) for details.
</content>
