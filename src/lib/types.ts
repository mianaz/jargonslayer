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
  onDiarStatus?: (state: "unavailable" | "error", detail?: string) => void;
}

export interface STTEngine {
  readonly kind: STTEngineKind;
  start(events: STTEvents, settings: Settings): Promise<void>;
  stop(): Promise<void>;
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

export interface DetectRequest {
  context: string; // previously analyzed tail, disambiguation only
  new_text: string; // fresh finalized text to analyze
  model?: string;
  lang?: ExplainLanguage; // explanation language, default "zh"
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
}

export interface TranslateResponse {
  translations: { id: string; text: string }[];
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
}

// API error body shared by routes: { error: string, code?: "no_key" | ... }
export interface ApiErrorBody {
  error: string;
  code?: "no_key" | "bad_request" | "upstream" | "rate_limit";
}

// ---------- settings ----------

// LLM provider: first-party Anthropic, or any OpenAI-compatible
// endpoint (DeepSeek / Qwen / Ollama / OpenRouter / ...). The
// compat path unlocks mainland access, low cost, and fully-local
// privacy (Ollama + local Whisper = nothing leaves the machine).
export type LlmProvider = "anthropic" | "openai-compat";

export interface Settings {
  engine: STTEngineKind;
  micId?: string;
  language: string; // BCP-47, for Web Speech API
  whisperUrl: string; // local sidecar websocket
  provider: LlmProvider;
  baseUrl: string; // openai-compat only, e.g. https://api.deepseek.com/v1
  apiKey: string; // "" = rely on server-side env ANTHROPIC_API_KEY
  detectModel: string;
  summaryModel: string;
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
  // agent-native output layer
  autoExport: boolean; // write session .md/.json to a chosen folder on save
  webhookUrl: string; // "" = off; POST session JSON after meeting
  exportFrontmatter: boolean; // YAML frontmatter on exported markdown
  // explanation target language ("zh" default; "en" = English-only
  // explanations for non-Chinese users; more languages later)
  explainLanguage: "zh" | "en";
  // dictionary theme packs: null = all packs enabled
  enabledPacks: string[] | null;
  // Hugging Face token for the local Whisper sidecar's speaker
  // diarization (pyannote); "" = disabled. Never leaves the browser
  // except over localhost to the sidecar (see upload.ts).
  hfToken: string;
  // Realtime speaker diarization (beta, whisper/tabaudio only): labels
  // live transcript segments with SPEAKER_1/2/… as the meeting
  // progresses, via the sidecar's ws-side pyannote pass (see
  // wsTransport.ts). Requires hfToken; default off (existing behavior
  // unchanged when off).
  realtimeDiarize: boolean;
  // Live bilingual transcript (#42): translate each FINALIZED segment
  // into explainLanguage and render it as a secondary line under the
  // English text (see translate/queue.ts). Only meaningful when
  // explainLanguage !== "en" (translating English into English is a
  // no-op); default off (existing single-line transcript unchanged).
  bilingualTranscript: boolean;

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
  engine: "demo",
  language: "en-US",
  whisperUrl: "ws://localhost:8765",
  provider: "anthropic",
  baseUrl: "",
  apiKey: "",
  // Haiku for live detection: low latency + high call volume.
  // Both models are user-configurable in Settings.
  detectModel: "claude-haiku-4-5",
  summaryModel: "claude-sonnet-5",
  autoDetect: true,
  aiDetect: true,
  minConfidence: 0.55,
  autoExport: false,
  webhookUrl: "",
  exportFrontmatter: true,
  explainLanguage: "zh",
  enabledPacks: null,
  hfToken: "",
  realtimeDiarize: false,
  bilingualTranscript: false,
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

export type MeetingStatus = "idle" | "connecting" | "listening" | "stopped";

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
  // Live bilingual transcript (#42): segment id -> translated text,
  // for segments translated while the meeting was live. Absent when
  // the feature was off or a segment's translation never landed.
  translations?: Record<string, string>;
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

export interface CustomEntry {
  id: string;
  kind: CustomEntryKind;
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
