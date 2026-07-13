// Mic first-grant visible-tab page (S7 blueprint §2 Decision A /
// chunk 3). Opened via micPermission.ts's openPermissionPage()
// (chrome.tabs.create) because getUserMedia's permission PROMPT
// cannot render inside the side panel, the popup, or an offscreen
// document (blueprint anchors 1/5) — a visible extension tab is the
// only place it can. Deliberately does NOT auto-request on load: the
// prompt only ever appears after an explicit click, never as a
// surprise the instant this tab opens. Because chrome-extension:// is
// a secure context, a grant obtained here persists for the whole
// origin, so the side panel's SpeechRecognition and the VAD's own
// getUserMedia both work afterward with no further prompting.
//
// Copy note: the blueprint's §7 "麦克风授权（首次）" block has six
// lines total. 标题/授权页正文 are static and already live directly in
// permission.html (title/body paragraph); SUCCESS_TEXT/DENIED_TEXT
// below are the two mutually-exclusive OUTCOME strings, both verbatim
// from that same block. 说明/按钮 from the block belong to the SIDE
// PANEL's own "need grant" affordance (S7 chunk 6, main.ts) — this
// page never shows them.

const SUCCESS_TEXT = "已获得麦克风权限，可以开始聆听了。";
const DENIED_TEXT = "麦克风权限被拒绝。可以在地址栏左侧的站点设置里重新允许。";

const grantBtn = document.querySelector<HTMLButtonElement>("#js-grant-btn")!;
const result = document.querySelector<HTMLParagraphElement>("#js-result")!;

function showResult(text: string, kind: "success" | "denied"): void {
  result.textContent = text;
  result.className = `js-result js-result--${kind}`;
  result.hidden = false;
}

async function requestMicGrant(): Promise<void> {
  grantBtn.disabled = true;
  result.hidden = true;
  try {
    const stream = await navigator.mediaDevices?.getUserMedia?.({ audio: true });
    if (!stream) throw new Error("getUserMedia unavailable in this context");
    // Stop every track synchronously, right here in the success
    // handler — the ONLY thing this page needs is for Chrome to
    // record the grant for this origin. Holding the stream open would
    // be a hot mic with nothing ever listening to it.
    for (const track of stream.getTracks()) track.stop();
    showResult(SUCCESS_TEXT, "success");
  } catch {
    grantBtn.disabled = false;
    showResult(DENIED_TEXT, "denied");
  }
}

grantBtn.addEventListener("click", () => {
  void requestMicGrant();
});
