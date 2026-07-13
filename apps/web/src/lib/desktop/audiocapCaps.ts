// Centralized S9.4/D6 macOS-floor gating probe (docs/design-explorations/
// s9-app-audio-tap-blueprint.md, D6) — adversarial review finding F9:
// each surface that gates the "appaudio" engine option on
// audiocap_capabilities() used to hand-roll its own copy — Header.tsx's
// ENGINE_OPTIONS had NO floor gating at all (appaudio stayed enabled on
// every macOS version, including below the 14.4 floor), while
// SettingsDialog.tsx hand-rolled its own separate probe+cache. This
// module is the ONE place that probes audiocap_capabilities(), caches
// the result, and exposes the shared gating POLICY below — Header.tsx's
// ENGINE_OPTIONS and SettingsDialog.tsx's ENGINE_CARDS both consume it
// instead of maintaining their own copy.
//
// POLICY (lead-adjudicated): a DEFINITIVE { appAudioSupported: false }
// disables the appaudio option EVERYWHERE, surfacing `reason` (falling
// back to DEFAULT_UNSUPPORTED_REASON) as the disabled title/copy. A
// probe ERROR or "not yet resolved" (the async round-trip hasn't landed
// yet — the null snapshot) both stay ENABLED (fail-open) — D6 is
// explicit that "runtime commands re-check support — UI gating is not a
// boundary", so a transient probe hiccup (or simply not having answered
// yet) must never falsely lock the feature behind a misleading "needs
// macOS 14.4" message on a machine that might actually be on 15.x. Only
// an EXPLICIT, successfully-resolved `false` is trusted enough to
// disable anything — an error is therefore NEVER cached as the resolved
// value (see probeCapabilitiesWith()'s own doc): a later caller (e.g.
// the dialog reopening, or Header's own next mount) gets to try again
// rather than being stuck fail-open forever off one transient hiccup.
//
// Framework-agnostic on purpose (no React import) — mirrors tauriApi.ts's
// own "callers take plain values, not a hook" posture, and
// bootstrap.ts's own bootstrapDesktop/BootstrapDeps split (pure core
// takes an injected InvokeFn, no IS_DESKTOP/tauriApi coupling of its
// own — see probeCapabilitiesWith() below). Header.tsx/SettingsDialog.tsx
// each wire this into their own useState/useEffect, the same shape
// every OTHER probe in SettingsDialog.tsx already uses (sidecarStatus,
// agentHealthState, diarizationInstalled, …).

import { getInvoke, type InvokeFn } from "./tauriApi";
import { IS_DESKTOP } from "../platform/desktop";
import type { AudiocapCapabilities } from "../stt/appAudio";

// Re-exported so callers only need ONE import for both the probe
// functions and the wire shape — this module owns no separate copy of
// the interface (appAudio.ts's own AudiocapCapabilities doc comment is
// still the source of truth for the wire contract itself).
export type { AudiocapCapabilities } from "../stt/appAudio";

const DEFAULT_UNSUPPORTED_REASON = "需要 macOS 14.4 或更高版本";

// Fail-open synthetic result for a probe that errored or ran outside a
// desktop build — see this module's own POLICY doc above. Never
// persisted as `cached` (see probeCapabilitiesWith()), only ever
// returned as THIS ONE call's resolution.
const FAIL_OPEN: AudiocapCapabilities = { appAudioSupported: true, reason: null };

type Listener = () => void;

let cached: AudiocapCapabilities | null = null; // null = not yet resolved
let inFlight: Promise<AudiocapCapabilities> | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Synchronous snapshot of the last successfully-resolved probe — null
 *  before probeCapabilitiesWith()/probeAudiocapCaps() has ever resolved
 *  for real (including the whole time outside a desktop build, where
 *  nothing is ever probed). Read this for a render-time value;
 *  subscribeAudiocapCaps() below is what tells a caller WHEN to re-read
 *  it. */
