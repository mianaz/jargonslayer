// Global zustand store — the bus between STT (worker A), detection
// (worker B) and all UI panels. Owned by the lead; workers read/write
// through the actions below and never import each other's modules.

import { create } from "zustand";
import {
  DEFAULT_SETTINGS,
  newId,
  type DetectResponse,
  type DetectionSource,
  type ExpressionCard,
  type InterimState,
  type MeetingSession,
  type MeetingStatus,
  type SessionMeta,
  type Settings,
  type SummaryResult,
  type TermCard,
  type TranscriptSegment,
} from "./types";
import { mergeDetections } from "./detect/dedupe";
import type { DetectMode } from "./detect/scheduler";
import * as storage from "./history/storage";
import * as glossary from "./history/glossary";
import type { CustomEntry } from "./types";

// Debounced top-up save for detection results arriving post-stop.
let postStopSaveTimer: ReturnType<typeof setTimeout> | null = null;

export interface LookupRequest {
  text: string; // selected text
  contextText: string; // surrounding segment text, for disambiguation
  x: number; // viewport coords for the popover
  y: number;
}

interface AppState {
  // settings
  settings: Settings;
  hydrated: boolean;

  // live meeting
  status: MeetingStatus;
  statusDetail: string | null;
  startedAt: number | null;
  segments: TranscriptSegment[];
  interim: InterimState | null;

  // detection results
  cards: ExpressionCard[];
  terms: TermCard[];
  detectBusy: boolean;
  detectMode: DetectMode;
  focusCardId: string | null; // transcript highlight → card scroll/flash

  // lookup popover (transcript selection → explanation)
  lookup: LookupRequest | null;

  // post-meeting
  summary: SummaryResult | null;
  summarizing: boolean;

  // history
  sessions: SessionMeta[];
  activeSessionId: string | null; // non-null when viewing a saved session

  // personal dictionary (global, cross-meeting)
  customEntries: CustomEntry[];

  // ui
  toast: string | null;

  // ---- actions ----
  hydrate: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => void;

  setStatus: (status: MeetingStatus, detail?: string | null) => void;
  beginMeeting: () => void; // clears live state, stamps startedAt
  addFinal: (
    text: string,
    opts?: { speaker?: string; startedAt?: number },
  ) => TranscriptSegment;
  setInterim: (interim: InterimState | null) => void;

  applyDetection: (res: DetectResponse, source: DetectionSource) => void;
  setDetectBusy: (busy: boolean) => void;
  setDetectMode: (mode: DetectMode) => void;
  setFocusCard: (id: string | null) => void;
  setLookup: (req: LookupRequest | null) => void;

  setSummary: (s: SummaryResult | null) => void;
  setSummarizing: (v: boolean) => void;

  saveCurrentSession: () => Promise<string | null>;
  loadSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  newMeeting: () => void;

  addCustomEntry: (entry: CustomEntry) => Promise<void>;
  updateCustomEntry: (entry: CustomEntry) => Promise<void>;
  removeCustomEntry: (id: string) => Promise<void>;

  showToast: (msg: string) => void;
  clearToast: () => void;
}

