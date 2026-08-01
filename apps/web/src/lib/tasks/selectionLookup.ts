// Background 划词 (selection lookup) — detached from LookupPopover's
// lifecycle so closing/reselecting does not discard an in-flight answer.
// A lookup is deliberately dictionary-first: an explicit selection means
// “what does this mean?”, not “is this jargon?”. Only a genuine local
// dictionary miss asks AI for a contextual definition and routes the
// selected surface through the configured translation provider.

import type {
  DetectionSource,
  DetectResponse,
  DefineResult,
  Settings,
} from "@jargonslayer/core/types";
import { scanDictionary } from "@jargonslayer/core/detect/dictionary";
import { create } from "zustand";
import { useApp, getMeetingDomainTracker, type LookupRequest } from "../store";
import { defineApi, NoKeyError } from "../llm/client";
import { resolveTaskCreds } from "../llm/taskConfig";
import {
  langPairFromSettings,
  resolveTranslationProvider,
  SystemTranslatorUnavailableError,
} from "../translate/providers";
import { startTask, completeTask, failTask } from "./registry";

export type LookupProgress =
  | { status: "loading" }
  | {
      status: "done";
      /** Local dictionary entries — always scanned before any AI call. */
      result: DetectResponse;
      /** Contextual AI definition, present only after a real dictionary miss. */
      definition?: DefineResult;
      /** Translation from the user's configured translation engine. */
      translation?: string;
      /** AI definition could not run (usually no configured key). */
      dictFallback: boolean;
      definitionError?: string;
      translationError?: string;
    }
  | { status: "error"; error: string };

interface SelectionLookupState {
  byId: Record<string, LookupProgress>;
}

/** Keyed by LookupRequest.id — LookupPopover.tsx reads its own current
 *  request's entry to render loading/result/error, entirely independent
 *  of whether IT is what started the pipeline (a popover reopened after
 *  the fact, or a second popover for a different selection, both just
 *  read whatever's here). */
export const useSelectionLookup = create<SelectionLookupState>(() => ({ byId: {} }));

// L1 (Sol review, v0.5 closeout): startProgress below prunes every
// TERMINAL byId entry the instant a NEW lookup starts, so the
// re-entrance guard at the top of runSelectionLookup — which only
// checks byId — stops seeing an id once its own entry has been pruned:
// a retained old request id resubmitted later would silently re-run
// the whole detect/dictionary pipeline a second time. No current call
// site can actually resubmit an old id (LookupRequest.id is minted
// fresh per selection — see that field's own doc, store.ts), so this is
// a belt for a FUTURE call site, not a fix for an active bug: a bounded
// Set survives the byId prune, capped at the last 32 ids that ever
// reached a terminal state (insertion order doubles as FIFO eviction
// order for a plain JS Set — the oldest entry is always
// `.values().next().value`).
const COMPLETED_IDS_CAP = 32;
const completedIds = new Set<string>();

function markCompleted(id: string): void {
  completedIds.add(id);
  if (completedIds.size > COMPLETED_IDS_CAP) {
    const oldest = completedIds.values().next().value;
    if (oldest !== undefined) completedIds.delete(oldest);
  }
}

// Bounded memory: a brand-new lookup drops every TERMINAL (done/error)
// entry from the map — mirrors registry.ts's own pruneTerminalTasks,
// except a still-LOADING sibling is always kept (a new selection must
// never cancel an older one still in flight — see runSelectionLookup's
// own re-entrance guard below and design item 6: both apply, both land
// their own cards independently).
function startProgress(id: string): void {
  useSelectionLookup.setState((s) => {
    const byId: Record<string, LookupProgress> = { [id]: { status: "loading" } };
    for (const [otherId, entry] of Object.entries(s.byId)) {
      if (entry.status === "loading") byId[otherId] = entry;
    }
    return { byId };
  });
}

function finishProgress(
  id: string,
  result: DetectResponse,
  details: Omit<Extract<LookupProgress, { status: "done" }>, "status" | "result">,
): void {
  useSelectionLookup.setState((s) => ({
    byId: { ...s.byId, [id]: { status: "done", result, ...details } },
  }));
  markCompleted(id);
}

function errorProgress(id: string, error: string): void {
  useSelectionLookup.setState((s) => ({ byId: { ...s.byId, [id]: { status: "error", error } } }));
  markCompleted(id);
}