export function getAudiocapCapsSnapshot(): AudiocapCapabilities | null {
  return cached;
}

/** Registers a listener fired once a probe resolves for real (or on a
 *  later re-resolution, e.g. after resetAudiocapCapsCache()) — shaped
 *  for React's useSyncExternalStore subscribe contract without this
 *  module itself depending on React (see this file's header). */
export function subscribeAudiocapCaps(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Pure(-ish) core: given an already-resolved InvokeFn, does the actual
 *  audiocap_capabilities() round-trip plus this module's fail-open
 *  policy — no IS_DESKTOP/tauriApi coupling of its own (mirrors
 *  bootstrap.ts's own bootstrapDesktop/BootstrapDeps split), so it's
 *  directly unit-testable with a fake invoke, no module-mocking
 *  gymnastics required. Caches a SUCCESSFUL resolution and notifies
 *  subscribers; an error resolves FAIL_OPEN but is deliberately NOT
 *  cached (see this module's own POLICY doc) — the next probe gets to
 *  try again. Exported for direct testing; probeAudiocapCaps() below is
 *  what callers actually use. */
export async function probeCapabilitiesWith(invoke: InvokeFn): Promise<AudiocapCapabilities> {
  try {
    const caps = await invoke<AudiocapCapabilities>("audiocap_capabilities");
    cached = caps;
    notify();
    return caps;
  } catch {
    return FAIL_OPEN;
  }
}

/** Single-flight cached probe of audiocap_capabilities. IS_DESKTOP-
 *  guarded — resolves the fail-open shape immediately outside a desktop
 *  build, never calling getInvoke() there (which would otherwise throw
 *  SYNCHRONOUSLY per tauriApi.ts's own "throws outside a desktop build"
 *  contract — every caller here wants a value, not an exception). Safe
 *  to call from multiple sites/renders — a resolved cache short-circuits
 *  immediately, and a call made while a probe is already in flight
 *  shares that SAME in-flight promise (never fires a second concurrent
 *  invoke). */
export function probeAudiocapCaps(): Promise<AudiocapCapabilities> {
  if (cached) return Promise.resolve(cached);
  if (!IS_DESKTOP) return Promise.resolve(FAIL_OPEN);
  if (!inFlight) {
    inFlight = getInvoke()
      .then((invoke) => probeCapabilitiesWith(invoke))
      .catch(() => FAIL_OPEN) // getInvoke() itself failing (e.g. a dynamic import hiccup) — same fail-open policy
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** S9.4/D6 gating policy: whether `caps` (a probe result, or the
 *  not-yet-resolved `null` snapshot) should disable the appaudio option
 *  for the given engine `value` — see this module's own POLICY doc
 *  above. Structurally a no-op for every OTHER engine value (only ever
 *  relevant to "appaudio" itself), so it's safe to call unconditionally
 *  against the web build's own tabaudio slot too. */
export function isAppAudioFloorLocked(value: string, caps: AudiocapCapabilities | null): boolean {
  return value === "appaudio" && caps !== null && !caps.appAudioSupported;
}

/** The reason text to show for a floor-locked appaudio option — `caps`'s
 *  own reason if the probe supplied one, else DEFAULT_UNSUPPORTED_REASON
 *  (also the fallback for a null/not-yet-resolved snapshot, though
 *  isAppAudioFloorLocked never actually locks on null — callers may
 *  still want SOME reason text ready before the probe resolves). */
export function appAudioLockReason(caps: AudiocapCapabilities | null): string {
  return caps?.reason || DEFAULT_UNSUPPORTED_REASON;
}

/** Test-only reset — mirrors tauriApi.ts's resetTauriApiCache convention
 *  for module-level state that must never leak between independent
 *  it() blocks. */
export function resetAudiocapCapsCache(): void {
  cached = null;
  inFlight = null;
  listeners.clear();
}