export const useApp = create<AppState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,

  status: "idle",
  statusDetail: null,
  startedAt: null,
  segments: [],
  interim: null,

  cards: [],
  terms: [],
  detectBusy: false,
  detectMode: "llm",
  focusCardId: null,
  lookup: null,

  summary: null,
  summarizing: false,

  sessions: [],
  activeSessionId: null,

  customEntries: [],

  toast: null,

  hydrate: async () => {
    const [saved, metas, entries] = await Promise.all([
      storage.loadSettings(),
      storage.listSessions(),
      glossary.loadCustomEntries(),
    ]);
    set({
      settings: { ...DEFAULT_SETTINGS, ...(saved ?? {}) },
      sessions: metas,
      customEntries: entries,
      hydrated: true,
    });
    // Ask the browser not to evict IndexedDB under storage pressure
    // (Safari's 7-day eviction, Chrome quota GC). Best-effort.
    try {
      if (typeof navigator !== "undefined" && navigator.storage?.persist) {
        void navigator.storage.persist();
      }
    } catch {
      // non-fatal
    }
  },

  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    void storage.saveSettings(settings);
  },

  setStatus: (status, detail = null) =>
    set({ status, statusDetail: detail ?? null }),

  beginMeeting: () =>
    set({
      status: "connecting",
      statusDetail: null,
      startedAt: Date.now(),
      segments: [],
      interim: null,
      cards: [],
      terms: [],
      summary: null,
      focusCardId: null,
      lookup: null,
      activeSessionId: null,
    }),

  addFinal: (text, opts) => {
    const { segments, settings } = get();
    const now = Date.now();
    const seg: TranscriptSegment = {
      id: newId(),
      index: segments.length,
      startedAt: opts?.startedAt ?? now,
      endedAt: now,
      speaker: opts?.speaker,
      text: text.trim(),
      engine: settings.engine,
    };
    set({ segments: [...segments, seg] });
    // Personal glossary matches ride on the segment funnel so every
    // engine and every detect mode benefits; counted exactly once
    // per occurrence here (other sources never bump custom cards).
    if (settings.autoDetect) {
      const hits = glossary.scanCustomEntries(seg.text);
      if (hits.expressions.length > 0 || hits.terms.length > 0) {
        get().applyDetection(hits, "custom");
      }
    }
    return seg;
  },

  setInterim: (interim) => set({ interim }),

  applyDetection: (res, source) => {
    const { cards, terms, settings } = get();
    const merged = mergeDetections(
      cards,
      terms,
      res,
      source,
      settings.minConfidence,
    );
    set({ cards: merged.cards, terms: merged.terms });
    // The final flush on stop resolves asynchronously (up to ~8s
    // later). If results land after the session was already saved,
    // top up the saved copy so history isn't missing tail cards.
    if (get().status === "stopped" && get().segments.length > 0) {
      if (postStopSaveTimer) clearTimeout(postStopSaveTimer);
      postStopSaveTimer = setTimeout(() => {
        postStopSaveTimer = null;
        void get().saveCurrentSession();
      }, 1500);
    }
  },

  setDetectBusy: (detectBusy) => set({ detectBusy }),
  setDetectMode: (detectMode) => set({ detectMode }),
  setFocusCard: (focusCardId) => set({ focusCardId }),
  setLookup: (lookup) => set({ lookup }),

  setSummary: (summary) => set({ summary }),
  setSummarizing: (summarizing) => set({ summarizing }),

  saveCurrentSession: async () => {
    const s = get();
    if (s.segments.length === 0) return null;
    const startedAt = s.startedAt ?? s.segments[0].startedAt;
    const d = new Date(startedAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    const session: MeetingSession = {
      id: s.activeSessionId ?? newId(),
      title: `会议 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
        d.getDate(),
      )} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
      startedAt,
      endedAt: s.segments[s.segments.length - 1].endedAt,
      engine: s.settings.engine,
      segments: s.segments,
      cards: s.cards,
      terms: s.terms,
      summary: s.summary ?? undefined,
    };
    await storage.saveSession(session);
    const metas = await storage.listSessions();
    set({ sessions: metas, activeSessionId: session.id });
    return session.id;
  },

  loadSession: async (id) => {
    const session = await storage.getSession(id);
    if (!session) {
      get().showToast("会话不存在或已删除");
      return;
    }
    set({
      status: "stopped",
      statusDetail: null,
      startedAt: session.startedAt,
      segments: session.segments,
      interim: null,
      cards: session.cards,
      terms: session.terms,
      summary: session.summary ?? null,
      activeSessionId: session.id,
      focusCardId: null,
      lookup: null,
    });
  },

  deleteSession: async (id) => {
    await storage.deleteSession(id);
    const metas = await storage.listSessions();
    const patch: Partial<AppState> = { sessions: metas };
    if (get().activeSessionId === id) {
      patch.activeSessionId = null;
    }
    set(patch);
  },

  addCustomEntry: async (entry) => {
    const list = await glossary.upsertCustomEntry(entry);
    set({ customEntries: [...list] });
  },

  updateCustomEntry: async (entry) => {
    const list = await glossary.upsertCustomEntry({
      ...entry,
      updatedAt: Date.now(),
    });
    set({ customEntries: [...list] });
  },

  removeCustomEntry: async (id) => {
    const list = await glossary.deleteCustomEntry(id);
    set({ customEntries: [...list] });
  },

  newMeeting: () =>
    set({
      status: "idle",
      statusDetail: null,
      startedAt: null,
      segments: [],
      interim: null,
      cards: [],
      terms: [],
      summary: null,
      summarizing: false,
      focusCardId: null,
      lookup: null,
      activeSessionId: null,
    }),

  showToast: (toast) => set({ toast }),
  clearToast: () => set({ toast: null }),
}));

/** Meta helper kept here so UI code doesn't rebuild it. */
export function currentSessionSnapshot(): MeetingSession | null {
  const s = useApp.getState();
  if (s.segments.length === 0) return null;
  return {
    id: s.activeSessionId ?? "unsaved",
    title: "当前会议",
    startedAt: s.startedAt ?? s.segments[0].startedAt,
    endedAt: s.segments[s.segments.length - 1].endedAt,
    engine: s.settings.engine,
    segments: s.segments,
    cards: s.cards,
    terms: s.terms,
    summary: s.summary ?? undefined,
  };
}
