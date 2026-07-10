// One-time `window` "error"/"unhandledrejection" listeners feeding the
// diag ring buffer (log.ts) — installed once from the app bootstrap
// path (src/app/page.tsx, right next to the existing hydrate() call).
// An uncaught error/rejection's shape is inherently unpredictable, so
// this module only ever reads a STRING message off it (never dumps
// the raw error/event object, which could carry request/response
// payloads from some future call site) — matches log.ts's PRIVACY
// RULE.

import { diagLog } from "./log";

let installed = false;
let errorListener: ((event: ErrorEvent) => void) | null = null;
let rejectionListener: ((event: PromiseRejectionEvent) => void) | null = null;

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "未知的未处理 Promise 拒绝";
}

/** Idempotent — safe to call from a component effect that may run
 *  more than once (React 18 StrictMode double-invoke, HMR) without
 *  registering duplicate listeners. No-ops outside a browser
 *  (`window` undefined, e.g. this module reached from a node test). */
export function installGlobalDiagHandlers(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  installed = true;

  errorListener = (event) => {
    const location = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined;
    diagLog("error", "window", event.message || "未捕获的运行时错误", location);
  };
  rejectionListener = (event) => {
    diagLog("error", "window", describeReason(event.reason));
  };
  window.addEventListener("error", errorListener);
  window.addEventListener("unhandledrejection", rejectionListener);
}

/** Test-only full reset — mirrors llm/client.ts's
 *  resetSubscriptionToastLatch pattern for a module-level once-latch,
 *  but also tears down the actual listeners (unlike a bare boolean
 *  reset) so repeated install/reset cycles against the SAME jsdom
 *  `window` across test cases never accumulate duplicate listeners. */
export function resetGlobalDiagHandlersLatch(): void {
  if (typeof window !== "undefined") {
    if (errorListener) window.removeEventListener("error", errorListener);
    if (rejectionListener) window.removeEventListener("unhandledrejection", rejectionListener);
  }
  errorListener = null;
  rejectionListener = null;
  installed = false;
}
