"use client";

// v0.4 S4 chunk 3 (docs/design-explorations/s4-model-wizard-blueprint.md,
// decision A + chunk 3) — the shared model-picker table: one row per
// MODEL_CATALOG entry, radio semantics (exactly one selectable at a
// time), reused by both the first-run wizard's consent overlay
// (DesktopWizard.tsx) and Settings' 更换模型 flow (chunk 4, not built
// yet). Terminal design language matching DesktopWizard.tsx/
// SettingsDialog.tsx: border-edge/bg-panel2/text-mut, mono, 0px radius
// (no rounded-* class anywhere below). Controlled component (value +
// onChange) — this file owns no selection state of its own, same
// contract as ToggleSwitch.tsx.
//
// Row styling mirrors SettingsDialog.tsx's ENGINE_CARDS button-card
// idiom (border-act bg-panel3 when selected, border-edge otherwise);
// the 推荐 chip reuses that same file's border-lab-green/30 text-lab-
// green idiom verbatim.
//
// Keyboard: a real <button role="radio"> per row — a real browser
// already activates a <button> on Enter/Space via its own native
// default action, but jsdom doesn't simulate that (see ToggleSwitch.
// tsx's own header comment) — onKeyDown wires the SAME shared
// lib/a11y.ts helper every other custom control in this codebase uses
// (CardsPanel/HistoryDrawer/TaskTray/ToggleSwitch), not a new
// implementation.
//
// S12 (v0.4.4, docs/design-explorations/s12-mlx-blueprint.md, §C
// Gating F13 + worker A3, flipped live by worker B2 §C L1/§E) — three
// additive gating layers:
//   1. `available === false` entries are HIDDEN from the picker
//      entirely (never rendered as a row at all) — no catalog entry
//      reads that way today (worker B2's flip), but the layer stays
//      live for any future stub/prelude entry; this is the ONLY reason
//      the row-count/each-row tests below filter MODEL_CATALOG first,
//      instead of iterating it raw.
//   2. Any `mlxOnly` entry (parakeet-tdt-0.6b-v3, live in production
//      since B2's flip) is gated a SECOND way, against mlxCaps.ts's
//      fail-CLOSED probe: unsupported/errored → real `disabled` +
//      `aria-disabled` + a visible reason line; a probe ERROR
//      additionally grows a 重试 affordance (mlxGateFor below is the
//      one place both layers combine). Every non-mlxOnly row (every
//      OTHER shipped entry) is entirely unaffected — mlxGateFor is a
//      structural no-op for it, same "no-op for every other value"
//      shape as osspeechCaps.ts's own isOsSpeechFloorLocked.
//   3. S12b fix round FB10 (§F, product default — ON THE VETO LIST
//      §7.7) — the caller-opt-in `hideDefinitivelyUnsupported` prop: an
//      `mlxOnly` entry whose caps probe has DEFINITIVELY resolved
//      unsupported (never on "still loading" or a transient probe
//      ERROR — isDefinitivelyUnsupported below) is hidden the SAME way
//      layer 1 hides an `available:false` entry, when the caller passes
//      the prop (DesktopWizard.tsx does; SettingsDialog.tsx doesn't —
//      see ModelPickerProps' own doc comment for the discoverability
//      rationale). A structural no-op when the prop is omitted —
//      every pre-FB10 test/caller is byte-unaffected.
//
// S12a fix round (§D F7, LOW, both reviewers) — errored-vs-unsupported
// used to be INFERRED from mlxCaps.ts's cache-identity contract
// (comparing a settled probe against getMlxCapsSnapshot() by
// reference), which both reviewers flagged as race-sensitive under a
// refresh/probe overlap (fail-closed direction still held — it could
// only ever misclassify a SUCCESS as an error, never the reverse, but
// that's still a real UX bug: a spuriously-shown 重试 button on a
// genuinely-resolved answer). Fixed at the SOURCE instead: A2's pinned
// contract (§D F7) has probeMlxCaps()/refreshMlxCaps() return an
// EXPLICIT `{status: "ok" | "error", caps}` envelope — mlxGateFor/
// useMlxCaps below consume that status directly, no inference left.
import { useEffect, useState } from "react";
import { ArrowClockwise, WarningCircle } from "@phosphor-icons/react";
import { handleButtonKeyDown } from "@/lib/a11y";
import { MODEL_CATALOG, type ModelCatalogEntry } from "@/lib/desktop/modelCatalog";
import {
  getMlxCapsSnapshot,
  probeMlxCaps,
  refreshMlxCaps,
  subscribeMlxCaps,
  type MlxCapabilities,
} from "@/lib/desktop/mlxCaps";

