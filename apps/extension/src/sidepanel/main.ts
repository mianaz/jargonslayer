// Side panel entry point — the Lite core loop (PLAN-v0.4 S6): paste
// English text -> @jargonslayer/core dictionary detection renders
// cards -> optional on-device translation of the pasted text.
//
// Only the built-in dictionary packs are used here — remote/community
// pack loading (detect/remotePacksRegistry.ts's setLoadedRemotePacks)
// is apps/web-only machinery (fetch + idb-keyval) that this app never
// calls, so scanDictionary() below only ever sees the 428/11 built-in
// packs. Explicitly deferred, not a bug: remote-pack loading in the
// extension is out of S6's scope (see the plan's requirement 3).
// Likewise, personal-glossary shadowing (history/glossaryLookup.ts) is
// a no-op here for the same reason — this app never populates that
// cache either, so every card comes straight from the built-in tables.
//
// S7 adds live mic capture (captureController.ts) as an ADDITIVE
// layer alongside all of the above: its own transcript/detected-cards
// area, history, and the 更多能力 locked-features section. Nothing in
// this file's S6 code paths (paste-and-scan, Translator lookups,
// savedLookups 收藏) changes shape — capture's detected cards render
// into their OWN #js-capture-cards area (see renderCaptureCards
// below), never into #js-results, so switching between typing/pasting
// and live listening can never clobber the other's on-screen state.

import { scanDictionary } from "@jargonslayer/core/detect/dictionary";
import type {
  DetectedExpression,
  DetectedTerm,
  ExpressionCard,
  TermCard,
} from "@jargonslayer/core/types";

import type { AccumulatorSnapshot } from "../detect/accumulator";
import { openPermissionPage } from "../permission/micPermission";
import {
  deleteSession,
  listSessions,
  type LiteSegment,
  type LiteSession,
} from "../storage/history";
import { getSavedLookups, saveLookup } from "../storage/savedLookups";
import { type CapabilityState } from "../translate/availability";
import {
  checkLanguageDetectorAvailability,
  detectTopLanguage,
} from "../translate/languageDetector";
import { checkTranslatorAvailability, translateText } from "../translate/translator";
import { CaptureController, type CaptureStatus } from "./captureController";
import { clearChildren, renderExpressionCard, renderTermCard } from "./render";
import { renderHistorySection } from "./renderHistory";
import { renderLockedSection } from "./renderLocked";
import { renderTranscript } from "./renderTranscript";

const input = document.querySelector<HTMLTextAreaElement>("#js-input")!;
const scanBtn = document.querySelector<HTMLButtonElement>("#js-scan-btn")!;
const scanStatus = document.querySelector<HTMLSpanElement>("#js-scan-status")!;
const resultsEl = document.querySelector<HTMLElement>("#js-results")!;
const emptyHint = document.querySelector<HTMLParagraphElement>("#js-empty-hint")!;

const translateSection = document.querySelector<HTMLElement>("#js-translate-section")!;
const translateBtn = document.querySelector<HTMLButtonElement>("#js-translate-btn")!;
const translateStatus = document.querySelector<HTMLSpanElement>("#js-translate-status")!;
const translateOutput = document.querySelector<HTMLParagraphElement>("#js-translate-output")!;

// ---- S7 capture elements ----
const listenBtn = document.querySelector<HTMLButtonElement>("#js-listen-btn")!;
const listenStatus = document.querySelector<HTMLSpanElement>("#js-listen-status")!;
const privacyLine = document.querySelector<HTMLParagraphElement>("#js-privacy-line")!;
const captureNotice = document.querySelector<HTMLParagraphElement>("#js-capture-notice")!;
const savedNotice = document.querySelector<HTMLParagraphElement>("#js-saved-notice")!;
const grantAffordance = document.querySelector<HTMLElement>("#js-grant-affordance")!;
const grantBtn = document.querySelector<HTMLButtonElement>("#js-grant-btn")!;
const unsupportedNotice = document.querySelector<HTMLParagraphElement>("#js-unsupported-notice")!;
const transcriptMount = document.querySelector<HTMLElement>("#js-transcript")!;
const captureCardsEl = document.querySelector<HTMLElement>("#js-capture-cards")!;
const captureEmptyHint = document.querySelector<HTMLParagraphElement>("#js-capture-empty-hint")!;
const historyMount = document.querySelector<HTMLElement>("#js-history-mount")!;
const lockedMount = document.querySelector<HTMLElement>("#js-locked-mount")!;

