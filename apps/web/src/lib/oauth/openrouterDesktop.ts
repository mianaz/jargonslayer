// S10 field-fix (docs/design-explorations/s10-fieldfix-blueprint.md,
// Chunk A, item 2 + Q1 verdict) — "Connect with OpenRouter" via the
// RFC 8252 loopback flow: opens the SYSTEM BROWSER (never the webview
// itself — WKWebView/wry can't usefully navigate to an arbitrary
// https:// URL, see lib/platform/openExternal.ts's own header comment)
// to OpenRouter's /auth page, and waits for its redirect back to a
// Rust-owned loopback listener (src-tauri/src/oauth.rs) instead of the
// web build's /oauth/openrouter PAGE route (desktop's Next build has no
// routable pages at runtime — `output: "export"` — and the webview
// never navigates here regardless: the PKCE verifier stays in this
// module's own closure for the whole hop).
//
// SMOKE-TEST CAVEAT (Q1 verdict, carried verbatim from the blueprint):
// OpenRouter's PKCE docs bless "localhost callbacks ... on any port"
// but literally say "localhost", never "127.0.0.1". CALLBACK_HOST below
// is the one knob to flip (to "localhost") if live testing shows
// OpenRouter's /auth rejects a 127.0.0.1 callback_url — oauth.rs's own
// listener keeps BINDING 127.0.0.1 regardless; only the hostname string
// embedded in the callback_url OpenRouter redirects back to is in
// question.
//
// F13 (MEDIUM, adversarial review): callback_url's own nonce moved from
// a `?ns=` query param to a `/oauth/openrouter/{ns}` PATH segment (see
// the callbackUrl construction below + oauth.rs's own parse_callback) —
// removes a SEPARATE, independent bet the old shape silently made
// (that OpenRouter's redirect preserves an arbitrary QUERY string on
// callback_url when appending its own `?code=`, undocumented either
// way), unrelated to the still-open hostname caveat just above.
import type { Settings } from "@jargonslayer/core/types";

import {
  getInvoke,
  getListen,
  getOpener,
  getTauriFetch,
  type InvokeFn,
  type ListenFn,
  type OpenExternalFn,
  type TauriFetchFn,
} from "../desktop/tauriApi";
import { buildAuthUrl, codeChallengeS256, exchangeCodeForKeyDirect, generateCodeVerifier } from "./openrouterPkce";
import { remapOpenRouterModelDefaults } from "./openrouterModelDefaults";

/** See this module's own header comment. */
const CALLBACK_HOST = "127.0.0.1";

/** ~180s (blueprint) — deliberately shorter than oauth.rs's own ~300s
 *  overall deadline, so JS is always the side that gives up first; the
 *  Rust deadline is only the backstop for a JS timer that somehow never
 *  fires (e.g. a suspended/backgrounded webview). */
const JS_TIMEOUT_MS = 180_000;

export type ConnectOpenRouterResult =
  | { ok: true }
  | {
      ok: false;
      reason: "timeout" | "cancelled" | "exchange-failed" | "port-bind-failed";
      message?: string;
    };

export interface ConnectOpenRouterDesktopDeps {
  invoke: InvokeFn;
  listen: ListenFn;
  openUrl: OpenExternalFn;
  tauriFetch: TauriFetchFn;
  updateSettings: (patch: Partial<Settings>) => void;
  /** Field-test fix (v0.4.4): read at the moment the code exchange
   *  succeeds (NOT snapshotted at connect-click time) — decides
   *  whether this connect should ALSO remap detectModel/summaryModel
   *  (see openrouterModelDefaults.ts's own doc comment). A getter
   *  rather than a passed-in value so a slow ~180s OAuth round-trip
   *  still reads whatever the user's models are right now. */
  getSettings: () => Pick<Settings, "detectModel" | "summaryModel">;
}

/** `oauth://openrouter` event payload — mirrors oauth.rs's own
 *  OauthCallbackPayload (`{ code?: string, error?: string }`) exactly. */