/** Whether `id` is still the popover's OPEN request, read live off the
 *  store rather than a snapshot captured at kickoff — the user may
 *  close/reselect at any point during the ~20s round trip. */
function isOpenLookup(id: string): boolean {
  return useApp.getState().lookup?.id === id;
}

/** Toast when the pipeline lands after the user has already moved on
 *  (design item 4): the popover that would have shown this result is
 *  gone, so a toast is the only remaining surface. Silent while the
 *  popover is still open on this exact request — it renders the same
 *  result itself (see LookupPopover.tsx). `appliedThisMeeting` (H2)
 *  swaps in a distinct message when hits existed but were withheld
 *  from applyDetection because the owning meeting has since ended —
 *  see applyDetectionForLiveMeeting's own doc below for why. A genuine
 *  dictionary miss instead reports whether its fallback explanation or
 *  translation completed, independently of the meeting generation. */
function notifyIfClosed(
  id: string,
  res: DetectResponse,
  appliedThisMeeting: boolean,
  details: Pick<Extract<LookupProgress, { status: "done" }>, "definition" | "translation" | "dictFallback">,
): void {
  if (isOpenLookup(id)) return;
  const hasHits = res.expressions.length > 0 || res.terms.length > 0;
  if (!hasHits) {
    if (details.definition || details.translation) {
      useApp.getState().showToast("划词解释完成");
    } else if (details.dictFallback) {
      useApp.getState().showToast("词典未收录，AI 解释暂不可用");
    } else {
      useApp.getState().showToast("词典未收录所选内容");
    }
    return;
  }
  useApp.getState().showToast(
    appliedThisMeeting ? "划词解释完成，已加入卡片" : "解释完成，但会议已切换，未自动加入卡片",
  );
}

/** H2 (Sol review, v0.5 closeout): applyDetection (store.ts) merges
 *  `res` into whatever `cards`/`terms` are CURRENT, with no idea which
 *  meeting they belong to. Contamination scenario this guards against:
 *  select text in meeting A, look it up, then start meeting B before
 *  the ~20s AI round trip resolves — an unguarded applyDetection call
 *  here would merge A's hit straight into B's live cards, and a
 *  post-stop save could then persist that contamination into B's saved
 *  session. Guarded by re-reading the LIVE meetingGen against
 *  `capturedGen` (captured at runSelectionLookup's own entry, before
 *  the round trip) — store.ts:353, the established stale-async
 *  discriminator this codebase already uses for the identical class of
 *  problem elsewhere (scheduleSessionSave and friends). Zero hits has
 *  nothing to contaminate, so it always takes the normal path
 *  regardless of gen (see notifyIfClosed's own doc). */
function applyDetectionForLiveMeeting(
  id: string,
  res: DetectResponse,
  source: DetectionSource,
  capturedGen: number,
  details: Pick<Extract<LookupProgress, { status: "done" }>, "definition" | "translation" | "dictFallback">,
): void {
  const hasHits = res.expressions.length > 0 || res.terms.length > 0;
  const sameMeeting = useApp.getState().meetingGen === capturedGen;
  if (hasHits && sameMeeting) useApp.getState().applyDetection(res, source);
  notifyIfClosed(id, res, sameMeeting, details);
}

function hasDictionaryHit(res: DetectResponse): boolean {
  return res.expressions.length > 0 || res.terms.length > 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "查询失败";
}

/** Runs the selection-lookup detect/dictionary pipeline for `req` to
 *  completion — never throws (every failure lands on the "error"
 *  progress entry + failTask below, mirroring this codebase's other
 *  "never throws" pipeline cores). `settings` is captured once, at
 *  kickoff, exactly like the original effect this was extracted from —
 *  not re-read live mid-flight.
 *
 *  Re-entrance guard (store.ts's setLookup fires this on every non-null
 *  lookup, including a duplicate call for a request id already in
 *  flight/finished — e.g. a fast double-tap on the touch "解释" action
 *  bar re-submitting the same LookupRequest): a request id is stable
 *  per SELECTION (minted once — see LookupRequest.id's own doc), so
 *  "already tracked here" means "already started"; bail out rather than
 *  firing a second contextual-definition/translation round trip / task. `completedIds` (L1)
 *  extends this guard past a byId prune — see that Set's own doc above.
 *
 *  meetingGen (H2) is captured HERE, before any await, so a meeting
 *  switch that happens during the ~20s AI round trip below is
 *  detectable once it resolves — see applyDetectionForLiveMeeting's own
 *  doc for the contamination this guards against. */
