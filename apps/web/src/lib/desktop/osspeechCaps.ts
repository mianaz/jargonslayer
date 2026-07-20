// S11 (v0.4.3, docs/design-explorations/s11-osspeech-blueprint.md,
// Worker C) — Zero-Install 系统识别 (SpeechAnalyzer) macOS-floor gating,
// mirroring audiocapCaps.ts's own single-flight probe/cache/fail-open
// shape for osspeech's OWN Rust command, os_speech_capabilities()
// (§2.4) — a fully separate probe/cache from audiocapCaps.ts's
// audiocap_capabilities(): different engine, different wire shape (adds
// locales/installedLocales), and the blueprint's own Q4 keeps the
// Rust-side probe-memo lifetime independent per command. See
// audiocapCaps.ts's own header comment for the shared POLICY this
// module repeats: a DEFINITIVE `{supported:false}` disables the
// osspeech option everywhere; a probe ERROR or not-yet-resolved (null
// snapshot) both stay fail-open, since "runtime commands re-check
// support — UI gating is not a boundary" (D6) applies here identically.
//
// ALSO owns preinstallOsSpeech() (§A2 lead adjudication: preinstall is
// a real 6th Rust command, single-flighted vs a running session) — the
// wizard's EngineChoiceScreen background preinstall + Settings' 预下载
// 模型 button (Worker D) import this ONE function and get back a plain
// Promise<void> that resolves once the model finishes installing (or
// rejects with whatever ended the attempt, including a busy rejection
// surfaced straight from the single-flight guard) — Worker D never
// touches tauriApi/osspeech://status directly.

import { useEffect, useState } from "react";
import { getInvoke, type InvokeFn } from "./tauriApi";
import { IS_TAURI } from "../platform/ios";
import { trackOsSpeechAsset, type OsSpeechAssetKind } from "./jobsBridge";
import { OSSPEECH_TERMINAL_STATUS_KINDS, type OsSpeechStatusKind } from "../stt/osSpeech";
import { listenOsSpeechStatus } from "../stt/osSpeechTransport";

// {supported, reason, locales, installedLocales} camelCase — §2.4's
// exact os_speech_capabilities() wire shape.
export interface OsSpeechCapabilities {
  supported: boolean;
  reason: string | null;
  locales: string[];
  installedLocales: string[];
}

const DEFAULT_UNSUPPORTED_REASON = "需要 macOS 26 或更高版本";

// Fail-open synthetic result — see this module's own POLICY doc above.
// Never persisted as `cached` (see probeOsSpeechCapabilitiesWith`),
// only ever returned as THIS ONE call's resolution.
const FAIL_OPEN: OsSpeechCapabilities = {
  supported: true,
  reason: null,
  locales: [],
  installedLocales: [],
};

type Listener = () => void;

let cached: OsSpeechCapabilities | null = null; // null = not yet resolved
let inFlight: Promise<OsSpeechCapabilities> | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Synchronous snapshot of the last successfully-resolved probe — null
 *  before probeOsSpeechCapabilitiesWith()/probeOsSpeechCaps() has ever
 *  resolved for real. */
export function getOsSpeechCapsSnapshot(): OsSpeechCapabilities | null {
  return cached;
}

/** Registers a listener fired once a probe resolves for real (or on a
 *  later re-resolution, e.g. after resetOsSpeechCapsCache()) — shaped
 *  for React's useSyncExternalStore subscribe contract, mirrors
 *  audiocapCaps.ts's own subscribeAudiocapCaps. */
