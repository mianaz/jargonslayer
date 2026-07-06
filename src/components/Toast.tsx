"use client";

// Bottom-center transient notification, driven by store.toast.

import { useEffect } from "react";
import { useApp } from "@/lib/store";

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

  return (
    <div className="fade-up fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-edge bg-panel2 px-4 py-2.5 text-sm text-fg shadow-lg">
      {toast}
    </div>
  );
}
