// S13 (docs/design-explorations/s13-ios-blueprint.md, §2/§6 D2, Lane D)
// — the ONLY place osspeech's event transport branches by platform.
// Desktop: the existing macOS global events "osspeech://transcript"/
// "osspeech://status" via getListen() — byte-identical to what
// osSpeech.ts/osspeechCaps.ts subscribed to directly before this shim
// existed (moved, not reinvented). iOS: there is no Swift->Rust
// streaming callback and Swift's `trigger()` delivers to PLUGIN-SCOPED
// listeners only (a different mechanism from the macOS global
// app.emit/listen path) — so iOS subscribes via
// getAddPluginListener()("os-speech", "transcript"|"status", cb)
// instead. Sol-verified (§6 D2): addPluginListener delivers the RAW
// payload, not a {payload}-wrapped Event like listen() does — the wrap
// happens HERE so every consumer (osSpeech.ts x2, osspeechCaps.ts's own
// preinstallOsSpeech x1 — F2) keeps reading `event.payload` regardless
// of which platform actually delivered it.
//
// Payload types are NOT redefined here — imported (type-only, so this
// file adds no runtime edge back into osSpeech.ts) from osSpeech.ts,
// which already exports them.

import { IS_IOS } from "../platform/ios";
import { getAddPluginListener, getListen, type UnlistenFn } from "../desktop/tauriApi";
import type { OsSpeechStatusPayload, OsSpeechTranscriptPayload } from "./osSpeech";

// §2: iOS plugin name, pinned.
const OS_SPEECH_PLUGIN = "os-speech";

async function listenOsSpeech<T>(
  desktopEvent: string,
  iosEvent: "transcript" | "status",
  cb: (e: { payload: T }) => void,
): Promise<UnlistenFn> {
  if (IS_IOS) {
    const addPluginListener = await getAddPluginListener();
    const listener = await addPluginListener<T>(OS_SPEECH_PLUGIN, iosEvent, (raw) => cb({ payload: raw }));
    // Fix-round F6 (Sol, MEDIUM): unregister() returns a Promise (see
    // tauriApi.ts's own PluginListenerHandle), but UnlistenFn's contract
    // is desktop's synchronous `() => void` (matches getListen()'s own
    // return below) — kept sync deliberately rather than widened to
    // `() => Promise<void>`, since a failed remove_listener is
    // non-actionable at teardown time either way. The catch only exists
    // to keep that rejection from becoming an unhandled-rejection crash
    // surface.
    return () => {
      void listener.unregister().catch(() => {});
    };
  }
  const listen = await getListen();
  return listen<T>(desktopEvent, cb);
}

export function listenOsSpeechTranscript(
  cb: (e: { payload: OsSpeechTranscriptPayload }) => void,
): Promise<UnlistenFn> {
  return listenOsSpeech<OsSpeechTranscriptPayload>("osspeech://transcript", "transcript", cb);
}

export function listenOsSpeechStatus(cb: (e: { payload: OsSpeechStatusPayload }) => void): Promise<UnlistenFn> {
  return listenOsSpeech<OsSpeechStatusPayload>("osspeech://status", "status", cb);
}
