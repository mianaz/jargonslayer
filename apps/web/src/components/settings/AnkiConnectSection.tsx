"use client";

// AnkiConnect settings subcomponent (v0.5 Wave-1 Feature 9, docs/design-
// explorations/v05-wave1-blueprint.md §1 Feature 9 + §5 A8/A9). A
// self-contained, props-driven block per the blueprint's SettingsDialog
// contention rule (§2: "each lane delivers its section as a
// self-contained subcomponent... referenced by a SINGLE import + render
// line; the lead serializes those one-line insertions") — no store
// imports, value+onChange only, mirroring CredentialFields.tsx's own
// shape. Hidden entirely on iOS (there is no local Anki app to reach).
//
// INSERTION POINT for the lead: SettingsDialog.tsx's 数据与联动 section
// (activeCategory === "dataIntegration", around the existing Webhook URL
// block, :3275-3288) —
//   import AnkiConnectSection from "@/components/settings/AnkiConnectSection";
//   <AnkiConnectSection
//     value={draft.ankiConnect}
//     onChange={(patch) => patch({ ankiConnect: { ...draft.ankiConnect, ...patch } })}
//   />
// (name the outer patch() callback differently from this component's own
// `patch` prop to avoid shadowing — draftPatch/patchSettings, whatever
// SettingsDialog's own convention is elsewhere.)

import { useState } from "react";
import ToggleSwitch from "@/components/ToggleSwitch";
import { IS_IOS } from "@/lib/platform/ios";
import {
  testAndAuthorize,
  type AnkiAuthStatus,
  type AnkiAuthStatusKind,
} from "@/lib/history/connectors/ankiConnect";

export interface AnkiConnectSectionValue {
  enabled: boolean;
  deckName: string;
  port: number;
}

export interface AnkiConnectSectionProps {
  value: AnkiConnectSectionValue;
  onChange: (patch: Partial<AnkiConnectSectionValue>) => void;
}

const STATUS_CLASS: Record<AnkiAuthStatusKind, string> = {
  ok: "text-lab-green",
  unreachable: "text-mut2",
  "network-blocked": "text-warn-soft",
  denied: "text-warn-soft",
  "ios-unsupported": "text-mut2",
};

export default function AnkiConnectSection({ value, onChange }: AnkiConnectSectionProps) {
  const [status, setStatus] = useState<AnkiAuthStatus | null>(null);
  const [testing, setTesting] = useState(false);

  if (IS_IOS) return null;

  async function handleTest() {
    setTesting(true);
    try {
      setStatus(await testAndAuthorize(value.port));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-edge pt-3" data-testid="anki-connect-section">
      <div className="text-xs uppercase tracking-wide text-mut">AnkiConnect</div>

      <label className="flex items-center justify-between gap-3 py-1">
        <span className="text-sm text-fg">启用 AnkiConnect</span>
        <ToggleSwitch checked={value.enabled} onChange={(checked) => onChange({ enabled: checked })} />
      </label>

      <div>
        <label className="text-xs text-mut">目标 Anki 牌组</label>
        <input
          type="text"
          value={value.deckName}
          onChange={(e) => onChange({ deckName: e.target.value })}
          placeholder="JargonSlayer"
          className="mt-1 w-full border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg placeholder:text-mut2 focus:outline-none"
        />
      </div>

      <div>
        <label className="text-xs text-mut">AnkiConnect 端口</label>
        <input
          type="number"
          min={1}
          max={65535}
          step={1}
          value={value.port}
          onChange={(e) => {
            // Same guard as SettingsDialog's own 行话最大词数/最大字符数
            // numeric fields: only patch on a finite integer >= 1 — a
            // blank/0/negative value must never silently clobber a
            // working port with garbage.
            const n = Math.trunc(Number(e.target.value));
            if (Number.isFinite(n) && n >= 1) onChange({ port: n });
          }}
          className="mt-1 w-32 border border-edge bg-panel2 px-3 py-1.5 text-sm text-fg focus:outline-none"
        />
        <div className="mt-1 text-xs leading-[1.7] text-mut2">
          若同时使用本地 Whisper（默认同为 8765 端口），需在 Anki 的 AnkiConnect
          配置中改用其他端口，并在此同步修改
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={testing}
          className="btn-tactile border border-edge px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {testing ? "测试中…" : "测试并授权"}
        </button>
        {status && (
          <span className={`text-xs ${STATUS_CLASS[status.kind]}`}>
            {status.kind === "ok" ? "●" : "○"} {status.label}
          </span>
        )}
      </div>
    </div>
  );
}
