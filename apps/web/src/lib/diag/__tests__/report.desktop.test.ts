// buildFullDiagnosticReport's desktop-only log-tail appendix (beta-phase
// diagnostics audit item 1) — IS_DESKTOP genuinely TRUE. IS_DESKTOP is a
// module-scope import-time const (lib/platform/desktop.ts) — vi.mock
// affects this whole file, so this lives in its own file rather than a
// describe block inside report.test.ts, which needs the REAL (false)
// value for its own ambient (non-desktop) coverage — same split
// secret.desktop.test.ts/mlxCaps.desktop.test.ts already established for
// the identical constraint (see either pair's own header comment).

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../platform/desktop", () => ({ IS_DESKTOP: true }));

let currentReadAppLog: ((source: string, tailLines: number) => Promise<string>) | null = null;
// F3 fix coverage: lets a test simulate initDesktop() itself
// rejecting (desktop-bootstrap failure), separate from readAppLog
// rejecting on an already-live handle (covered above).
let initDesktopShouldReject = false;
vi.mock("../../desktop/bootstrap", () => ({
  initDesktop: async () => {
    if (initDesktopShouldReject) {
      throw new Error("simulated desktop bootstrap failure");
    }
    return {
      readAppLog: (source: string, tailLines: number) => {
        if (!currentReadAppLog) {
          throw new Error("report.desktop.test.ts: readAppLog called with no currentReadAppLog set");
        }
        return currentReadAppLog(source, tailLines);
      },
    };
  },
}));

import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import { buildDiagnosticReport, buildFullDiagnosticReport, copyDiagnosticReport } from "../report";

afterEach(() => {
  initDesktopShouldReject = false;
});

describe("buildFullDiagnosticReport — desktop log tails", () => {
  it("appends all three log tails as fenced sections when every source has content", async () => {
    currentReadAppLog = async (source) => `${source}-line1\n${source}-line2`;
    const text = await buildFullDiagnosticReport(DEFAULT_SETTINGS);
    expect(text).toContain("## whisper_server.log（最后 40 行）");
    expect(text).toContain("whisper_server.log-line1");
    expect(text).toContain("## audiocap.log（最后 40 行）");
    expect(text).toContain("## osspeech.log（最后 40 行）");
  });

  it("requests a 40-line tail for every source, in order", async () => {
    const requested: Array<{ source: string; tailLines: number }> = [];
    currentReadAppLog = async (source, tailLines) => {
      requested.push({ source, tailLines });
      return "x";
    };
    await buildFullDiagnosticReport(DEFAULT_SETTINGS);
    expect(requested).toEqual([
      { source: "whisper_server.log", tailLines: 40 },
      { source: "audiocap.log", tailLines: 40 },
      { source: "osspeech.log", tailLines: 40 },
    ]);
  });

  it("skips a missing (empty-string) source silently — no section rendered for it", async () => {
    currentReadAppLog = async (source) => (source === "audiocap.log" ? "" : `${source}-content`);
    const text = await buildFullDiagnosticReport(DEFAULT_SETTINGS);
    expect(text).not.toContain("audiocap.log（最后");
    expect(text).toContain("whisper_server.log（最后");
    expect(text).toContain("osspeech.log（最后");
  });

  it("skips a source whose read rejects, without failing the whole report", async () => {
    currentReadAppLog = async (source) => {
      if (source === "osspeech.log") throw new Error("simulated read failure");
      return `${source}-content`;
    };
    const text = await buildFullDiagnosticReport(DEFAULT_SETTINGS);
    expect(text).not.toContain("osspeech.log（最后");
    expect(text).toContain("whisper_server.log（最后");
    expect(text).toContain("audiocap.log（最后");
  });

  it("returns the base report unchanged when all three sources are empty — no trailing section at all", async () => {
    currentReadAppLog = async () => "";
    const base = buildDiagnosticReport(DEFAULT_SETTINGS);
    const text = await buildFullDiagnosticReport(DEFAULT_SETTINGS);
    expect(text).toBe(base);
  });

  it("F3 fix: degrades to the base report (no log sections) when initDesktop itself rejects", async () => {
    initDesktopShouldReject = true;
    const base = buildDiagnosticReport(DEFAULT_SETTINGS);
    await expect(buildFullDiagnosticReport(DEFAULT_SETTINGS)).resolves.toBe(base);
  });

  it("F3 fix: copyDiagnosticReport still resolves (never rejects) when initDesktop rejects", async () => {
    initDesktopShouldReject = true;
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText }, userAgent: "test-agent" });
    await expect(copyDiagnosticReport(DEFAULT_SETTINGS)).resolves.toBe(true);
    expect(writeText.mock.calls[0][0]).not.toContain("（最后 40 行）");
    vi.unstubAllGlobals();
  });
});
