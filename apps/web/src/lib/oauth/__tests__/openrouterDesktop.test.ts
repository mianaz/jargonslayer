// Local invoke/listen fakes mirror lib/stt/__tests__/fakeTauri.ts's own
// makeFakeInvoke/makeFakeListen shape — a same-shaped local copy, not a
// cross-feature-directory reuse, same precedent that file's own header
// comment documents for provisionRunner.test.ts's identical local copy.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@jargonslayer/core/types";
import {
  cancelOpenRouterConnect,
  connectOpenRouterDesktopWith,
  resetConnectOpenRouterLatch,
  type ConnectOpenRouterDesktopDeps,
} from "../openrouterDesktop";
import type { InvokeFn, ListenFn, OpenExternalFn, TauriEvent, TauriFetchFn, UnlistenFn } from "../../desktop/tauriApi";

interface FakeInvokeCall {
  cmd: string;
  args?: Record<string, unknown>;
}

function makeFakeInvoke(
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

function makeFakeListen(): {
  listen: ListenFn;
  emit: (event: string, payload: unknown) => void;
  unlisten: ReturnType<typeof vi.fn>;
} {
  const active = new Map<string, Array<(event: TauriEvent<unknown>) => void>>();
  const unlisten = vi.fn();
  const listen: ListenFn = (async <T>(event: string, handler: (event: TauriEvent<T>) => void) => {
    const list = active.get(event) ?? [];
    list.push(handler as (event: TauriEvent<unknown>) => void);
    active.set(event, list);
    const off: UnlistenFn = () => {
      unlisten();
      active.set(
        event,
        (active.get(event) ?? []).filter((h) => h !== handler),
      );
    };
    return off;
  }) as ListenFn;
  function emit(event: string, payload: unknown): void {
    for (const handler of active.get(event) ?? []) handler({ event, payload });
  }
  return { listen, emit, unlisten };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Polls a tick at a time until `check()` is true — robust against
 *  exactly how many internal awaits sit between a call and a given
 *  observable milestone, same idiom lib/stt/__tests__/appAudio.test.ts's
 *  own flushUntil already establishes for this codebase. Ticks via a
 *  real macrotask (`setTimeout(0)`), NOT a plain microtask
 *  (`Promise.resolve()`) — this flow's own `codeChallengeS256` awaits
 *  `crypto.subtle.digest`, which (verified empirically: 20 microtask
 *  ticks never observe it resolved, one macrotask tick always does)
 *  settles via Node's real event loop, not a pure microtask chain. */
async function flushUntil(check: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!check()) throw new Error("flushUntil: condition never became true");
}

/** flushUntil's own fake-timer counterpart — `setTimeout(0)` itself is
 *  one of the timers `vi.useFakeTimers()` replaces, so it would never
 *  fire on its own and flushUntil above would hang forever under fake
 *  timers. `vi.advanceTimersByTimeAsync` is vitest's documented way to
 *  mix fake timers with genuinely-pending real async work (like
 *  crypto.subtle.digest above): it still yields to the real event loop
 *  on every call, it just ALSO drives the fake clock forward by `ms`. */
async function flushUntilFake(check: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (check()) return;
    await vi.advanceTimersByTimeAsync(0);
  }
  if (!check()) throw new Error("flushUntilFake: condition never became true");
}

const PORT = 54321;

