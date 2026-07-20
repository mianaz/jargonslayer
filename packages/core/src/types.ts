// ============================================================
// JargonSlayer shared contract — single source of truth for all
// cross-module types. Owned by the lead; workers code against it.
// ============================================================

// ---------- transcription ----------

// "import" (#43): not a live capture engine — segments come from a
// parsed transcript file/paste, processed fully offline in-browser
// except for the same /api/detect + /api/translate calls a live
// meeting makes. Never selectable in Settings/Header's engine picker
// (see createEngine in stt/index.ts, which throws on it) and never
// appears in the ENGINE_CARDS/ENGINE_OPTIONS arrays there.
//
// "browser-whisper" (#43 phase 2a): also not a live capture engine —
// an uploaded audio file is transcribed entirely in-browser (a Web
// Worker running @huggingface/transformers, see
// ingest/whisperBrowser.ts) and built into a session by
// ingest/importAudio.ts. Data path: 本地 — the audio never leaves the
// browser (no upload, unlike "whisper" which is the local Whisper
// sidecar reached over websocket). Never selectable in Settings/
// Header's engine picker and never appears in ENGINE_CARDS/
// ENGINE_OPTIONS there, same as "import".
export type STTEngineKind =
  | "demo"
  | "webspeech"
  | "whisper"
  | "tabaudio"
  // v0.5 Wave-1 Feature 4 (docs/design-explorations/v05-wave1-
  // blueprint.md §1 Feature 4 + §5 A4): tab audio WITHOUT the local
  // sidecar — getDisplayMedia capture piped into a CLOUD STT backend
  // (Soniox or Deepgram, see Settings.tabAudioCloudProvider) instead of
  // tabaudio's local faster-whisper sidecar. ONE kind covers both cloud
  // backends (avoids an STTEngineKind explosion per provider). This
  // Foundation lane lands only the kind + total migration/coercion
  // coverage (store.ts's applyPlatformEngineDefaults/applyTierDefaults
  // and migrateSettings' mode back-derivation all already know this
  // value) — the actual engine (lib/stt/tabAudioCloud.ts) is a later
  // lane's job. Unreachable from any picker until that lane adds its
  // ENGINE_CARD/ENGINE_OPTIONS entry — same "exists, not yet
  // selectable" posture osspeech/appaudio had between their own kind
  // landing and their UI wiring. Web-only for v0.5 (desktop already has
  // sidecar+appaudio) — applyPlatformEngineDefaults coerces a persisted
  // value to appaudio on desktop.
  | "tabaudio-cloud"
  // v0.4 S4: Soniox cloud STT (BYOK, experimental until the zh-en
  // benchmark clears it — docs/design-explorations/s4-model-wizard-
  // blueprint.md §E). Preview tier must never offer it: it joins
  // whisper/tabaudio's triple gate (ENGINE_CARDS/Header previewLocked +
  // store.ts applyTierDefaults coercion + key field disabled).
  | "soniox"
  // v0.4.7 (docs/design-explorations/stt-provider-wiring-2026-07.md,
  // Lane D): Deepgram Nova-3 cloud STT — second cloud engine, same BYOK
  // triple gate as soniox above (ENGINE_CARDS byokOnly + store.ts
  // applyTierDefaults coercion + key field disabled). English-only in
  // v0.4.7 (Nova-3's language=multi has no Chinese — soniox stays the
  // zh-en code-switching engine); lights up web + desktop from the one
  // browser-WS adapter (deepgramTransport.ts), no iOS v1 capture path.
  | "deepgram"
  // S9 (docs/design-explorations/s9-app-audio-tap-blueprint.md, D7):
  // desktop-only native app/system audio capture via a CoreAudio
  // process tap (apps/desktop/src-tauri's audiocap helper) — the
  // Zoom/Teams/WeChat-app case tabaudio can never cover (getDisplayMedia
  // only ever taps a browser TAB). Tauri-only (existing isTauri gate;
  // browser keeps tabaudio) and below the macOS 14.4 support floor
  // shows disabled — see lib/stt/appAudio.ts. D7 supersedes tabaudio on
  // desktop everywhere: every exhaustive Record/label map keyed by this
  // type, plus persisted-settings coercion both directions, must add
  // "appaudio" (S9.3 added the type + lib/stt-layer maps; S9.4 owns the
  // components-layer surfaces — ENGINE_CARDS/Header/SettingsDialog/
  // TutorialOverlay/history export labels/tier gating).
  | "appaudio"
  // S11 (v0.4.3, docs/design-explorations/s11-osspeech-blueprint.md) —
  // Zero-Install 系统识别: desktop-only, macOS 26+ on-device transcription
  // via Apple's SpeechAnalyzer, riding the SAME CoreAudio process tap
  // appaudio already taps (no local Whisper sidecar, no PCM ever leaving
  // the process). Every exhaustive Record/label map keyed by this type
  // must add "osspeech" — see lib/stt/osSpeech.ts for the wire contract.
  | "osspeech"
  | "import"
  | "browser-whisper";

export interface TranscriptSegment {
  id: string;
  index: number; // 0-based arrival order
  startedAt: number; // epoch ms, approximate utterance start
  endedAt: number; // epoch ms, when finalized
  speaker?: string; // DISPLAY string — demo mode, upload diarization, or
  // realtime diarization post-alias (see MeetingSession.speakerAliases)
  text: string;
  engine: STTEngineKind;
  // realtime speaker diarization (beta): this segment's sidecar-
  // assigned seg_id (from the `final` message), so a later
  // `speaker_update` can back-label it; and the RAW stable id
  // (SPEAKER_1/2/…) the sidecar last assigned, kept separate from
  // `speaker` so a user rename doesn't get clobbered by a later
  // auto-update (see store.ts renameSpeaker/applySpeakerUpdate).
  sttSeg?: number;
  sttSpeaker?: string;
  // v0.5 Wave-1 Feature 1 (per-segment speaker assignment, docs/design-
  // explorations/v05-wave1-blueprint.md §1 Feature 1 + §5 A2): true once
  // this segment's `speaker` was set by an explicit user action (single
  // assign / bulk multi-select / "this and after" / the live latch —
  // see store.ts's assignSegmentsSpeaker/assignSpeakerFollowing/addFinal)
  // rather than realtime diarization. Manual-wins: a LOCKED segment's
  // `sttSpeaker` still updates on a later speaker_update (the sidecar's
  // changed-only assignments carry the only copy of that raw id — see
  // A2), but `speaker` itself is never overwritten while locked. Cleared
  // by the 跟随识别 unlock action (store.ts's unlockSegmentSpeaker), which
  // recomputes `speaker` from the alias map. Absent/false = today's
  // realtime-diarization-wins behavior, unchanged.
  speakerLocked?: boolean;
}

