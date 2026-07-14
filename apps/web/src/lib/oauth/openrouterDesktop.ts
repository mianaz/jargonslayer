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

/** Test-only reset — mirrors tauriApi.ts's resetTauriApiCache /
 *  audiocapCaps.ts's resetAudiocapCapsCache convention for module-level
 *  state that must never leak between independent `it()` blocks. */
export function resetConnectOpenRouterLatch(): void {
  inFlight = false;
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

      timer = setTimeout(() => settle({ ok: false, reason: "timeout" }), JS_TIMEOUT_MS);

      void (async () => {
        try {
          // (1) PKCE verifier/challenge — reused verbatim from
          // openrouterPkce.ts, same functions the web flow uses.
          const verifier = generateCodeVerifier();
          const challenge = await codeChallengeS256(verifier);

          // (2) a SECOND, independent random token for the loopback
          // listener's own `ns` — reuses generateCodeVerifier() again
          // rather than a new generator: it's already a
          // crypto.getRandomValues-backed, URL-safe (RFC 7636
          // unreserved charset — no percent-encoding needed in the
          // template literal below), high-entropy random string, and
          // this `ns` has nothing to do with PKCE itself, just needs
          // the same "hard to guess" property.
          const ns = generateCodeVerifier();

          let port: number;
          try {
            port = await deps.invoke<number>("oauth_loopback_start", { ns });
          } catch (err) {
            settle({ ok: false, reason: "port-bind-failed", message: describeError(err) });
            return;
          }

          // (3)(4)
          const callbackUrl = `http://${CALLBACK_HOST}:${port}/oauth/openrouter?ns=${ns}`;
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
                // EXACT same settings write as the web callback page
                // (app/oauth/openrouter/page.tsx's own handleConnect
                // effect) — see that file's own updateSettings call.
                deps.updateSettings({
                  provider: "openai-compat",
                  baseUrl: "https://openrouter.ai/api/v1",
                  apiKey: key,
                });
                settle({ ok: true });
              } catch (err) {
                settle({ ok: false, reason: "exchange-failed", message: describeError(err) });
              }
            })();
          });

          await deps.openUrl(authUrl);
        } catch (err) {
          settle({ ok: false, reason: "exchange-failed", message: describeError(err) });
        }
      })();
    });
  } finally {
    inFlight = false;
  }
}

/** Hydration-gated read of store.ts's `updateSettings` action — mirrors
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
async function resolveUpdateSettings(): Promise<(patch: Partial<Settings>) => void> {
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
  return (patch) => useApp.getState().updateSettings(patch);
}

/** PINNED CONTRACT (S10 blueprint): the wizard's OAuth button (Chunk C)
 *  imports exactly this — the thin real wrapper, resolving every dep
 *  from tauriApi.ts (+ store.ts for updateSettings) and delegating to
 *  the testable core above. Mirrors bootstrap.ts's own
 *  bootstrapWithRealDeps (Promise.all of the tauriApi.ts getters, then
 *  one call into the injected-deps core). */
export async function connectOpenRouterDesktop(): Promise<ConnectOpenRouterResult> {
  const [invoke, listen, openUrl, tauriFetch, updateSettings] = await Promise.all([
    getInvoke(),
    getListen(),
    getOpener(),
    getTauriFetch(),
    resolveUpdateSettings(),
  ]);
  return connectOpenRouterDesktopWith({ invoke, listen, openUrl, tauriFetch, updateSettings });
}
