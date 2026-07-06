// ============================================================
// JargonSlayer shared contract — single source of truth for all
// cross-module types. Owned by the lead; workers code against it.
// ============================================================

// ---------- transcription ----------

export type STTEngineKind = "demo" | "webspeech" | "whisper" | "tabaudio";

export interface TranscriptSegment {
  id: string;
  index: number; // 0-based arrival order
  startedAt: number; // epoch ms, approximate utterance start
  endedAt: number; // epoch ms, when finalized
  speaker?: string; // demo mode now; diarization later
  text: string;
  engine: STTEngineKind;
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
    opts?: { speaker?: string; startedAt?: number },
  ) => void;
  onStatus: (status: STTStatus, detail?: string) => void;
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
}

export interface TermCard extends DetectedTerm {
  id: string;
  normKey: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  source: DetectionSource;
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
  dictionaryOnly: boolean; // force offline dictionary mode
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
  dictionaryOnly: false,
  minConfidence: 0.55,
  autoExport: false,
  webhookUrl: "",
  exportFrontmatter: true,
  explainLanguage: "zh",
  enabledPacks: null,
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