export interface InterimState {
  text: string;
  speaker?: string;
}

export type STTStatus = "idle" | "connecting" | "listening" | "error";

export interface STTEvents {
  onInterim: (text: string, speaker?: string) => void;
  onFinal: (
    text: string,
    opts?: { speaker?: string; startedAt?: number; sttSeg?: number },
  ) => void;
  onStatus: (status: STTStatus, detail?: string) => void;
  // realtime speaker diarization (beta) — both optional, no-op unless
  // wired up (only wsTransport.ts's config gates them on: whisper/
  // tabaudio + realtimeDiarize + hfToken; see Settings.realtimeDiarize).
  onSpeakerUpdate?: (
    assignments: { segId: number; speaker: string }[],
    speakers: string[],
  ) => void;
  // "ready" (STT protocol v2): the sidecar's diarization arming
  // actually succeeded (diarize + token + pyannote all held) — see
  // wsTransport.ts's DiarStatusMessage and useMeeting.ts's one-shot
  // toast for it.
  onDiarStatus?: (state: "unavailable" | "error" | "ready", detail?: string) => void;
  // STT VAD supervisor (docs/design-explorations/stt-vad-supervisor.md):
  // a one-time "steer to a different engine" toast — e.g. Web Speech
  // hearing continuous speech it can't transcribe (language mismatch).
  // Advisory only: MUST NOT stop the meeting (never routed through
  // onStatus("error")) — the engine keeps retrying on its own backoff.
  onNotice?: (msg: string) => void;
  // On-device Web Speech (Chrome 139+, `processLocally` — see
  // docs/research/stt-live-engines-2026-07.md item #1 and
  // lib/stt/onDeviceSpeech.ts's decision core): fires once per engine
  // session, right after the session actually starts, with the mode
  // it ended up running in (post any defensive cloud fallback — never
  // the merely-decided mode if starting on-device threw and it fell
  // back). webspeech-only; other engines never call this. Lets
  // StatusLine's privacy indicator show the same green "音频在本地处理"
  // posture whisper/tabaudio use instead of the amber cloud warning.
  onEngineMode?: (mode: "on-device" | "cloud") => void;
}

// v0.4.7 Lane B (glossary -> recognizer bias, docs/design-explorations/
// stt-provider-wiring-2026-07.md §3/D3/D8): ONE tiered, deduped,
// priority-ordered (highest priority first) term list, built ONCE per
// engine.start() call at the meeting-start callsite
// (apps/web/src/hooks/useMeeting.ts's attachEngine) and passed
// explicitly — D8: adapters never read the store for this themselves.
// Purely structural (no zh strings) so it can live in core alongside
// STTEngine; the actual builder (glossary + packs + suppressed-
// learn-set tiering, D3) and every per-adapter projection/cap live in
// apps/web/src/lib/stt/lexicon.ts (D6 placement — core carries no zh
// strings/business logic; desktop/iOS both wrap the same apps/web
// bundle, so that placement already reaches every surface).
export interface MeetingLexicon {
  terms: string[];
}

export interface STTEngine {
  readonly kind: STTEngineKind;
  // `lexicon` (v0.4.7 Lane B, D8): optional so engines that don't
  // consume bias (webspeech: biasSupport "none"; demo) need not
  // declare/read a 3rd param at all — TS structurally allows an
  // implementation with fewer parameters than the interface declares.
  start(events: STTEvents, settings: Settings, lexicon?: MeetingLexicon): Promise<void>;
  stop(): Promise<void>;
  // Soft pause/resume (STT protocol v2, B4 pause matrix): OPTIONAL —
  // only engines that can keep their capture/transport alive through a
  // pause (tabaudio) implement these. useMeeting.ts's pause()/resume()
  // branch on `engineRef.current?.pause`/`?.resume` at call time: when
  // present, the engine instance is KEPT (not torn down/recreated) —
  // when absent, the existing teardown-pause branch (stop the engine,
  // reattach a fresh one on resume) is used instead, unchanged. See
  // Header.tsx's canPause for which engines get a pause affordance at
  // all.
  pause?(): Promise<void>;
  resume?(): Promise<void>;
}

// ---------- detection (wire format, field names are part of the
// LLM JSON contract — do not rename) ----------

export type ExpressionCategory =
  | "idiom"
  | "slang"
  | "phrase"
  | "metaphor"
  | "indirect"
  | "other";

export interface DetectedExpression {
  expression: string;
  category: ExpressionCategory;
  meaning: string; // in-context English meaning
  chinese_explanation: string; // 自然的中文解释，商务语境
  plain_english: string; // 直白的英文改写
  tone: string; // e.g. "neutral, common business phrase"
  confidence: number; // 0–1
  source_sentence: string; // verbatim sentence it appeared in
}

export type TermType =
  | "acronym"
  | "company"
  | "product"
  | "tech"
  | "metric"
  | "person"
  | "other";

export interface DetectedTerm {
  term: string;
  type: TermType;
  gloss_en: string;
  gloss_zh: string;
}

// ---------- UI cards = detection + bookkeeping ----------

export type DetectionSource = "llm" | "dictionary" | "custom";

export interface ExpressionCard extends DetectedExpression {
  id: string;
  normKey: string; // normalized dedup key
  firstSeenAt: number;
  lastSeenAt: number;
  count: number; // times re-detected
  source: DetectionSource;
  // Last time the DICTIONARY floor bumped this card (#54). Lets the
  // llm merge skip the count bump when the same occurrence was
  // already counted by the instant floor scan (see mergeDetections'
  // llmCountSuppressSince). Optional: absent on pre-#54 persisted
  // cards and on llm/custom-born cards — absent = never suppress.
  lastDictSeenAt?: number;
}