export interface ModelPickerProps {
  value: string;
  onChange: (model: string) => void;
  /** S12b fix round FB10 (§F; product default — ON THE VETO LIST §7.7,
   *  kept cleanly reversible via this one prop rather than baked into
   *  the gating logic): when true, an `mlxOnly` entry whose caps probe
   *  has DEFINITIVELY resolved unsupported is hidden entirely (never
   *  rendered as a row), instead of shown disabled-with-reason. The
   *  first-run wizard (DesktopWizard.tsx) passes this — a brand-new
   *  user on hardware that can never run parakeet gets a clean catalog,
   *  not a dead row. Settings' own managed 更换模型 picker (SettingsDialog.
   *  tsx) omits it (defaults to the pre-FB10 behavior) — discoverability
   *  matters more there (a user troubleshooting, or who just upgraded
   *  hardware, should still see the row and why it's disabled). Never
   *  hides a row on a transient probe ERROR in EITHER surface — see
   *  isDefinitivelyUnsupported's own doc comment; that state always
   *  stays disabled + 重试, identically on both surfaces. */
  hideDefinitivelyUnsupported?: boolean;
}

// §C Gating F13's own fallback copy, verbatim — used whenever a
// definitively-unsupported probe result carries no `reason` of its own
// (mlxCaps.ts's pinned wire shape, §D F7: `reason: string | null`).
const MLX_UNSUPPORTED_REASON_FALLBACK = "需要 Apple 芯片（M 系列），macOS 14 或更高";

interface MlxGate {
  disabled: boolean;
  /** Visible reason line — null renders no reason chrome at all (the
   *  not-yet-resolved/non-mlxOnly cases). */
  reason: string | null;
  /** Only true on a genuine probe ERROR (fail-closed) — never on a
   *  DEFINITIVE unsupported result, where retrying can't change the
   *  answer. Sourced directly from A2's pinned `status` field (§D F7) —
   *  see mlxGateFor's own doc comment. */
  showRetry: boolean;
}

const MLX_SUPPORTED_GATE: MlxGate = { disabled: false, reason: null, showRetry: false };
const MLX_LOADING_GATE: MlxGate = { disabled: true, reason: null, showRetry: false };
const MLX_NOT_GATED: MlxGate = { disabled: false, reason: null, showRetry: false };

/** Combines an entry's own `mlxOnly` flag with the caller's current
 *  mlxCaps probe state into this row's gate. Structural no-op (never
 *  disabled) for every non-mlxOnly entry — every catalog entry shipped
 *  today.
 *
 *  §D F7 fix round: "errored" is now the EXPLICIT `status === "error"`
 *  A2's pinned probeMlxCaps()/refreshMlxCaps() contract hands back
 *  (`Promise<{status: "ok" | "error", caps: MlxCapabilities}>`) — no
 *  more inferring it from whether a resolution happened to get cached
 *  (the prior reference-identity heuristic both reviewers flagged as
 *  race-sensitive under a refresh/probe overlap). */
function mlxGateFor(entry: ModelCatalogEntry, resolved: MlxCapabilities | null, errored: boolean): MlxGate {
  if (!entry.mlxOnly) return MLX_NOT_GATED;
  if (errored) {
    return { disabled: true, reason: resolved?.reason || MLX_UNSUPPORTED_REASON_FALLBACK, showRetry: true };
  }
  if (resolved === null) return MLX_LOADING_GATE; // probe still in flight — fail-closed default
  if (!resolved.mlxSupported) {
    return { disabled: true, reason: resolved.reason || MLX_UNSUPPORTED_REASON_FALLBACK, showRetry: false };
  }
  return MLX_SUPPORTED_GATE;
}

/** True only when an `mlxOnly` entry's caps probe has DEFINITIVELY
 *  resolved unsupported — a real, settled answer, never "still loading"
 *  (`resolved === null`) and never a transient probe ERROR (`errored`)
 *  — mirrors mlxGateFor's own three-way split above exactly (this is
 *  precisely its third branch's own condition), kept as an independent
 *  function rather than read back off a computed `MlxGate` because
 *  MLX_LOADING_GATE and the definitively-unsupported gate share the
 *  same `{disabled:true, showRetry:false}` shape — only `reason`
 *  differs, too fragile a discriminator to reverse-engineer from.
 *  §F FB10's own hideDefinitivelyUnsupported policy (ModelPickerProps)
 *  is the one caller. */
function isDefinitivelyUnsupported(
  entry: ModelCatalogEntry,
  resolved: MlxCapabilities | null,
  errored: boolean,
): boolean {
  return entry.mlxOnly === true && !errored && resolved !== null && !resolved.mlxSupported;
}

