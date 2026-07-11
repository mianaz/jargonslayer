// #62 progressive disclosure — settingsSections.ts is the single
// source of truth SettingsDialog.tsx renders from; these tests only
// exercise that pure module (never render the 1800+ line dialog).

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings, type TaskLlmConfig } from "@jargonslayer/core/types";
import {
  isSectionVisible,
  SETTINGS_UI_LEVELS,
  shouldAutoPromoteToAdvanced,
} from "../settingsSections";

describe("SETTINGS_UI_LEVELS — level-tagging completeness", () => {
  // Every section/row SettingsDialog.tsx tags with data-ui-level, one
  // id each — this is the canonical list; a future section landing
  // without a tag (or an id typo'd/removed) fails this test rather
  // than silently rendering in the wrong mode.
  const EXPECTED_IDS = [
    "engine",
    "diarization",
    "aiDetectPreviewBanner",
    "aiDetectCredentials",
    "aiDetectAutoDetect",
    "aiDetectCore",
    "aiDetectConfidence",
    "aiDetectExplainLanguage",
    "aiDetectBilingual",
    "aiDetectProfile",
    "aiDetectPacks",
    "aiDetectPackSources",
    "taskLlm",
    "dataIntegration",
    "subscriptionDirect",
    "display",
  ].sort();

  it("covers exactly the expected section/row ids — nothing missing, nothing stray", () => {
    expect(Object.keys(SETTINGS_UI_LEVELS).sort()).toEqual(EXPECTED_IDS);
  });

  it("every id maps to a valid UiLevel", () => {
    for (const level of Object.values(SETTINGS_UI_LEVELS)) {
      expect(["simple", "advanced"]).toContain(level);
    }
  });

  it("simple-mode surface matches the plan's simple set (转录引擎 core, AI 检测 core, 显示)", () => {
    const simpleIds = Object.entries(SETTINGS_UI_LEVELS)
      .filter(([, level]) => level === "simple")
      .map(([id]) => id)
      .sort();
    expect(simpleIds).toEqual(
      [
        "engine",
        "display",
        "aiDetectPreviewBanner",
        "aiDetectAutoDetect",
        "aiDetectCore",
        "aiDetectExplainLanguage",
        "aiDetectBilingual",
        "aiDetectProfile",
      ].sort(),
    );
  });
});

describe("isSectionVisible — advanced is always a superset of simple", () => {
  it("a simple-tagged row is visible at both levels", () => {
    expect(isSectionVisible("simple", "simple")).toBe(true);
    expect(isSectionVisible("advanced", "simple")).toBe(true);
  });

  it("an advanced-tagged row is visible only at the advanced level", () => {
    expect(isSectionVisible("simple", "advanced")).toBe(false);
    expect(isSectionVisible("advanced", "advanced")).toBe(true);
  });
});

describe("shouldAutoPromoteToAdvanced — auto-promote predicate", () => {
  it("all-defaults stays simple", () => {
    expect(shouldAutoPromoteToAdvanced(DEFAULT_SETTINGS)).toBe(false);
  });

  // Table-driven: one advanced-only field deviating from its default
  // (holding everything else at default) must promote on its own.
  const DEVIATIONS: { name: string; patch: Partial<Settings> }[] = [
    { name: "provider", patch: { provider: "openai-compat" } },
    { name: "baseUrl", patch: { baseUrl: "https://api.deepseek.com" } },
    { name: "apiKey", patch: { apiKey: "sk-test" } },
    { name: "detectModel", patch: { detectModel: "claude-sonnet-5" } },
    { name: "summaryModel", patch: { summaryModel: "claude-opus-4-8" } },
    { name: "minConfidence", patch: { minConfidence: 0.75 } },
    { name: "autoExport", patch: { autoExport: true } },
    { name: "webhookUrl", patch: { webhookUrl: "https://example.com/hook" } },
    { name: "exportFrontmatter", patch: { exportFrontmatter: false } },
    { name: "enabledPacks", patch: { enabledPacks: ["core"] } },
    { name: "hfToken", patch: { hfToken: "hf_xxx" } },
    { name: "realtimeDiarize", patch: { realtimeDiarize: true } },
    { name: "subscriptionDirect", patch: { subscriptionDirect: true } },
    { name: "subscriptionProvider", patch: { subscriptionProvider: "chatgpt-sub" } },
    { name: "agentUrl", patch: { agentUrl: "http://127.0.0.1:9999" } },
    { name: "agentToken", patch: { agentToken: "tok123" } },
  ];

  it.each(DEVIATIONS)("$name deviating from default promotes to advanced", ({ patch }) => {
    expect(shouldAutoPromoteToAdvanced({ ...DEFAULT_SETTINGS, ...patch })).toBe(true);
  });

  it("an enabled taskLlm domain override promotes to advanced", () => {
    const taskLlm: Partial<Record<"translate" | "detect" | "summary", TaskLlmConfig>> = {
      detect: { enabled: true, model: "claude-sonnet-5" },
    };
    expect(shouldAutoPromoteToAdvanced({ ...DEFAULT_SETTINGS, taskLlm })).toBe(true);
  });

  it("a taskLlm entry present but enabled:false does NOT promote (inherits primary entirely)", () => {
    const taskLlm: Partial<Record<"translate" | "detect" | "summary", TaskLlmConfig>> = {
      detect: { enabled: false, model: "claude-sonnet-5" },
    };
    expect(shouldAutoPromoteToAdvanced({ ...DEFAULT_SETTINGS, taskLlm })).toBe(false);
  });

  // Simple-tagged fields are already visible in simple mode, so
  // deviating from their default must NOT force a promotion.
  const SIMPLE_FIELD_CHANGES: { name: string; patch: Partial<Settings> }[] = [
    { name: "engine", patch: { engine: "webspeech" } },
    { name: "micId", patch: { micId: "device-1" } },
    { name: "language", patch: { language: "en-GB" } },
    { name: "whisperUrl", patch: { whisperUrl: "ws://example:8765" } },
    { name: "autoDetect", patch: { autoDetect: false } },
    { name: "aiDetect", patch: { aiDetect: false } },
    { name: "explainLanguage", patch: { explainLanguage: "en" } },
    { name: "bilingualTranscript", patch: { bilingualTranscript: true } },
    { name: "profile.enabled", patch: { profile: { enabled: true, industry: "SaaS" } } },
    { name: "themeId", patch: { themeId: "clarity" } },
    { name: "fontSize", patch: { fontSize: "lg" } },
    { name: "transcriptScale", patch: { transcriptScale: "xl" } },
    { name: "transcriptLeading", patch: { transcriptLeading: "relaxed" } },
  ];

  it.each(SIMPLE_FIELD_CHANGES)("$name deviating does NOT promote (already simple-visible)", ({ patch }) => {
    expect(shouldAutoPromoteToAdvanced({ ...DEFAULT_SETTINGS, ...patch })).toBe(false);
  });

  it("multiple simultaneous deviations still just promote (no double-counting/crash)", () => {
    expect(
      shouldAutoPromoteToAdvanced({
        ...DEFAULT_SETTINGS,
        apiKey: "sk-test",
        webhookUrl: "https://example.com/hook",
        minConfidence: 0.75,
      }),
    ).toBe(true);
  });
});