export interface TermCard extends DetectedTerm {
  id: string;
  normKey: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  source: DetectionSource;
  lastDictSeenAt?: number; // see ExpressionCard.lastDictSeenAt
}

// ---------- API contracts ----------

export type ExplainLanguage = "zh" | "en";

// Background profile (#48 step 3) self-reported English proficiency.
export type EnglishLevel = "basic" | "intermediate" | "advanced";

export interface DetectRequest {
  context: string; // previously analyzed tail, disambiguation only
  new_text: string; // fresh finalized text to analyze
  model?: string;
  lang?: ExplainLanguage; // explanation language, default "zh"
  // Pre-rendered background-profile hint (#48 step 3, design Q5):
  // threaded exactly like `lang` above — client renders it from
  // Settings.profile (llm/profileHint.ts), sent only when
  // profile.enabled. Spliced into the USER message ONLY (see
  // buildDetectUserMessage); the cached SYSTEM prompt never changes.
  profile?: string;
}

export interface DetectResponse {
  expressions: DetectedExpression[];
  terms: DetectedTerm[];
}

export interface SummarizeRequest {
  segments: { index: number; speaker?: string; text: string }[];
  expressions: DetectedExpression[]; // live-detected, seed for flashcards
  terms: DetectedTerm[];
  meetingTitle?: string;
  model?: string;
  lang?: ExplainLanguage; // affects the missed-items sweep only
  // Pre-rendered background-profile hint (#48 step 3) — same threading
  // as `lang` above: affects the missed-items sweep stage only (the
  // summary/translation stages stay untouched, same v1 scope as lang).
  profile?: string;
  // v0.4.5 detect-span QC (item 6, F3 field fix): the user's configured
  // idiom-category length caps (Settings.detectIdiomMaxWords/Chars),
  // threaded through so the sweep stage (which runs server-side on the
  // default web transport) honors the SAME caps the live/import detect
  // paths already read straight off Settings, instead of always falling
  // back to the isomorphic task module's own DEFAULT_SPAN_QC_CAPS. Inline
  // shape (not DetectSpanCaps from apps/web's detect layer) — core must
  // not import from an app package. Optional: an absent value falls back
  // to the default, same as before this field existed.
  spanQcCaps?: { idiomMaxWords: number; idiomMaxChars: number };
}

export interface TranslationPair {
  index: number; // aligned to SummarizeRequest.segments[].index
  zh: string;
}

// ---------- live bilingual transcript (#42) ----------
// Distinct from the post-meeting TranslationPair/SummarizeRequest
// pair above: this translates individual finalized transcript
// segments as they arrive, keyed by segment id rather than index,
// into whatever language `settings.explainLanguage` names (not
// always zh — see Settings.bilingualTranscript below).

export interface TranslateRequest {
  segments: { id: string; text: string }[];
  lang: string;
  // #56 per-task model override, additive. "" / absent = today's
  // behavior (server-side env-forced model + #61 fallback stands
  // unchanged — see the translate route's pickModel call).
  model?: string;
}

export interface TranslateResponse {
  translations: { id: string; text: string }[];
}

// ---------- AI transcript correction (v0.5 Wave-1 Feature 2, batch/
// review-gated — docs/design-explorations/v05-wave1-blueprint.md §1
// Feature 2 + §5 A5). Mirrors TranslateRequest/TranslateResponse above:
// segments keyed by id, corrections returned keyed by id. Isomorphic —
// implemented through ONE shared task module consumed by both
// app/api/correct/route.ts (web) and correctViaClient (desktop/iOS,
// which strip app/api) — see A5. ----------

export interface CorrectRequest {
  segments: { id: string; text: string }[];
  context: string; // surrounding-segment context the batch needs to disambiguate jargon/homophones
  lexicon: string[]; // glossary/pack bias terms — ground truth for what counts as a "real" correction
  meetingTitle?: string;
  model?: string;
  lang?: ExplainLanguage;
}

// A5 (BLOCKER): no model-supplied `changed` field on the wire — a
// silent/incorrect model claim of "unchanged" must never suppress a
// review row, and a false "changed" must never fabricate a diff. Every
// consumer computes `changed` itself, CLIENT-side, by diffing this
// `text` against the request's own original segment text.
export interface CorrectResponse {
  corrections: { id: string; text: string }[];
}

export interface BilingualLine {
  en: string;
  zh: string;
}

export interface ActionItem {
  owner: string; // "unassigned" when not identifiable
  en: string;
  zh: string;
  due: string; // "" when not stated
}

export interface MeetingSummary {
  topic: BilingualLine;
  key_points: BilingualLine[];
  decisions: BilingualLine[];
  action_items: ActionItem[];
}

export interface Flashcard {
  front: string; // the expression / term
  back_zh: string;
  back_en: string;
  example: string; // sentence from the meeting
  tags: string[];
}

export interface SummaryResult {
  summary: MeetingSummary;
  translations: TranslationPair[];
  flashcards: Flashcard[];
  generatedAt: number;
  model: string;
  // v0.4.5 detect-span QC (item 6, F4 field fix): count of sweep-stage
  // expressions dropped as over-selected spans (spanQc.ts's
  // filterDetectSpans). Serialized through SummaryResult rather than
  // recorded inside the (isomorphic, server-reachable) sweep stage
  // itself, so BOTH the Next.js-routed and client-transport paths let
  // the BROWSER be the one that updates telemetry.ts's session-scoped
  // store — see lib/llm/client.ts's summarizeApi. Optional (rather than
  // required) so older persisted/fixture SummaryResult objects that
  // predate this field stay valid — runSummarizeTask always populates
  // it; a reader treats an absent value as 0 (`?? 0`).
  sweepQcDropped?: number;
}

