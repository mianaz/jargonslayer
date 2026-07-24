"use client";

// Wiring hook: connects the STT engine layer to the app store and
// the detection scheduler. Owns the lifecycle of both per meeting.

import { useCallback, useEffect, useRef } from "react";
import { useApp, currentSessionSnapshot } from "../lib/store";
import { createEngine } from "../lib/stt";
import { DetectionScheduler } from "../lib/detect/scheduler";
import { TranslateQueue } from "../lib/translate/queue";
import { langPairFromSettings, resolveTranslationProvider } from "../lib/translate/providers";
import { diagLog } from "../lib/diag/log";
import { resetLagStats } from "../lib/stt/latencyStats";
import { buildMeetingLexicon } from "../lib/stt/lexicon";
import { SONIOX_PREVIEW_LANE } from "../lib/deployTier";
import { getPreviewSessionSeconds } from "../lib/stt/soniox";
import { ENGINE_CAPABILITIES, resolveTabAudioCloudProvider, type LiveEngineKind } from "../lib/stt/engineCapabilities";
import * as liveDraft from "../lib/history/liveDraft";
import { IS_DESKTOP } from "../lib/platform/desktop";
import { initDesktop } from "../lib/desktop/bootstrap";
import type { STTEngine, STTEngineKind, STTEvents, Settings } from "@jargonslayer/core/types";

// Live bilingual transcript (#42): how many of the most recent
// finalized segments to catch up when the toggle flips OFF->ON
// mid-meeting (see the backfill effect below).
const BILINGUAL_BACKFILL_COUNT = 5;

// Storage durability (v0.5 closeout item 4): navigator.storage.persist()
// asks the browser not to evict IndexedDB under pressure. Requested once
// per PAGE LOAD (not per meeting, and never at app boot — see this
// module-level flag's own read site in start() below for why boot is the
// wrong moment). Module-level, not a ref: this hook is mounted once for
// the app's whole lifetime (page.tsx), so this is equivalent in practice,
// but a plain module flag says "once ever this load" more directly than
// a ref would.
let storagePersistRequested = false;

/** Diagnostics choke-point wiring (item 2/3): every onError-shaped
 *  callback below (DetectionScheduler, TranslateQueue, STT engine
 *  onStatus("error")/onDiarStatus's error branch) uses this SAME
 *  pattern — log an "error" diag entry (log.ts assigns it a ref) and
 *  build the matching ref-carrying toast payload, so the toast's ref
 *  and the ring-buffer entry's ref are always the exact same value.
 *  Exported (not just inlined per call site) so this exact wiring is
 *  directly unit-testable — this repo has no hook-render test harness
 *  (see hooks/__tests__'s existing coverage, all pure-function-level),
 *  so testing useMeeting() itself isn't practical; testing the wiring
 *  it actually calls is. */
export function logAndToastError(
  tag: string,
  message: string,
  detail?: string,
): { message: string; ref?: string } {
  const entry = diagLog("error", tag, message, detail);
  return { message, ref: entry.ref };
}

/** Field-test fix B: does `engine` ride the managed local sidecar
 *  process (engineCapabilities.ts's own static sidecarOnly flag, e.g.
 *  whisper/appaudio) — used by preflightManagedSidecar below (start()'s
 *  and resume()'s shared preflight). Object.hasOwn
 *  (not `in`, which also matches anything inherited off
 *  Object.prototype) keeps the lookup an honest miss for the non-live
 *  STTEngineKind members (demo/import/browser-whisper), none of which
 *  have a row in ENGINE_CAPABILITIES. */
function ridesManagedSidecar(engine: STTEngineKind): boolean {
  return (
    Object.hasOwn(ENGINE_CAPABILITIES, engine) &&
    ENGINE_CAPABILITIES[engine as LiveEngineKind].sidecarOnly === true
  );
}

/** Field-test fix B: does `settings` need the managed-sidecar preflight
 *  below AT ALL — desktop-only (IS_DESKTOP), managed-mode-only
 *  (sidecarMode !== "external"), sidecar-riding-engine-only
 *  (ridesManagedSidecar). A plain synchronous boolean, deliberately
 *  checked by callers BEFORE ever calling (let alone awaiting)
 *  preflightManagedSidecar itself — that function unconditionally
 *  awaits initDesktop(), so gating it here means the overwhelmingly
 *  common case (any non-desktop web build, external sidecar mode, or a
 *  non-sidecar engine) costs zero async overhead: no promise, no
 *  microtask tick, same synchronous timing as if this preflight didn't
 *  exist at all. That's not just tidiness — useMeeting.lifecycle.test.
 *  tsx's own startListeningSoft() helper relies on createEngine()
 *  running fully SYNCHRONOUSLY as part of `p = api!.start();` itself
 *  (see that helper's own comment); an unconditional `await
 *  preflightManagedSidecar(...)` at the call site, even one that
 *  resolves "immediately", would still push createEngine() one
 *  microtask later and break that assumption for every non-desktop
 *  test in this file. */
function needsManagedSidecarPreflight(settings: Settings): boolean {
  return IS_DESKTOP && settings.sidecarMode !== "external" && ridesManagedSidecar(settings.engine);
}

/** Field-test fix B (verified root cause): whisper/appaudio ride the
 *  managed local sidecar — starting/resuming into one while the
 *  sidecar isn't actually provisioned/healthy used to sail straight
 *  into the engine's own doomed connect, landing on a raw "cd sidecar
 *  && python whisper_server.py" CLI error no desktop-app user can act
 *  on (whisperSocket.ts's connectFailureMessage). Only ever called once
 *  needsManagedSidecarPreflight(settings) above has already returned
 *  true (see its own doc comment for why that gate lives OUTSIDE this
 *  function rather than as its own leading check) — an "external" user
 *  runs their own server and must never be redirected into this app's
 *  own install wizard. requestProvisionCheck() (bootstrap.ts) is the
 *  NON-destructive re-entry into the same CHECKING flow reprovision()
 *  uses — see its own doc comment for why this must not be
 *  reprovision() itself (which would wipe an already-good install
 *  record over what might just be a transient probe blip). Fire-and-
 *  forget + swallowed rejection: the only way it rejects is the shared
 *  sidecar-lifecycle latch already being held by some OTHER in-flight
 *  operation, which will settle the UI on its own.
 *
 *  Shared by start() and resume() (F2 field-test fix, round 2 —
 *  resume() used to bypass this entirely: settings cards unlock while
 *  paused, so switching to an unprovisioned sidecar engine and then
 *  resuming sailed into the exact same doomed connect start() already
 *  guarded against) — ONE implementation so both stay in lock-step,
 *  never two copies of this logic drifting apart. Returns true when
 *  the caller must ABORT (the toast + fire-and-forget
 *  requestProvisionCheck() above already fired); false when it's safe
 *  to proceed with a normal attach — the handle is already HEALTHY. */
