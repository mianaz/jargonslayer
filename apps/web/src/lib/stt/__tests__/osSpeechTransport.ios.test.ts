// osSpeechTransport.ts (S13 blueprint §2/§6 D2, Lane D) — iOS-branch
// coverage. IS_IOS is a module-scope import-time const, so this needs
// its own file/vi.mock — mirrors engineOptions.desktop.test.ts's own
// split for the identical constraint. See osSpeechTransport.test.ts for
// the desktop branch.

import { describe, expect, it, vi } from "vitest";
import type { AddPluginListenerFn, PluginListenerHandle } from "../../desktop/tauriApi";

vi.mock("../../platform/ios", () => ({ IS_IOS: true }));

let currentAddPluginListener!: AddPluginListenerFn;
vi.mock("../../desktop/tauriApi", () => ({
  getAddPluginListener: () => Promise.resolve(currentAddPluginListener),
}));

import { listenOsSpeechStatus, listenOsSpeechTranscript } from "../osSpeechTransport";

function makeFakeAddPluginListener(unregisterSpy: () => void): {
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
        unregisterSpy();
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

describe("listenOsSpeechTranscript/listenOsSpeechStatus — iOS branch (S13 §2/§6 D2)", () => {
  it('listenOsSpeechTranscript subscribes to the "os-speech" plugin\'s "transcript" event via getAddPluginListener(), wrapping the RAW payload into {payload}', async () => {
    const { addPluginListener, emit } = makeFakeAddPluginListener(vi.fn());
    currentAddPluginListener = addPluginListener;
    const cb = vi.fn();

    await listenOsSpeechTranscript(cb);
    // Swift's trigger() delivers the RAW payload, not {payload}-wrapped
    // like listen()'s own Event<T> — this emits exactly that raw shape.
    emit("os-speech", "transcript", { final: true, seq: 1, startMs: 0, endMs: 100, text: "hi" });

    expect(cb).toHaveBeenCalledWith({ payload: { final: true, seq: 1, startMs: 0, endMs: 100, text: "hi" } });
  });

  it('listenOsSpeechStatus subscribes to the "os-speech" plugin\'s "status" event, same {payload} wrap', async () => {
    const { addPluginListener, emit } = makeFakeAddPluginListener(vi.fn());
    currentAddPluginListener = addPluginListener;
    const cb = vi.fn();

    await listenOsSpeechStatus(cb);
    emit("os-speech", "status", { kind: "capturing", source: "session" });

    expect(cb).toHaveBeenCalledWith({ payload: { kind: "capturing", source: "session" } });
  });

  it("never touches any OTHER plugin/event pair — a same-named event on a different plugin is ignored", async () => {
    const { addPluginListener, emit } = makeFakeAddPluginListener(vi.fn());
    currentAddPluginListener = addPluginListener;
    const cb = vi.fn();

    await listenOsSpeechStatus(cb);
    emit("some-other-plugin", "status", { kind: "capturing", source: "session" });

    expect(cb).not.toHaveBeenCalled();
  });

  it("the returned UnlistenFn calls the plugin listener handle's own unregister() (F3: plugin:os-speech|remove_listener)", async () => {
    const unregisterSpy = vi.fn();
    const { addPluginListener } = makeFakeAddPluginListener(unregisterSpy);
    currentAddPluginListener = addPluginListener;

    const unlisten = await listenOsSpeechStatus(vi.fn());
    unlisten();
    await Promise.resolve(); // unregister() is async — let it settle

    expect(unregisterSpy).toHaveBeenCalledTimes(1);
  });

  // Fix-round F6 (Sol, MEDIUM): unregister() returns a Promise, but
  // UnlistenFn's contract is desktop's synchronous `() => void` — a
  // rejected unregister() (e.g. a torn-down plugin) must be swallowed,
  // not left as a fire-and-forget unhandled rejection.
  it("the returned UnlistenFn swallows a rejected unregister() — stays synchronous void, no unhandled rejection", async () => {
    const handle: PluginListenerHandle = {
      unregister: () => Promise.reject(new Error("remove_listener failed")),
    };
    currentAddPluginListener = (async () => handle) as AddPluginListenerFn;

    const onUnhandledRejection = vi.fn();
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const unlisten = await listenOsSpeechStatus(vi.fn());
      const result = unlisten();
      expect(result).toBeUndefined(); // sync UnlistenFn contract, not a Promise

      await Promise.resolve();
      await Promise.resolve();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(onUnhandledRejection).not.toHaveBeenCalled();
  });
});
