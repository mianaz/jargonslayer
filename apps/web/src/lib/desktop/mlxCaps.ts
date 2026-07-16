// S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
// Gating F13) — parakeet/MLX capability-snapshot probe: native arm64
// (not Rosetta) + macOS >= 14.0 + mlx pinned (the lockfile fixes the
// version), mirroring audiocapCaps.ts's own single-flight probe/cache
// shape for THIS module's own Rust command, mlx_capabilities() (§3.4 /
// §C Gating) — a fully separate probe/cache from audiocapCaps.ts's
// audiocap_capabilities()/osspeechCaps.ts's os_speech_capabilities():
// different engine, different wire shape ({mlxSupported, reason?}).
//
// POLICY — deliberately the OPPOSITE of audiocapCaps.ts's/
// osspeechCaps.ts's fail-OPEN posture (§C Gating, explicit call-out in
// the blueprint): ANY probe error (or a `getInvoke()` failure) resolves
// parakeet as UNSUPPORTED. The 2.5 GB opt-in install is what flips the
// S11 "probe-error-stays-open" convention — staying open on an
// unconfirmed probe would let a user kick off a multi-GB download the
// Rust side may then reject; the conservative direction here is closed,
// with a user-visible retry (resetMlxCapsCache below) rather than a
// silent auto-unlock. A definitive, successfully-resolved response
// (mlxSupported true OR false) IS cached and trusted either way — only
// an actual probe ERROR is deliberately left uncached, so the very next
// probeMlxCaps() call gets to try again (same "don't cache a transient
// hiccup" discipline as the fail-open siblings, applied to the opposite
// default).
//
// This module only PINS the shape for the S12a prelude fan-out (§C
// L1) — worker A2 owns the real capability logic + tests. Framework-
// agnostic on purpose (no React import), mirroring audiocapCaps.ts's
// own posture: a caller wires its own useState/useEffect (or its own
// hook) against getMlxCapsSnapshot/subscribeMlxCaps, this module owns
// no hook of its own.
//
// NOTE for A2 (sharp edge, not resolved here): resetMlxCapsCache()
// below mirrors the siblings' test-only reset convention exactly,
// including clearing `listeners` — if it's also wired as a live "重试"
// button per §C Gating, the caller must re-probe (and re-read the
// snapshot) itself rather than relying on its OWN subscription still
// being registered to fire on the next notify().

import { getInvoke, type InvokeFn } from "./tauriApi";
import { IS_DESKTOP } from "../platform/desktop";

// {mlxSupported, reason} camelCase — §3.4's mlx_capabilities() wire
// shape (native arm64 + macOS >= 14.0 + mlx pinned, §C Gating).
//
// NOTE (worker A2, cross-lane observation, deliberately NOT fixed
// here): the now-landed Rust struct (apps/desktop/src-tauri/src/
// mlxcaps.rs) is `MlxCapabilities { mlx_supported: bool, reason:
// Option<String> }` — serde's default Option<T> encoding always emits
// the KEY with an explicit JSON `null`, never omits it, so the more
// accurate TS type is `reason: string | null` (matching audiocapCaps.
// ts's/osspeechCaps.ts's own identical convention for the SAME Option<
// String> shape) rather than this prelude-authored `reason?: string`.
// Tried tightening it locally; reverted — worker A3's own ModelPicker.
// render.test.tsx already constructs several `MlxCapabilities` literals
// typed `{mlxSupported: true}` (no `reason` key at all), which only
// type-checks under the CURRENT optional shape. Every real call site in
// EITHER worker's code already reads `caps.reason || fallback`, so this
// is purely a type-precision gap (not a runtime bug) — flagged for the
// lead to reconcile across worker A2/A3's touch lists rather than
// fixed unilaterally here.
export interface MlxCapabilities {
  mlxSupported: boolean;
  reason?: string;
}

// Fail-CLOSED synthetic result for a probe that errored or ran outside a
// desktop build — see this module's own POLICY doc above. Never
// persisted as `cached` (see probeMlxCapabilitiesWith()), only ever
// returned as THIS ONE call's resolution.
const FAIL_CLOSED: MlxCapabilities = {
  mlxSupported: false,
  reason: "无法确认 Apple 芯片支持，请重试",
};

type Listener = () => void;

let cached: MlxCapabilities | null = null; // null = not yet resolved
let inFlight: Promise<MlxCapabilities> | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Synchronous snapshot of the last successfully-resolved probe — null
 *  before probeMlxCapabilitiesWith()/probeMlxCaps() has ever resolved
 *  for real (including the whole time outside a desktop build, where
 *  nothing is ever probed — see probeMlxCaps()'s own IS_DESKTOP guard,
 *  which returns FAIL_CLOSED without ever writing this). */
export function getMlxCapsSnapshot(): MlxCapabilities | null {
  return cached;
}