async function preflightManagedSidecar(): Promise<boolean> {
  const handle = await initDesktop();
  if (handle.currentState().phase !== "HEALTHY") {
    useApp.getState().showToast("本地 Whisper 尚未安装，正在打开安装向导…");
    void handle.requestProvisionCheck().catch(() => {});
    return true;
  }
  return false;
}

export interface UseMeetingResult {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  startDemo: () => Promise<void>;
}

export function useMeeting(): UseMeetingResult {
  const engineRef = useRef<STTEngine | null>(null);
  const schedulerRef = useRef<DetectionScheduler | null>(null);
  const translateQueueRef = useRef<TranslateQueue | null>(null);

  // Lifecycle serialization (codex review 2026-07-10, rounds 1-3):
  // start/pause/resume/stop each await an engine teardown or attach,
  // and a second lifecycle click landing INSIDE that window corrupted
  // state (double-pause restamped pauseStartedAt; End during pause's
  // await resurrected an already-saved meeting as "paused").
  // Synchronous check-and-set — a concurrent lifecycle call no-ops
  // instead of interleaving.
  //
  // EXCEPT End: a gated no-op silently DROPS the user's End exactly
  // when it must win (e.g. clicked while resume is awaiting a
  // permission prompt). End therefore never no-ops — when the gate is
  // held it records an intent flag; the intent suppresses any
  // engine-driven upward status flip (attachEngine's onStatus), blocks
  // resume's accounting fold, and the gate drains it into a real stop
  // the moment it frees.
  const lifecycleBusyRef = useRef(false);
  const pendingEndRef = useRef(false);

  // Terminal-teardown race (codex v2 review F6): the error and
  // capture_ended branches below call runStopFlow() UN-GATED (they
  // deliberately never go through withLifecycleGate — gating them
  // would deadlock: an error firing WHILE pause()/resume() itself
  // holds the gate could otherwise never resolve). That means the
  // lifecycle gate stays FREE for the whole up-to-8s drain, so if the
  // meeting was "paused" (soft) when the error/capture_ended fired,
  // Resume stays clickable the entire time: the still-alive-but-
  // dying engine's own resume() would no-op (it's mid-`stopping`), yet
  // resume() would unconditionally call resumeMeeting() anyway,
  // producing a phantom "listening" over a dead capture. Set
  // SYNCHRONOUSLY (before runStopFlow ever awaits) at the top of both
  // branches, cleared in a finally once runStopFlow settles — pause()/
  // resume() both plain-return while it's set, without touching the
  // gate itself.
  const terminalTeardownRef = useRef(false);

  // Diar "ready" one-shot toast (STT protocol v2): reset per meeting
  // (see start() below) so a hard-resume's fresh engine (which re-arms
  // diarization from scratch on the sidecar) doesn't spam a second
  // toast within the SAME meeting — a soft-paused/resumed connection
  // never re-arms at all, so this also naturally covers "don't toast
  // again on a within-meeting reconnect".
  const diarReadyToastedRef = useRef(false);

  // Preview-lane trial notice (v0.5 closeout, owner ask: "the trial's
  // limits CLEARLY noticed"): one-shot per meeting start, same reset
  // seam as diarReadyToastedRef immediately above — no existing
  // "first listening" hook point exists in this file to piggy-back on
  // (diarReadyToastedRef covers a DIFFERENT event, onDiarStatus
  // "ready"), so this is a new ref styled identically. Unlike
  // diarReadyToastedRef, this ALSO covers a teardown-RESUME: soniox/
  // tabaudio-cloud have no soft pause (see either engine's own "No
  // pause/resume" header note), so resuming from a pause reattaches a
  // FRESH engine instance that fires onStatus("listening") again — this
  // ref is only reset in start(), never in resume(), so that re-fire is
  // deliberately suppressed (one notice per MEETING, not per attach).
  const previewMintNoticeRef = useRef(false);

  // Live draft persistence (v0.5 closeout item 1 — see
  // lib/history/liveDraft.ts's own header comment for the write policy).
  // Last-written dirty signature (M1 fix, Sol adversarial review:
  // replaces the old segments/cards-count throttle pair with
  // liveDraft.computeDraftSignature's field-separated string) — null
  // means "this meeting hasn't written a draft yet". Reset in start() (same
  // seam as diarReadyToastedRef/previewMintNoticeRef above) so a
  // brand-new meeting's first tick isn't compared against the PREVIOUS
  // meeting's last-known signature.
  const lastDraftSignatureRef = useRef<string | null>(null);
  // Draft-write single-flight (Sol round-3 H) — a ref so it survives
  // the [status, engine] effect re-running mid-write; see the tick's
  // own comment below.
  const draftWritingRef = useRef(false);

  // Engine-creation/wiring block (pause/resume, B3): extracted out of
  // start() so resume() can reattach a FRESH engine instance to the
  // SAME meeting (same scheduler/translateQueue, same sessionGen)
  // without re-running beginMeeting() or recreating either queue —
  // both stay alive across a pause (they read meetingGen via
  // closures, not a captured value, so they keep working unchanged
  // once the meeting resumes). Requires schedulerRef/translateQueueRef
  // to already be wired (true both from start(), which just created
  // them, and from resume(), which never tore them down).
  // Returns whether the attach SUCCEEDED — resume must not infer
  // success from global status (codex round-3: the un-awaited error
  // stop flow updates status asynchronously, so status can read
  // "paused" long after the engine already failed).
  const attachEngine = useCallback(async (sessionGen: number): Promise<boolean> => {
    const scheduler = schedulerRef.current;
    const translateQueue = translateQueueRef.current;
    if (!scheduler || !translateQueue) return false;

    const settings = useApp.getState().settings;
    const engine = createEngine(settings.engine);
    engineRef.current = engine;
    let attachFailed = false;

    // Returns whether it's safe for a caller to show a "your meeting was
    // saved" toast (H1 fix, Sol adversarial review): true when there was
    // nothing to save OR saveCurrentSession's write succeeded; false
    // only when there WAS something to save and it failed —
    // saveCurrentSession already shows its own 保存失败 toast in that
    // case, so callers must not show a contradicting success toast on
    // top of it.
    const runStopFlow = async (): Promise<boolean> => {
      // F1 field-test fix (stale-teardown ownership guard, Sol
      // adversarial review): captured HERE, synchronously, before this
      // flow's OWN first await — this is the engine THIS flow itself
      // is tearing down, never re-read from live settings.engine after
      // the awaits below, which by the time they resolve may belong to
      // an entirely different, NEWER meeting (a real engine erroring
      // here can race a brand-new startDemo() started while this flow
      // is still awaiting saveCurrentSession — see the endDemoOverlay()
      // call site further down for why that race matters).
      const wasDemo = engine.kind === "demo";
      await engine.stop();
      // Stop-drain belt (STT protocol v2): the drain final's own
      // onFinal already clears interim when one arrives, but a stop
      // with no trailing final must not leave a stale gray interim on
      // screen forever — see doStop's matching call for the full
      // rationale.
      useApp.getState().setInterim(null);
      scheduler.flushNow();
      const segCount = useApp.getState().segments.length;
      useApp.getState().setStatus(segCount ? "stopped" : "idle");
      // Persist whatever was transcribed — engine errors and demo
      // completion must not lose the session. Late detection results
      // and a lingering speaker_update (see wsTransport.ts's
      // POST_STOP_LINGER_MS) are both re-saved by the store's post-stop
      // debounced save (store.ts's applyDetection/applySpeakerUpdate).
      let ok = true;
      if (segCount > 0) {
        const savedId = await useApp.getState().saveCurrentSession();
        ok = savedId !== null;
      }
      // Demo-overlay stash (field-test round, extends S14.1): this is
      // the natural-completion teardown path (detail === "demo_finished",
      // see below) for a demo that plays through to its own scripted end
      // rather than being manually stopped — doStop below covers the
      // OTHER teardown path (an early manual End). endDemoOverlay is a
      // safe no-op for the error/capture_ended branches sharing this
      // same function (no overlay is ever active while a REAL engine is
      // attached). Called AFTER saveCurrentSession above, never before —
      // saveCurrentSession stamps the saved MeetingSession's own
      // `engine` field from the LIVE settings.engine at call time, which
      // must still read "demo" for a demo session's own history record.
      // F1 field-test fix: gated on wasDemo (captured above, before any
      // await) — a stale flow tearing down a REAL engine must never end
      // an overlay some OTHER, newer flow armed in the meantime (see
      // wasDemo's own doc comment for the exact race this closes).
      if (wasDemo) useApp.getState().endDemoOverlay();
      return ok;
    };

    const events: STTEvents = {
      onInterim: (text, speaker) => {
        // Late-partial belt (STT protocol v2 fix, codex v2 review
        // F4): a "flush" (soft pause) doesn't cancel an in-flight
        // partial transcription — its result can arrive AFTER pause
        // already cleared the interim, with no new PCM ever coming to
        // replace it, so it would otherwise stick on screen forever.
        // Only accept interim text while the meeting is actually
        // listening for one; this also belts a straggler arriving
        // after End (stop()/runStopFlow already clear interim, but a
        // late partial landing right after would otherwise repopulate
        // it one more time).
        const status = useApp.getState().status;
        if (status !== "listening" && status !== "connecting") {
          diagLog("info", "stt-lifecycle", "忽略非监听状态下到达的插字");
          return;
        }
        // Honest interim contract (fix #A4): the engine layer now
        // forwards `""` (a genuine retraction) instead of swallowing
        // it — map that to `null` here so InterimLine doesn't render
        // an empty-but-non-null interim row. Real engines other than
        // webSpeech (wsTransport/demo) only ever emit non-empty text,
        // so this is a no-op for them.
        useApp.getState().setInterim(text ? { text, speaker } : null);
      },
      onFinal: (text, opts) => {
        const seg = useApp.getState().addFinal(text, opts);
        useApp.getState().setInterim(null);
        scheduler.pushSegment(seg);
        translateQueue.pushSegment(seg);
      },
      onSpeakerUpdate: (assignments, speakers) => {
        useApp.getState().applySpeakerUpdate(assignments, speakers, sessionGen);
      },
      onDiarStatus: (state, detail) => {
        // UI copy is fixed per spec — `detail` (the sidecar's own
        // short status string) only ever reaches the diag ring buffer
        // below, never the toast text itself.
        if (state === "error") {
          useApp
            .getState()
            .showToast(logAndToastError("stt-diar", "实时说话人分离出错，已停止本场自动标注", detail));
        } else if (state === "ready") {
          // Positive ack (STT protocol v2): arming actually succeeded
          // on the sidecar. One-shot per meeting — see
          // diarReadyToastedRef's own doc comment.
          if (!diarReadyToastedRef.current) {
            diarReadyToastedRef.current = true;
            diagLog("info", "stt-diar", "实时说话人分离已开启");
            useApp.getState().showToast("实时说话人分离已开启");
          }
        } else {
          diagLog("warn", "stt-diar", "实时说话人分离不可用，已回退到纯转录", detail);
          useApp.getState().showToast("实时说话人分离不可用，已回退到纯转录");
        }
      },
      onNotice: (msg) => {
        // Advisory only (see STTEvents.onNotice's own doc comment) —
        // logged at "warn", no ref/toast-copy action: this is a steer
        // hint, not a failure to diagnose.
        diagLog("warn", "stt-notice", msg);
        useApp.getState().showToast(msg);
      },
      onEngineMode: (mode) => {
        // On-device Web Speech (see STTEvents.onEngineMode's own doc)
        // — plain store mirror, no toast/diag here (webSpeech.ts
        // already diag-logs the decision itself); StatusLine's privacy
        // indicator reads this field directly.
        useApp.getState().setSttEngineMode(mode);
      },
      onStatus: (status, detail) => {
        if (status === "connecting" || status === "listening") {
          // A pending End outranks the engine (codex round-3): once
          // the user clicked End, no engine event may flip the meeting
          // upward while the intent awaits its drain.
          if (pendingEndRef.current) return;
          // Soft-paused (STT protocol v2): a still-alive transport
          // (tabaudio) can emit its own reconnect status events (e.g.
          // a transient ws drop) while the meeting is soft-paused —
          // that must never un-pause the UI out from under the user.
          if (useApp.getState().status === "paused") {
            diagLog("warn", "stt-lifecycle", `忽略暂停期间的引擎状态变化: ${status}`);
            return;
          }
          useApp.getState().setStatus(status, status === "connecting" ? detail : undefined);
          // Preview-lane trial notice (v0.5 closeout item 3, tightened
          // for BYOK preview — docs/design-explorations/byok-preview-
          // blueprint.md D3): fires once per meeting start, only for a
          // session actually riding the server-minted credential — real
          // BYOK traffic must never see a toast claiming a trial cap
          // that doesn't apply to it. `engine.kind === "soniox"` is
          // already gated on `!settings.sonioxKey` (a BYOK sonioxKey
          // holder never mints, see soniox.ts's own SonioxEngine.
          // start). `engine.kind === "tabaudio-cloud"` ALSO needs the
          // resolved-provider check below now: tabAudioCloud.ts's
          // effectiveProvider no longer force-routes every tab-cloud
          // session through Soniox on this lane (D3 — it honestly runs
          // whatever Settings.tabAudioCloudProvider says), so a user
          // running their OWN Deepgram key through this engine has
          // `!settings.sonioxKey` trivially true (they never entered a
          // Soniox key at all) even though no mint is involved —
          // without this check the notice would wrongly tell a paying
          // Deepgram BYOK user their audio went through Soniox's trial.
          if (
            status === "listening" &&
            !previewMintNoticeRef.current &&
            SONIOX_PREVIEW_LANE &&
            !settings.sonioxKey &&
            (engine.kind === "soniox" ||
              (engine.kind === "tabaudio-cloud" && resolveTabAudioCloudProvider(settings) === "soniox"))
          ) {
            previewMintNoticeRef.current = true;
            const s = getPreviewSessionSeconds() ?? 600;
            useApp
              .getState()
              .showToast(
                `预览体验：本段最长 ${Math.round(s / 60)} 分钟（每日限量），音频经 Soniox 云端转写、不留存`,
              );
          }
        } else if (status === "error") {
          attachFailed = true;
          // F6: set BEFORE runStopFlow's first await — see
          // terminalTeardownRef's own doc above.
          terminalTeardownRef.current = true;
          useApp.getState().showToast(logAndToastError("stt", detail ?? "转录引擎错误"));
          void runStopFlow().finally(() => {
            terminalTeardownRef.current = false;
          });
        } else if (
          status === "idle" &&
          (detail === "demo_finished" || detail === "capture_ended")
        ) {
          // F6: same synchronous-before-await set as the error branch.
          terminalTeardownRef.current = true;
          // capture_ended toast copy is engine-kind-conditional
          // (adversarial review finding F10): an earlier S9.4 fix here
          // changed this to "音频捕获已结束" UNCONDITIONALLY, which
          // silently altered tabaudio's (and any other non-appaudio
          // engine's) WEB-build toast too, violating D7's "browser
          // behavior stays byte-identical" pin. tabaudio (and anything
          // else) keeps the ORIGINAL "共享已结束" share-picker phrasing;
          // only appaudio's own CoreAudio-tap ending gets "音频捕获已结束"
          // — "共享" reads wrong there, since a tap never opened a share
          // picker in the first place. `engine` (this attachEngine()
          // call's own instance, same closure the pause branch below
          // reads `engine?.pause` from) is what carries the kind.
          const endToast =
            detail === "capture_ended"
              ? engine.kind === "appaudio"
                ? "音频捕获已结束，会议已保存到历史记录"
                : "共享已结束，会议已保存到历史记录"
              : "演示结束，打开右侧「纪要」标签生成会后报告试试";
          void runStopFlow()
            .then((savedOk) => {
              // H1 fix (Sol adversarial review): don't claim "已保存到
              // 历史记录" over a save that saveCurrentSession itself
              // just reported (and toasted) as failed — that toast
              // already told the user their draft is intact; this one
              // would silently overwrite it with a false success claim.
              if (savedOk) useApp.getState().showToast(endToast);
            })
            .finally(() => {
              terminalTeardownRef.current = false;
            });
        }
      },
    };

    // v0.4.7 Lane B (glossary -> recognizer bias, docs/design-
    // explorations/stt-provider-wiring-2026-07.md §3, D8): ONE lexicon
    // snapshot, built HERE (read via existing store selectors, same
    // moment `settings` above was read) and passed explicitly into
    // engine.start() — adapters never read the store for this
    // themselves anymore (Q11's osSpeech.ts direct read migrated onto
    // this same seam). Every real engine.start() invocation goes
    // through this ONE attachEngine() call site (fresh start() AND
    // resume()'s teardown-reattach), so a mid-meeting reattach always
    // gets a freshly-built snapshot too — same "start-time one-shot"
    // semantics Q11 already had, just generalized.
    //
    // D1 extension point: bias is default-ON, unconditional, for every
    // free/local mechanism (doc D1) — a future 术语偏置 Settings toggle
    // would gate this whole build+pass step right here (e.g. `settings
    // .termBiasEnabled === false ? undefined : buildMeetingLexicon(...)`)
    // rather than inside any individual adapter.
    const lexicon = buildMeetingLexicon({
      customEntries: useApp.getState().customEntries,
      enabledPacks: settings.enabledPacks,
      learnset: useApp.getState().learnset,
    });
    await engine.start(events, settings, lexicon);
    return !attachFailed;
  }, []);

  // End body, ungated — reachable from listening AND paused; also the
  // drain target for pendingEndRef.
  const doStop = useCallback(async () => {
    const engine = engineRef.current;
    engineRef.current = null;
    // F1 field-test fix — same ownership guard as attachEngine's own
    // runStopFlow above (see its wasDemo doc comment for the full
    // race): captured HERE, before this flow's own first await, from
    // the engine THIS flow itself is tearing down.
    const wasDemo = engine?.kind === "demo";
    const scheduler = schedulerRef.current;
    if (engine) {
      await engine.stop();
    }
    // Stop-drain belt (STT protocol v2): the drain final's own onFinal
    // already clears interim when one arrives (WsTransport.stop() now
    // waits for the sidecar's drain ack before resolving — see
    // wsTransport.ts), but a stop with no trailing final (nothing was
    // being said, or the tail was pure silence) would otherwise leave
    // a stale gray interim on screen forever.
    useApp.getState().setInterim(null);
    // Scheduler stays alive so late responses still land; it is
    // replaced+stopped on the next start().
    scheduler?.flushNow();
    useApp.getState().setStatus("stopped");

    if (useApp.getState().segments.length > 0) {
      const savedId = await useApp.getState().saveCurrentSession();
      // H1 fix (Sol adversarial review): only claim "已保存到历史记录"
      // when it actually was — saveCurrentSession already shows its own
      // 保存失败 toast (and keeps the draft) when the underlying write
      // fails.
      if (savedId) {
        useApp.getState().showToast("会议已保存到历史记录");
      }
    }
    // Demo-overlay stash (field-test round, extends S14.1): this is the
    // manual-End teardown path — attachEngine's own runStopFlow covers a
    // demo playing through to its own scripted end instead. A safe
    // no-op for any non-demo meeting (endDemoOverlay only restores when
    // an overlay is actually active), so an ordinary End never touches
    // this. Called AFTER saveCurrentSession above — see runStopFlow's
    // matching comment for why the order matters (the saved
    // MeetingSession.engine must still read "demo").
    // F1 field-test fix: gated on wasDemo (captured above, before any
    // await) — see runStopFlow's matching guard for the exact race.
    if (wasDemo) useApp.getState().endDemoOverlay();
  }, []);

  const withLifecycleGate = useCallback(async (fn: () => Promise<void>) => {
    if (lifecycleBusyRef.current) return;
    lifecycleBusyRef.current = true;
    try {
      await fn();
    } finally {
      lifecycleBusyRef.current = false;
      if (pendingEndRef.current) {
        pendingEndRef.current = false;
        // Re-enters the (now free) gate; a pendingEnd set during THIS
        // drain lands in the drain's own finally, so intents can't
        // starve.
        void withLifecycleGate(doStop);
      }
    }
  }, [doStop]);

  const start = useCallback(async () => withLifecycleGate(async () => {
    const { status, settings } = useApp.getState();
    if (status === "listening" || status === "connecting") return;

    // Field-test fix B (verified root cause) — see preflightManagedSidecar's
    // own doc comment (shared with resume() below, F2 field-test fix)
    // for the full rationale. Checked, and returned from, BEFORE
    // beginMeeting()/the scheduler/translateQueue below are ever
    // touched, so a blocked Start leaves the app in exactly the state
    // it was in before the click — unlike the mic-permission-denial
    // path (acquireStream's own catch, surfaced through this
    // callback's onStatus("error") handler below AFTER beginMeeting()
    // has already run and torn down via runStopFlow), there's nothing
    // here to tear down in the first place.
    if (needsManagedSidecarPreflight(settings) && (await preflightManagedSidecar())) return;

    diarReadyToastedRef.current = false;
    previewMintNoticeRef.current = false;
    // Live draft persistence: fresh signature state for the new meeting
    // — see lastDraftSignatureRef's own doc comment above for why this
    // reset matters (not just tidiness).
    lastDraftSignatureRef.current = null;
    // Storage durability (v0.5 closeout item 4): first meeting start of
    // this page load only (not app boot — see storagePersistRequested's
    // own doc comment above), fire-and-forget, feature-detected. Fires
    // for a demo start too — this is general IndexedDB-eviction
    // protection (settings/history/glossary/learnset), unrelated to
    // whether THIS particular meeting ever drafts anything.
    if (!storagePersistRequested) {
      storagePersistRequested = true;
      try {
        if (typeof navigator !== "undefined" && navigator.storage?.persist) {
          void navigator.storage.persist();
        }
      } catch {
        // non-fatal
      }
    }
    // S10 field-fix #6: a fresh session must never show a stale EMA
    // reading carried over from the previous one (lib/stt/latencyStats.
    // ts's own resetLagStats doc comment) — same per-session-start seam
    // as diarReadyToastedRef's reset just above. Not called from
    // resume()'s soft/teardown-resume paths below — those continue the
    // SAME session (a pause never counts as "the next" one).
    resetLagStats();
    useApp.getState().beginMeeting();
    // Captured once, right after beginMeeting() bumps meetingGen —
    // this is "this engine session's gen" for the meeting-boundary
    // guards below (late scheduler results / late speaker updates
    // from a previous meeting must not land on this one, and vice
    // versa once a NEXT meeting starts and bumps the gen again).
    const sessionGen = useApp.getState().meetingGen;

    // Replace any previous scheduler before wiring a fresh one.
    schedulerRef.current?.stop();
    const scheduler = new DetectionScheduler({
      getSettings: () => useApp.getState().settings,
      getMeetingGen: () => useApp.getState().meetingGen,
      onDetection: (res, src, meta) => useApp.getState().applyDetection(res, src, meta),
      onBusyChange: (b) => useApp.getState().setDetectBusy(b),
      onModeChange: (m) => useApp.getState().setDetectMode(m),
      onError: (msg) => useApp.getState().showToast(logAndToastError("detect-scheduler", msg)),
    });
    schedulerRef.current = scheduler;

    // Replace any previous translate queue before wiring a fresh one —
    // same lifecycle as the scheduler above.
    translateQueueRef.current?.stop();
    // v0.5 Wave-1 Feature 6 / A6 (docs/design-explorations/
    // v05-wave1-blueprint.md §1 Feature 6 + §5 A6): provider KIND is
    // decided once here (mirrors attachEngine's own settings.engine
    // snapshot just below) and, when it resolves to the on-device
    // Chrome provider, prepare() MUST fire synchronously, inside THIS
    // Start click's own user gesture, before any await — this whole
    // start() callback body still runs synchronously up to
    // attachEngine's own internal `await engine.start(...)`, so this
    // call site is well inside that window. See providers.ts's header
    // comment for the full activation contract; LlmTranslationProvider's
    // prepare() is a no-op, so this is harmless when the resolved
    // provider is (as by far most commonly) "llm".
    const provider = resolveTranslationProvider(() => useApp.getState().settings);
    provider.prepare(langPairFromSettings(useApp.getState().settings));
    const translateQueue = new TranslateQueue({
      getSettings: () => useApp.getState().settings,
      getMeetingGen: () => useApp.getState().meetingGen,
      provider,
      onTranslations: (map, gen) => useApp.getState().applyTranslations(map, gen),
      onError: (msg) => useApp.getState().showToast(logAndToastError("translate-queue", msg)),
    });
    translateQueueRef.current = translateQueue;

    await attachEngine(sessionGen);
  }), [attachEngine, withLifecycleGate]);

  // Pause (B3, soft branch added by STT protocol v2): two branches —
  // SOFT (engine.pause exists — tabaudio and appaudio) keeps the
  // engine/transport alive, so resume needs no reconnect and no
  // re-picker; TEARDOWN (everything else, unchanged from B3) stops the
  // engine outright and resume() reattaches a fresh one. Both branches
  // share the same ordering rationale (codex review 2026-07-10): flip
  // to "paused" SYNCHRONOUSLY before the awaited pause/stop call, so
  // every other lifecycle guard sees the new state first.
  const pause = useCallback(async () => withLifecycleGate(async () => {
    // F6: an un-gated error/capture_ended teardown is draining — see
    // terminalTeardownRef's own doc above. Plain-return without
    // touching the gate itself (the gate stays free for this whole
    // window by design).
    if (terminalTeardownRef.current) return;
    const { status } = useApp.getState();
    if (status !== "listening") return;
    const engine = engineRef.current;
    if (engine?.pause) {
      // Soft pause: KEEP engineRef.current — this is what distinguishes
      // it from the teardown branch below (resume() branches on the
      // very same `engineRef.current?.resume` check).
      useApp.getState().pauseMeeting();
      await engine.pause();
      useApp.getState().setInterim(null);
      return;
    }
    // Teardown pause: webspeech's stop() drains the working tail into
    // committed segments before it resolves; the interim display is
    // cleared only after that drain.
    engineRef.current = null;
    useApp.getState().pauseMeeting();
    await engine?.stop();
    useApp.getState().setInterim(null);
  }), [withLifecycleGate]);

  // Resume (B3, soft branch added by STT protocol v2): mirrors pause()'s
  // two branches. SOFT (engineRef.current?.resume exists — the SAME
  // still-alive engine from a soft pause): resume it in place, no
  // re-attach, no re-picker. TEARDOWN (everything else, unchanged from
  // B3): attachEngine() a FRESH engine instance (the paused one was
  // fully torn down), and resumeMeeting() only once capture is
  // attached, so the paused-time accounting also absorbs the
  // connection delay instead of counting it as active meeting time
  // (codex review 2026-07-10).
  const resume = useCallback(async () => withLifecycleGate(async () => {
    // F6: same plain-return as pause() above — see terminalTeardownRef's
    // own doc.
    if (terminalTeardownRef.current) return;
    const { status, meetingGen, settings } = useApp.getState();
    if (status !== "paused") return;
    let engine = engineRef.current;
    // F2 field-test fix (Sol review, round 2): settings cards unlock
    // while paused, so this resume() call can end up attaching a
    // DIFFERENT engine than whatever was live before — either via the
    // kind-mismatch teardown+reattach below (F7), or because the prior
    // pause was already a full TEARDOWN pause to begin with (e.g.
    // webspeech, which has no soft pause at all — `engine` is already
    // null here). Either way that's a fresh attachEngine() call below,
    // exactly like start()'s own first attach, and needs the SAME
    // preflight — see preflightManagedSidecar's own doc comment.
    // needsFreshAttach is false ONLY when `engine` is both alive AND
    // still the currently-selected kind — the one case guaranteed to
    // take the soft in-place engine.resume() branch further down
    // untouched, so it's the only case that keeps current (no-
    // preflight) behavior. Computed and checked BEFORE any teardown
    // below — a blocked resume leaves the meeting exactly as it was:
    // still paused, old engine (if any) fully untouched, same non-
    // destructive contract as start()'s own preflight (the user can fix
    // the sidecar and hit resume again).
    const needsFreshAttach = !(engine && engine.resume && engine.kind === settings.engine);
    if (
      needsFreshAttach &&
      needsManagedSidecarPreflight(settings) &&
      (await preflightManagedSidecar())
    ) {
      return;
    }
    // Engine switch during a retained soft pause (codex v2 review F7):
    // pre-v2, EVERY pause was teardown, so switching engines in
    // Settings while paused was already honored (resume's
    // teardown-resume path below always attaches whatever
    // settings.engine currently says). A RETAINED soft-paused engine
    // (tabaudio) bypasses that entirely by design — it's the SAME
    // instance, never re-attached — so it silently kept ignoring a
    // mid-pause engine switch. If the live engine no longer matches
    // the currently-selected one, fully tear it down (including its
    // own stop drain) here, then fall through to the SAME
    // teardown-resume path below so the newly selected engine attaches
    // (the tab-audio picker reappearing when switching TO tabaudio is
    // expected — same as any other fresh attach). Same pendingEnd
    // guards as the paths below apply automatically once this falls
    // through — nothing extra needed here.
    if (engine && engine.kind !== settings.engine) {
      engineRef.current = null;
      await engine.stop();
      engine = null;
    }
    if (engine?.resume) {
      await engine.resume();
      // A pending End equally wins over the fold here (mirrors the
      // teardown branch's own guard below) — the gate's drain will
      // stop this SAME engine the moment this call releases. Unlike
      // the teardown branch, there is no attach-failure/stopped-or-
      // idle race to also guard against: resume() on an already-live
      // transport doesn't asynchronously fail the way attachEngine can.
      if (!pendingEndRef.current) {
        useApp.getState().resumeMeeting();
      }
      return;
    }
    const attached = await attachEngine(meetingGen);
    // Fold accounting ONLY on an explicit successful attach (codex
    // round-3: the error stop flow is un-awaited, so global status is
    // not a reliable success signal). A failed attach's own error path
    // lands the meeting on stopped/idle; the terminal-status check is
    // the belt for teardown that already completed. A pending End
    // equally wins over the flip: the gate's drain will stop the
    // just-attached engine the moment this releases.
    const after = useApp.getState().status;
    if (attached && after !== "stopped" && after !== "idle" && !pendingEndRef.current) {
      useApp.getState().resumeMeeting();
    }
  }), [attachEngine, withLifecycleGate]);

  const stop = useCallback(async () => {
    if (lifecycleBusyRef.current) {
      // Never drop an End (codex round-2 HIGH): the gate-holder's
      // finally drains this intent into a real stop.
      pendingEndRef.current = true;
      return;
    }
    await withLifecycleGate(doStop);
  }, [withLifecycleGate, doStop]);

  const startDemo = useCallback(async () => {
    // Demo-overlay stash (field-test round, extends S14.1): beginDemoOverlay
    // stashes the user's real settings.engine (root AppState, never
    // persisted itself) and flips the live value to "demo" via the same
    // updateSettings `persist:false` path S14.1 originally added — but
    // now ALSO guarantees every OTHER settings save (an ordinary
    // Settings-dialog save, the quit-time flushSettings/pagehide flush)
    // that fires while the demo is live persists the STASHED real engine
    // instead of re-baking "demo" back into storage (store.ts's
    // settingsForPersist chokepoint). doStop/runStopFlow call
    // endDemoOverlay() on the way out so the live UI (not just storage)
    // lands back on the user's real engine too — see store.ts's
    // demoOverlayPrevEngine/applyTierDefaults docs for the full field
    // report this closes.
    useApp.getState().beginDemoOverlay();
    await start();
  }, [start]);

  useEffect(() => {
    return () => {
      void engineRef.current?.stop();
      schedulerRef.current?.stop();
      translateQueueRef.current?.stop();
    };
  }, []);

  // Live draft persistence (v0.5 closeout item 1): best-effort flush on
  // the visibility/pagehide path. `visibilitychange`→hidden fires first
  // (covers backgrounding without an actual unload); `pagehide` fires on
  // most real navigations/tab closes. M1 field fix (Sol adversarial
  // review): NEITHER is reliable against an iOS-Safari force-kill of a
  // backgrounded tab — WebKit bug 199854 means no pagehide (and no
  // visibilitychange) is guaranteed to fire at all on that path — so
  // this is a best-effort head start, not the actual safety net; the
  // periodic interval effect below is what actually bounds data loss
  // (at most one DRAFT_WRITE_INTERVAL_MS's worth), since it runs
  // independent of whether the page ever gets a chance to unload
  // cleanly. Bypasses the dirty-signature check entirely — this is the
  // last chance, not a routine tick — but still updates
  // lastDraftSignatureRef afterward so the interval effect below
  // doesn't immediately redo the same write once its next tick fires.
  // Mount-once: this hook lives for the whole page load (page.tsx), the
  // same lifetime `now` vs. "first meeting start of a page load" above
  // assumes. Reads useApp.getState() fresh rather than closing over the
  // reactive `status`/`segments` below — no stale-closure risk despite
  // the empty deps array.
  useEffect(() => {
    const flush = () => {
      const { status, settings, meetingGen, startedAt } = useApp.getState();
      if (!liveDraft.isDraftableMeeting(status, settings.engine)) return;
      const snapshot = currentSessionSnapshot();
      if (!snapshot) return;
      const signature = liveDraft.computeDraftSignature(snapshot);
      const draftId = liveDraft.deriveDraftId(meetingGen, startedAt);
      // Same landed-only bookkeeping as the interval tick above — a
      // flush that buffer-skipped/failed must not suppress the next
      // tick's retry. (The page may be dying, in which case the .then
      // never runs — equally fine: nothing left to suppress.)
      void liveDraft.writeDraft(draftId, snapshot).then((landed) => {
        if (landed) lastDraftSignatureRef.current = signature;
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Live bilingual transcript (#42): flipping the toggle OFF->ON
  // mid-meeting shouldn't leave the just-elapsed minute untranslated —
  // catch up the most recent finalized segments that don't have one
  // yet. Gated to `listening` because the queue is only alive for a
  // live meeting (stopped sessions have no TranslateQueue to backfill
  // into; toggling the setting from a stopped session's view has no
  // live effect here).
  const bilingualTranscript = useApp((s) => s.settings.bilingualTranscript);
  const status = useApp((s) => s.status);
  const prevBilingualRef = useRef(bilingualTranscript);
  useEffect(() => {
    const wasOff = !prevBilingualRef.current;
    prevBilingualRef.current = bilingualTranscript;
    if (!(wasOff && bilingualTranscript && status === "listening")) return;

    const { segments, translations } = useApp.getState();
    const toBackfill = segments
      .filter((s) => !translations[s.id])
      .slice(-BILINGUAL_BACKFILL_COUNT);
    translateQueueRef.current?.backfill(toBackfill);
  }, [bilingualTranscript, status]);

  // Field-test issue 8b (manual AI-detect retry): AiStatusPanel has no
  // existing path to schedulerRef — it's a leaf component mounted with
  // NO props at both its hosts (StatusLine's popover, SettingsDialog's
  // AI 检测 section; verified against both call sites), and this hook's
  // own return value (start/pause/resume/stop/startDemo) is only ever
  // consumed by page.tsx, never threaded down to either host either. The
  // store's aiRetryNonce is the cheapest seam instead — same monotonic-
  // nonce shape as bitCelebrateNonce/PixelDragon just above (this ref
  // seeds to whatever the nonce already is at mount, so an already-
  // nonzero nonce never fires on first render, only later INCREASES do)
  // — this is the one place that actually holds the live scheduler ref.
  const aiRetryNonce = useApp((s) => s.aiRetryNonce);
  const prevAiRetryNonceRef = useRef(aiRetryNonce);
  useEffect(() => {
    if (aiRetryNonce > prevAiRetryNonceRef.current) {
      schedulerRef.current?.retryAi();
    }
    prevAiRetryNonceRef.current = aiRetryNonce;
  }, [aiRetryNonce]);

  // Re-translate a segment whose text was hand-corrected (store's
  // updateSegmentText already dropped the stale translation entry —
  // see store.ts) while the toggle is on. Tracks last-seen text per
  // segment id so only genuine edits (not new arrivals) re-enqueue;
  // cleared per meetingGen so it doesn't accumulate ids across every
  // meeting held in one tab session.
  const segments = useApp((s) => s.segments);
  const meetingGen = useApp((s) => s.meetingGen);
  const lastTextRef = useRef<Map<string, string>>(new Map());
  const lastTextGenRef = useRef(meetingGen);
  useEffect(() => {
    if (lastTextGenRef.current !== meetingGen) {
      lastTextGenRef.current = meetingGen;
      lastTextRef.current = new Map();
    }
    const lastText = lastTextRef.current;
    const settings = useApp.getState().settings;
    for (const seg of segments) {
      const prevText = lastText.get(seg.id);
      if (prevText !== undefined && prevText !== seg.text && settings.bilingualTranscript) {
        translateQueueRef.current?.pushSegment(seg);
      }
      lastText.set(seg.id, seg.text);
    }
  }, [segments, meetingGen]);

  // Live draft persistence (v0.5 closeout item 1, M1 field fix — Sol
  // adversarial review) — the routine (non-pagehide) write path: an
  // INTERVAL loop, not a segments/cards-count-reactive effect. The old
  // reactive effect had no trailing edge — a translation, speaker
  // reassignment, or term-only change inside one write window never
  // changed the segments/cards ARRAY REFERENCE this effect keyed on, so
  // it was never persisted until a segment/card count eventually changed
  // too. liveDraft.computeDraftSignature folds in exactly those
  // dimensions (see its own doc), so a plain tick-to-tick comparison
  // catches them all without naming every reactive slice as a
  // dependency. Owned by the SAME effect that sees start/stop (deps:
  // `status`, `engine`) — the interval only ever runs while the meeting
  // is actually draftable, and restarts cleanly (via the cleanup below)
  // whenever either changes.
  const engine = useApp((s) => s.settings.engine);
  useEffect(() => {
    if (!liveDraft.isDraftableMeeting(status, engine)) return;
    // Async now (writeDraft's landed/skipped verdict gates the dirty
    // bookkeeping). Single-flight lives in draftWritingRef — a REF, not
    // an effect-local flag (Sol round-3 H): status/engine transitions
    // re-run this effect, and an effect-local `writing` would reset to
    // false while the previous incarnation's write is still pending,
    // letting a second write overlap it. The landed callback re-derives
    // the draftId against CURRENT state before marking clean — a stale
    // write landing after a meeting transition must not stamp the NEW
    // meeting's (start()-reset-to-null) signature slot with the OLD
    // meeting's signature.
    const tick = () => {
      if (draftWritingRef.current) return;
      // Fresh read (not the closed-over `status`/`engine` above) — this
      // callback can fire in the brief window before a status/engine
      // change has re-run this effect (see attachEngine's own handlers
      // for the same fresh-read posture elsewhere in this file).
      const state = useApp.getState();
      if (!liveDraft.isDraftableMeeting(state.status, state.settings.engine)) return;
      const snapshot = currentSessionSnapshot();
      if (!snapshot) return;
      const signature = liveDraft.computeDraftSignature(snapshot);
      if (signature === lastDraftSignatureRef.current) return;
      const draftId = liveDraft.deriveDraftId(state.meetingGen, state.startedAt);
      draftWritingRef.current = true;
      void liveDraft
        .writeDraft(draftId, snapshot)
        .then((landed) => {
          // Mark clean ONLY on a landed write for the SAME meeting (Sol
          // re-verify HIGH + round-3 H): a buffer-skip/IDB failure must
          // leave the signature dirty so the NEXT tick retries, and a
          // slow write resolving after a meeting transition must not
          // write into the new meeting's bookkeeping.
          const now = useApp.getState();
          const stillSameMeeting =
            liveDraft.deriveDraftId(now.meetingGen, now.startedAt) === draftId;
          if (landed && stillSameMeeting) lastDraftSignatureRef.current = signature;
        })
        .finally(() => {
          draftWritingRef.current = false;
        });
    };
    // One immediate tick so a brand-new meeting's first draft isn't a
    // full interval away — under a pure setInterval, a crash inside
    // the first DRAFT_WRITE_INTERVAL_MS lost everything said in it
    // (W1 design note, lead-accepted). tick() itself no-ops until the
    // meeting is draftable and something exists to snapshot, so firing
    // it eagerly here is free on the idle path.
    tick();
    const id = setInterval(tick, liveDraft.DRAFT_WRITE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [status, engine]);

  return { start, pause, resume, stop, startDemo };
}
