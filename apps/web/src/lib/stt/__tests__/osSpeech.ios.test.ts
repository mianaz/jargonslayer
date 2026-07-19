// OsSpeechEngine — iOS-only coverage (S13, docs/design-explorations/
// s13-ios-blueprint.md, §6 Sol F7): permission-denied/unsupported status
// copy platform-branches on IS_IOS. IS_IOS is a module-scope import-time
// const, so this needs its own file/vi.mock — mirrors osSpeech.test.ts's
// own tauriApi mocking shape (getInvoke faked, "../../store" mocked for
// buildContextualJson's own customEntries source) plus the
// engineOptions.desktop.test.ts convention for splitting a flag-mocked
// suite into its own file. On IS_IOS, osSpeechTransport.ts's shim
// subscribes via getAddPluginListener() (not getListen()) — this fakes
// THAT surface, mirroring osSpeechTransport.ios.test.ts's own fake. The
// macOS (ambient, IS_IOS false) copy for these SAME two kinds is already
// pinned byte-identical in osSpeech.test.ts — this file only exercises
// the iOS branch.

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type STTEvents } from "@jargonslayer/core/types";
import { makeFakeInvoke } from "./fakeTauri";
import type { AddPluginListenerFn, InvokeFn, PluginListenerHandle } from "../../desktop/tauriApi";

vi.mock("../../platform/ios", () => ({ IS_IOS: true }));

let currentInvoke!: InvokeFn;
let currentAddPluginListener!: AddPluginListenerFn;
vi.mock("../../desktop/tauriApi", () => ({
  getInvoke: () => Promise.resolve(currentInvoke),
  getAddPluginListener: () => Promise.resolve(currentAddPluginListener),
}));

vi.mock("../../store", () => ({
  useApp: { getState: () => ({ customEntries: [] }) },
}));

vi.mock("../../desktop/jobsBridge", () => ({
  trackOsSpeechAsset: () => ({ handle: vi.fn(), settle: vi.fn() }),
}));

import { OsSpeechEngine } from "../osSpeech";

const OSSPEECH_SETTINGS = { ...DEFAULT_SETTINGS, engine: "osspeech" as const };

function noopEvents(): STTEvents {
  return {
    onInterim: () => {},
    onFinal: () => {},
    onStatus: () => {},
    onNotice: () => {},
    onSpeakerUpdate: () => {},
    onDiarStatus: () => {},
  } as unknown as STTEvents;
}

/** Fakes the "os-speech" plugin's own addPluginListener surface —
 *  mirrors osSpeechTransport.ios.test.ts's own same-shaped helper (not
 *  cross-imported, same "every __tests__ dir keeps its own copy"
 *  convention fakeTauri.ts's header comment already documents). */
function makeFakeAddPluginListener(): {
  addPluginListener: AddPluginListenerFn;
  emit: (plugin: string, event: string, payload: unknown) => void;
} {
  const active = new Map<string, Array<(payload: unknown) => void>>();
  const addPluginListener: AddPluginListenerFn = (async <T>(
    plugin: string,
    event: string,
    cb: (payload: T) => void,
  ) => {
    const key = `${plugin}:${event}`;
    const list = active.get(key) ?? [];
    list.push(cb as (payload: unknown) => void);
    active.set(key, list);
    const handle: PluginListenerHandle = {
      unregister: async () => {
        active.set(key, (active.get(key) ?? []).filter((h) => h !== cb));
      },
    };
    return handle;
  }) as AddPluginListenerFn;
  function emit(plugin: string, event: string, payload: unknown): void {
    for (const handler of active.get(`${plugin}:${event}`) ?? []) handler(payload);
  }
  return { addPluginListener, emit };
}

function wireFakes(): { emit: (event: "transcript" | "status", payload: unknown) => void } {
  const { invoke } = makeFakeInvoke({
    start_os_speech: () => undefined,
    stop_os_speech: () => undefined,
  });
  currentInvoke = invoke;
  const { addPluginListener, emit } = makeFakeAddPluginListener();
  currentAddPluginListener = addPluginListener;
  return { emit: (event, payload) => emit("os-speech", event, payload) };
}

describe("OsSpeechEngine — iOS status copy (S13 §6 Sol F7)", () => {
  it('permission-denied on iOS directs to 设置 → 隐私与安全性 → 麦克风 (NOT the macOS 屏幕与系统音频录制 pane)', async () => {
    const { emit } = wireFakes();
    const engine = new OsSpeechEngine();
    const onStatus = vi.fn();
    await engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);

    emit("status", { kind: "permission-denied", source: "session" });

    expect(onStatus).toHaveBeenCalledWith("error", "JargonSlayer 没有麦克风权限，请前往 设置 → 隐私与安全性 → 麦克风 开启后重试");
    expect(onStatus.mock.calls[0][1]).not.toContain("屏幕与系统音频录制");
    expect(onStatus.mock.calls[0][1]).not.toContain("系统设置");
  });

  it('unsupported on iOS reads "系统识别需要 iOS 26 或更高版本" (NOT macOS 26)', async () => {
    const { emit } = wireFakes();
    const engine = new OsSpeechEngine();
    const onStatus = vi.fn();
    await engine.start({ ...noopEvents(), onStatus } as unknown as STTEvents, OSSPEECH_SETTINGS);

    emit("status", { kind: "unsupported", source: "session" });

    expect(onStatus).toHaveBeenCalledWith("error", "系统识别需要 iOS 26 或更高版本");
  });
});