/** Registers a listener fired once a probe resolves for real (or on a
 *  later re-resolution, e.g. after resetMlxCapsCache()) — shaped for
 *  React's useSyncExternalStore subscribe contract without this module
 *  itself depending on React, mirrors audiocapCaps.ts's own
 *  subscribeAudiocapCaps. */
export function subscribeMlxCaps(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Pure(-ish) core: given an already-resolved InvokeFn, does the actual
 *  mlx_capabilities() round-trip plus this module's FAIL-CLOSED policy
 *  (see this file's header doc) — no IS_DESKTOP/tauriApi coupling of
 *  its own, so it's directly unit-testable with a fake invoke, no
 *  module-mocking gymnastics required. Caches a SUCCESSFUL resolution
 *  (mlxSupported true OR false) and notifies subscribers; an error
 *  resolves FAIL_CLOSED but is deliberately NOT cached — the next probe
 *  gets to try again. Exported for direct testing; probeMlxCaps() below
 *  is what callers actually use. */
export async function probeMlxCapabilitiesWith(invoke: InvokeFn): Promise<MlxCapabilities> {
  try {
    const caps = await invoke<MlxCapabilities>("mlx_capabilities");
    cached = caps;
    notify();
    return caps;
  } catch {
    return FAIL_CLOSED;
  }
}

/** Single-flight cached probe of mlx_capabilities. IS_DESKTOP-guarded —
 *  resolves the fail-CLOSED shape immediately outside a desktop build,
 *  never calling getInvoke() there (which would otherwise throw
 *  SYNCHRONOUSLY per tauriApi.ts's own "throws outside a desktop build"
 *  contract). Safe to call from multiple sites/renders — a resolved
 *  cache short-circuits immediately, and a call made while a probe is
 *  already in flight shares that SAME in-flight promise (never fires a
 *  second concurrent invoke). */
export function probeMlxCaps(): Promise<MlxCapabilities> {
  if (cached) return Promise.resolve(cached);
  if (!IS_DESKTOP) return Promise.resolve(FAIL_CLOSED);
  if (!inFlight) {
    inFlight = getInvoke()
      .then((invoke) => probeMlxCapabilitiesWith(invoke))
      .catch(() => FAIL_CLOSED) // getInvoke() itself failing (e.g. a dynamic import hiccup) — same fail-closed policy
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Clears the cached resolution (and drops any in-flight promise
 *  reference, and every registered listener) so the NEXT probeMlxCaps()
 *  call re-probes from scratch. Mirrors audiocapCaps.ts's/
 *  osspeechCaps.ts's own reset-cache test convention for the same
 *  module-level state; per §C Gating this is ALSO meant to back a
 *  user-visible retry (fail-closed never auto-unlocks on its own, only
 *  an explicit re-probe can) — see this file's header NOTE for the one
 *  sharp edge that leaves for whichever worker wires that retry
 *  affordance. */
export function resetMlxCapsCache(): void {
  cached = null;
  inFlight = null;
  listeners.clear();
}

/** Worker A2's resolution of the header NOTE's sharp edge above: the
 *  REAL "重试" affordance a caller wires per §C Gating ("a user-visible
 *  retry" on a fail-closed probe error) — distinct from
 *  resetMlxCapsCache() in exactly the one way that matters for a live
 *  retry button: it does NOT clear `listeners`, so a caller's own
 *  subscription (registered once, e.g. via subscribeMlxCaps in a
 *  useEffect) stays intact and fires when THIS re-probe resolves,
 *  instead of silently going dead the way it would after
 *  resetMlxCapsCache()'s test-only full reset. Always performs a FRESH
 *  round-trip — ignores (but does not itself clear) any current
 *  `cached` value, unlike probeMlxCaps()'s short-circuit — and shares
 *  its result as the new `inFlight` promise, so a concurrent
 *  probeMlxCaps() call made while a refresh is in progress joins THIS
 *  SAME re-probe rather than firing a second one. Same IS_DESKTOP guard
 *  and FAIL_CLOSED-on-error policy as probeMlxCaps()/
 *  probeMlxCapabilitiesWith() above (a successful resolution — true OR
 *  false — is cached and notified; an error is deliberately left
 *  uncached, so the very next call gets to try again). */
export function refreshMlxCaps(): Promise<MlxCapabilities> {
  if (!IS_DESKTOP) return Promise.resolve(FAIL_CLOSED);
  const probe: Promise<MlxCapabilities> = getInvoke()
    .then((invoke) => probeMlxCapabilitiesWith(invoke))
    .catch(() => FAIL_CLOSED) // getInvoke() itself failing — same fail-closed policy as probeMlxCaps()
    .finally(() => {
      if (inFlight === probe) inFlight = null;
    });
  inFlight = probe;
  return probe;
}
