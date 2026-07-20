// Background 划词 (selection-lookup) card generation — v0.5 closeout.
//
// Extracted out of LookupPopover.tsx's own component effect: selecting
// transcript text used to run detection (AI or dictionary) INSIDE that
// popover's effect, guarded by a `cancelled` flag set on cleanup —
// closing the popover (Escape/outside-click/new selection) before the
// ~20s preview-tier AI detect resolved discarded the result outright
// (the flag was checked BEFORE applyDetection). On a live meeting the
// user routinely closes the popover to keep reading, silently losing
// their lookup. This module runs the EXACT same pipeline logic, moved
// verbatim, but detached from any component's lifecycle: once started
// (from store.ts's setLookup — see that action's own doc comment) it
// always runs to completion, applies its detections, and updates the
// task registry/toast regardless of whether the triggering popover is
// still open, still mounted, or long gone.
//
// LookupPopover.tsx stays display-only: it subscribes to
// useSelectionLookup below, keyed by its own current request id,
// instead of owning any of this itself.

import type {
  DetectionSource,
  DetectResponse,
  Settings,
} from "@jargonslayer/core/types";
import { scanDictionary } from "@jargonslayer/core/detect/dictionary";
import { create } from "zustand";
import { useApp, type LookupRequest } from "../store";
import { detectApi, NoKeyError } from "../llm/client";
import { resolveTaskCreds } from "../llm/taskConfig";
import { startTask, completeTask, failTask } from "./registry";

export type LookupProgress =
  | { status: "loading" }
  | { status: "done"; result: DetectResponse; dictFallback: boolean }
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

function finishProgress(id: string, result: DetectResponse, dictFallback: boolean): void {
  useSelectionLookup.setState((s) => ({
    byId: { ...s.byId, [id]: { status: "done", result, dictFallback } },
  }));
}

function errorProgress(id: string, error: string): void {
  useSelectionLookup.setState((s) => ({ byId: { ...s.byId, [id]: { status: "error", error } } }));
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
 *  result itself (see LookupPopover.tsx). */
function notifyIfClosed(id: string, res: DetectResponse): void {
  if (isOpenLookup(id)) return;
  const hasHits = res.expressions.length > 0 || res.terms.length > 0;
  useApp.getState().showToast(hasHits ? "划词解释完成，已加入卡片" : "所选内容未检出术语");
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
 *  firing a second detectApi round trip / task. */
export async function runSelectionLookup(req: LookupRequest, settings: Settings): Promise<void> {
  if (useSelectionLookup.getState().byId[req.id]) return;

  const source: DetectionSource = settings.aiDetect ? "llm" : "dictionary";
  startProgress(req.id);

  if (!settings.aiDetect) {
    // Dictionary-only lookups are instant — no task registered (a task
    // that's born completed is noise; see the TaskKind doc in
    // ./registry).
    const res = scanDictionary(req.text);
    finishProgress(req.id, res, false);
    if (res.expressions.length > 0 || res.terms.length > 0) {
      useApp.getState().applyDetection(res, source);
    }
    notifyIfClosed(req.id, res);
    return;
  }

  // AI path — this is the ~20s (preview-tier) call the tray needs
  // visibility into.
  startTask(req.id, "selection-lookup", "解释所选");
  try {
    const res = await detectApi(
      {
        context: req.contextText,
        new_text: req.text,
        model: resolveTaskCreds(settings, "detect").model,
      },
      settings,
    );
    // #48 s1 review item 12c (preserved from the original LookupPopover
    // effect this pipeline was extracted from): `res` here is shown to
    // the user as-is — a manually-selected phrase always gets explained
    // (LookupPopover renders whatever lands in useSelectionLookup for
    // its open request id), even if its learnKey is suppressed. Only
    // applyDetection (below) re-filters against the learn-set before
    // anything becomes a live card, so a suppressed term stays
    // suppressed (no live card reappears) while the user can still
    // deliberately look it up on demand. By design in v1 — "known" only
    // means "stop pushing it at me automatically."
    finishProgress(req.id, res, false);
    if (res.expressions.length > 0 || res.terms.length > 0) {
      useApp.getState().applyDetection(res, source);
    }
    completeTask(req.id);
    notifyIfClosed(req.id, res);
  } catch (err) {
    if (err instanceof NoKeyError) {
      const dictRes = scanDictionary(req.text);
      finishProgress(req.id, dictRes, true);
      if (dictRes.expressions.length > 0 || dictRes.terms.length > 0) {
        useApp.getState().applyDetection(dictRes, "dictionary");
      }
      completeTask(req.id);
      notifyIfClosed(req.id, dictRes);
    } else {
      const message = err instanceof Error ? err.message : "查询失败";
      errorProgress(req.id, message);
      failTask(req.id, message);
    }
  }
}
