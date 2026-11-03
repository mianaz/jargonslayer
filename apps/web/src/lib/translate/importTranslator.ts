// Translation engine for one import (transcript text or audio file).
//
// Imports used to always translate through the LLM /api/translate, so a
// user on the default on-device engine (系统翻译, no key) got an import
// with no Chinese at all. They now go through the same engine a live
// meeting uses.
//
// prepare() MUST run synchronously inside the 导入 click: Chrome's
// on-device Translator only creates a session (and starts a first-use
// model download) on a live user gesture. So the caller grabs the
// provider in its click handler, before runTrackedAsync's first await,
// and hands it down to runTranslation.

import { useApp } from "@/lib/store";
import { isGapFillRunning } from "./gapfill";
import {
  langPairFromSettings,
  resolveTranslationProvider,
  stopSystemTranslator,
  type TranslationProvider,
} from "./providers";

/** Resolves and prepares the user's engine. Call from the click handler
 *  itself. Returns undefined when this import won't translate. */
export function prepareImportTranslator(
  settings: Parameters<typeof langPairFromSettings>[0],
  translate: boolean,
): TranslationProvider | undefined {
  if (!translate) return undefined;
  const pair = langPairFromSettings(settings);
  if (pair.source === pair.target) return undefined;
  const provider = resolveTranslationProvider(() => settings);
  provider.prepare(pair);
  return provider;
}

/** Tears down a native system-translation child this import's prepare()
 *  may have spawned (desktop/iOS), unless something else still relies on
 *  that shared translator: a live meeting's own TranslateQueue, or a
 *  补全翻译 run. Leaving it up in those cases is the same bounded,
 *  deliberate trade gapfill.ts makes. No-op on the web, where
 *  stopSystemTranslator() itself is a no-op. */
export function releaseImportTranslator(provider: TranslationProvider | undefined): void {
  if (!provider || provider.kind !== "system") return;
  const status = useApp.getState().status;
  const meetingLive = status === "connecting" || status === "listening" || status === "paused";
  if (meetingLive || isGapFillRunning()) return;
  void stopSystemTranslator();
}