export async function runSelectionLookup(req: LookupRequest, settings: Settings): Promise<void> {
  if (useSelectionLookup.getState().byId[req.id] || completedIds.has(req.id)) return;

  const capturedGen = useApp.getState().meetingGen;
  startProgress(req.id);

  // An explicit lookup is not ordinary transcript detection: keep all
  // enabled-pack entries for one surface, including common words. This
  // is synchronous, so known entries render without waiting on any AI.
  const dictionary = scanDictionary(req.text, undefined, {
    bypassCommonWordSuppression: true,
    includeAllPackMatches: true,
    activeDomains: getMeetingDomainTracker().activeDomains(),
  });
  if (hasDictionaryHit(dictionary)) {
    const details = { dictFallback: false };
    finishProgress(req.id, dictionary, details);
    applyDetectionForLiveMeeting(req.id, dictionary, "dictionary", capturedGen, details);
    return;
  }

  if (!settings.aiDetect) {
    // Dictionary-only lookups are instant — no task registered (a task
    // that's born completed is noise; see the TaskKind doc in
    // ./registry).
    const details = { dictFallback: false };
    finishProgress(req.id, dictionary, details);
    applyDetectionForLiveMeeting(req.id, dictionary, "dictionary", capturedGen, details);
    return;
  }

  // Real miss: define in the enclosing transcript context and translate
  // the selected surface through the same configured provider used for
  // segment translation. Neither failure hides the other useful result.
  startTask(req.id, "selection-lookup", "解释所选");
  try {
    const pair = langPairFromSettings(settings);
    const provider = resolveTranslationProvider(() => settings);
    // This is a no-op for cloud providers. On-device providers use an
    // existing meeting-start preparation when available; a fresh lookup
    // also makes the best permitted attempt to prepare its language pair.
    provider.prepare(pair);

    // Definition is sequenced BEFORE translation rather than raced
    // against it. `prepare()` above only KICKS OFF an on-device
    // provider's model download/session creation (ChromeTranslator
    // Provider) — it does not wait for it. Firing translate() in the
    // very same tick as prepare() (the old Promise.allSettled pairing)
    // meant a cold model's cache entry was still "pending" 100% of the
    // time, so a provider's very first lookup this page load always
    // threw. defineApi's own network round trip gives that
    // download/session real wall-clock time to finish before translate()
    // is even attempted. Each result is still reported independently —
    // a definition failure never hides a working translation or vice
    // versa.
    let definition: DefineResult | undefined;
    let definitionError: string | undefined;
    let dictFallback = false;
    try {
      definition = await defineApi(
        {
          phrase: req.text,
          context: req.contextText,
          lang: settings.explainLanguage,
          model: resolveTaskCreds(settings, "detect").model,
        },
        settings,
      );
    } catch (err) {
      definitionError = errorMessage(err);
      dictFallback = err instanceof NoKeyError;
    }

    let translation: string | undefined;
    let translationError: string | undefined;
    if (pair.source !== pair.target) {
      try {
        const translations = await provider.translate([{ id: req.id, text: req.text }], pair.target);
        translation = translations.find((item) => item.id === req.id)?.text?.trim() || undefined;
      } catch (err) {
        // A provider that is genuinely unavailable (model still
        // downloading, browser lacks the Translator API at all, native
        // child failed to start) is not something the user can act on
        // from this popover — quietly omitting the translation line is
        // correct; a permanent red error for a condition with no
        // available fix is not. Any OTHER translation failure (a BYOK
        // key/quota problem, say) is still surfaced as before.
        if (!(err instanceof SystemTranslatorUnavailableError)) {
          translationError = errorMessage(err);
        }
      }
    }

    const details = {
      dictFallback,
      ...(definition ? { definition } : {}),
      ...(translation ? { translation } : {}),
      ...(definitionError ? { definitionError } : {}),
      ...(translationError ? { translationError } : {}),
    };
    finishProgress(req.id, dictionary, details);
    completeTask(req.id);
    applyDetectionForLiveMeeting(req.id, dictionary, "dictionary", capturedGen, details);
  } catch (err) {
    // This only covers a synchronous provider/setup defect. Individual
    // definition/translation failures above still land as a readable,
    // honest completed lookup rather than a dead end.
    const message = errorMessage(err);
    errorProgress(req.id, message);
    failTask(req.id, message);
  }
}
