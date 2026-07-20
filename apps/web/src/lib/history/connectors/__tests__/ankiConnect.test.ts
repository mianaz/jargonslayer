import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Flashcard, MeetingSession } from "@jargonslayer/core/types";
import { buildAnkiTSV } from "../../export";

// Same in-memory idb-keyval mock as glossary.test.ts/autoExport.test.ts
// — ankiLedger is idb-keyval-backed, same guarded get/set convention.
const memStore = new Map<string, unknown>();

vi.mock("idb-keyval", () => ({
  get: vi.fn(async (key: string) => memStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    memStore.set(key, value);
  }),
}));

import {
  AnkiConnectApiError,
  AnkiIosUnsupportedError,
  AnkiInvokeTimeoutError,
  ankiInvoke,
  ankiLedger,
  buildAnkiNotePayload,
  deliverSessionNotes,
  flashcardFingerprint,
  testAndAuthorize,
  type AnkiDeliveryLedger,
} from "../ankiConnect";

// ---------------------------------------------------------------
// Fake-fetch helpers — a per-action router so multi-step flows
// (requestPermission -> version, canAddNotes -> addNotes) can be
// scripted per test without a plain sequential queue.
// ---------------------------------------------------------------

interface AnkiCall {
  action: string;
  version: number;
  params?: unknown;
}

function routedFetch(
  handlers: Record<string, (params: unknown) => { result?: unknown; error?: string | null }>,
  calls: AnkiCall[],
) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as AnkiCall;
    calls.push(body);
    const handler = handlers[body.action];
    if (!handler) throw new Error(`unmocked action: ${body.action}`);
    const out = handler(body.params);
    return { json: async () => ({ result: out.result ?? null, error: out.error ?? null }) } as Response;
  });
}

function makeCard(overrides: Partial<Flashcard> = {}): Flashcard {
  return {
    front: "circle back",
    back_zh: "回头再聊",
    back_en: "discuss again",
    example: "Let's circle back later.",
    tags: ["expression"],
    ...overrides,
  };
}

function makeSession(overrides: Partial<MeetingSession> = {}, flashcards: Flashcard[] = [makeCard()]): MeetingSession {
  return {
    id: "s1",
    title: "Weekly sync",
    startedAt: 1000,
    endedAt: 2000,
    engine: "demo",
    segments: [],
    cards: [],
    terms: [],
    summary: {
      summary: { topic: { en: "", zh: "" }, key_points: [], decisions: [], action_items: [] },
      translations: [],
      flashcards,
      generatedAt: 1500,
      model: "test-model",
    },
    ...overrides,
  };
}

function makeFakeLedger(): AnkiDeliveryLedger & { sentKeys: Set<string> } {
  const sentKeys = new Set<string>();
  return {
    sentKeys,
    async hasSent(sessionId, fingerprint) {
      return sentKeys.has(`${sessionId}::${fingerprint}`);
    },
    async markSent(sessionId, fingerprint) {
      sentKeys.add(`${sessionId}::${fingerprint}`);
    },
  };
}

