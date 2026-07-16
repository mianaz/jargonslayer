// S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
// Gating F13) — parakeet/MLX capability-snapshot probe: native arm64
// (not Rosetta) + macOS >= 14.0 + mlx pinned (the lockfile fixes the
// version), mirroring audiocapCaps.ts's own single-flight probe/cache
// shape for THIS module's own Rust command, mlx_capabilities() (§3.4 /
// §C Gating) — a fully separate probe/cache from audiocapCaps.ts's
// audiocap_capabilities()/osspeechCaps.ts's os_speech_capabilities():
// different engine, different wire shape ({mlxSupported, reason}).
//
// POLICY — deliberately the OPPOSITE of audiocapCaps.ts's/
// osspeechCaps.ts's fail-OPEN posture (§C Gating, explicit call-out in
// the blueprint): ANY probe error (or a `getInvoke()` failure) resolves
// parakeet as UNSUPPORTED. The 2.5 GB opt-in install is what flips the
// S11 "probe-error-stays-open" convention — staying open on an
// unconfirmed probe would let a user kick off a multi-GB download the
// Rust side may then reject; the conservative direction here is closed,
// with a user-visible retry (refreshMlxCaps below) rather than a
// silent auto-unlock. A definitive, successfully-resolved response
// (mlxSupported true OR false) IS cached and trusted either way — only
// an actual probe ERROR is deliberately left uncached, so the very next
// probeMlxCaps() call gets to try again (same "don't cache a transient
// hiccup" discipline as the fail-open siblings, applied to the opposite
// default).
//
// S12a fix round (§D F7, LOW, both reviewers — folded together with F2
// since F2's own probeMlxUsable needs the SAME ok/error distinction
// this module's own callers do): probeMlxCaps()/refreshMlxCaps() used
// to resolve a bare `MlxCapabilities`, which is genuinely AMBIGUOUS —
// a resolved `{mlxSupported:false, reason:"无法确认..."}"` is
// byte-identical whether mlx_capabilities() genuinely, definitively
// answered "unsupported" OR the invoke() itself rejected and this
// module's own fail-closed policy papered over it. Every caller that
// needs to tell those apart (ModelPicker.tsx's own errored-vs-
// unsupported UI, worker A3; provisionRunner.ts's probeMlxUsable,
// F2) used to infer it via a race-sensitive cache-identity heuristic
// (comparing the settled result against getMlxCapsSnapshot() by
// reference) — fixed at the SOURCE instead: every probe/refresh now
// resolves an EXPLICIT `{status: "ok" | "error", caps}` envelope, no
// inference left anywhere downstream. PINNED CONTRACT (§D F7, verified
// against worker A3's own already-landed ModelPicker.tsx/
// ModelPicker.render.test.tsx): `probeMlxCaps()/refreshMlxCaps() ->
// Promise<{status: "ok" | "error", caps: MlxCapabilities}>`.
//
// Also reconciled `MlxCapabilities.reason` from the prelude's
// `reason?: string` to `reason: string | null` — mlxcaps.rs's real,
// now-landed Rust struct is `{mlx_supported: bool, reason:
// Option<String>}`; serde's Option<T> encoding always emits the KEY
// with an explicit JSON `null`, never omits it, matching
// audiocapCaps.ts's/osspeechCaps.ts's own identical `reason: string |
// null` convention for the SAME Option<String> shape. Safe to tighten
// now (unlike the earlier attempt this same sprint, reverted because
// worker A3's fixtures predated this coordination) — A3's own
// ModelPicker.render.test.tsx already constructs every MlxCapabilities
// literal with an explicit `reason: null`/`reason: "..."` key, per the
// pinned contract.
//
// Also fixes the OTHER half of §D F7 (not race-sensitive in outcome —
// fail-closed direction always held — but a real correctness gap):
// probeMlxCaps()'s own `inFlight`-clearing `.finally()` used to be
// unconditional, so an OLDER probeMlxCaps() attempt superseded by a
// refreshMlxCaps() call (which always fires a FRESH probe, ignoring
// any `inFlight` already in progress — see refreshMlxCaps' own doc
// comment) could still wrongly null out the NEWER refresh's still-
// pending `inFlight` reference the instant the older one settles,
// letting a THIRD, redundant probe fire. Fixed with the SAME identity-
// compare guard refreshMlxCaps already had (`if (inFlight === probe)
// inFlight = null`), now on BOTH functions. A companion
// `requestGeneration` counter (bumped once per REAL probeMlxCapabilitiesWith
// attempt) guards the OTHER race: an older, slower-resolving attempt's
// own `cached`-write/notify() now no-ops if a NEWER attempt has already
// started (and possibly already resolved) in the meantime — the
// "stale snapshot" half of the same overlap.
//
// This module only PINS the shape for the S12a prelude fan-out (§C
// L1) — worker A2 owns the real capability logic + tests. Framework-
// agnostic on purpose (no React import), mirroring audiocapCaps.ts's
// own posture: a caller wires its own useState/useEffect (or its own
// hook) against getMlxCapsSnapshot/subscribeMlxCaps, this module owns
// no hook of its own.