let lastScannedText = "";
let savedHeadwords = new Set<string>();

// ---- S7 capture state ----
let isListening = false;
let currentSegments: LiteSegment[] = [];
let lastCaptureSnapshot: AccumulatorSnapshot = { cards: [], terms: [] };

async function refreshSavedHeadwords(): Promise<void> {
  const saved = await getSavedLookups();
  savedHeadwords = new Set(saved.map((s) => s.headword.trim().toLowerCase()));
}

function isSaved(headword: string): boolean {
  return savedHeadwords.has(headword.trim().toLowerCase());
}

async function handleSaveExpression(expr: DetectedExpression): Promise<void> {
  await saveLookup({
    kind: "expression",
    headword: expr.expression,
    chinese_explanation: expr.chinese_explanation,
    source_sentence: expr.source_sentence,
  });
  await refreshSavedHeadwords();
  runScan(); // re-render so the just-saved card flips to "已收藏 ✓"
}

async function handleSaveTerm(term: DetectedTerm): Promise<void> {
  await saveLookup({
    kind: "term",
    headword: term.term,
    chinese_explanation: term.gloss_zh,
  });
  await refreshSavedHeadwords();
  runScan();
}

function runScan(): void {
  const text = input.value.trim();
  lastScannedText = text;
  clearChildren(resultsEl);
  resultsEl.appendChild(emptyHint);

  if (!text) {
    emptyHint.hidden = false;
    emptyHint.textContent = "检测结果会显示在这里。";
    scanStatus.textContent = "";
    translateOutput.hidden = true;
    return;
  }

  const { expressions, terms } = scanDictionary(text);

  if (expressions.length === 0 && terms.length === 0) {
    emptyHint.hidden = false;
    emptyHint.textContent = "没有检测到黑话或术语 — 这段文本很直白。";
  } else {
    emptyHint.hidden = true;
    for (const expr of expressions) {
      resultsEl.appendChild(
        renderExpressionCard(expr, {
          saved: isSaved(expr.expression),
          onSave: () => void handleSaveExpression(expr),
        }),
      );
    }
    for (const term of terms) {
      resultsEl.appendChild(
        renderTermCard(term, {
          saved: isSaved(term.term),
          onSave: () => void handleSaveTerm(term),
        }),
      );
    }
  }

  scanStatus.textContent = `${expressions.length + terms.length} 项`;
  void offerLanguageHint(text);
}

/** Soft, non-blocking hint only — see translate/languageDetector.ts's
 *  module comment. Skipped for short text (the API's own guidance:
 *  short phrases/single words are unreliable to classify). */
async function offerLanguageHint(text: string): Promise<void> {
  if (text.length < 20) return;
  const guess = await detectTopLanguage(text);
  if (!guess) return;
  if (guess.language !== "en" && guess.confidence > 0.6) {
    scanStatus.textContent += ` · 检测到的语言可能不是英语 (${guess.language})`;
  }
}

function describeTranslatorState(state: CapabilityState): string {
  switch (state.status) {
    case "unsupported":
      return "本机翻译不可用（需 Chrome 138+）";
    case "unavailable":
      return "本机翻译不支持中英文";
    case "downloadable":
      return "点击翻译将下载本机翻译模型（首次使用）";
    case "downloading":
      return `翻译模型下载中… ${Math.round(state.progress * 100)}%`;
    case "available":
      return "本机翻译已就绪";
    case "error":
      return state.message ?? "翻译出错了";
  }
}

