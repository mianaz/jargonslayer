// buildFullDiagnosticReport's desktop-only log-tail appendix (beta-phase
// diagnostics audit item 1) — IS_DESKTOP genuinely TRUE. IS_DESKTOP is a
// module-scope import-time const (lib/platform/desktop.ts) — vi.mock
// affects this whole file, so this lives in its own file rather than a
// describe block inside report.test.ts, which needs the REAL (false)
// value for its own ambient (non-desktop) coverage — same split
// secret.desktop.test.ts/mlxCaps.desktop.test.ts already established for
// the identical constraint (see either pair's own header comment).

import { describe, expect, it, vi } from "vitest";

vi.mock("../../platform/desktop", () => ({ IS_DESKTOP: true }));

let currentReadAppLog: ((source: string, tailLines: number) => Promise<string>) | null = null;
vi.mock("../../desktop/bootstrap", () => ({
  initDesktop: async () => ({
    readAppLog: (source: string, tailLines: number) => {
      if (!currentReadAppLog) {
        throw new Error("report.desktop.test.ts: readAppLog called with no currentReadAppLog set");
      }
      return currentReadAppLog(source, tailLines);
    },
  }),
}));

import { DEFAULT_SETTINGS } from "@jargonslayer/core/types";
import { buildDiagnosticReport, buildFullDiagnosticReport } from "../report";

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
});
