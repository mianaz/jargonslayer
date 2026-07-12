// MV3 stateless coordinator (PLAN-v0.4 S6, §1C decision: the side
// panel IS the app; this worker's only job is telling Chrome "clicking
// the toolbar action opens the side panel" — the documented pattern
// for wiring an action click to the panel without a manual
// chrome.action.onClicked listener). Everything else — the scan loop,
// storage, translation — runs entirely inside the panel page itself
// (src/sidepanel/); this worker holds no state and can be killed and
// respawned by Chrome at any time (the MV3 30s idle timeout) with zero
// user-visible effect, since nothing here is long-lived.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => {
      console.error("[jargonslayer] setPanelBehavior failed", error);
    });
});
