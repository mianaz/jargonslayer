// ============================================================
// MeetLingo shared contract — single source of truth for all
// cross-module types. Owned by the lead; workers code against it.
// ============================================================

// ---------- transcription ----------

export type STTEngineKind = "demo" | "webspeech" | "whisper";

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

export type DetectionSource = "llm" | "dictionary";

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

export interface DetectRequest {
  context: string; // previously analyzed tail, disambiguation only
  new_text: string; // fresh finalized text to analyze
  model?: string;
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

export interface Settings {
  engine: STTEngineKind;
  micId?: string;
  language: string; // BCP-47, for Web Speech API
  whisperUrl: string; // local sidecar websocket
  apiKey: string; // "" = rely on server-side env ANTHROPIC_API_KEY
  detectModel: string;
  summaryModel: string;
  autoDetect: boolean; // live detection on/off
  dictionaryOnly: boolean; // force offline dictionary mode
  minConfidence: number;
}

export const DEFAULT_SETTINGS: Settings = {
  engine: "demo",
  language: "en-US",
  whisperUrl: "ws://localhost:8765",
  apiKey: "",
  // Haiku for live detection: low latency + high call volume.
  // Both models are user-configurable in Settings.
  detectModel: "claude-haiku-4-5",
  summaryModel: "claude-sonnet-5",
  autoDetect: true,
  dictionaryOnly: false,
  minConfidence: 0.55,
};

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

export function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}
