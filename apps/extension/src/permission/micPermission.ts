// Mic first-grant pure logic (S7 blueprint §2 Decision A / chunk 3).
// getUserMedia() cannot show its permission PROMPT inside the side
// panel (or the popup, or an offscreen document) — Chrome dismisses
// it silently and hands back a permission-denied error; "ask for the
// mic from inside the panel" is never viable there. The prompt CAN
// render in a visible extension tab/window, and because
// chrome-extension:// is a secure context, the grant then persists
// for the whole origin — so the panel's SpeechRecognition and the
// VAD's own getUserMedia both work afterward with no further
// prompting. See the blueprint's §0/§2-A and anchors 1/5 for the doc
// citations this is built on.
//
// This file is the PURE decision layer only — it never touches the
// DOM and never calls getUserMedia itself. permission.html/permission.ts
// (the visible-tab page) owns the actual prompt; this module just
// decides, given whatever we currently know, what the panel should do
// next, plus the one (trivially impure) call to open that tab.

export type MicPermissionAction =
  | "start" // already granted, or unknown (best-effort optimistic try) — go straight to capture
  | "open-grant-page" // known not-yet-decided ("prompt") — the panel can't resolve that itself, so send the user to the one page that can
  | "denied-guidance"; // explicitly denied — re-asking won't produce a fresh prompt; point at browser site settings instead

/**
 * Pure decision table, no I/O. `state` is either a real
 * `navigator.permissions.query({name:"microphone"})` result or
 * `"unknown"` when that API is unavailable/unsupported or the query
 * itself rejects (best-effort only — blueprint anchor 5).
 *
 * - "granted" -> "start": already usable, skip the grant tab entirely.
 * - "prompt" -> "open-grant-page": the browser has definitely NOT
 *   resolved this yet, and the side panel definitely CANNOT resolve
 *   it either (anchor 1) — trying capture first would just be a
 *   guaranteed, wasted failure, so go straight to the grant tab.
 * - "denied" -> "denied-guidance": already explicitly refused; calling
 *   getUserMedia again (even from the grant tab) won't surface a
 *   fresh prompt — only the browser's own site settings can undo an
 *   explicit denial, so show the recovery copy instead of a tab.
 * - "unknown" -> "start": no proactive signal either way (the query
 *   API is unavailable/unreliable here). Optimistically try capture
 *   directly — the "try" half of the blueprint's "fall back to
 *   try-then-catch"; the caller's reactive not-allowed handling
 *   (captureController, S7 chunk 6) is the "catch" half that opens
 *   the grant page if this attempt turns out to fail. This avoids
 *   forcing every returning user through an extra tab just because
 *   the query API happened to be unavailable.
 */
export function decideMicPermissionAction(
  state: PermissionState | "unknown",
): MicPermissionAction {
  switch (state) {
    case "granted":
      return "start";
    case "prompt":
      return "open-grant-page";
    case "denied":
      return "denied-guidance";
    case "unknown":
      return "start";
  }
}

/**
 * Best-effort proactive check — never throws. Not every Chrome
 * build/context is guaranteed to expose a queryable "microphone"
 * permission descriptor, and the call can reject depending on
 * context, so both "the API doesn't exist" and "the call rejected"
 * collapse to `"unknown"`, which `decideMicPermissionAction` above
 * already treats as "just try" (the try-then-catch fallback).
 */
export async function queryMicPermission(): Promise<PermissionState | "unknown"> {
  try {
    const permissions = globalThis.navigator?.permissions;
    if (!permissions) return "unknown";
    const status = await permissions.query({ name: "microphone" });
    return status.state;
  } catch {
    return "unknown";
  }
}

/**
 * Opens the one-time mic-grant page in a visible tab — the only place
 * the getUserMedia prompt can actually render (blueprint anchors
 * 1/5). `chrome.tabs.create` needs no `"tabs"` permission for this
 * call shape (blueprint §9), and `chrome.runtime.getURL` resolves the
 * packaged path the same way regardless of how the bundler emits it.
 */
export function openPermissionPage(): Promise<chrome.tabs.Tab> {
  return chrome.tabs.create({ url: chrome.runtime.getURL("src/permission/permission.html") });
}