// Field-test fix (v0.4.4): default getSettings mirrors a real never-
// touched-since-install user — the pre-fix bare Anthropic defaults —
// so the DEFAULT makeDeps() call exercises the realistic "OAuth fixes
// a stale model" path end-to-end; tests that don't care about the
// remap at all (every failure-mapping/timeout case below) can ignore
// it since updateSettings is never even called on those paths.
function makeDeps(
  overrides: Partial<{
    startPort: () => number;
    tauriFetch: TauriFetchFn;
    currentModels: Pick<Settings, "detectModel" | "summaryModel">;
  }> = {},
) {
  const { invoke, calls: invokeCalls } = makeFakeInvoke({
    oauth_loopback_start: () => (overrides.startPort ? overrides.startPort() : PORT),
    oauth_loopback_cancel: () => undefined,
  });
  const { listen, emit, unlisten } = makeFakeListen();
  const openUrl = vi.fn<OpenExternalFn>().mockResolvedValue(undefined);
  const tauriFetch =
    overrides.tauriFetch ?? (vi.fn().mockResolvedValue(jsonResponse({ key: "sk-or-v1-abc" })) as unknown as TauriFetchFn);
  const updateSettings = vi.fn<(patch: Partial<Settings>) => void>();
  const getSettings = vi.fn(
    () =>
      overrides.currentModels ?? { detectModel: "claude-haiku-4-5", summaryModel: "claude-sonnet-5" },
  );
  const deps: ConnectOpenRouterDesktopDeps = { invoke, listen, openUrl, tauriFetch, updateSettings, getSettings };
  return { deps, invokeCalls, emit, unlisten, openUrl, tauriFetch, updateSettings, getSettings };
}