function setTranslateStatus(state: CapabilityState): void {
  translateStatus.textContent = describeTranslatorState(state);
}

/** Risk #5 mitigation: hide the translate affordance entirely when
 *  the API doesn't exist at all, rather than show a dead button —
 *  dictionary zh glosses need no translation regardless. Any other
 *  state (including "unavailable" for this language pair, or
 *  "error") still shows the section so the status line can explain
 *  why, since those are potentially transient/informative. */
async function updateTranslateAffordance(): Promise<void> {
  const state = await checkTranslatorAvailability();
  if (state.status === "unsupported") {
    translateSection.hidden = true;
    return;
  }
  translateSection.hidden = false;
  setTranslateStatus(state);
}

// ---------------------------------------------------------------
// S7 capture — captureController.ts owns the engine/permission/
// accumulator/history-save lifecycle; everything below is DOM-only
// glue wiring its injected callbacks to this panel's elements (the
// same "controller stays DOM-free, main.ts owns the DOM" split
// render.ts's own header comment describes for renderExpressionCard/
// renderTermCard).
// ---------------------------------------------------------------

function setListenButtonState(listening: boolean): void {
  isListening = listening;
  listenBtn.disabled = false;
  listenBtn.textContent = listening ? "停止聆听" : "开始聆听";
  listenBtn.className = listening ? "js-btn js-btn-listening" : "js-btn js-btn-primary";
}

function handleCaptureStatus(status: CaptureStatus, detail?: string): void {
  switch (status) {
    case "listening":
      setListenButtonState(true);
      listenStatus.textContent = "正在聆听…";
      grantAffordance.hidden = true;
      unsupportedNotice.hidden = true;
      return;
    case "stopped":
      setListenButtonState(false);
      listenStatus.textContent = "已停止";
      return;
    case "error":
      setListenButtonState(false);
      listenStatus.textContent = detail ?? "";
      return;
    case "unsupported":
      setListenButtonState(false);
      listenBtn.disabled = true;
      listenStatus.textContent = "";
      unsupportedNotice.hidden = false;
      return;
    case "idle":
    case "connecting":
      listenStatus.textContent = "";
      return;
  }
}

function handleTranscriptChange(segments: LiteSegment[], interim: string): void {
  currentSegments = segments;
  transcriptMount.replaceChildren(renderTranscript(segments, interim));
  transcriptMount.scrollTop = transcriptMount.scrollHeight;
}

/** Mirrors runScan()'s own persistent-hint idiom above (clearChildren,
 *  then always re-append the ONE captureEmptyHint node first, toggling
 *  its hidden/textContent) rather than renderTranscript.ts/renderLocked
 *  .ts's fresh-node-per-call convention — this logic lives in the SAME
 *  file as runScan and should read the same way it does. */
function renderCaptureCards(snapshot: AccumulatorSnapshot): void {
  lastCaptureSnapshot = snapshot;
  clearChildren(captureCardsEl);
  captureCardsEl.appendChild(captureEmptyHint);

  const { cards, terms } = snapshot;
  if (cards.length === 0 && terms.length === 0) {
    captureEmptyHint.hidden = false;
    captureEmptyHint.textContent =
      currentSegments.length === 0
        ? "检测结果会显示在这里。"
        : "没有检测到黑话或术语 — 这段话说得挺直白。";
    return;
  }

  captureEmptyHint.hidden = true;
  for (const card of cards) {
    captureCardsEl.appendChild(
      renderExpressionCard(card, {
        saved: isSaved(card.expression),
        onSave: () => void handleSaveCaptureExpression(card),
      }),
    );
  }
  for (const term of terms) {
    captureCardsEl.appendChild(
      renderTermCard(term, {
        saved: isSaved(term.term),
        onSave: () => void handleSaveCaptureTerm(term),
      }),
    );
  }
}