// API error body shared by routes: { error: string, code?: "no_key" | ... }
export interface ApiErrorBody {
  error: string;
  // "preview_budget": the hosted preview's monthly Soniox spend cap is
  // exhausted — client should fall back to browser 识别 (see
  // /api/soniox/token + lib/stt/soniox.ts's mint path).
  code?: "no_key" | "bad_request" | "upstream" | "rate_limit" | "preview_budget";
  // Diagnostics (server-side chain): a short id stamped on every 4xx/
  // 5xx response by the three routes below — see
  // lib/diag/requestId.ts. The client (llm/client.ts) folds it into
  // its own diagLog detail so a user's ref (lib/diag/log.ts) can be
  // chained to a server-side log line for the SAME request.
  requestId?: string;
}

// ---------- settings ----------

// LLM provider: first-party Anthropic, or any OpenAI-compatible
// endpoint (DeepSeek / Qwen / Ollama / OpenRouter / ...). The
// compat path unlocks mainland access, low cost, and fully-local
// privacy (Ollama + local Whisper = nothing leaves the machine).
export type LlmProvider = "anthropic" | "openai-compat";

// ---------- per-task provider/model (#56, BYOK-only) ----------
// The three LLM task domains this feature covers. NOT LlmCallKind
// (lib/llm/anthropic.ts) — that has "define"; define always rides
// detect's config (see lib/llm/taskConfig.ts's resolveTaskCreds).
export type LlmTaskDomain = "translate" | "detect" | "summary";