beforeEach(() => {
  memStore.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = {} as never;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

describe("ankiInvoke", () => {
  it("POSTs {action, version: 6, params} and unwraps a successful result", async () => {
    const calls: AnkiCall[] = [];
    global.fetch = routedFetch({ deckNames: () => ({ result: ["Default"] }) }, calls) as unknown as typeof fetch;

    const result = await ankiInvoke<string[]>(8765, "deckNames", { foo: "bar" });

    expect(result).toEqual(["Default"]);
    expect(calls).toEqual([{ action: "deckNames", version: 6, params: { foo: "bar" } }]);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8765");
  });

  it("omits the params key entirely when no params are given (matches AnkiConnect's own no-params sample requests)", async () => {
    const calls: AnkiCall[] = [];
    global.fetch = routedFetch({ version: () => ({ result: 6 }) }, calls) as unknown as typeof fetch;

    await ankiInvoke(8765, "version");

    expect(calls[0]).toEqual({ action: "version", version: 6 });
    expect("params" in calls[0]).toBe(false);
  });

  it("throws AnkiConnectApiError with the envelope's error message when error is non-null", async () => {
    const calls: AnkiCall[] = [];
    global.fetch = routedFetch(
      { addNotes: () => ({ result: null, error: "model was not found: bogus" }) },
      calls,
    ) as unknown as typeof fetch;

    await expect(ankiInvoke(8765, "addNotes", { notes: [] })).rejects.toThrow(
      "model was not found: bogus",
    );
    await expect(ankiInvoke(8765, "addNotes", { notes: [] })).rejects.toBeInstanceOf(AnkiConnectApiError);
  });

  it("propagates a network-level fetch rejection (e.g. Anki not running) instead of swallowing it", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await expect(ankiInvoke(8765, "version")).rejects.toThrow("Failed to fetch");
  });
});

// M3 (Sol review 2026-07-20, v0.5 closeout): a hung round trip used to
// leave ankiInvoke's own returned promise pending forever — no timeout
// existed unless a caller explicitly passed one (only testAndAuthorize's
// own foreground probe did). A short custom timeoutMs here keeps this
// test fast while exercising the REAL mechanism (raceWithTimeout),
// unlike testAndAuthorize's own tests below, which simulate an already-
// fired timeout by throwing synchronously from the mock.
describe("ankiInvoke — round-trip timeout (M3)", () => {
  it("a hung round trip rejects with AnkiInvokeTimeoutError instead of hanging forever", async () => {
    global.fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;

    await expect(ankiInvoke(8765, "version", undefined, 20)).rejects.toBeInstanceOf(
      AnkiInvokeTimeoutError,
    );
  });
});

describe("ankiInvoke — iOS guard", () => {
  // IS_IOS is a module-scope import-time const — see
  // ankiConnect.ios.test.ts for the vi.mock'd-module coverage (this file
  // covers ambient/web behavior, where IS_IOS is false).
  it("is exported as a coded, named error class", () => {
    const err = new AnkiIosUnsupportedError();
    expect(err.name).toBe("AnkiIosUnsupportedError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("buildAnkiNotePayload — projection parity with buildAnkiTSV", () => {
  it("Front/Back match buildAnkiTSV's own front/back for the identical flashcard", () => {
    const card = makeCard();
    const note = buildAnkiNotePayload(card, "JargonSlayer");
    const [tsvFront, tsvBack] = buildAnkiTSV([card]).split("\t");

    expect(note.fields.Front).toBe(tsvFront);
    expect(note.fields.Back).toBe(tsvBack);
  });

  it("carries deckName, Basic model, allowDuplicate:false, and the jargonslayer tag", () => {
    const note = buildAnkiNotePayload(makeCard(), "我的牌组");
    expect(note.deckName).toBe("我的牌组");
    expect(note.modelName).toBe("Basic");
    expect(note.options).toEqual({ allowDuplicate: false });
    expect(note.tags).toEqual(["jargonslayer"]);
  });

  it("escapes tabs/newlines the same way buildAnkiTSV does (shared escapeAnkiField semantics)", () => {
    const card = makeCard({ front: "a\tb", back_zh: "第一行\n第二行" });
    const note = buildAnkiNotePayload(card, "Default");
    expect(note.fields.Front).toBe("a b");
    expect(note.fields.Back).toContain("第一行<br>第二行");
  });
});

describe("flashcardFingerprint", () => {
  it("is stable across repeated calls for identical content", () => {
    const note = buildAnkiNotePayload(makeCard(), "Default");
    expect(flashcardFingerprint(note)).toBe(flashcardFingerprint(note));
  });

  it("differs when the front or back content differs", () => {
    const a = buildAnkiNotePayload(makeCard(), "Default");
    const b = buildAnkiNotePayload(makeCard({ front: "different phrase" }), "Default");
    const c = buildAnkiNotePayload(makeCard({ back_zh: "不同的中文" }), "Default");
    expect(flashcardFingerprint(a)).not.toBe(flashcardFingerprint(b));
    expect(flashcardFingerprint(a)).not.toBe(flashcardFingerprint(c));
  });

  it("is independent of deckName (deck is not part of the note's content identity)", () => {
    const a = buildAnkiNotePayload(makeCard(), "Deck A");
    const b = buildAnkiNotePayload(makeCard(), "Deck B");
    expect(flashcardFingerprint(a)).toBe(flashcardFingerprint(b));
  });
});

describe("testAndAuthorize — outcome classification", () => {
  it("已连接: requestPermission granted, then version succeeds", async () => {
    const calls: AnkiCall[] = [];
    global.fetch = routedFetch(
      {
        requestPermission: () => ({ result: { permission: "granted", requireApiKey: false, version: 6 } }),
        version: () => ({ result: 6 }),
      },
      calls,
    ) as unknown as typeof fetch;

    const status = await testAndAuthorize(8765);
    expect(status).toEqual({ kind: "ok", label: "已连接" });
    expect(calls.map((c) => c.action)).toEqual(["requestPermission", "version"]);
  });

  it("未授权: requestPermission responds denied", async () => {
    const calls: AnkiCall[] = [];
    global.fetch = routedFetch(
      { requestPermission: () => ({ result: { permission: "denied" } }) },
      calls,
    ) as unknown as typeof fetch;

    const status = await testAndAuthorize(8765);
    expect(status.kind).toBe("denied");
    expect(status.label).toBe("未授权（请在 Anki 弹窗中允许）");
    // version must never be called once denied.
    expect(calls.map((c) => c.action)).toEqual(["requestPermission"]);
  });

  it("Anki 未运行或端口不通: a plain (non-abort) fetch rejection", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const status = await testAndAuthorize(8765);
    expect(status).toEqual({ kind: "unreachable", label: "Anki 未运行或端口不通" });
  });

  it("浏览器阻止了本地网络访问: the requestPermission call aborts via our own timeout", async () => {
    global.fetch = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;

    const status = await testAndAuthorize(8765);
    expect(status).toEqual({
      kind: "network-blocked",
      label: "浏览器阻止了本地网络访问（需在弹窗中允许）",
    });
  });

  it("unreachable when requestPermission succeeds (granted) but the follow-up version call fails", async () => {
    const calls: AnkiCall[] = [];
    global.fetch = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as AnkiCall;
      calls.push(body);
      if (body.action === "requestPermission") {
        return { json: async () => ({ result: { permission: "granted" }, error: null }) } as Response;
      }
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const status = await testAndAuthorize(8765);
    expect(status.kind).toBe("unreachable");
    expect(calls.map((c) => c.action)).toEqual(["requestPermission", "version"]);
  });
});

describe("deliverSessionNotes — payload delivery + ledger idempotency", () => {
  it("no-op (no network calls) when the session has no flashcards", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const ledger = makeFakeLedger();

    const result = await deliverSessionNotes(makeSession({}, []), { deckName: "JargonSlayer", port: 8765 }, ledger);

    expect(result).toEqual({ sent: 0, skipped: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("delivers unsent flashcards via canAddNotes pre-filter + addNotes, marking only successful indices sent", async () => {
    const cards = [makeCard({ front: "circle back" }), makeCard({ front: "touch base" })];
    const calls: AnkiCall[] = [];
    global.fetch = routedFetch(
      {
        canAddNotes: () => ({ result: [true, true] }),
        addNotes: () => ({ result: [111, 222] }),
      },
      calls,
    ) as unknown as typeof fetch;
    const ledger = makeFakeLedger();

    const result = await deliverSessionNotes(
      makeSession({}, cards),
      { deckName: "JargonSlayer", port: 8765 },
      ledger,
    );

    expect(result).toEqual({ sent: 2, skipped: 0 });
    expect(ledger.sentKeys.size).toBe(2);
    expect(calls.map((c) => c.action)).toEqual(["canAddNotes", "addNotes"]);
  });

  it("second delivery of the SAME session sends nothing further (ledger idempotency) — no network calls at all", async () => {
    const cards = [makeCard()];
    const calls: AnkiCall[] = [];
    global.fetch = routedFetch(
      { canAddNotes: () => ({ result: [true] }), addNotes: () => ({ result: [111] }) },
      calls,
    ) as unknown as typeof fetch;
    const ledger = makeFakeLedger();
    const cfg = { deckName: "JargonSlayer", port: 8765 };
    const session = makeSession({}, cards);

    const first = await deliverSessionNotes(session, cfg, ledger);
    expect(first).toEqual({ sent: 1, skipped: 0 });

    calls.length = 0;
    (global.fetch as ReturnType<typeof vi.fn>).mockClear();
    const second = await deliverSessionNotes(session, cfg, ledger);

    expect(second).toEqual({ sent: 0, skipped: 1 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("partial addNotes failure (one null result) marks ONLY the successful note sent — the failed one is retried next call", async () => {
    const cards = [makeCard({ front: "circle back" }), makeCard({ front: "touch base" })];
    const calls: AnkiCall[] = [];
    global.fetch = routedFetch(
      {
        canAddNotes: () => ({ result: [true, true] }),
        addNotes: () => ({ result: [111, null] }),
      },
      calls,
    ) as unknown as typeof fetch;
    const ledger = makeFakeLedger();
    const cfg = { deckName: "JargonSlayer", port: 8765 };
    const session = makeSession({}, cards);

    const result = await deliverSessionNotes(session, cfg, ledger);
    expect(result).toEqual({ sent: 1, skipped: 1 });
    expect(ledger.sentKeys.size).toBe(1);

    // A follow-up delivery re-attempts exactly the one that failed.
    calls.length = 0;
    const retryFetch = routedFetch(
      { canAddNotes: () => ({ result: [true] }), addNotes: () => ({ result: [333] }) },
      calls,
    );
    global.fetch = retryFetch as unknown as typeof fetch;
    const retry = await deliverSessionNotes(session, cfg, ledger);
    // total flashcards is still 2 ("circle back" from the first call
    // counts toward skipped again here, same accounting convention as
    // the "second delivery sends nothing" case above — skipped means
    // "not delivered BY THIS call", not "never delivered at all").
    expect(retry).toEqual({ sent: 1, skipped: 1 });
    const addNotesCall = calls.find((c) => c.action === "addNotes")!;
    expect((addNotesCall.params as { notes: Array<{ fields: { Front: string } }> }).notes).toHaveLength(1);
    expect((addNotesCall.params as { notes: Array<{ fields: { Front: string } }> }).notes[0].fields.Front).toBe(
      "touch base",
    );
  });

  it("canAddNotes:false pre-filters a note out of the addNotes call entirely (never marked sent)", async () => {
    const cards = [makeCard({ front: "circle back" }), makeCard({ front: "touch base" })];
    const calls: AnkiCall[] = [];
    global.fetch = routedFetch(
      {
        canAddNotes: () => ({ result: [true, false] }),
        addNotes: () => ({ result: [111] }),
      },
      calls,
    ) as unknown as typeof fetch;
    const ledger = makeFakeLedger();

    const result = await deliverSessionNotes(
      makeSession({}, cards),
      { deckName: "JargonSlayer", port: 8765 },
      ledger,
    );

    expect(result).toEqual({ sent: 1, skipped: 1 });
    const addNotesCall = calls.find((c) => c.action === "addNotes")!;
    expect((addNotesCall.params as { notes: unknown[] }).notes).toHaveLength(1);
  });

  it("canAddNotes itself failing falls back to sending the full unfiltered candidate set (auxiliary pre-filter, never the sole gate)", async () => {
    const cards = [makeCard()];
    const calls: AnkiCall[] = [];
    global.fetch = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as AnkiCall;
      calls.push(body);
      if (body.action === "canAddNotes") throw new TypeError("Failed to fetch");
      return { json: async () => ({ result: [111], error: null }) } as Response;
    }) as unknown as typeof fetch;
    const ledger = makeFakeLedger();

    const result = await deliverSessionNotes(
      makeSession({}, cards),
      { deckName: "JargonSlayer", port: 8765 },
      ledger,
    );

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(calls.map((c) => c.action)).toEqual(["canAddNotes", "addNotes"]);
  });

  it("addNotes failing entirely marks nothing sent and never throws", async () => {
    const cards = [makeCard()];
    global.fetch = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as AnkiCall;
      if (body.action === "canAddNotes") {
        return { json: async () => ({ result: [true], error: null }) } as Response;
      }
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const ledger = makeFakeLedger();

    await expect(
      deliverSessionNotes(makeSession({}, cards), { deckName: "JargonSlayer", port: 8765 }, ledger),
    ).resolves.toEqual({ sent: 0, skipped: 1 });
    expect(ledger.sentKeys.size).toBe(0);
  });
});

describe("deliverSessionNotes — per-session in-flight serialization", () => {
  it("two overlapping deliveries for the SAME session serialize — the second only starts once the first's ledger writes have landed, so addNotes is never sent twice", async () => {
    const cards = [makeCard()];
    const calls: AnkiCall[] = [];
    let releaseAddNotes: () => void = () => {};
    const addNotesStarted = new Promise<void>((resolveStarted) => {
      global.fetch = vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as AnkiCall;
        calls.push(body);
        if (body.action === "canAddNotes") {
          return { json: async () => ({ result: [true], error: null }) } as Response;
        }
        // addNotes hangs until the test releases it — this holds the
        // first delivery mid-flight (past its ledger.hasSent read, but
        // before its ledger.markSent write) so the second call is
        // issued into exactly the race window being closed.
        resolveStarted();
        await new Promise<void>((resolve) => {
          releaseAddNotes = resolve;
        });
        return { json: async () => ({ result: [111], error: null }) } as Response;
      }) as unknown as typeof fetch;
    });
    const ledger = makeFakeLedger();
    const cfg = { deckName: "JargonSlayer", port: 8765 };
    const session = makeSession({}, cards);

    const first = deliverSessionNotes(session, cfg, ledger);
    await addNotesStarted;
    const second = deliverSessionNotes(session, cfg, ledger);
    releaseAddNotes();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({ sent: 1, skipped: 0 });
    expect(secondResult).toEqual({ sent: 0, skipped: 1 });
    expect(calls.filter((c) => c.action === "addNotes")).toHaveLength(1);
    expect(ledger.sentKeys.size).toBe(1);
  });

  it("different sessions are NOT serialized against each other", async () => {
    const cardA = makeCard({ front: "circle back" });
    const cardB = makeCard({ front: "touch base" });
    let releaseAddNotesA: () => void = () => {};
    const addNotesAStarted = new Promise<void>((resolveStarted) => {
      global.fetch = vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as AnkiCall;
        if (body.action === "canAddNotes") {
          return { json: async () => ({ result: [true], error: null }) } as Response;
        }
        const notes = (body.params as { notes: Array<{ fields: { Front: string } }> }).notes;
        if (notes[0].fields.Front !== cardA.front) {
          return { json: async () => ({ result: [222], error: null }) } as Response;
        }
        // Only session "a"'s addNotes hangs — session "b" must resolve
        // without ever waiting on it.
        resolveStarted();
        await new Promise<void>((resolve) => {
          releaseAddNotesA = resolve;
        });
        return { json: async () => ({ result: [111], error: null }) } as Response;
      }) as unknown as typeof fetch;
    });
    const ledger = makeFakeLedger();
    const cfg = { deckName: "JargonSlayer", port: 8765 };

    const first = deliverSessionNotes(makeSession({ id: "session-a" }, [cardA]), cfg, ledger);
    await addNotesAStarted;
    const second = await deliverSessionNotes(makeSession({ id: "session-b" }, [cardB]), cfg, ledger);
    expect(second).toEqual({ sent: 1, skipped: 0 });

    releaseAddNotesA();
    expect(await first).toEqual({ sent: 1, skipped: 0 });
  });

  it("a REJECTED delivery does not poison the per-session chain — a later delivery for the same session still runs", async () => {
    const cards = [makeCard()];
    global.fetch = routedFetch(
      { canAddNotes: () => ({ result: [true] }), addNotes: () => ({ result: [111] }) },
      [],
    ) as unknown as typeof fetch;
    const realLedger = makeFakeLedger();
    let hasSentCalls = 0;
    // A ledger whose FIRST call rejects — violates AnkiDeliveryLedger's
    // own "must never throw" contract deliberately, to prove the
    // serialization queue survives a misbehaving/failed link rather than
    // wedging every later delivery for the session.
    const flakyLedger: AnkiDeliveryLedger = {
      async hasSent(sessionId, fingerprint) {
        hasSentCalls++;
        if (hasSentCalls === 1) throw new Error("ledger boom");
        return realLedger.hasSent(sessionId, fingerprint);
      },
      markSent: realLedger.markSent,
    };
    const cfg = { deckName: "JargonSlayer", port: 8765 };
    const session = makeSession({}, cards);

    await expect(deliverSessionNotes(session, cfg, flakyLedger)).rejects.toThrow("ledger boom");

    const second = await deliverSessionNotes(session, cfg, flakyLedger);
    expect(second).toEqual({ sent: 1, skipped: 0 });
    expect(realLedger.sentKeys.size).toBe(1);
  });
});

// M3 (Sol review 2026-07-20, v0.5 closeout): the chain above was
// UNBOUNDED — a hung ankiInvoke plus repeated post-stop re-saves grew a
// new link per call, each retaining a full session snapshot. At most
// ONE delivery may now be QUEUED (not yet running) per session at a
// time — a call arriving while one is already queued overwrites that
// queued snapshot instead of chaining another.
describe("deliverSessionNotes — bounded coalescing (M3)", () => {
  it("a hung first delivery + 3 rapid re-saves for the same session collapse into exactly ONE more delivery, using the LAST snapshot, once the hang resolves", async () => {
    const calls: AnkiCall[] = [];
    let addNotesCallCount = 0;
    let releaseAddNotes: () => void = () => {};
    const addNotesStarted = new Promise<void>((resolveStarted) => {
      global.fetch = vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as AnkiCall;
        calls.push(body);
        if (body.action === "canAddNotes") {
          const notes = (body.params as { notes: unknown[] }).notes;
          return { json: async () => ({ result: notes.map(() => true), error: null }) } as Response;
        }
        // addNotes: only the FIRST call (session-1's own) hangs — every
        // later (coalesced) call resolves immediately.
        addNotesCallCount++;
        if (addNotesCallCount === 1) {
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseAddNotes = resolve;
          });
        }
        const notes = (body.params as { notes: Array<{ fields: { Front: string } }> }).notes;
        return { json: async () => ({ result: notes.map((_, i) => 100 + i), error: null }) } as Response;
      }) as unknown as typeof fetch;
    });
    const ledger = makeFakeLedger();
    const cfg = { deckName: "JargonSlayer", port: 8765 };

    const first = deliverSessionNotes(makeSession({ id: "s1" }, [makeCard({ front: "call-1" })]), cfg, ledger);
    await addNotesStarted;

    // 3 rapid re-saves while the first is still hung — none of these
    // may add a second/third/fourth link to the chain.
    const second = deliverSessionNotes(makeSession({ id: "s1" }, [makeCard({ front: "call-2" })]), cfg, ledger);
    const third = deliverSessionNotes(makeSession({ id: "s1" }, [makeCard({ front: "call-3" })]), cfg, ledger);
    const fourth = deliverSessionNotes(makeSession({ id: "s1" }, [makeCard({ front: "call-4" })]), cfg, ledger);

    releaseAddNotes();
    const [firstResult, secondResult, thirdResult, fourthResult] = await Promise.all([
      first,
      second,
      third,
      fourth,
    ]);

    expect(firstResult).toEqual({ sent: 1, skipped: 0 });
    // The 3 coalesced callers all share the ONE delivery that actually ran.
    expect(secondResult).toEqual(fourthResult);
    expect(thirdResult).toEqual(fourthResult);
    expect(fourthResult).toEqual({ sent: 1, skipped: 0 });

    const addNotesCalls = calls.filter((c) => c.action === "addNotes");
    expect(addNotesCalls).toHaveLength(2); // call-1's own hung one + exactly ONE more
    const secondFronts = (
      addNotesCalls[1].params as { notes: Array<{ fields: { Front: string } }> }
    ).notes.map((n) => n.fields.Front);
    expect(secondFronts).toEqual(["call-4"]); // the LAST snapshot, not call-2/call-3
  });

  it("a first delivery whose addNotes round trip times out does not poison the per-session chain — a later delivery for the same session still runs", async () => {
    let addNotesCallCount = 0;
    global.fetch = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as AnkiCall;
      if (body.action === "canAddNotes") {
        const notes = (body.params as { notes: unknown[] }).notes;
        return { json: async () => ({ result: notes.map(() => true), error: null }) } as Response;
      }
      addNotesCallCount++;
      if (addNotesCallCount === 1) {
        // Simulates ankiInvoke's own round-trip timeout (M3, see the
        // "ankiInvoke — round-trip timeout" describe block above for
        // the real mechanism) actually firing during the first
        // delivery's addNotes call — this test is only about what
        // happens one level up, in deliverSessionNotes' own chain.
        throw new AnkiInvokeTimeoutError("addNotes", 30000);
      }
      const notes = (body.params as { notes: Array<{ fields: { Front: string } }> }).notes;
      return { json: async () => ({ result: notes.map((_, i) => 100 + i), error: null }) } as Response;
    }) as unknown as typeof fetch;
    const ledger = makeFakeLedger();
    const cfg = { deckName: "JargonSlayer", port: 8765 };

    const first = await deliverSessionNotes(makeSession({ id: "s1" }, [makeCard({ front: "call-1" })]), cfg, ledger);
    // fail-soft (module-wide posture, deliverSessionNotesImpl's own
    // addNotes try/catch): a timed-out addNotes never rejects
    // deliverSessionNotes itself.
    expect(first).toEqual({ sent: 0, skipped: 1 });

    const second = await deliverSessionNotes(makeSession({ id: "s1" }, [makeCard({ front: "call-2" })]), cfg, ledger);
    expect(second).toEqual({ sent: 1, skipped: 0 });
  });
});

describe("ankiLedger — the real IDB-backed implementation", () => {
  it("hasSent is false until markSent is called for that exact (sessionId, fingerprint) pair", async () => {
    expect(await ankiLedger.hasSent("s1", "fp-a")).toBe(false);
    await ankiLedger.markSent("s1", "fp-a");
    expect(await ankiLedger.hasSent("s1", "fp-a")).toBe(true);
    // A different session or a different fingerprint is unaffected.
    expect(await ankiLedger.hasSent("s2", "fp-a")).toBe(false);
    expect(await ankiLedger.hasSent("s1", "fp-b")).toBe(false);
  });

  it("markSent is idempotent — calling it twice does not throw and hasSent stays true", async () => {
    await ankiLedger.markSent("s1", "fp-a");
    await expect(ankiLedger.markSent("s1", "fp-a")).resolves.toBeUndefined();
    expect(await ankiLedger.hasSent("s1", "fp-a")).toBe(true);
  });

  it("degrades to false/no-op (never throws) when indexedDB is unavailable", async () => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    await expect(ankiLedger.markSent("s1", "fp-a")).resolves.toBeUndefined();
    await expect(ankiLedger.hasSent("s1", "fp-a")).resolves.toBe(false);
  });
});
