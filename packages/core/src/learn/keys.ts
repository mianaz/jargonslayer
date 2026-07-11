// learnKey — the PURE slice of learn/store.ts, split out for #53 core
// extraction.
//
// learn/store.ts (apps/web) owns learn-set persistence (idb-keyval) —
// impure, stays in apps/web. But learn/queue.ts (this package) needs
// learnKey() to build review-queue candidates. This module is that
// shared pure function; apps/web's learn/store.ts re-exports it so its
// own existing call sites (and consumers importing from
// "@/lib/learn/store") keep working unchanged.

import { expressionNormKey, termNormKey } from "../detect/dedupe";
import type { LearnKind } from "./types";

export function learnKey(kind: LearnKind, surface: string): string {
  return `${kind}:${kind === "term" ? termNormKey(surface) : expressionNormKey(surface)}`;
}