// A per-domain override. Every field optional — an absent field
// inherits the primary (top-level Settings.provider/baseUrl/apiKey +
// the domain's legacy model field). enabled:false (or no entry at
// all) means the domain uses the primary entirely, exactly as before
// this feature existed.
export interface TaskLlmConfig {
  enabled: boolean;
  provider?: LlmProvider;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface Settings {
  // ---- progressive disclosure (#62) ----
  // Governs how much of SettingsDialog renders: "simple" (default,
  // fleet-wide) hides advanced-only sections/rows (LLM/BYOK + per-task
  // models, 说话人分离, 数据与联动, 订阅直连, dictionary packs,
  // confidence tuning); "advanced" shows everything (simple ∪
  // advanced-only, never a disjoint view). See lib/settingsSections.ts
  // for the section→level map and shouldAutoPromoteToAdvanced, which
  // forces this to "advanced" whenever an advanced-only field already
  // deviates from its default — nothing a user relies on is ever
  // hidden. Toggled immediately via the dialog header's 简单/高级
  // control — a pure view preference, applied+persisted outside the
  // draft/保存 flow (see SettingsDialog.tsx). migrateSettings's
  // defaults-fold handles absence on old settings blobs; no migration
  // code needed.
  uiMode: "simple" | "advanced";

  engine: STTEngineKind;
  // v0.5 Wave-1 Feature 5 (mode-first UI, docs/design-explorations/
  // v05-wave1-blueprint.md §1 Feature 5 + §5 A3): the user's INTENT —
  // what she's trying to capture — kept as its own persisted field
  // rather than inferred from `engine` alone, because intent and
  // mechanism can legitimately diverge (StatusLine's engine dropdown
  // stays a power-user override that writes `engine` directly without
  // touching `mode` — see doc §1 F5's "Store shape decision"). Picking
  // a mode tile (a later lane's ModeSelector) derives+writes BOTH
  // `mode` and `engine` together via deriveEngineForMode (engineOptions.
  // ts, that lane's job). "system-audio" = 本机会议声音, "tab" = 浏览器
  // 标签页, "mic" = 麦克风, "import"/"url" = the two non-live ingest paths
  // (ImportHub's file/text vs URL tabs) — never a live capture engine by
  // themselves. migrateSettings back-derives this from a persisted
  // `engine` for every returning user who saved settings before this
  // field existed (see modeForPersistedEngine in store.ts, exported for
  // tests) — runtime-validated (an untrusted/garbage persisted string is
  // treated as absent, not blindly trusted) and NEVER derived as "url"
  // (a returning user is never silently dropped into the URL-ingest tab).
  mode: "system-audio" | "tab" | "mic" | "import" | "url";
  micId?: string;
  language: string; // BCP-47, for Web Speech API
  whisperUrl: string; // local sidecar websocket
  // v0.4 S3 chunk 6 (docs/design-explorations/s3-tauri-uv-blueprint.md,
  // architecture decision 6) — desktop build only, meaningless (never
  // read) on a web build. "managed" (default): the desktop app itself
  // provisions + spawns the local Whisper sidecar (see lib/desktop/
  // {provisionMachine,bootstrap}.ts) and whisperUrl above is fixed/
  // greyed in SettingsDialog. "external": today's manual-install
  // behavior (README「本地版安装」) — the user runs their own sidecar,
  // whisperUrl stays editable, probe-only. migrateSettings's
  // defaults-fold + sanitizeRestoredSettings's Object.keys(DEFAULT_
  // SETTINGS) allow-list both pick this up automatically, same as
  // partials/preferOnDeviceSpeech — no extra migration code needed.
  sidecarMode: "managed" | "external";
  // v0.4 S4 (blueprint decision C): the user's TARGET Whisper model for
  // the managed desktop sidecar — a preference, not the installed
  // truth. The provision marker's own `model` field stays what
  // start_server actually launches (marker wins on provisioned-dead
  // restart); the model-SWITCH flow is the only writer that updates
  // both together. Web builds never read it. Same zero-migration
  // fold-in as sidecarMode above.
  whisperModel: string;
  provider: LlmProvider;
  baseUrl: string; // openai-compat only, e.g. https://api.deepseek.com/v1
  apiKey: string; // "" = rely on server-side env ANTHROPIC_API_KEY
  detectModel: string;
  summaryModel: string;
  // Per-task provider/model overrides (#56, BYOK-only — never affects
  // the server-key/allowlist path (#61) or subscription-direct). Keyed
  // by LlmTaskDomain; a domain absent from the map (or present with
  // enabled:false) inherits provider/baseUrl/apiKey above and the
  // matching legacy model field entirely — see lib/llm/taskConfig.ts's
  // resolveTaskCreds, the single source of truth for this inheritance.
  // undefined (the default) is byte-identical to pre-#56 behavior.
  taskLlm?: Partial<Record<LlmTaskDomain, TaskLlmConfig>>;
  autoDetect: boolean; // live detection on/off
  // AI detection layer (#54). The built-in dictionary is ALWAYS the
  // instant floor — every finalized segment is scanned synchronously
  // and hits surface immediately. This toggle only controls whether
  // the LLM additionally runs in parallel batches and upgrades
  // dictionary cards in place (see dedupe.ts mergeDetections: content
  // swap by normKey, never retracts a dictionary hit). Off = fully
  // offline, no API calls (the old dictionaryOnly:true posture; that
  // legacy field migrates to !aiDetect in store.hydrate).
  aiDetect: boolean;
  minConfidence: number;
  // v0.4.5 detect-span QC (item 6, owner ruling 2026-07-17): the length
  // ceiling above which an AI-detected span the model tagged
  // category:idiom|slang is dropped as an over-selected sentence rather
  // than kept as a genuine multi-word idiom. Configurable per her call;
  // default 12 words / 90 chars. Non-idiom categories use a tighter
  // fixed cap and CJK spans a fixed internal char cap (成语/俗语 are
  // short) — neither is governed by these two. See lib/detect/spanQc.ts.
  detectIdiomMaxWords: number;
  detectIdiomMaxChars: number;
  // agent-native output layer
  autoExport: boolean; // write session .md/.json to a chosen folder on save
  webhookUrl: string; // "" = off; POST session JSON after meeting
  exportFrontmatter: boolean; // YAML frontmatter on exported markdown
  // v0.5 Wave-1 Feature 9 (AnkiConnect connector, docs/design-
  // explorations/v05-wave1-blueprint.md §1 Feature 9 + §5 A8): fires an
  // `addNotes` POST to a local AnkiConnect instance on session save
  // (like webhookUrl/autoExport above), reusing the existing flashcard
  // projection (customEntryToFlashcard). No credential field —
  // AnkiConnect is localhost-only, no auth. `port` defaults to 8765,
  // AnkiConnect's own default — which COLLIDES with whisperUrl's
  // ws://localhost:8765 sidecar default above; both can't bind on the
  // same desktop machine at once, hence this being independently
  // configurable rather than hardcoded (see A8's port-clash copy, which
  // explains both sides). `deckName` is the target Anki deck, created if
  // it doesn't already exist.
  ankiConnect: { enabled: boolean; deckName: string; port: number };
  // explanation target language ("zh" default; "en" = English-only
  // explanations for non-Chinese users; more languages later)
  explainLanguage: "zh" | "en";
  // dictionary theme packs: null = all packs enabled
  enabledPacks: string[] | null;
  // Hugging Face token for the local Whisper sidecar's speaker
  // diarization (pyannote); "" = disabled. Never leaves the browser
  // except over localhost to the sidecar (see upload.ts).
  hfToken: string;
  // v0.4 S4 (blueprint decision E): Soniox BYOK API key for the
  // "soniox" cloud engine; "" = engine unavailable. Sent ONLY inside
  // sonioxTransport.ts's wss config message to stt-rt.soniox.com.
  // diag/report.ts's SECRET_KEY_RE catches the name automatically
  // (→ hasSonioxKey), but history/autoExport.ts's stripKeyMaterial is a
  // HAND-LISTED strip — sonioxKey must be added there (S4 chunk 6).
  sonioxKey: string;
  // v0.4.7 (stt-provider-wiring-2026-07.md, Lane D): Deepgram BYOK API
  // key for the "deepgram" cloud engine; "" = engine unavailable. Sent
  // ONLY via deepgramTransport.ts's WebSocket Sec-WebSocket-Protocol
  // handshake to api.deepgram.com (never a URL param, never a JSON
  // message body — see that file's own header for the verified wire
  // shape). diag/report.ts's SECRET_KEY_RE catches the name
  // automatically (→ hasDeepgramKey), but history/autoExport.ts's
  // stripKeyMaterial is a HAND-LISTED strip — deepgramKey is added there
  // too, mirroring sonioxKey's own precedent immediately above.
  deepgramKey: string;
  // v0.5 Wave-1 Feature 4 (tab audio without the sidecar, cloud path —
  // docs/design-explorations/v05-wave1-blueprint.md §1 Feature 4 + §5
  // A4): which BYOK cloud backend the "tabaudio-cloud" engine (see
  // STTEngineKind above) transports the tab's getDisplayMedia capture
  // to — reuses sonioxKey/deepgramKey above (no separate credential
  // field); gated on the matching key actually being present (else mode
  // derivation falls back — see A4). Default "soniox" (the zh-en
  // code-switching engine, matching this codebase's existing default
  // cloud-engine preference).
  tabAudioCloudProvider: "soniox" | "deepgram";
  // Realtime speaker diarization (beta, whisper/tabaudio only): labels
  // live transcript segments with SPEAKER_1/2/… as the meeting
  // progresses, via the sidecar's ws-side pyannote pass (see
  // wsTransport.ts). Requires hfToken; default off (existing behavior
  // unchanged when off).
  realtimeDiarize: boolean;
  // Rolling partial transcriptions (STT protocol v2, whisper/tabaudio
  // only — see wsTransport.ts's config.partials): the sidecar shows
  // gray interim text (typewriter effect) every ~2s during active
  // speech before a sentence finalizes. Always sent explicitly in the
  // ws config so the app — not the sidecar's own --partials CLI flag —
  // controls this per session; default on (a plainly better default
  // than v1's off, now that the sidecar's tail-window scheduling makes
  // it CPU-cheap regardless of segment length). See SettingsDialog.
  // tsx's 实时转录预览 row.
  partials: boolean;
  // On-device Web Speech (Chrome 139+, `processLocally` — see
  // docs/research/stt-live-engines-2026-07.md item #1 and
  // lib/stt/onDeviceSpeech.ts's decision core): webspeech-only. When
  // on AND the browser reports a local model available for
  // `language`, recognition runs fully on-device — audio never
  // reaches the browser vendor's cloud STT. Falls back to the
  // existing cloud Web Speech path whenever the browser lacks the
  // feature, the language isn't (yet) available on-device, or this is
  // off. Default true — plainly better privacy posture at zero cost
  // when supported; a no-op (existing cloud behavior, byte-identical)
  // everywhere it isn't. See SettingsDialog.tsx's 设备端识别 row.
  preferOnDeviceSpeech: boolean;
  // Live bilingual transcript (#42): translate each FINALIZED segment
  // into explainLanguage and render it as a secondary line under the
  // English text (see translate/queue.ts). Only meaningful when
  // explainLanguage !== "en" (translating English into English is a
  // no-op); default off (existing single-line transcript unchanged).
  bilingualTranscript: boolean;
  // v0.5 Wave-1 Feature 6 (configurable translation engines, docs/
  // design-explorations/v05-wave1-blueprint.md §1 Feature 6 + §5 A6):
  // which TranslationProvider the live bilingual-transcript queue
  // (lib/translate/queue.ts) resolves through — "llm" (default,
  // quality, today's translateApi path, unchanged) or "system"
  // (on-device, free — Chrome's Translator API on web; a future Apple
  // Translation spike elsewhere; hidden/falls back to "llm" wherever no
  // on-device provider exists, e.g. Tauri desktop/iOS — see A6).
  // Independent of explainLanguage/bilingualTranscript above (this only
  // selects WHICH engine translates, not whether/into-what-language
  // translation happens at all).
  translateEngine: "llm" | "system";

  // Background profile (#48 step 3, design Q5): a handful of short
  // free-text hints about the user, rendered into ONE short string
  // (see llm/profileHint.ts) and spliced into the USER message only —
  // the server-built, prompt-cached SYSTEM prompt never sees it (cache
  // guarantee; see prompts.ts's AUDIENCE splice). `enabled: false` is
  // the default — opt-in privacy posture, matches the #63 framework.
  // migrateSettings's defaults-fold handles absence on old settings
  // blobs; no migration code needed.
  profile?: {
    industry?: string;
    role?: string;
    englishLevel?: EnglishLevel;
    familiarDomains?: string;
    weakDomains?: string;
    enabled: boolean;
  };

  // ---- display settings (v0.2.1) — independent of theme; surviving a
  // theme switch is the whole point, so these live as their own
  // fields rather than inside a theme's token set. Persisted through
  // the same settings store as everything else above, AND mirrored to
  // a small localStorage key (see lib/theme/displayStorage.ts) so the
  // pre-hydration FOUC script in layout.tsx can read them
  // synchronously before IndexedDB (async) resolves. ----

  // Built-in theme id (lib/theme/themes.ts registry). "terminal" is
  // the CSS-authored default; any other id goes through the engine's
  // applyTheme() pipeline.
  themeId: string;
  // Global font-size tier — applied as `<html data-fs="…">` +
  // globals.css `html[data-fs="…"]{font-size:…%}`, an all-rem-relative
  // scale (same effect as the browser's own zoom, just theme-portable
  // and persisted).
  fontSize: "sm" | "md" | "lg" | "xl";
  // Transcript-only font scale, independent of the global tier above —
  // multiplies the transcript's own `--ts-scale` custom property
  // (TranscriptPanel.tsx), never the global rem base.
  transcriptScale: "follow" | "lg" | "xl";
  // Transcript-only line-height tier — multiplies `--ts-leading`.
  transcriptLeading: "compact" | "standard" | "relaxed";

  // ---- subscription-direct (v0.2.2, experimental, LOCAL DEV BUILD
  // ONLY) — lets detect/define call Claude/ChatGPT via YOUR OWN local
  // `claude`/`codex` CLI login, reached through a separate local
  // sidecar process (sidecar/agent_server.py), never through any
  // server this project runs. This is NOT "we connect your
  // subscription for you" — it's "a tool on your machine asks the CLI
  // you already logged into, the same way running `claude -p` /
  // `codex exec` yourself would." Gated end-to-end behind THREE
  // independent kill switches (see src/lib/agent/localHost.ts): this
  // flag (default false), the NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT
  // build flag (unset = the whole UI section + call branch don't
  // exist in the built bundle), and a remote flags.json fetch (see
  // checkRemoteKillSwitch). Only detect/define ever use this path;
  // translate/summarize always use the existing Next.js /api/* routes
  // in every build, unconditionally. ----
  subscriptionDirect: boolean;
  subscriptionProvider: "claude-sub" | "chatgpt-sub";
  // sidecar/agent_server.py's HTTP base, default matches its own
  // --port 8767 default (whisper_server.py's ws/job-API ports are
  // 8765/8766 — 8767 is this feature's own, separate port).
  agentUrl: string;
  // Connection code (X-JS-Agent-Token): copied by hand from the
  // sidecar's own startup stdout banner into Settings, once per
  // sidecar run — proves this browser tab is one the person who
  // started the sidecar authorized, not a drive-by page. Never a
  // provider credential itself (see agent_server.py's Origin-gate
  // comment for the full threat model this closes).
  agentToken: string;
}

export const DEFAULT_SETTINGS: Settings = {
  uiMode: "simple",
  engine: "demo",
  // "mic" — the one capture mode legal on every platform (web/desktop/
  // iOS all support mic capture; system-audio/tab don't) — see
  // modeForPersistedEngine in store.ts, which resolves to this same
  // value for both "demo" and any unrecognized legalEngine.
  mode: "mic",
  language: "en-US",
  whisperUrl: "ws://localhost:8765",
  sidecarMode: "managed",
  // "small" mirrors bootstrap.ts's DEFAULT_DESKTOP_MODEL (S3 risk-1
  // reliability default); the first-run picker overwrites it with the
  // user's explicit choice (S4 chunk 3).
  whisperModel: "small",
  // R2 field fix (v0.4.4, adversarial review): provider:"anthropic" +
  // baseUrl:"" used to be paired with the DeepSeek OpenRouter model
  // slugs below — internally incoherent (a fresh user who pastes an
  // Anthropic key without ever touching the already-"active" anthropic
  // preset gets a DeepSeek/OpenRouter-flavored model id sent to
  // Anthropic's API and 404s). "openai-compat" + the OpenRouter base
  // URL make the DEFAULTS self-consistent with both the DeepSeek slugs
  // below and the product's promoted "Connect with OpenRouter" OAuth
  // onboarding (SettingsDialog.tsx's PROVIDER_PRESETS "openrouter"
  // entry now matches on sight, via CredentialFields' presetIdFor).
  // Anthropic-direct users still get Claude models back via the
  // "anthropic" preset's own suggestedModels the moment they pick it —
  // this only changes what an UNTOUCHED default looks like.
  provider: "openai-compat",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "",
  // Field-test fix (v0.4.4, real user report): these were bare
  // Anthropic ids (claude-haiku-4-5/claude-sonnet-5) — 400s the moment
  // provider is "openai-compat" pointed at OpenRouter (e.g. the
  // "Connect with OpenRouter" button), which needs a "vendor/model"
  // slug instead. Product decision: DeepSeek's own OpenRouter slugs
  // are the new global default (not Claude) — FLASH for low-latency
  // live detection, PRO for the async (no live-UI budget) summary;
  // both ids are already proven live (apps/web's deployTier.ts
  // PREVIEW_LIVE_MODELS/PREVIEW_SUMMARY_MODELS) — kept in sync BY HAND
  // with apps/web/src/lib/llm/tasks/{detect,summarize}.ts's own
  // DEFAULT_* consts (this package can't import the web app's task
  // modules the other way around; those are the ones actually
  // consumed by pickModel/the client no-override path — this Settings
  // default is what a brand-new Settings object seeds the field with).
  // Anthropic-direct users get claude-haiku-4-5/claude-sonnet-5 back
  // via SettingsDialog.tsx's "anthropic" PROVIDER_PRESETS entry
  // instead of this global default. Both models stay user-configurable
  // in Settings either way.
  detectModel: "deepseek/deepseek-v4-flash",
  summaryModel: "deepseek/deepseek-v4-pro",
  autoDetect: true,
  aiDetect: true,
  minConfidence: 0.55,
  detectIdiomMaxWords: 12,
  detectIdiomMaxChars: 90,
  autoExport: false,
  webhookUrl: "",
  exportFrontmatter: true,
  ankiConnect: { enabled: false, deckName: "JargonSlayer", port: 8765 },
  explainLanguage: "zh",
  enabledPacks: null,
  hfToken: "",
  sonioxKey: "",
  deepgramKey: "",
  tabAudioCloudProvider: "soniox",
  realtimeDiarize: false,
  partials: true,
  preferOnDeviceSpeech: true,
  bilingualTranscript: false,
  translateEngine: "llm",
  profile: { enabled: false },
  themeId: "terminal",
  fontSize: "md",
  transcriptScale: "follow",
  transcriptLeading: "standard",
  subscriptionDirect: false,
  subscriptionProvider: "claude-sub",
  agentUrl: "http://127.0.0.1:8767",
  agentToken: "",
};

/** Headers that carry LLM provider config from browser to routes.
 *  Wire body types stay provider-agnostic. */
export const PROVIDER_HEADERS = {
  key: "x-jargonslayer-key",
  provider: "x-jargonslayer-provider",
  baseUrl: "x-jargonslayer-base-url",
} as const;

// ---------- meeting session / history ----------

// "paused" (B1, pause/resume/end): the engine is fully torn down but
// the meeting itself is still open (same meetingGen, segments/cards
// intact) — distinct from "stopped", which is the terminal, saved-to-
// history state. See store.ts's pauseMeeting/resumeMeeting and
// useMeeting.ts's pause()/resume().
export type MeetingStatus = "idle" | "connecting" | "listening" | "paused" | "stopped";

export interface MeetingSession {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number;
  engine: STTEngineKind;
  segments: TranscriptSegment[];
  cards: ExpressionCard[];
  terms: TermCard[];
  summary?: SummaryResult;
  // realtime speaker diarization (beta): stable sidecar id (SPEAKER_1/
  // 2/…) -> user-chosen display name, set by renameSpeaker so a later
  // applySpeakerUpdate never clobbers a rename ("rename-wins", see
  // store.ts).
  speakerAliases?: Record<string, string>;
  // v0.5 Wave-1 Feature 1 (manual speaker roster, see TranscriptSegment.
  // speakerLocked above): this meeting's roster of manually-managed
  // speaker names (store.ts's speakerRoster live slice), persisted
  // ALWAYS (even []) by saveCurrentSession — same "presence, even
  // empty, marks this as known-complete bookkeeping vs. legacy-absent"
  // posture as pauseIntervals below, NOT speakerAliases/translations'
  // omit-when-empty convention above: loadSession must tell "this
  // session's roster really is empty" apart from "this session predates
  // the roster feature entirely" (only the latter derives a roster from
  // segments' own speaker values — see store.ts's loadSession).
  speakerRoster?: string[];
  // Live bilingual transcript (#42): segment id -> translated text,
  // for segments translated while the meeting was live. Absent when
  // the feature was off or a segment's translation never landed.
  translations?: Record<string, string>;
  // Transcript-timestamp fix: completed pause intervals (B2 pause/
  // resume) this meeting, so a saved session's per-segment elapsed
  // time can exclude paused spans the same way the live view does —
  // see apps/web/src/lib/segmentElapsed.ts's segmentElapsedMs.
  // Persisted going forward from store.ts's `pauseIntervals` on every
  // save (even []); ABSENT (not merely []) marks a session saved
  // BEFORE this field existed — resolveSessionElapsedBasis treats
  // that as "no pause bookkeeping available" and falls back to
  // segments[0].startedAt as the elapsed zero point instead of this
  // session's own startedAt (any real pause gap then just shows as a
  // jump between segments — not recoverable after the fact).
  pauseIntervals?: { start: number; end: number }[];
}

export interface SessionMeta {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number;
  segmentCount: number;
  cardCount: number;
  termCount: number;
  hasSummary: boolean;
}

export function sessionToMeta(s: MeetingSession): SessionMeta {
  return {
    id: s.id,
    title: s.title,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    segmentCount: s.segments.length,
    cardCount: s.cards.length,
    termCount: s.terms.length,
    hasSummary: !!s.summary,
  };
}

// ---------- personal dictionary (user-curated glossary) ----------
// Persisted across meetings (IndexedDB). Entries participate in live
// detection like the built-in dictionary, but rank above it and are
// never overwritten by LLM/dictionary hits. One shape covers both an
// explainable expression and a glossed term; kind selects which
// optional fields are meaningful.

export type CustomEntryKind = "expression" | "term";

// v0.5 Wave-1 Feature 8 (named custom dictionary packs, docs/design-
// explorations/v05-wave1-blueprint.md §1 Feature 8 + §5 A7): a named,
// independently toggleable group of CustomEntry rows — a separate
// persisted slice (own IDB key, mirroring lib/history/glossary.ts's own
// storage; NOT a Settings field, so pack CRUD doesn't round-trip
// through the settings save/restore path). "personal" (CustomEntry.
// packId's own default below) is the always-present, non-deletable
// pack every pre-Feature-8 entry migrates onto — the load-time
// normalization/auto-creation that guarantees it exists is a later
// lane's job (A7), not this Foundation type.
export interface CustomPack {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: number;
}

export interface CustomEntry {
  id: string;
  kind: CustomEntryKind;
  // v0.5 Wave-1 Feature 8 (see CustomPack above): which pack this entry
  // belongs to. REQUIRED (not optional) so every construction site must
  // decide explicitly rather than silently defaulting somewhere
  // downstream — "personal" is the value every construction site in
  // this codebase sets today (see cardToCustomEntry/termToCustomEntry
  // below and every UI/test construction site) until a later lane
  // builds real pack selection.
  packId: string;
  headword: string; // canonical phrase/term — display + primary match
  variants: string[]; // extra surface forms to also match
  chinese_explanation: string; // 中文解释（两种 kind 都有）
  example: string; // AI-generated standalone example sentence
  context: string; // 原始会议语境句（capture 时的出处，可空）
  note: string; // user's own note
  createdAt: number;
  updatedAt: number;
  source: "ai" | "manual" | "session"; // authored by AI, by hand, or collected from a meeting's cards
  // review/practice state (the glossary is the single learning home;
  // sessions stay immutable archives)
  mastered?: boolean;
  reviewCount?: number;
  lastReviewedAt?: number;
  // expression-only
  category?: ExpressionCategory;
  meaning?: string; // in-context English
  plain_english?: string;
  tone?: string;
  // term-only
  termType?: TermType;
  gloss_en?: string;
}

// AI "define this phrase" result (client fills id/timestamps/note).
export interface DefineRequest {
  phrase: string;
  context: string; // surrounding sentence for disambiguation
  model?: string;
  lang?: ExplainLanguage;
  // Pre-rendered background-profile hint (#48 step 3) — threaded
  // exactly like `lang` above.
  profile?: string;
}

export interface DefineResult {
  kind: CustomEntryKind;
  headword: string;
  variants: string[];
  chinese_explanation: string;
  example: string;
  // expression-only
  category?: ExpressionCategory;
  meaning?: string;
  plain_english?: string;
  tone?: string;
  // term-only
  termType?: TermType;
  gloss_en?: string;
}

/** All surface forms a custom entry should match against, deduped. */
export function customEntrySurfaces(e: CustomEntry): string[] {
  return Array.from(
    new Set([e.headword, ...e.variants].map((s) => s.trim()).filter(Boolean)),
  );
}

/** Project a custom entry onto the detection wire shape so dictionary
 *  scanning can emit it into the live card stream. `sentence` is the
 *  matched transcript sentence (falls back to the stored context). */
export function customEntryToExpression(
  e: CustomEntry,
  sentence: string,
): DetectedExpression {
  return {
    expression: e.headword,
    category: e.category ?? "phrase",
    meaning: e.meaning ?? e.chinese_explanation,
    chinese_explanation: e.chinese_explanation,
    plain_english: e.plain_english ?? e.headword,
    tone: e.tone ?? "自定义词条",
    confidence: 1,
    source_sentence: sentence || e.context || e.example,
  };
}

export function customEntryToTerm(e: CustomEntry): DetectedTerm {
  return {
    term: e.headword,
    type: e.termType ?? "other",
    gloss_en: e.gloss_en ?? "",
    gloss_zh: e.chinese_explanation,
  };
}

/** Build a study flashcard from a custom entry (for export/merge). */
export function customEntryToFlashcard(e: CustomEntry): Flashcard {
  const backEn =
    e.kind === "term"
      ? e.gloss_en ?? ""
      : [e.meaning, e.plain_english && `plain: ${e.plain_english}`]
          .filter(Boolean)
          .join(" — ");
  return {
    front: e.headword,
    back_zh: e.chinese_explanation,
    back_en: backEn,
    example: e.example || e.context,
    tags: [e.kind === "term" ? e.termType ?? "term" : e.category ?? "expression", "custom"],
  };
}

/** Collect a live-detected card into the personal glossary
 *  ("收藏本场卡片"). Mastery state lives only on glossary entries. */
export function cardToCustomEntry(c: ExpressionCard): CustomEntry {
  const now = Date.now();
  return {
    id: newId(),
    kind: "expression",
    packId: "personal",
    headword: c.expression,
    variants: [],
    chinese_explanation: c.chinese_explanation,
    example: "",
    context: c.source_sentence,
    note: "",
    createdAt: now,
    updatedAt: now,
    source: "session",
    category: c.category,
    meaning: c.meaning,
    plain_english: c.plain_english,
    tone: c.tone,
    mastered: false,
    reviewCount: 0,
  };
}

export function termToCustomEntry(t: TermCard): CustomEntry {
  const now = Date.now();
  return {
    id: newId(),
    kind: "term",
    packId: "personal",
    headword: t.term,
    variants: [],
    chinese_explanation: t.gloss_zh,
    example: "",
    context: "",
    note: "",
    createdAt: now,
    updatedAt: now,
    source: "session",
    termType: t.type,
    gloss_en: t.gloss_en,
    mastered: false,
    reviewCount: 0,
  };
}

export function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}
