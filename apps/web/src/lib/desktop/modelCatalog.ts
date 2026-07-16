// v0.4 S4 chunk 3 (docs/design-explorations/s4-model-wizard-blueprint.md,
// decision A + chunk 3) — the shared Whisper model catalog: one entry
// per SELECTABLE model, consumed by both the first-run wizard's consent
// overlay (DesktopWizard.tsx's <ModelPicker>) and, later, Settings' 更换
// 模型 flow (chunk 4, not built yet — same <ModelPicker> component,
// different screen). tiny/base are deliberately EXCLUDED here — "too
// weak to recommend" (chunk 3's own task text) — even though
// provisionMachine.ts's ALLOWED_MARKER_MODELS still allows them (a
// manually-dropped-in CT2 dir, or an old marker predating this picker,
// per the manual-install escape hatch). See this module's own test file
// for the actual invariant: every id BELOW is a member of that
// allowlist (catalog ⊆ allowlist) — the converse (allowlist ⊆ catalog)
// is deliberately false; tiny/base being absent here is a curation
// choice, not a bug.
//
// Source: docs/PLAN-v0.4.md §2 "Model wizard" 4-model table (small/
// medium/large-v3/large-v3-turbo — "Handy ships 16 model families... we
// curate hard instead of cloning the menu"). Pure data, no JSX — lives
// in lib/desktop/ rather than components/desktop/, mirroring
// bootstrap.ts's own PROVISION_STEP_LABELS precedent: UI-facing copy
// that's still plain data belongs beside the machine/catalog it
// describes, not the component that renders it.

export interface ModelCatalogEntry {
  /** Matches provisionMachine.ts's ProvisionMarker.model / server.rs's
   *  ALLOWED_MODELS / whisper_server.py's --model choices verbatim —
   *  the exact string threaded through ctx.model into the
   *  prewarmModel/startServer effects and the written marker. */
  id: string;
  /** Wizard label — blueprint decision A's exact 4 labels. */
  label: string;
  /** Disk size on first download, one decimal GB — PLAN-v0.4.md §2's
   *  own 4-model table. */
  size: string;
  /** How it performs live on Apple Silicon (this app's primary desktop
   *  target) — condensed from PLAN-v0.4.md's "Live on Mac (CPU)"
   *  column into user-facing Chinese copy. */
  macSpeedHint: string;
  /** zh-en transcription quality — condensed from PLAN-v0.4.md's
   *  "zh-en quality" column. */
  qualityHint: string;
  /** true for exactly ONE entry (medium) — the honest zh-en default
   *  (blueprint decision A) — drives the picker's own 推荐 chip. */
  recommended: boolean;
  /** S12a (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
   *  R1) — true only for the parakeet entry: requires the separate,
   *  hash-locked MLX venv (uvCommands.ts's DesktopPaths mlx fields) and
   *  gates on mlxCaps.ts's mlx_capabilities() probe, unlike every other
   *  (whisper-family) entry here, which shares the one base venv and
   *  has no capability gate at all. Undefined/omitted reads as false —
   *  every existing entry below is left unannotated on purpose. */
  mlxOnly?: boolean;
  /** S12a prelude stub flag (§C L1): false while an entry exists in
   *  this catalog only to pin its shape but must NOT be selectable/
   *  offered yet. Worker B2 flips this true once the parakeet install +
   *  backend lane is verified end-to-end (§C, merge gates). Undefined/
   *  omitted reads as available — every existing (already-shippable)
   *  entry below is left unannotated on purpose; ModelPicker.tsx's own
   *  gating (worker A3) is what actually enforces this. */
  available?: boolean;
}

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: "small",
    label: "轻量·默认",
    size: "~0.46GB",
    macSpeedHint: "Mac 本机很快（约 5–10 倍实时）",
    qualityHint: "英文/清晰语音够用，中英混说容易漏细节",
    recommended: false,
  },
  {
    id: "medium",
    label: "均衡·推荐 (zh-en)",
    size: "~1.5GB",
    macSpeedHint: "Mac 本机流畅（约 2–3 倍实时）",
    qualityHint: "中英混说均衡，日常场景够用",
    recommended: true,
  },
  {
    id: "large-v3",
    label: "最高精度",
    size: "~1.6GB",
    macSpeedHint: "Mac 本机勉强跟上实时，更适合录音后上传处理",
    qualityHint: "中英混说识别最强，代码切换场景最佳",
    recommended: false,
  },
  {
    id: "large-v3-turbo",
    label: "快·精度高 (English-primary)",
    size: "~1.6GB",
    macSpeedHint: "比 large-v3 快约 4 倍，Mac 本机流畅",
    qualityHint: "英文场景精度高，中文稍弱于 large-v3",
    recommended: false,
  },
  // S12a (v0.4.4) stub — §C L1's prelude commit, §C Product/L3's opt-in
  // copy verbatim ("英文加速 · Apple 芯片 · 约 2.5 GB", NO 推荐 chip; zh
  // strings get a later 4.6 pass, not polished here). `available: false`
  // keeps this UNSELECTABLE/unoffered until worker B2 flips it once the
  // parakeet install + backend lane is verified end-to-end — see this
  // module's own ModelCatalogEntry doc above. Live repo size is 2.51 GB
  // (§C R1 F12) — displayed rounded, matching this catalog's own
  // one-decimal-GB convention elsewhere.
  {
    id: "parakeet-tdt-0.6b-v3",
    label: "英文加速 · Apple 芯片 · 约 2.5 GB",
    size: "~2.5GB",
    macSpeedHint: "仅 Apple 芯片（M 系列）可用，MLX 本机加速",
    qualityHint: "英文识别更快；中英混说效果待验证（M1 探针）",
    recommended: false,
    mlxOnly: true,
    available: false,
  },
] as const;

/** First-run wizard's pre-selected pick (blueprint decision A's veto
 *  window: medium — "the honest scenario default" — vs small — S3's
 *  own risk-1 reliability default). A standalone constant, NOT derived
 *  from MODEL_CATALOG's own `recommended` flag, so a veto ("pre-select
 *  small instead") is the one-line change the blueprint promises,
 *  without touching the 推荐 chip's own, separate meaning. */
export const WIZARD_PRESELECTED_MODEL = "medium";