/** Wires mlxCaps.ts's framework-agnostic probe/cache (getMlxCapsSnapshot/
 *  subscribeMlxCaps/probeMlxCaps/refreshMlxCaps) into local component
 *  state — that module deliberately owns no hook of its own (see its own
 *  header doc), mirroring how every OTHER caps module in this codebase
 *  (osspeechCaps.ts's useOsSpeechCaps) resolves-on-mount +
 *  subscribes-for-later-resolutions. `errored` is set straight from
 *  A2's pinned `{status, caps}` envelope on every settle (probe AND
 *  retry, §D F7) — see mlxGateFor's own doc comment. */
function useMlxCaps(): { resolved: MlxCapabilities | null; errored: boolean; retry: () => void } {
  const [resolved, setResolved] = useState<MlxCapabilities | null>(() => getMlxCapsSnapshot());
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribeMlxCaps(() => {
      if (cancelled) return;
      const snapshot = getMlxCapsSnapshot();
      if (snapshot) {
        setResolved(snapshot);
        setErrored(false);
      }
    });
    void probeMlxCaps().then(({ status, caps }) => {
      if (cancelled) return;
      setResolved(caps);
      setErrored(status === "error");
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const retry = () => {
    void refreshMlxCaps().then(({ status, caps }) => {
      setResolved(caps);
      setErrored(status === "error");
    });
  };

  return { resolved, errored, retry };
}

export default function ModelPicker({ value, onChange, hideDefinitivelyUnsupported }: ModelPickerProps) {
  const { resolved: mlxCaps, errored: mlxErrored, retry: retryMlxCaps } = useMlxCaps();
  // S12a (§C L1): worker B2's own flip point — an entry stays entirely
  // OFF the picker until its own `available` reads true (undefined reads
  // as available, matching modelCatalog.ts's own doc on every
  // pre-existing entry being left unannotated). §F FB10: the caller's
  // own hideDefinitivelyUnsupported policy is a SECOND, independent
  // reason a row can be filtered out here — see ModelPickerProps' own
  // doc comment and isDefinitivelyUnsupported above.
  const visibleEntries = MODEL_CATALOG.filter((entry) => {
    if (entry.available === false) return false;
    if (hideDefinitivelyUnsupported && isDefinitivelyUnsupported(entry, mlxCaps, mlxErrored)) return false;
    return true;
  });

  return (
    <div className="space-y-1">
      {/* v0.4.4 field-fix (finding 1 — real user report: "浏览器识别 —
         what is the actual used model?" / "should have more clear
         explanation that these are 本地大模型"): a Settings user or a
         wizard user landing here sees Whisper's several sizes AND
         parakeet listed side by side with no shared framing — this one
         line names the category (both families run ON-DEVICE) without
         touching any existing per-row label below. */}
      <p className="text-xs text-mut2">本地大模型，均在本机运行</p>
      <div
        role="radiogroup"
        aria-label="识别模型"
        data-testid="model-picker"
        className="space-y-1 border border-edge bg-panel2 p-1 font-mono"
      >
        {visibleEntries.map((entry) => {
          const selected = entry.id === value;
          const gate = mlxGateFor(entry, mlxCaps, mlxErrored);
          const select = () => {
            if (gate.disabled) return;
            onChange(entry.id);
          };
          return (
            <div key={entry.id} className="space-y-1">
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                aria-disabled={gate.disabled || undefined}
                disabled={gate.disabled}
                data-testid={`model-option-${entry.id}`}
                title={gate.reason ?? undefined}
                onClick={select}
                onKeyDown={(e) => handleButtonKeyDown(e, select)}
                className={`flex w-full items-center justify-between gap-3 border p-2.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  selected ? "border-act bg-panel3 text-fg" : "border-edge text-fg hover:bg-panel3"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{entry.id}</span>
                    <span className="text-xs text-mut">{entry.label}</span>
                    {entry.recommended && (
                      <span className="shrink-0 border border-lab-green/30 px-1.5 py-0 text-[10px] text-lab-green">
                        推荐
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs leading-[1.6] text-mut2">
                    {entry.macSpeedHint} · {entry.qualityHint}
                  </div>
                  {gate.reason && (
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-warn-soft">
                      <WarningCircle size={11} weight="fill" className="shrink-0" aria-hidden />
                      {gate.reason}
                    </div>
                  )}
                </div>
                <span className="shrink-0 text-xs text-mut">{entry.size}</span>
              </button>
              {gate.showRetry && (
                <button
                  type="button"
                  data-testid={`model-option-${entry.id}-retry`}
                  onClick={(e) => {
                    e.stopPropagation();
                    retryMlxCaps();
                  }}
                  className="btn-tactile ml-2.5 flex items-center gap-1 text-[11px] text-mut hover:text-fg"
                >
                  <ArrowClockwise size={11} weight="regular" aria-hidden />
                  重试
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