interface OauthLoopbackEventPayload {
  code?: string;
  error?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Single-flight REJECT (not join, not supersede) — mirrors
 *  bootstrap.ts's own sidecarLifecycleInFlight latch for
 *  reprovision()/switchModel() (Finding 1a there): a second overlapping
 *  call is declined outright rather than joining the first's promise
 *  (which would resolve as if the SECOND caller's own click had
 *  connected) or superseding the first (which would race this module's
 *  own JS-side settle against oauth.rs's Rust-side generation counter
 *  for no real benefit — the first attempt is left to run its own
 *  course untouched). This is the one trigger this file provides for
 *  the pinned `"cancelled"` reason; see this task's own report for the
 *  call-out that the pinned flow doesn't spell out a "cancelled"
 *  trigger explicitly. Test-only reset: resetConnectOpenRouterLatch. */
let inFlight = false;

/** F3 (adversarial review, HIGH): the current in-flight attempt's own
 *  cancel — assigned synchronously at the top of
 *  connectOpenRouterDesktopWith's Promise executor (before any
 *  `await`), so there is never a window where `inFlight` is true but
 *  an external caller's cancelOpenRouterConnect() would be a no-op.
 *  Cleared in the same `finally` as `inFlight`. */
let cancelCurrentAttempt: (() => void) | null = null;

/** Test-only reset — mirrors tauriApi.ts's resetTauriApiCache /
 *  audiocapCaps.ts's resetAudiocapCapsCache convention for module-level
 *  state that must never leak between independent `it()` blocks. */
export function resetConnectOpenRouterLatch(): void {
  inFlight = false;
  cancelCurrentAttempt = null;
}

/** F3/F4 (adversarial review) — lets an external caller (e.g.
 *  OnboardingByokStep's unmount effect, or its paste-save/skip
 *  handlers racing a still-open OAuth attempt) abort whatever "Connect
 *  with OpenRouter" attempt is currently in flight: settles it as
 *  `{ok:false, reason:"cancelled"}` through the SAME settle() every
 *  other path uses, so the Rust-side oauth_loopback_cancel best-effort
 *  call and the event unlisten both still fire. A harmless no-op when
 *  nothing is in flight. */
export function cancelOpenRouterConnect(): void {
  cancelCurrentAttempt?.();
}

/** The testable core (blueprint: "Dependency-injected internals ...
 *  following the BootstrapDeps injection pattern") — see this module's
 *  header comment for the full flow. Every dep is taken as a plain
 *  injected function value, same contract as bootstrap.ts's own
 *  BootstrapDeps, so this is exercised in tests with fakes and imports
 *  zero `@tauri-apps/*` itself. */
export async function connectOpenRouterDesktopWith(deps: ConnectOpenRouterDesktopDeps): Promise<ConnectOpenRouterResult> {
  if (inFlight) {
    return { ok: false, reason: "cancelled" };
  }
  inFlight = true;

  try {
    return await new Promise<ConnectOpenRouterResult>((resolve) => {
      let settled = false;
      let unlisten: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const settle = (result: ConnectOpenRouterResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        unlisten?.();
        // "always ... invoke oauth_loopback_cancel on settle" (pinned
        // contract) — belt-and-suspenders against a listener that's
        // already stopped on its own; see oauth.rs's own doc comment on
        // why this is safe (and idempotent) even when nothing is
        // running. Best-effort: a failure here must never flip an
        // otherwise-successful/already-decided result.
        void deps.invoke<void>("oauth_loopback_cancel").catch(() => {});
        resolve(result);
      };

      // F3: exposes THIS attempt's cancel to the module-level export —
      // assigned synchronously (before the async IIFE below ever
      // yields), so cancelOpenRouterConnect() is live for the entire
      // attempt, not just after its first await.
      cancelCurrentAttempt = () => settle({ ok: false, reason: "cancelled" });

      timer = setTimeout(() => settle({ ok: false, reason: "timeout" }), JS_TIMEOUT_MS);

      void (async () => {
        try {
          // (1) PKCE verifier/challenge — reused verbatim from
          // openrouterPkce.ts, same functions the web flow uses.
          const verifier = generateCodeVerifier();
          const challenge = await codeChallengeS256(verifier);
          // F3: settled/cancelled state re-checked after EVERY await
          // below, before the next side effect — a timeout/cancel that
          // raced this digest must stop the flow here rather than go
          // on to invoke/openUrl/write settings as if still live.
          if (settled) return;

          // (2) a SECOND, independent random token for the loopback
          // listener's own `ns` — reuses generateCodeVerifier() again
          // rather than a new generator: it's already a
          // crypto.getRandomValues-backed, URL-safe (RFC 7636
          // unreserved charset — no percent-encoding needed in the
          // callbackUrl PATH segment below, same as it needed none in
          // the query-param shape this replaces), high-entropy random
          // string, and this `ns` has nothing to do with PKCE itself,
          // just needs the same "hard to guess" property.
          const ns = generateCodeVerifier();

          let port: number;
          try {
            port = await deps.invoke<number>("oauth_loopback_start", { ns });
          } catch (err) {
            settle({ ok: false, reason: "port-bind-failed", message: describeError(err) });
            return;
          }
          // F3: a timeout/cancel while oauth_loopback_start was still
          // pending must not go on to open the system browser against
          // a now-abandoned attempt.
          if (settled) return;

          // (3)(4) F13: ns is a PATH segment (oauth.rs's own
          // parse_callback matches the /oauth/openrouter/ prefix and
          // extracts everything after it as the nonce), not a `?ns=`
          // query param — see this module's own header comment.
          const callbackUrl = `http://${CALLBACK_HOST}:${port}/oauth/openrouter/${ns}`;
          const authUrl = buildAuthUrl({ callbackUrl, codeChallenge: challenge });

          // (5) subscribe BEFORE opening the browser — pinned ordering,
          // so a callback that races back faster than this function's
          // own next tick can never arrive un-listened-for.
          unlisten = await deps.listen<OauthLoopbackEventPayload>("oauth://openrouter", (event) => {
            const payload = event.payload;
            if (payload.error) {
              // oauth.rs's own ~300s deadline emits exactly
              // `{error:"timeout"}` — folded into the SAME "timeout"
              // reason JS's own timer above produces; every other
              // upstream error (e.g. OpenRouter's own
              // `error=access_denied`) falls into the general
              // "exchange-failed" catch-all — the pinned reason union
              // has no dedicated bucket for an upstream-denied
              // authorization, and this one is the closest honest fit
              // ("the round-trip didn't produce a usable key").
              settle({
                ok: false,
                reason: payload.error === "timeout" ? "timeout" : "exchange-failed",
                message: payload.error,
              });
              return;
            }
            if (!payload.code) return; // not a shape oauth.rs's own parse_callback ever actually emits — ignore defensively, keep waiting
            const code = payload.code;
            void (async () => {
              try {
                // (6)
                const key = await exchangeCodeForKeyDirect({
                  code,
                  codeVerifier: verifier,
                  fetchImpl: deps.tauriFetch,
                });
                // F3: a timeout/cancel that raced this exchange must
                // never write a key this late — settle() itself is
                // idempotent-guarded, but skipping straight past the
                // settings write is the actual fix (the write, not a
                // redundant re-settle, was the leak).
                if (settled) return;
                // EXACT same settings write as the web callback page
                // (app/oauth/openrouter/page.tsx's own handleConnect
                // effect) — see that file's own updateSettings call.
                // Field-test fix (v0.4.4): ...plus a conditional
                // detectModel/summaryModel remap (openrouterModelDefaults.ts)
                // — a bare Anthropic id paired with this OpenRouter
                // baseUrl 400s on detect/summary's very first call; a
                // user's own already-slash-shaped OpenRouter model
                // (deliberate custom slug, or a prior remap) is left
                // untouched by remapOpenRouterModelDefaults' own
                // heuristic.
                deps.updateSettings({
                  provider: "openai-compat",
                  baseUrl: "https://openrouter.ai/api/v1",
                  apiKey: key,
                  ...remapOpenRouterModelDefaults(deps.getSettings()),
                });
                settle({ ok: true });
              } catch (err) {
                settle({ ok: false, reason: "exchange-failed", message: describeError(err) });
              }
            })();
          });
          if (settled) {
            // settle()'s own unlisten?.() already ran before THIS
            // subscription existed (a timeout/cancel raced deps.listen
            // itself) — clean up the now-orphaned listener rather than
            // leaking it, and never reach openUrl below.
            unlisten?.();
            return;
          }

          await deps.openUrl(authUrl);
        } catch (err) {
          settle({ ok: false, reason: "exchange-failed", message: describeError(err) });
        }
      })();
    });
  } finally {
    inFlight = false;
    cancelCurrentAttempt = null;
  }
}

/** Hydration-gated read of store.ts's `updateSettings` action (+, since
 *  the field-test fix above, a `getSettings` reader too) — mirrors
 *  bootstrap.ts's own getPersistedSidecarMode/persistDesktopModelToStore
 *  (same dynamic-import + "await hydrated before touching settings"
 *  shape, same rationale: store.ts's own hydrate() does a raw
 *  overwrite, so a write landing before it resolves would be silently
 *  clobbered). A local copy rather than a reuse — bootstrap.ts exports
 *  none of its three near-identical helpers (all module-private), and
 *  it's off this chunk's own touch list either way; same "this file
 *  needs its own copy rather than widening that file's touch list for
 *  one caller" precedent bootstrap.ts's own withUvLog doc comment
 *  already sets for the identical situation. */
async function resolveSettingsAccess(): Promise<{
  getSettings: () => Pick<Settings, "detectModel" | "summaryModel">;
  updateSettings: (patch: Partial<Settings>) => void;
}> {
  const { useApp } = await import("../store");
  if (!useApp.getState().hydrated) {
    await new Promise<void>((resolve) => {
      const unsubscribe = useApp.subscribe((state) => {
        if (state.hydrated) {
          unsubscribe();
          resolve();
        }
      });
    });
  }
  return {
    getSettings: () => useApp.getState().settings,
    updateSettings: (patch) => useApp.getState().updateSettings(patch),
  };
}

/** PINNED CONTRACT (S10 blueprint): the wizard's OAuth button (Chunk C)
 *  imports exactly this — the thin real wrapper, resolving every dep
 *  from tauriApi.ts (+ store.ts for updateSettings) and delegating to
 *  the testable core above. Mirrors bootstrap.ts's own
 *  bootstrapWithRealDeps (Promise.all of the tauriApi.ts getters, then
 *  one call into the injected-deps core). */
export async function connectOpenRouterDesktop(): Promise<ConnectOpenRouterResult> {
  const [invoke, listen, openUrl, tauriFetch, settingsAccess] = await Promise.all([
    getInvoke(),
    getListen(),
    getOpener(),
    getTauriFetch(),
    resolveSettingsAccess(),
  ]);
  return connectOpenRouterDesktopWith({ invoke, listen, openUrl, tauriFetch, ...settingsAccess });
}