beforeEach(() => {
  resetConnectOpenRouterLatch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connectOpenRouterDesktopWith — happy path", () => {
  it("exchanges the code, writes settings exactly like the web callback page (PLUS the field-test detectModel/summaryModel remap, since makeDeps' default getSettings mirrors the pre-fix bare Anthropic defaults), settles ok:true, and cleans up", async () => {
    const { deps, emit, unlisten, tauriFetch, updateSettings, invokeCalls, openUrl } = makeDeps();

    const resultPromise = connectOpenRouterDesktopWith(deps);
    await flushUntil(() => openUrl.mock.calls.length > 0); // listen is guaranteed subscribed by here (see ordering test below)
    emit("oauth://openrouter", { code: "auth-code-1" });

    const result = await resultPromise;

    expect(result).toEqual({ ok: true });
    expect(updateSettings).toHaveBeenCalledWith({
      provider: "openai-compat",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-v1-abc",
      detectModel: "deepseek/deepseek-v4-flash",
      summaryModel: "deepseek/deepseek-v4-pro",
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invokeCalls.map((c) => c.cmd)).toEqual(["oauth_loopback_start", "oauth_loopback_cancel"]);
    // exchangeCodeForKeyDirect POSTs through the injected tauriFetch, never global fetch.
    expect(tauriFetch).toHaveBeenCalledTimes(1);
  });

  // Field-test fix (v0.4.4, real user report): the bug itself — a
  // never-touched-since-install user (still on the pre-fix bare
  // Anthropic defaults) connects OpenRouter, then their very first
  // detect/summary call 400s ("claude-haiku-4-5 is not a valid model
  // ID") because nothing remapped the model. RED against the pre-fix
  // code (which wrote only provider/baseUrl/apiKey): this exact
  // assertion — detectModel/summaryModel present in the updateSettings
  // call — would have failed before openrouterModelDefaults.ts existed.
  it("field-test fix: a bare pre-fix detectModel/summaryModel gets remapped to the DeepSeek OpenRouter defaults alongside the key", async () => {
    const { deps, emit, openUrl, updateSettings } = makeDeps({
      currentModels: { detectModel: "claude-haiku-4-5", summaryModel: "claude-sonnet-5" },
    });

    const resultPromise = connectOpenRouterDesktopWith(deps);
    await flushUntil(() => openUrl.mock.calls.length > 0);
    emit("oauth://openrouter", { code: "auth-code-1" });
    await resultPromise;

    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        detectModel: "deepseek/deepseek-v4-flash",
        summaryModel: "deepseek/deepseek-v4-pro",
      }),
    );
  });

  it("never clobbers a user's own already-slash-shaped OpenRouter model (deliberate custom slug)", async () => {
    const { deps, emit, openUrl, updateSettings } = makeDeps({
      currentModels: { detectModel: "openai/gpt-5.4", summaryModel: "anthropic/claude-opus-4.8" },
    });

    const resultPromise = connectOpenRouterDesktopWith(deps);
    await flushUntil(() => openUrl.mock.calls.length > 0);
    emit("oauth://openrouter", { code: "auth-code-1" });
    await resultPromise;

    const call = updateSettings.mock.calls[0][0];
    expect(call).not.toHaveProperty("detectModel");
    expect(call).not.toHaveProperty("summaryModel");
  });

  it("reads getSettings at the moment the exchange succeeds, not at connect-click time (a slow round-trip must see the LATEST models)", async () => {
    // Mutable, not a mockReturnValueOnce sequence — getSettings is only
    // ever CALLED once in the real flow (right at exchange-success), so
    // a call-count-based mock would never actually exercise "reads
    // late, not early"; a variable that changes AFTER connect-click but
    // BEFORE the code arrives does.
    let currentModels: Pick<Settings, "detectModel" | "summaryModel"> = {
      detectModel: "claude-haiku-4-5",
      summaryModel: "claude-sonnet-5",
    };
    const { deps, emit, openUrl, updateSettings } = makeDeps();
    deps.getSettings = () => currentModels;

    const resultPromise = connectOpenRouterDesktopWith(deps);
    await flushUntil(() => openUrl.mock.calls.length > 0);
    // Between opening the browser and the code arriving, detectModel
    // was already fixed some OTHER way (e.g. a #56 domain override
    // save) — still bare-defaulted at connect-click time, current now.
    currentModels = { detectModel: "openai/gpt-5.4", summaryModel: "claude-sonnet-5" };
    emit("oauth://openrouter", { code: "auth-code-1" });
    await resultPromise;

    // detectModel already slash-shaped BY THE TIME OF SUCCESS -> left
    // alone; summaryModel still bare -> remapped. A snapshot-at-click
    // implementation would have wrongly remapped detectModel too (it
    // was bare at click time).
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ summaryModel: "deepseek/deepseek-v4-pro" }),
    );
    const call = updateSettings.mock.calls[0][0];
    expect(call).not.toHaveProperty("detectModel");
  });

  it("subscribes listen() BEFORE calling openUrl() (pinned ordering)", async () => {
    const { deps, openUrl, emit } = makeDeps();
    const order: string[] = [];
    const originalListen = deps.listen;
    deps.listen = (async (...args: Parameters<ListenFn>) => {
      order.push("listen");
      return originalListen(...(args as [string, (event: TauriEvent<unknown>) => void]));
    }) as ListenFn;
    openUrl.mockImplementation(async () => {
      order.push("openUrl");
    });

    const resultPromise = connectOpenRouterDesktopWith(deps);
    await flushUntil(() => order.includes("openUrl"));
    expect(order).toEqual(["listen", "openUrl"]);

    emit("oauth://openrouter", { error: "access_denied" });
    await resultPromise;
  });

  it("builds callback_url from the real bound port and the same ns sent to oauth_loopback_start, over 127.0.0.1 — F13: ns is a PATH segment, not a ?ns= query param", async () => {
    const { deps, invokeCalls, openUrl, emit } = makeDeps();

    const resultPromise = connectOpenRouterDesktopWith(deps);
    await flushUntil(() => openUrl.mock.calls.length > 0);

    const startCall = invokeCalls.find((c) => c.cmd === "oauth_loopback_start");
    const ns = startCall?.args?.ns as string;
    expect(ns).toBeTruthy();

    const authUrl = new URL(openUrl.mock.calls[0][0]);
    const callbackUrl = authUrl.searchParams.get("callback_url");
    // F13 (MEDIUM, reviewer 3): the old `?ns=${ns}` query-param shape
    // silently bet on OpenRouter's redirect PRESERVING an arbitrary
    // query string on callback_url when appending its own `?code=` —
    // undocumented behavior; a PATH segment carries no such risk (a
    // redirect never rewrites the callback_url's path).
    expect(callbackUrl).toBe(`http://127.0.0.1:${PORT}/oauth/openrouter/${ns}`);
    expect(new URL(callbackUrl!).search).toBe(""); // no query string at all — see oauth.rs's own parse_callback
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();

    emit("oauth://openrouter", { code: "x" });
    await resultPromise;
  });
});