import { getInvoke, type InvokeFn } from "./tauriApi";
import { IS_DESKTOP } from "../platform/desktop";

// {mlxSupported, reason} camelCase — §3.4's mlx_capabilities() wire
// shape (native arm64 + macOS >= 14.0 + mlx pinned, §C Gating).
// `reason: string | null` — see this file's own header doc (§D F7) for
// why this is required-and-nullable, not optional.
export interface MlxCapabilities {
  mlxSupported: boolean;
  reason: string | null;
}

/** §D F7's own pinned envelope — every probe/refresh below resolves
 *  this, never a bare `MlxCapabilities`, so "did the invoke itself
 *  fail" is never re-inferred downstream (ModelPicker.tsx's own
 *  mlxGateFor/useMlxCaps, provisionRunner.ts's probeMlxUsable, F2). */
export interface MlxCapsResult {
  status: "ok" | "error";
  caps: MlxCapabilities;
}

// Fail-CLOSED synthetic result for a probe that errored or ran outside a
// desktop build — see this module's own POLICY doc above. Never
// persisted as `cached` (see probeMlxCapabilitiesWith()), only ever
// returned as THIS ONE call's resolution (status:"error").
const FAIL_CLOSED: MlxCapabilities = {
  mlxSupported: false,
  reason: "无法确认 Apple 芯片支持，请重试",
};

type Listener = () => void;