export function subscribeOsSpeechCaps(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Pure(-ish) core: given an already-resolved InvokeFn, does the actual
 *  os_speech_capabilities() round-trip plus this module's fail-open
 *  policy — no IS_DESKTOP/tauriApi coupling of its own, directly
 *  unit-testable with a fake invoke. Caches a SUCCESSFUL resolution and
 *  notifies subscribers; an error resolves FAIL_OPEN but is deliberately
 *  NOT cached — the next probe gets to try again. */
export async function probeOsSpeechCapabilitiesWith(invoke: InvokeFn): Promise<OsSpeechCapabilities> {
  try {
    const caps = await invoke<OsSpeechCapabilities>("os_speech_capabilities");
    cached = caps;
    notify();
    return caps;
  } catch {
    return FAIL_OPEN;
  }
}

/** Single-flight cached probe of os_speech_capabilities. IS_TAURI-guarded
 *  (S13 blueprint §6, widened from IS_DESKTOP — the probe/invoke names
 *  are identical on iOS, D2) — resolves the fail-open shape immediately
 *  outside a Tauri build, never calling getInvoke() there (which would
 *  otherwise throw SYNCHRONOUSLY per tauriApi.ts's own "throws outside a
 *  Tauri build" contract). Safe to call from multiple sites/renders — a
 *  resolved cache short-circuits immediately, and a call made while a
 *  probe is already in flight shares that SAME in-flight promise. */
export function probeOsSpeechCaps(): Promise<OsSpeechCapabilities> {
  if (cached) return Promise.resolve(cached);
  if (!IS_TAURI) return Promise.resolve(FAIL_OPEN);
  if (!inFlight) {
    inFlight = getInvoke()
      .then((invoke) => probeOsSpeechCapabilitiesWith(invoke))
      .catch(() => FAIL_OPEN) // getInvoke() itself failing — same fail-open policy
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Gating policy (mirrors audiocapCaps.ts's isAppAudioFloorLocked
 *  exactly): whether `caps` (a probe result, or the not-yet-resolved
 *  `null` snapshot) should disable the osspeech option for the given
 *  engine `value`. A structural no-op for every OTHER engine value. */
export function isOsSpeechFloorLocked(value: string, caps: OsSpeechCapabilities | null): boolean {
  return value === "osspeech" && caps !== null && !caps.supported;
}

/** The reason text to show for a floor-locked osspeech option — `caps`'s
 *  own reason if the probe supplied one, else DEFAULT_UNSUPPORTED_REASON
 *  (also the fallback for a null/not-yet-resolved snapshot). */
export function osSpeechLockReason(caps: OsSpeechCapabilities | null): string {
  return caps?.reason || DEFAULT_UNSUPPORTED_REASON;
}

/** React hook wrapper — subscribes on mount, kicks off the shared probe,
 *  and re-renders on every resolution. Mirrors engineOptions.ts's own
 *  useAudiocapCaps (that hook lives in engineOptions.ts for the appaudio
 *  precedent; this one is asked to live directly in this module per
 *  Worker C's own task spec, so engineOptions.ts's osspeech gate branch
 *  and any component just import it straight from here). */
export function useOsSpeechCaps(): OsSpeechCapabilities | null {
  const [caps, setCaps] = useState<OsSpeechCapabilities | null>(() => getOsSpeechCapsSnapshot());
  useEffect(() => {
    const unsubscribe = subscribeOsSpeechCaps(() => setCaps(getOsSpeechCapsSnapshot()));
    void probeOsSpeechCaps().then(() => setCaps(getOsSpeechCapsSnapshot()));
    return unsubscribe;
  }, []);
  return caps;
}

/** Test-only reset — mirrors audiocapCaps.ts's resetAudiocapCapsCache
 *  convention for module-level state that must never leak between
 *  independent it() blocks. */
export function resetOsSpeechCapsCache(): void {
  cached = null;
  inFlight = null;
  listeners.clear();
}

function isAssetKind(kind: OsSpeechStatusKind): kind is OsSpeechAssetKind {
  return (
    kind === "asset-checking" ||
    kind === "asset-downloading" ||
    kind === "asset-installed" ||
    kind === "asset-failed"
  );
}

/** §A2 lead adjudication: preinstall_os_speech is a real 6th Rust
 *  command, single-flighted vs a running session (rejects, v1). This
 *  wrapper invokes it, then drives an "os-speech-asset" task row off
 *  its OWN "osspeech://status" listener for the attempt's duration
 *  (single listener, self-cleaning — unlisten() runs on every exit
 *  path) and resolves once "asset-installed" arrives. ANY other
 *  terminal status kind (OSSPEECH_TERMINAL_STATUS_KINDS — not just
 *  "asset-failed") rejects too, so a locale/tap-level failure mid
 *  preinstall can't leave this Promise hanging forever; a busy/
 *  single-flight rejection from the invoke() call itself surfaces
 *  straight through. Worker D imports this one function — no other
 *  osspeech wiring needed on that side.
 *
 *  S13 (blueprint §6 Sol F2, BLOCKER): this was osspeechCaps.ts's own
 *  THIRD "osspeech://status" subscription (alongside osSpeech.ts's own
 *  two) — on iOS the macOS global event it used to listen for would
 *  never arrive (plugin events are plugin-scoped), so this now goes
 *  through the SAME osSpeechTransport.ts shim osSpeech.ts uses. */
export async function preinstallOsSpeech(locale: string): Promise<void> {
  const invoke = await getInvoke();
  const tracker = trackOsSpeechAsset();

  let settled = false;
  let resolveDone!: () => void;
  let rejectDone!: (err: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const unlisten = await listenOsSpeechStatus((event) => {
    const { kind, progress, message } = event.payload;
    if (isAssetKind(kind)) tracker.handle(kind, progress, message);

    if (settled) return;
    if (kind === "asset-installed") {
      settled = true;
      resolveDone();
    } else if (OSSPEECH_TERMINAL_STATUS_KINDS.has(kind)) {
      settled = true;
      rejectDone(new Error(message || "系统识别模型预下载失败"));
    }
  });

  try {
    await invoke("preinstall_os_speech", { locale });
  } catch (err) {
    unlisten();
    throw err instanceof Error ? err : new Error(String(err));
  }

  try {
    await done;
  } finally {
    unlisten();
  }
}
