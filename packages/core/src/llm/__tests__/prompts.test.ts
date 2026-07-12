import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DETECT_SYSTEM_PROMPT,
  DEFINE_SYSTEM_PROMPT,
  SWEEP_SYSTEM_PROMPT,
  buildDefineSystemPrompt,
  buildDefineUserMessage,
  buildDetectSystemPrompt,
  buildDetectUserMessage,
  buildSweepSystemPrompt,
  buildSweepUserMessage,
} from "../prompts";
import { renderProfileHint } from "../profileHint";
import type { Settings } from "../../types";

describe("buildDetectSystemPrompt", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('"zh" returns exactly DETECT_SYSTEM_PROMPT, unmodified', () => {
    expect(buildDetectSystemPrompt("zh")).toBe(DETECT_SYSTEM_PROMPT);
  });

  it('"en" differs from the zh base prompt', () => {
    expect(buildDetectSystemPrompt("en")).not.toBe(DETECT_SYSTEM_PROMPT);
  });

  it('"en" contains "simple everyday-English"', () => {
    expect(buildDetectSystemPrompt("en")).toContain("simple everyday-English");
  });

  it('"en" does NOT contain 自然的商务中文解释 (the zh-only anchor should have been spliced out)', () => {
    expect(buildDetectSystemPrompt("en")).not.toContain("自然的商务中文解释");
  });

  it("all splice anchors are found for both languages — console.warn is never called", () => {
    buildDetectSystemPrompt("zh");
    buildDetectSystemPrompt("en");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // Fix: "ai detection is catching whole sentences rather than
  // phrases" — the prompt-level half of the two-layer defense (the
  // scheduler.ts post-filter is the other). Both "zh" and "en" share
  // this rule verbatim (it isn't one of applyLangVariant's splice
  // anchors), so it must appear unchanged in both variants.
  it('rule 10 caps "expression" at a short phrase (word/char limits), never a full sentence, for both zh and en', () => {
    for (const lang of ["zh", "en"] as const) {
      const prompt = buildDetectSystemPrompt(lang);
      expect(prompt).toContain("short phrase, never a full clause or sentence");
      expect(prompt).toContain("~6 words");
      expect(prompt).toContain("~12 characters");
    }
  });
});

describe("buildDefineSystemPrompt", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('"zh" returns exactly DEFINE_SYSTEM_PROMPT', () => {
    expect(buildDefineSystemPrompt("zh")).toBe(DEFINE_SYSTEM_PROMPT);
  });

  it('"en" differs and contains "simple everyday-English"', () => {
    const en = buildDefineSystemPrompt("en");
    expect(en).not.toBe(DEFINE_SYSTEM_PROMPT);
    expect(en).toContain("simple everyday-English");
  });

  it('"en" does NOT contain 自然的商务中文解释', () => {
    expect(buildDefineSystemPrompt("en")).not.toContain("自然的商务中文解释");
  });

  it("anchors all found — console.warn not called", () => {
    buildDefineSystemPrompt("zh");
    buildDefineSystemPrompt("en");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("buildSweepSystemPrompt", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('"zh" returns exactly SWEEP_SYSTEM_PROMPT', () => {
    expect(buildSweepSystemPrompt("zh")).toBe(SWEEP_SYSTEM_PROMPT);
  });

  it('"en" differs and contains "simple everyday English" (sweep prompt phrasing)', () => {
    const en = buildSweepSystemPrompt("en");
    expect(en).not.toBe(SWEEP_SYSTEM_PROMPT);
    expect(en).toContain("simple everyday English");
  });

  it('"en" does NOT contain 自然商务中文', () => {
    expect(buildSweepSystemPrompt("en")).not.toContain("自然商务中文");
  });

  it("anchors all found — console.warn not called", () => {
    buildSweepSystemPrompt("zh");
    buildSweepSystemPrompt("en");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("buildDetectUserMessage", () => {
  it("formats context and newText into CONTEXT:/NEW: sections", () => {
    const msg = buildDetectUserMessage("previous transcript tail", "fresh new text");
    expect(msg).toBe("CONTEXT:\nprevious transcript tail\n\nNEW:\nfresh new text");
  });

  it("falls back to '(meeting just started)' when context is empty", () => {
    const msg = buildDetectUserMessage("", "fresh new text");
    expect(msg).toContain("(meeting just started)");
    expect(msg).toBe("CONTEXT:\n(meeting just started)\n\nNEW:\nfresh new text");
  });

  it("does not fall back when newText is empty (only context has a fallback)", () => {
    const msg = buildDetectUserMessage("some context", "");
    expect(msg).toBe("CONTEXT:\nsome context\n\nNEW:\n");
  });
});

describe("buildSweepUserMessage", () => {
  it("formats alreadyCaptured (joined) and transcript into sections", () => {
    const msg = buildSweepUserMessage("full transcript text", ["circle back", "ARR"]);
    expect(msg).toBe(
      "ALREADY_CAPTURED:\ncircle back, ARR\n\nTRANSCRIPT:\nfull transcript text",
    );
  });

  it("falls back to '(none)' when alreadyCaptured is empty", () => {
    const msg = buildSweepUserMessage("full transcript text", []);
    expect(msg).toContain("(none)");
    expect(msg).toBe("ALREADY_CAPTURED:\n(none)\n\nTRANSCRIPT:\nfull transcript text");
  });
});

describe("buildDefineUserMessage", () => {
  it("formats phrase and context into PHRASE:/CONTEXT: sections", () => {
    const msg = buildDefineUserMessage("circle back", "We should circle back later.");
    expect(msg).toBe("PHRASE:\ncircle back\n\nCONTEXT:\nWe should circle back later.");
  });

  it("falls back to '(none)' when context is empty", () => {
    const msg = buildDefineUserMessage("circle back", "");
    expect(msg).toBe("PHRASE:\ncircle back\n\nCONTEXT:\n(none)");
  });
});

// ---------------------------------------------------------------
// #48 step 3 — background-profile AUDIENCE splice. The design's core
// constraint: the SYSTEM prompt (server-built, prompt-cached) must
// stay BYTE-IDENTICAL with or without a profile hint — only the USER
// message may differ. This is the single most important test of the
// step (the cache guarantee the $-per-meeting cost model depends on).
// ---------------------------------------------------------------

describe("profile hint splice — system-prompt byte-identity (cache guarantee)", () => {
  it("buildDetectSystemPrompt('zh') is byte-identical whether or not a profile hint would be spliced into the user message", () => {
    const systemNoProfile = buildDetectSystemPrompt("zh");
    buildDetectUserMessage("ctx", "new text"); // no profile hint
    const systemWithProfile = buildDetectSystemPrompt("zh");
    buildDetectUserMessage("ctx", "new text", "行业：互联网；角色：产品经理"); // with hint
    expect(systemWithProfile).toBe(systemNoProfile);
  });

  it("buildDetectSystemPrompt('en') is likewise byte-identical regardless of a profile hint", () => {
    const systemNoProfile = buildDetectSystemPrompt("en");
    const systemWithProfile = buildDetectSystemPrompt("en");
    expect(systemWithProfile).toBe(systemNoProfile);
  });

  it("buildDefineSystemPrompt is byte-identical regardless of a profile hint", () => {
    expect(buildDefineSystemPrompt("zh")).toBe(buildDefineSystemPrompt("zh"));
    expect(buildDefineSystemPrompt("en")).toBe(buildDefineSystemPrompt("en"));
  });

  it("buildSweepSystemPrompt is byte-identical regardless of a profile hint", () => {
    expect(buildSweepSystemPrompt("zh")).toBe(buildSweepSystemPrompt("zh"));
    expect(buildSweepSystemPrompt("en")).toBe(buildSweepSystemPrompt("en"));
  });
});

// ---------------------------------------------------------------
// #48 s1 review item 10: the block above is tautological — calling
// e.g. buildDetectSystemPrompt("zh") twice with no input that could
// ever vary trivially returns the same string regardless of whether
// this feature works at all. This block instead builds the FULL
// request-level message pair (system + user) exactly as each API
// route does (detect/route.ts, define/route.ts, summarize/route.ts's
// runSweepStage) with profile enabled+set vs. disabled, and asserts:
// the SYSTEM string is byte-identical in both cases, and ONLY the
// USER message differs — the actual cache guarantee this whole
// design rests on.
// ---------------------------------------------------------------

describe("profile hint splice — REQUEST-level byte-identity (#48 s1 review item 10)", () => {
  const enabledProfile: Settings["profile"] = {
    enabled: true,
    industry: "互联网",
    role: "产品经理",
  };
  // Fields still populated but enabled:false (opt-out, not "empty") —
  // proves the byte-identity below isn't accidentally comparing two
  // hints that both happen to be empty.
  const disabledProfile: Settings["profile"] = {
    enabled: false,
    industry: "互联网",
    role: "产品经理",
  };

  function buildDetectRequest(profile: Settings["profile"], lang: "zh" | "en") {
    const hint = renderProfileHint(profile);
    return {
      system: buildDetectSystemPrompt(lang),
      user: buildDetectUserMessage("some transcript context", "some new text", hint),
    };
  }

  function buildDefineRequest(profile: Settings["profile"], lang: "zh" | "en") {
    const hint = renderProfileHint(profile);
    return {
      system: buildDefineSystemPrompt(lang),
      user: buildDefineUserMessage("circle back", "some context", hint),
    };
  }

  function buildSweepRequest(profile: Settings["profile"], lang: "zh" | "en") {
    const hint = renderProfileHint(profile);
    return {
      system: buildSweepSystemPrompt(lang),
      user: buildSweepUserMessage("full transcript", ["circle back"], hint),
    };
  }

  for (const lang of ["zh", "en"] as const) {
    it(`detect (${lang}): SYSTEM is byte-identical enabled vs. disabled; only USER differs`, () => {
      const withProfile = buildDetectRequest(enabledProfile, lang);
      const withoutProfile = buildDetectRequest(disabledProfile, lang);

      expect(withProfile.system).toBe(withoutProfile.system);
      expect(withProfile.user).not.toBe(withoutProfile.user);
      expect(withProfile.user).toContain("AUDIENCE:");
      expect(withoutProfile.user).not.toContain("AUDIENCE:");
    });

    it(`define (${lang}): SYSTEM is byte-identical enabled vs. disabled; only USER differs`, () => {
      const withProfile = buildDefineRequest(enabledProfile, lang);
      const withoutProfile = buildDefineRequest(disabledProfile, lang);

      expect(withProfile.system).toBe(withoutProfile.system);
      expect(withProfile.user).not.toBe(withoutProfile.user);
      expect(withProfile.user).toContain("AUDIENCE:");
      expect(withoutProfile.user).not.toContain("AUDIENCE:");
    });

    it(`summarize sweep stage (${lang}): SYSTEM is byte-identical enabled vs. disabled; only USER differs`, () => {
      const withProfile = buildSweepRequest(enabledProfile, lang);
      const withoutProfile = buildSweepRequest(disabledProfile, lang);

      expect(withProfile.system).toBe(withoutProfile.system);
      expect(withProfile.user).not.toBe(withoutProfile.user);
      expect(withProfile.user).toContain("AUDIENCE:");
      expect(withoutProfile.user).not.toContain("AUDIENCE:");
    });
  }

  it("a disabled profile with fields still populated (opt-out, not empty) sends no AUDIENCE line at all — proves the test above isn't accidentally comparing two empty hints", () => {
    const hint = renderProfileHint(disabledProfile);
    expect(hint).toBeUndefined();
    const msg = buildDetectUserMessage("ctx", "new text", hint);
    expect(msg).not.toContain("AUDIENCE:");
  });
});

describe("profile hint splice — USER message AUDIENCE: line", () => {
  it("buildDetectUserMessage: no hint -> no AUDIENCE line, output unchanged from pre-#48 shape", () => {
    const msg = buildDetectUserMessage("ctx", "new text");
    expect(msg).not.toContain("AUDIENCE:");
    expect(msg).toBe("CONTEXT:\nctx\n\nNEW:\nnew text");
  });

  it("buildDetectUserMessage: hint present -> prepends exactly one AUDIENCE: line before CONTEXT:", () => {
    const msg = buildDetectUserMessage("ctx", "new text", "行业：互联网");
    expect(msg).toBe("AUDIENCE:\n行业：互联网\n\nCONTEXT:\nctx\n\nNEW:\nnew text");
  });

  it("buildDetectUserMessage: empty-string hint is treated as absent (no AUDIENCE line)", () => {
    const msg = buildDetectUserMessage("ctx", "new text", "");
    expect(msg).not.toContain("AUDIENCE:");
  });

  it("buildDefineUserMessage: no hint -> unchanged from pre-#48 shape", () => {
    const msg = buildDefineUserMessage("circle back", "ctx");
    expect(msg).not.toContain("AUDIENCE:");
    expect(msg).toBe("PHRASE:\ncircle back\n\nCONTEXT:\nctx");
  });

  it("buildDefineUserMessage: hint present -> prepends AUDIENCE: line", () => {
    const msg = buildDefineUserMessage("circle back", "ctx", "角色：工程师");
    expect(msg).toBe("AUDIENCE:\n角色：工程师\n\nPHRASE:\ncircle back\n\nCONTEXT:\nctx");
  });

  it("buildSweepUserMessage: no hint -> unchanged from pre-#48 shape", () => {
    const msg = buildSweepUserMessage("transcript", ["circle back"]);
    expect(msg).not.toContain("AUDIENCE:");
    expect(msg).toBe("ALREADY_CAPTURED:\ncircle back\n\nTRANSCRIPT:\ntranscript");
  });

  it("buildSweepUserMessage: hint present -> prepends AUDIENCE: line", () => {
    const msg = buildSweepUserMessage("transcript", [], "英语水平：初级");
    expect(msg).toBe("AUDIENCE:\n英语水平：初级\n\nALREADY_CAPTURED:\n(none)\n\nTRANSCRIPT:\ntranscript");
  });
});
