"use client";

// Bottom-center transient notification, driven by store.toast.

import { useEffect } from "react";
import { useApp } from "@/lib/store";
import { copyDiagnosticReport } from "@/lib/diag/report";

const TOAST_DURATION_MS = 4000;

export default function Toast() {
  const toast = useApp((s) => s.toast);
  const clearToast = useApp((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => clearToast(), TOAST_DURATION_MS);
    return () => clearTimeout(t);
  }, [toast, clearToast]);

  if (!toast) return null;

  const message = typeof toast === "string" ? toast : toast.message;
  const ref = typeof toast === "string" ? undefined : toast.ref;
  // A ref-carrying toast (error-class choke points — see store.ts's
  // ToastState doc) always offers 复制诊断 unless the call site already
  // set its own action; an explicit action always wins (none of
  // today's callers set both, but this keeps the two additive rather
  // than one silently shadowing the other).
  const action =
    typeof toast === "string"
      ? undefined
      : (toast.action ??
        (ref
          ? {
              label: "复制诊断",
              run: () => {
                void copyDiagnosticReport(useApp.getState().settings);
              },
            }
          : undefined));

  return (
    // S14.2 field fix (owner report: toast "too close to the right" on
    // iPhone): the old `left-1/2 -translate-x-1/2` centering was
    // silently defeated by .fade-up — its keyframes animate `transform:
    // translateY(...)` with fill-mode `both`, and since transform is ONE
    // property the animation's final frame permanently REPLACED the
    // -translate-x-1/2, pinning the toast's LEFT edge to the viewport
    // midline (measured live: left=188 on a 375px viewport, right edge
    // clipped offscreen). Fix: center with a full-width flex wrapper so
    // no transform is needed at all — fade-up keeps animating the inner
    // box freely. max-w + px keep long messages wrapping on phones.
    <div className="pointer-events-none fixed inset-x-0 bottom-9 z-50 flex justify-center px-3">
      <div className="fade-up pointer-events-auto flex max-w-full items-center gap-3 border border-edge bg-panel2 px-4 py-2 text-sm text-fg shadow-lg">
      <span>
        {message}
        {ref && <span className="ml-2 font-mono text-xs text-mut2">[{ref}]</span>}
      </span>
      {action && (
        <button
          type="button"
          onClick={() => {
            action.run();
            clearToast();
          }}
          className="border border-edge px-2 py-0.5 font-mono text-xs text-act hover:bg-panel3"
        >
          {action.label}
        </button>
      )}
      </div>
    </div>
  );
}