let cached: MlxCapabilities | null = null; // null = not yet resolved
let inFlight: Promise<MlxCapsResult> | null = null;
// §D F7 — bumped once per REAL probeMlxCapabilitiesWith() attempt (the
// only place `cached` is ever written); see this file's own header doc
// for the exact race this closes. Reset alongside every other
// module-level slot in resetMlxCapsCache() below, so leftover
// generations from a PRIOR test never influence a later one's
// "am I still the latest attempt" comparison.
let requestGeneration = 0;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Synchronous snapshot of the last successfully-resolved probe — null
 *  before probeMlxCapabilitiesWith()/probeMlxCaps() has ever resolved
 *  for real (including the whole time outside a desktop build, where
 *  nothing is ever probed — see probeMlxCaps()'s own IS_DESKTOP guard,
 *  which returns status:"error" without ever writing this). */
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
 *  module-mocking gymnastics required. Resolves the §D F7 envelope
 *  (`{status, caps}`): a SUCCESSFUL round-trip (mlxSupported true OR
 *  false, a definitive answer either way) caches `caps` and notifies
 *  subscribers, `status:"ok"`; an invoke() rejection resolves
 *  `status:"error"` with the FAIL_CLOSED shape, deliberately NOT
 *  cached — the next probe gets to try again. Own request-generation
 *  guard (see this file's header doc): a call superseded by a NEWER
 *  one (this function invoked again before this call's own round trip
 *  resolves) skips writing `cached`/notifying on late resolution,
 *  though it still resolves ITS OWN promise with whatever it got —
 *  callers awaiting this SPECIFIC call always get a real answer, only
 *  the SHARED cache/listeners are protected from a stale overwrite.
 *  Exported for direct testing; probeMlxCaps() below is what callers
 *  actually use. */
export async function probeMlxCapabilitiesWith(invoke: InvokeFn): Promise<MlxCapsResult> {
  const myGeneration = ++requestGeneration;
  try {
    const caps = await invoke<MlxCapabilities>("mlx_capabilities");
    if (myGeneration === requestGeneration) {
      cached = caps;
      notify();
    }
    return { status: "ok", caps };
  } catch {
    return { status: "error", caps: FAIL_CLOSED };
  }
}

/** Single-flight cached probe of mlx_capabilities. IS_DESKTOP-guarded —
 *  resolves `status:"error"`/FAIL_CLOSED immediately outside a desktop
 *  build, never calling getInvoke() there (which would otherwise throw
 *  SYNCHRONOUSLY per tauriApi.ts's own "throws outside a desktop build"
 *  contract). Safe to call from multiple sites/renders — a resolved
 *  cache short-circuits immediately (`status:"ok"`, the cached value —
 *  a cache hit is never itself an error), and a call made while a
 *  probe is already in flight shares that SAME in-flight promise
 *  (never fires a second concurrent invoke). `inFlight` is cleared via
 *  an identity compare (§D F7) — see this file's own header doc — so a
 *  concurrent refreshMlxCaps() taking over `inFlight` with its own
 *  fresh probe is never wrongly cleared by THIS call's own settling. */
export function probeMlxCaps(): Promise<MlxCapsResult> {
  if (cached) return Promise.resolve({ status: "ok", caps: cached });
  if (!IS_DESKTOP) return Promise.resolve({ status: "error", caps: FAIL_CLOSED });
  if (!inFlight) {
    const probe: Promise<MlxCapsResult> = getInvoke()
      .then((invoke) => probeMlxCapabilitiesWith(invoke))
      .catch(() => ({ status: "error" as const, caps: FAIL_CLOSED })) // getInvoke() itself failing (e.g. a dynamic import hiccup) — same fail-closed policy
      .finally(() => {
        if (inFlight === probe) inFlight = null;
      });
    inFlight = probe;
  }
  return inFlight;
}

/** Clears the cached resolution (and drops any in-flight promise
 *  reference, every registered listener, and the request-generation
 *  counter) so the NEXT probeMlxCaps() call re-probes from scratch.
 *  Mirrors audiocapCaps.ts's/osspeechCaps.ts's own reset-cache test
 *  convention for the same module-level state; per §C Gating this is
 *  ALSO meant to back a user-visible retry (fail-closed never
 *  auto-unlocks on its own, only an explicit re-probe can) — see this
 *  file's header NOTE for the one sharp edge that leaves for whichever
 *  worker wires that retry affordance. */
export function resetMlxCapsCache(): void {
  cached = null;
  inFlight = null;
  requestGeneration = 0;
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
 *  and fail-closed-on-error policy as probeMlxCaps()/
 *  probeMlxCapabilitiesWith() above (a successful resolution — true OR
 *  false — is cached and notified; an error is deliberately left
 *  uncached, so the very next call gets to try again); same §D F7
 *  identity-guarded `inFlight` clearing. */
export function refreshMlxCaps(): Promise<MlxCapsResult> {
  if (!IS_DESKTOP) return Promise.resolve({ status: "error", caps: FAIL_CLOSED });
  const probe: Promise<MlxCapsResult> = getInvoke()
    .then((invoke) => probeMlxCapabilitiesWith(invoke))
    .catch(() => ({ status: "error" as const, caps: FAIL_CLOSED })) // getInvoke() itself failing — same fail-closed policy as probeMlxCaps()
    .finally(() => {
      if (inFlight === probe) inFlight = null;
    });
  inFlight = probe;
  return probe;
}
