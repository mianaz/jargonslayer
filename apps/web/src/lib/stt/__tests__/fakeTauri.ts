// Shared invoke/listen/Channel fakes for testing appAudio.ts's
// AppAudioEngine (appAudio.test.ts) — mirrors apps/web/src/lib/desktop/
// __tests__/provisionRunner.test.ts's own makeFakeInvoke/makeFakeListen
// (that file predates this shared helper and isn't itself importable —
// a test file, not a module — so this is a same-shaped local copy, not
// a reuse). Not itself a test file (no .test.ts suffix), same
// convention as fakeMedia.ts/fakeWs.ts in this directory.

import type { ChannelFactory, InvokeFn, ListenFn, PcmChannel, TauriEvent, UnlistenFn } from "../../desktop/tauriApi";

export interface FakeInvokeCall {
  cmd: string;
  args?: Record<string, unknown>;
}

/** Records every invoke() call and dispatches to a per-command handler
 *  — throws for any command a given test didn't expect, so an
 *  unexpected/wrongly-named invoke() call fails loudly instead of
 *  silently resolving undefined. A handler may return a value OR a
 *  Promise (awaited automatically, since `invoke` itself is async) —
 *  handy for a test that needs to defer a specific command's
 *  resolution (e.g. "stop() lands while start_app_audio is in
 *  flight"). */
export function makeFakeInvoke(
  handlers: Record<string, (args?: Record<string, unknown>) => unknown>,
): { invoke: InvokeFn; calls: FakeInvokeCall[] } {
  const calls: FakeInvokeCall[] = [];
  const invoke: InvokeFn = (async <T>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (!(cmd in handlers)) throw new Error(`unexpected invoke("${cmd}")`);
    return (await handlers[cmd](args)) as T;
  }) as InvokeFn;
  return { invoke, calls };
}

/** Records listen()/unlisten() activity and lets a test emit an event
 *  to whatever's currently subscribed — enough to simulate the
 *  `audiocap://status` event AppAudioEngine subscribes to. */
export function makeFakeListen(): {
  listen: ListenFn;
  emit: (event: string, payload: unknown) => void;
  activeCount: (event: string) => number;
} {
  const active = new Map<string, Array<(event: TauriEvent<unknown>) => void>>();
  const listen: ListenFn = (async <T>(event: string, handler: (event: TauriEvent<T>) => void) => {
    const list = active.get(event) ?? [];
    list.push(handler as (event: TauriEvent<unknown>) => void);
    active.set(event, list);
    const unlisten: UnlistenFn = () => {
      const remaining = (active.get(event) ?? []).filter((h) => h !== handler);
      active.set(event, remaining);
    };
    return unlisten;
  }) as ListenFn;
  function emit(event: string, payload: unknown): void {
    for (const handler of active.get(event) ?? []) handler({ event, payload });
  }
  function activeCount(event: string): number {
    return (active.get(event) ?? []).length;
  }
  return { listen, emit, activeCount };
}

/** Fake Channel factory (D5 wire contract: a `Channel<ArrayBuffer>`
 *  from `@tauri-apps/api/core`, arriving in appAudio.ts via
 *  tauriApi.ts's getChannelFactory()) — records every constructed
 *  channel so a test can push a simulated ArrayBuffer chunk straight
 *  through `channels[n].onmessage(...)`, exactly as the native helper
 *  would over the real IPC channel. */
export function makeFakeChannelFactory(): {
  createChannel: ChannelFactory;
  channels: PcmChannel[];
} {
  const channels: PcmChannel[] = [];
  const createChannel: ChannelFactory = (onmessage) => {
    const channel: PcmChannel = { onmessage };
    channels.push(channel);
    return channel;
  };
  return { createChannel, channels };
}
