// Anti-drift guard for the deliberate TS/Python prompt duplication
// (v0.2.2 design doc Q6 open question #4 — see sidecar/agent_prompts.
// py's module docstring for why this is two copies rather than one
// shared resource: prompts.ts's buildDetectSystemPrompt/
// buildDefineSystemPrompt are template functions that splice zh/en
// text into a base string via string-anchor replacement
// (applyLangVariant), not a pure exported text constant — porting
// THAT machinery to Python for exactly two prompts would be more
// surface area than the duplication it avoids).
//
// This test calls both languages of both prompt builders on the TS
// side, shells out to the Python sidecar venv to call the mirrors in
// sidecar/agent_prompts.py, and asserts a whitespace-normalized
// equality — so a future edit to prompts.ts that forgets to update
// agent_prompts.py fails CI instead of silently letting the
// subscription-direct path's detect/define output quality drift away
// from the existing Next.js path's.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDefineSystemPrompt, buildDetectSystemPrompt } from "@jargonslayer/core/llm/prompts";

// #53 workspace extraction: sidecar/ stays at the repo root while this
// test file now lives 2 directories deeper (apps/web/ was inserted
// above src/) — 6 "../" from src/lib/agent/__tests__/ back through
// apps/web/ to the repo root, then into sidecar/.
const SIDECAR_DIR = path.resolve(__dirname, "../../../../../../sidecar");
// Prefer the sidecar's own pinned venv (matches CI/dev setup exactly);
// fall back to whatever `python3` is on PATH so this test can still
// run somewhere the venv wasn't provisioned (e.g. a fresh checkout
// that only ran `npm install`, not the sidecar's own setup) — the
// pure-stdlib agent_prompts.py module has no third-party dependency,
// so any Python 3 interpreter can import it.
const VENV_PYTHON = path.join(SIDECAR_DIR, ".venv", "bin", "python3");

function pythonInterpreter(): string {
  try {
    execFileSync(VENV_PYTHON, ["--version"], { stdio: "ignore" });
    return VENV_PYTHON;
  } catch {
    return "python3";
  }
}

/** Runs a small inline Python script that imports agent_prompts.py and
 *  prints the requested builder's output for `lang`, verbatim, on
 *  stdout. Kept to a single call per (builder, lang) pair (rather than
 *  one script printing all four) so a failure clearly names which
 *  specific combination diverged. */
function pythonPromptFor(builder: "detect" | "define", lang: "zh" | "en"): string {
  const fn = builder === "detect" ? "build_detect_system_prompt" : "build_define_system_prompt";
  const script = `import sys; sys.path.insert(0, ${JSON.stringify(SIDECAR_DIR)}); import agent_prompts; sys.stdout.write(agent_prompts.${fn}(${JSON.stringify(lang)}))`;
  return execFileSync(pythonInterpreter(), ["-c", script], { encoding: "utf-8" });
}

/** Whitespace-normalized comparison key: collapses all runs of
 *  whitespace (including newlines) to a single space and trims ends.
 *  The two copies are maintained as separate literal string sources
 *  (a TS template literal vs. a Python triple-quoted string) — trivial
 *  formatting differences (trailing newline handling, editor
 *  whitespace) are not the thing this test protects against; actual
 *  CONTENT drift is. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

describe("TS/Python detect+define prompt parity (anti-drift guard, v0.2.2 Q6)", () => {
  it("build_detect_system_prompt('zh') matches buildDetectSystemPrompt('zh') after whitespace normalization", () => {
    const ts = normalize(buildDetectSystemPrompt("zh"));
    const py = normalize(pythonPromptFor("detect", "zh"));
    expect(py).toBe(ts);
  });

  it("build_detect_system_prompt('en') matches buildDetectSystemPrompt('en') after whitespace normalization", () => {
    const ts = normalize(buildDetectSystemPrompt("en"));
    const py = normalize(pythonPromptFor("detect", "en"));
    expect(py).toBe(ts);
  });

  it("build_define_system_prompt('zh') matches buildDefineSystemPrompt('zh') after whitespace normalization", () => {
    const ts = normalize(buildDefineSystemPrompt("zh"));
    const py = normalize(pythonPromptFor("define", "zh"));
    expect(py).toBe(ts);
  });

  it("build_define_system_prompt('en') matches buildDefineSystemPrompt('en') after whitespace normalization", () => {
    const ts = normalize(buildDefineSystemPrompt("en"));
    const py = normalize(pythonPromptFor("define", "en"));
    expect(py).toBe(ts);
  });
});