describe("connectOpenRouterDesktopWith — failure mapping", () => {
  it("oauth_loopback_start rejecting maps to port-bind-failed, never subscribes or opens a url", async () => {
    const { invoke } = makeFakeInvoke({
      oauth_loopback_start: () => {
        throw new Error("address in use");
      },
    });
    const { listen, unlisten } = makeFakeListen();
    const openUrl = vi.fn<OpenExternalFn>();
    const deps: ConnectOpenRouterDesktopDeps = {
      invoke,
      listen,
      openUrl,
      tauriFetch: vi.fn() as unknown as TauriFetchFn,
      updateSettings: vi.fn(),
      // These failure-mapping/timeout/cancel paths never reach the
      // updateSettings write at all (asserted below), so getSettings'
      // own return value is irrelevant — already-slash-shaped so it's
      // an obvious no-op if a future refactor ever DID reach it.
      getSettings: () => ({ detectModel: "openai/gpt-5.4", summaryModel: "anthropic/claude-opus-4.8" }),
    };

    const result = await connectOpenRouterDesktopWith(deps);

    expect(result).toEqual({ ok: false, reason: "port-bind-failed", message: "address in use" });
    expect(openUrl).not.toHaveBeenCalled();
    expect(unlisten).not.toHaveBeenCalled(); // never subscribed in the first place
  });

  it("an {error} payload other than \"timeout\" maps to exchange-failed, carrying the upstream message", async () => {
    const { deps, emit, openUrl, updateSettings } = makeDeps();

    const resultPromise = connectOpenRouterDesktopWith(deps);
    await flushUntil(() => openUrl.mock.calls.length > 0);
    emit("oauth://openrouter", { error: "access_denied" });

    const result = await resultPromise;
    expect(result).toEqual({ ok: false, reason: "exchange-failed", message: "access_denied" });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("an {error:\"timeout\"} payload (oauth.rs's own ~300s deadline) maps to reason timeout", async () => {
    const { deps, emit, openUrl } = makeDeps();

    const resultPromise = connectOpenRouterDesktopWith(deps);
    await flushUntil(() => openUrl.mock.calls.length > 0);
    emit("oauth://openrouter", { error: "timeout" });

    const result = await resultPromise;
    expect(result).toEqual({ ok: false, reason: "timeout", message: "timeout" });
  });

  it("exchangeCodeForKeyDirect failing (non-2xx from EXCHANGE_URL) maps to exchange-failed, settings never written", async () => {
    const tauriFetch = vi.fn().mockResolvedValue(jsonResponse({ error: "invalid code" }, 400)) as unknown as TauriFetchFn;
    const { deps, emit, openUrl, updateSettings } = makeDeps({ tauriFetch });

    const resultPromise = connectOpenRouterDesktopWith(deps);
    await flushUntil(() => openUrl.mock.calls.length > 0);
    emit("oauth://openrouter", { code: "auth-code-1" });

    const result = await resultPromise;
    expect(result).toEqual({ ok: false, reason: "exchange-failed", message: "invalid code" });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("listen() itself rejecting maps to exchange-failed", async () => {
    const listen: ListenFn = (async () => {
      throw new Error("ipc unavailable");
    }) as ListenFn;
    const { invoke } = makeFakeInvoke({
      oauth_loopback_start: () => PORT,
      oauth_loopback_cancel: () => undefined,
    });
    const deps: ConnectOpenRouterDesktopDeps = {
      invoke,
      listen,
      openUrl: vi.fn<OpenExternalFn>(),
      tauriFetch: vi.fn() as unknown as TauriFetchFn,
      updateSettings: vi.fn(),
      // These failure-mapping/timeout/cancel paths never reach the
      // updateSettings write at all (asserted below), so getSettings'
      // own return value is irrelevant — already-slash-shaped so it's
      // an obvious no-op if a future refactor ever DID reach it.
      getSettings: () => ({ detectModel: "openai/gpt-5.4", summaryModel: "anthropic/claude-opus-4.8" }),
    };

    const result = await connectOpenRouterDesktopWith(deps);
    expect(result).toEqual({ ok: false, reason: "exchange-failed", message: "ipc unavailable" });
  });

  it("openUrl() itself rejecting maps to exchange-failed and still unlistens/cancels", async () => {
    const { deps, unlisten, invokeCalls } = makeDeps();
    deps.openUrl = vi.fn<OpenExternalFn>().mockRejectedValue(new Error("capability scope denied"));

    const result = await connectOpenRouterDesktopWith(deps);

    expect(result).toEqual({ ok: false, reason: "exchange-failed", message: "capability scope denied" });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invokeCalls.map((c) => c.cmd)).toContain("oauth_loopback_cancel");
  });
});

describe("connectOpenRouterDesktopWith — settle is a single-fire latch", () => {
  it("a second event after settling is ignored (no double exchange, no double updateSettings)", async () => {
    const { deps, emit, openUrl, tauriFetch, updateSettings } = makeDeps();

    const resultPromise = connectOpenRouterDesktopWith(deps);
    await flushUntil(() => openUrl.mock.calls.length > 0);
    emit("oauth://openrouter", { code: "auth-code-1" });
    await resultPromise;

    emit("oauth://openrouter", { code: "auth-code-2" }); // late/duplicate — must be a no-op
    await Promise.resolve();

    expect(tauriFetch).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });
});

describe("connectOpenRouterDesktopWith — single-flight", () => {
  it("a second call while one is still in flight is rejected as cancelled, and never touches its own deps", async () => {
    const first = makeDeps();
    const second = makeDeps();

    const p1 = connectOpenRouterDesktopWith(first.deps); // synchronously claims the in-flight latch
    const result2 = await connectOpenRouterDesktopWith(second.deps);

    expect(result2).toEqual({ ok: false, reason: "cancelled" });
    expect(second.invokeCalls).toHaveLength(0);
    expect(second.openUrl).not.toHaveBeenCalled();

    // Settle the first attempt too so its own real setTimeout doesn't
    // leak past this test.
    await flushUntil(() => first.openUrl.mock.calls.length > 0);
    first.emit("oauth://openrouter", { error: "cancelled-by-test" });
    await p1;
  });

  it("the latch is released once the in-flight call settles, so a later call is not spuriously cancelled", async () => {
    const first = makeDeps();
    const p1 = connectOpenRouterDesktopWith(first.deps);
    await flushUntil(() => first.openUrl.mock.calls.length > 0);
    first.emit("oauth://openrouter", { code: "auth-code-1" });
    await p1;

    const second = makeDeps();
    const resultPromise = connectOpenRouterDesktopWith(second.deps);
    await flushUntil(() => second.openUrl.mock.calls.length > 0);
    second.emit("oauth://openrouter", { code: "auth-code-2" });
    const result2 = await resultPromise;

    expect(result2).toEqual({ ok: true });
  });
});

describe("connectOpenRouterDesktopWith — JS-side ~180s timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("settles ok:false reason:timeout if nothing ever arrives, and cleans up", async () => {
    const { deps, unlisten, invokeCalls, openUrl } = makeDeps();

    const resultPromise = connectOpenRouterDesktopWith(deps);
    await flushUntilFake(() => openUrl.mock.calls.length > 0);

    await vi.advanceTimersByTimeAsync(180_000);
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invokeCalls.map((c) => c.cmd)).toContain("oauth_loopback_cancel");
  });

  // F3 (HIGH, adversarial review): once the timeout settles the
  // promise, the detached async continuation must not go on to invoke
  // a side effect as if the attempt were still alive.
  it("timeout firing before oauth_loopback_start resolves -> openUrl is never called, even once the stale invoke later resolves", async () => {
    let resolvePort!: (port: number) => void;
    const portPromise = new Promise<number>((resolve) => {
      resolvePort = resolve;
    });
    const { invoke, calls: invokeCalls } = makeFakeInvoke({
      oauth_loopback_start: () => portPromise,
      oauth_loopback_cancel: () => undefined,
    });
    const { listen } = makeFakeListen();
    const openUrl = vi.fn<OpenExternalFn>().mockResolvedValue(undefined);
    const deps: ConnectOpenRouterDesktopDeps = {
      invoke,
      listen,
      openUrl,
      tauriFetch: vi.fn() as unknown as TauriFetchFn,
      updateSettings: vi.fn(),
      // These failure-mapping/timeout/cancel paths never reach the
      // updateSettings write at all (asserted below), so getSettings'
      // own return value is irrelevant — already-slash-shaped so it's
      // an obvious no-op if a future refactor ever DID reach it.
      getSettings: () => ({ detectModel: "openai/gpt-5.4", summaryModel: "anthropic/claude-opus-4.8" }),
    };

    const resultPromise = connectOpenRouterDesktopWith(deps);
    await flushUntilFake(() => invokeCalls.some((c) => c.cmd === "oauth_loopback_start"));

    await vi.advanceTimersByTimeAsync(180_000);
    const result = await resultPromise;
    expect(result).toEqual({ ok: false, reason: "timeout" });

    // The stale oauth_loopback_start call finally resolves — the
    // detached continuation must bail out instead of opening a
    // now-pointless system-browser window.
    resolvePort(PORT);
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("timeout firing while the code exchange is still in flight -> settings are never written", async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const tauriFetch = vi.fn().mockReturnValue(fetchPromise) as unknown as TauriFetchFn;
    const { deps, emit, openUrl, updateSettings } = makeDeps({ tauriFetch });

    const resultPromise = connectOpenRouterDesktopWith(deps);
    await flushUntilFake(() => openUrl.mock.calls.length > 0);
    emit("oauth://openrouter", { code: "auth-code-1" }); // kicks off exchangeCodeForKeyDirect, left pending

    await vi.advanceTimersByTimeAsync(180_000);
    const result = await resultPromise;
    expect(result).toEqual({ ok: false, reason: "timeout" });

    // The stale exchange finally "succeeds" — must never reach the
    // settings write this late.
    resolveFetch(jsonResponse({ key: "sk-or-v1-should-never-land" }));
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

describe("cancelOpenRouterConnect (F3/F4 export)", () => {
  it("settles the in-flight attempt as cancelled, never opens the browser, and fires the Rust cancel", async () => {
    let resolvePort!: (port: number) => void;
    const portPromise = new Promise<number>((resolve) => {
      resolvePort = resolve;
    });
    const { invoke, calls: invokeCalls } = makeFakeInvoke({
      oauth_loopback_start: () => portPromise,
      oauth_loopback_cancel: () => undefined,
    });
    const { listen } = makeFakeListen();
    const openUrl = vi.fn<OpenExternalFn>().mockResolvedValue(undefined);
    const deps: ConnectOpenRouterDesktopDeps = {
      invoke,
      listen,
      openUrl,
      tauriFetch: vi.fn() as unknown as TauriFetchFn,
      updateSettings: vi.fn(),
      // These failure-mapping/timeout/cancel paths never reach the
      // updateSettings write at all (asserted below), so getSettings'
      // own return value is irrelevant — already-slash-shaped so it's
      // an obvious no-op if a future refactor ever DID reach it.
      getSettings: () => ({ detectModel: "openai/gpt-5.4", summaryModel: "anthropic/claude-opus-4.8" }),
    };

    const resultPromise = connectOpenRouterDesktopWith(deps);
    await flushUntil(() => invokeCalls.some((c) => c.cmd === "oauth_loopback_start"));

    cancelOpenRouterConnect();
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, reason: "cancelled" });
    expect(openUrl).not.toHaveBeenCalled();
    expect(invokeCalls.map((c) => c.cmd)).toContain("oauth_loopback_cancel");

    // The stale oauth_loopback_start call resolving after the fact
    // must not resurrect the flow.
    resolvePort(PORT);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("is a harmless no-op when nothing is in flight", () => {
    expect(() => cancelOpenRouterConnect()).not.toThrow();
  });
});
