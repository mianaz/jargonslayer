// permission.ts is the mic first-grant page: its ONLY job is to make
// Chrome record a grant for the extension origin and then let go of the
// hardware. The load-bearing invariant is the track-stop loop — a
// regression there is a hot mic held open with nothing listening, in a
// privacy-first product — so these tests pin that every track is
// stopped BEFORE the success copy renders, plus both outcome strings
// verbatim (blueprint §7 麦克风授权（首次）).
//
// Same node-env posture as micPermission.test.ts next door: no jsdom,
// the module's own document/navigator bindings are stubbed globals and
// the module is re-imported fresh per test (it binds #js-grant-btn at
// import time).
import { afterEach, describe, expect, it, vi } from "vitest";

const SUCCESS_TEXT = "已获得麦克风权限，可以开始聆听了。";
const DENIED_TEXT = "麦克风权限被拒绝。可以在地址栏左侧的站点设置里重新允许。";

interface FakePage {
  btn: { disabled: boolean; addEventListener: (type: string, cb: () => void) => void };
  resultEl: { textContent: string; className: string; hidden: boolean };
  click: () => Promise<void>;
  log: string[];
}

async function loadPage(navigatorStub: unknown): Promise<FakePage> {
  const log: string[] = [];
  let clickHandler: (() => void) | undefined;

  const btn = {
    disabled: false,
    addEventListener: (type: string, cb: () => void) => {
      if (type === "click") clickHandler = cb;
    },
  };

  let text = "";
  const resultEl = {
    className: "",
    hidden: true,
    get textContent() {
      return text;
    },
    set textContent(v: string) {
      text = v;
      log.push(`text:${v}`);
    },
  };

  vi.stubGlobal("document", {
    querySelector: (sel: string) =>
      sel === "#js-grant-btn" ? btn : sel === "#js-result" ? resultEl : null,
  });
  vi.stubGlobal("navigator", navigatorStub);

  vi.resetModules();
  await import("../permission");
  if (!clickHandler) throw new Error("permission.ts never bound the click handler");

  return {
    btn,
    resultEl,
    log,
    click: async () => {
      clickHandler!();
      await new Promise((r) => setTimeout(r, 0)); // let requestMicGrant settle
    },
  };
}

function makeTracks(log: string[], n: number): { stop: () => void }[] {
  return Array.from({ length: n }, (_, i) => ({
    stop: () => log.push(`stop:${i}`),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("permission page — grant flow", () => {
  it("does NOT auto-request on load: getUserMedia only runs after the click", async () => {
    const getUserMedia = vi.fn();
    await loadPage({ mediaDevices: { getUserMedia } });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("requests audio-only, stops EVERY track before showing success, and keeps the button disabled", async () => {
    let seenConstraints: unknown;
    let tracks: { stop: () => void }[] = [];
    const getUserMedia = vi.fn(async (constraints: unknown) => {
      seenConstraints = constraints;
      return { getTracks: () => tracks };
    });
    const page = await loadPage({ mediaDevices: { getUserMedia } });
    tracks = makeTracks(page.log, 2);

    await page.click();

    expect(seenConstraints).toEqual({ audio: true });
    // The hot-mic guard: both stops land before the success copy.
    expect(page.log).toEqual(["stop:0", "stop:1", `text:${SUCCESS_TEXT}`]);
    expect(page.resultEl.hidden).toBe(false);
    expect(page.resultEl.className).toBe("js-result js-result--success");
    // Success needs no retry — the button stays disabled.
    expect(page.btn.disabled).toBe(true);
  });

  it("shows the denied guidance and re-enables the button when the user rejects the prompt", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    const page = await loadPage({ mediaDevices: { getUserMedia } });

    await page.click();

    expect(page.resultEl.textContent).toBe(DENIED_TEXT);
    expect(page.resultEl.className).toBe("js-result js-result--denied");
    expect(page.resultEl.hidden).toBe(false);
    expect(page.btn.disabled).toBe(false); // the user may try again
  });

  it("treats a missing mediaDevices API as denied instead of crashing", async () => {
    const page = await loadPage({}); // no navigator.mediaDevices at all

    await page.click();

    expect(page.resultEl.textContent).toBe(DENIED_TEXT);
    expect(page.btn.disabled).toBe(false);
  });

  it("hides any previous result while a new request is in flight", async () => {
    let release: (v: { getTracks: () => { stop: () => void }[] }) => void = () => {};
    const getUserMedia = vi.fn(
      () => new Promise<{ getTracks: () => { stop: () => void }[] }>((r) => (release = r)),
    );
    const page = await loadPage({ mediaDevices: { getUserMedia } });

    page.resultEl.hidden = false; // simulate a previous denied outcome on screen
    const clicked = page.click();
    expect(page.resultEl.hidden).toBe(true); // cleared synchronously on click
    expect(page.btn.disabled).toBe(true);

    release({ getTracks: () => [] });
    await clicked;
  });
});