async function handleSaveCaptureExpression(expr: ExpressionCard): Promise<void> {
  await saveLookup({
    kind: "expression",
    headword: expr.expression,
    chinese_explanation: expr.chinese_explanation,
    source_sentence: expr.source_sentence,
  });
  await refreshSavedHeadwords();
  renderCaptureCards(lastCaptureSnapshot); // re-render so the just-saved card flips to "已收藏 ✓"
}

async function handleSaveCaptureTerm(term: TermCard): Promise<void> {
  await saveLookup({
    kind: "term",
    headword: term.term,
    chinese_explanation: term.gloss_zh,
  });
  await refreshSavedHeadwords();
  renderCaptureCards(lastCaptureSnapshot);
}

function handlePrivacyMode(mode: "on-device" | "cloud"): void {
  privacyLine.hidden = false;
  if (mode === "on-device") {
    privacyLine.textContent = "设备端识别，音频未离开本机。";
    privacyLine.className = "js-privacy-line js-privacy-line--on-device";
  } else {
    privacyLine.textContent = "云端模式，音频会发送给 Google 处理。";
    privacyLine.className = "js-privacy-line";
  }
}

function handleGrantNeeded(): void {
  grantAffordance.hidden = false;
  setListenButtonState(false);
}

function handleNotice(msg: string): void {
  captureNotice.hidden = false;
  captureNotice.textContent = msg;
}

function handleSaved(_session: LiteSession): void {
  savedNotice.hidden = false;
  void refreshHistory();
}

async function refreshHistory(): Promise<void> {
  const sessions = await listSessions();
  historyMount.replaceChildren(
    renderHistorySection(sessions, { onDelete: (id) => void handleDeleteSession(id) }),
  );
}

async function handleDeleteSession(id: string): Promise<void> {
  await deleteSession(id);
  void refreshHistory();
}

const captureController = new CaptureController({
  callbacks: {
    onStatusChange: handleCaptureStatus,
    onTranscriptChange: handleTranscriptChange,
    onCardsChange: renderCaptureCards,
    onPrivacyMode: handlePrivacyMode,
    onGrantNeeded: handleGrantNeeded,
    onNotice: handleNotice,
    onSaved: handleSaved,
  },
});

listenBtn.addEventListener("click", () => {
  if (isListening) {
    void captureController.stop();
    return;
  }
  // Clear affordances from any PRIOR attempt before this one runs its
  // own permission/support check.
  grantAffordance.hidden = true;
  savedNotice.hidden = true;
  captureNotice.hidden = true;
  void captureController.start();
});

grantBtn.addEventListener("click", () => {
  // The ONLY place this controller's grant affordance actually opens
  // the permission tab — an explicit extra click, never automatic
  // (blueprint §7's own copy: "点下面的按钮会打开一个页面…").
  void openPermissionPage();
});

translateBtn.addEventListener("click", () => {
  void (async () => {
    if (!lastScannedText) return;
    translateBtn.disabled = true;
    translateOutput.hidden = true;
    const result = await translateText(lastScannedText, setTranslateStatus);
    translateBtn.disabled = false;
    if (result) {
      translateOutput.hidden = false;
      translateOutput.textContent = result;
      translateStatus.textContent = "本机翻译已就绪";
    }
  })();
});

scanBtn.addEventListener("click", runScan);
input.addEventListener("keydown", (e) => {
  // Cmd/Ctrl+Enter scans without leaving the textarea — plain Enter
  // stays a newline (pasted text is often multi-sentence).
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    runScan();
  }
});

void refreshSavedHeadwords();
void checkLanguageDetectorAvailability();
void updateTranslateAffordance();

// 更多能力 is a static registry (lockedFeatures.ts) — rendered once,
// never refreshed, unlike history below.
lockedMount.appendChild(renderLockedSection());
void refreshHistory();
