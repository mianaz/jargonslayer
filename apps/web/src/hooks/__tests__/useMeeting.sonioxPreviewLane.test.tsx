// @vitest-environment jsdom
//
// useMeeting — Soniox preview lane session-start trial notice (v0.5
// closeout item 3): fires ONCE per meeting start, only for a session
// actually riding the server-minted credential (soniox/tabaudio-cloud,
// SONIOX_PREVIEW_LANE, no BYOK sonioxKey). Tightened for BYOK preview
// (docs/design-explorations/byok-preview-blueprint.md D3): tabaudio-
// cloud's own effectiveProvider no longer force-routes through Soniox
// on this lane, so the notice ALSO requires the resolved tab-cloud
// provider to actually be soniox — a BYOK Deepgram tab-cloud session
// (engine tabaudio-cloud, no sonioxKey, but a real deepgramKey) must
// never see a toast claiming its audio went through Soniox's trial.
// PREVIEW_TIER/SONIOX_PREVIEW_LANE are both import-time consts
// (deployTier.ts) —
// same "needs its own vi.mock'd file" constraint as engineOptions.
// sonioxPreviewLane.test.ts/soniox.sonioxPreview.test.ts (see either
// file's own header) — useMeeting.lifecycle.test.tsx's own ambient env
// (both false) stays untouched for its existing ordinary-lifecycle
// coverage. Hook-level (not engine-level): the guard itself lives in
// useMeeting.ts's own onStatus wiring, not any one engine — reuses that
// file's createRoot + mocked-createEngine harness shape, trimmed to
// just what this one seam needs (no pause/resume races here).

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/deployTier", () => ({ PREVIEW_TIER: true, SONIOX_PREVIEW_LANE: true }));

type AnyEvents = {
  onStatus: (status: string, detail?: string) => void;
  onInterim: (text: string, speaker?: string) => void;
  [k: string]: unknown;
};

class FakeEngine {
  kind: string;
  events: AnyEvents | null = null;
  startResolve: (() => void) | null = null;
  private startP = new Promise<void>((r) => (this.startResolve = r));

  constructor(kind: string) {
    this.kind = kind;
  }
  async start(events: AnyEvents): Promise<void> {
    this.events = events;
    await this.startP;
  }
  async stop(): Promise<void> {}
}

const engines: FakeEngine[] = [];
let nextEngineKind = "demo";
vi.mock("../../lib/stt", () => ({
  createEngine: vi.fn(() => {
    const e = new FakeEngine(nextEngineKind);
    engines.push(e);
    return e as unknown as import("@jargonslayer/core/types").STTEngine;
  }),
}));

import { useMeeting, type UseMeetingResult } from "../useMeeting";
import { useApp } from "../../lib/store";
import type { Settings, STTEngineKind } from "@jargonslayer/core/types";

let api: UseMeetingResult | null = null;
function Probe() {
  api = useMeeting();
  return null;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useMeeting — soniox preview lane session-start trial notice", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    engines.length = 0;
    nextEngineKind = "demo";
    useApp.setState({
      status: "idle",
      segments: [],
      interim: null,
      pausedAccumMs: 0,
      pauseStartedAt: null,
      toast: null,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Probe />);
    });
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
    api = null;
  });

  async function startListening(
    engineKind: STTEngineKind,
    sonioxKey: string,
    extraSettings: Partial<Settings> = {},
  ): Promise<FakeEngine> {
    nextEngineKind = engineKind;
    useApp.setState({
      settings: { ...useApp.getState().settings, engine: engineKind, sonioxKey, ...extraSettings },
    });
    let p: Promise<void>;
    await act(async () => {
      p = api!.start();
      await flush();
      engines[engines.length - 1].startResolve!();
      await p;
      engines[engines.length - 1].events!.onStatus("listening");
    });
    expect(useApp.getState().status).toBe("listening");
    return engines[engines.length - 1];
  }

  it("fires once when a keyless soniox session first reaches listening", async () => {
    await startListening("soniox", "");
    expect(useApp.getState().toast).toBe(
      "预览体验：本段最长 10 分钟（每日限量），音频经 Soniox 云端转写、不留存",
    );
  });

  it("fires for tabaudio-cloud too — the same server-minted credential", async () => {
    await startListening("tabaudio-cloud", "");
    expect(useApp.getState().toast).toBe(
      "预览体验：本段最长 10 分钟（每日限量），音频经 Soniox 云端转写、不留存",
    );
  });

  it("never fires when a BYOK sonioxKey is present, even on the lane", async () => {
    await startListening("soniox", "sk-own-key");
    expect(useApp.getState().toast).toBeNull();
  });

  it("never fires for other engines (e.g. webspeech)", async () => {
    await startListening("webspeech", "");
    expect(useApp.getState().toast).toBeNull();
  });

  it("fires only once per meeting — a second onStatus('listening') on the SAME engine does not re-toast", async () => {
    const engine = await startListening("soniox", "");
    useApp.setState({ toast: null });

    await act(async () => {
      engine.events!.onStatus("listening");
    });

    expect(useApp.getState().toast).toBeNull();
  });

  // BYOK preview D3: engine tabaudio-cloud + no sonioxKey used to be
  // sufficient to fire the notice (tabAudioCloud.ts's old effectiveProvider
  // force made that a safe inference) — it no longer is, since the
  // engine now honestly runs whatever Settings.tabAudioCloudProvider
  // says. Placed last in this describe block: `startListening` never
  // resets `settings` between tests (only status/segments/toast/etc —
  // see beforeEach above), so a persisted tabAudioCloudProvider:
  // "deepgram" here must not leak into a later test.
  it("never fires for BYOK Deepgram tab-cloud (engine tabaudio-cloud, resolved provider deepgram, no mint involved)", async () => {
    await startListening("tabaudio-cloud", "", { tabAudioCloudProvider: "deepgram", deepgramKey: "dg-own-key" });
    expect(useApp.getState().toast).toBeNull();
  });
});
