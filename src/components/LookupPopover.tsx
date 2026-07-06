"use client";

// Selection-triggered explanation popover: user selects text in the
// transcript, this auto-runs detection (AI or dictionary) on it and
// feeds any hits into the shared session card stream.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { useApp } from "@/lib/store";
import { detectApi, NoKeyError } from "@/lib/llm/client";
import { scanDictionary } from "@/lib/detect/dictionary";
import type { DetectResponse, DetectionSource } from "@/lib/types";

const POPOVER_WIDTH = 320; // w-80
const POPOVER_MAX_HEIGHT = 384; // max-h-96
const VIEWPORT_MARGIN = 8;

export default function LookupPopover() {
  const lookup = useApp((s) => s.lookup);
  const setLookup = useApp((s) => s.setLookup);
  const settings = useApp((s) => s.settings);
  const applyDetection = useApp((s) => s.applyDetection);

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DetectResponse | null>(null);
  const [dictFallback, setDictFallback] = useState(false);

  // Run detection whenever a fresh lookup request comes in.
  useEffect(() => {
    if (!lookup) {
      setResult(null);
      setError(null);
      setDictFallback(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    setDictFallback(false);

    const run = async () => {
      const source: DetectionSource = settings.dictionaryOnly ? "dictionary" : "llm";
      try {
        let res: DetectResponse;
        if (settings.dictionaryOnly) {
          res = scanDictionary(lookup.text);
        } else {
          res = await detectApi(
            {
              context: lookup.contextText,
              new_text: lookup.text,
              model: settings.detectModel,
            },
            settings,
          );
        }
        if (cancelled) return;
        setResult(res);
        if (res.expressions.length > 0 || res.terms.length > 0) {
          applyDetection(res, source);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof NoKeyError) {
          const dictRes = scanDictionary(lookup.text);
          setResult(dictRes);
          setDictFallback(true);
          if (dictRes.expressions.length > 0 || dictRes.terms.length > 0) {
            applyDetection(dictRes, "dictionary");
          }
        } else {
          const message = err instanceof Error ? err.message : "查询失败";
          setError(message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
    // Re-run only when the lookup request identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookup]);

  // Clamp position to viewport.
  useLayoutEffect(() => {
    if (!lookup) {
      setPos(null);
      return;
    }
    const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - POPOVER_MAX_HEIGHT - VIEWPORT_MARGIN;
    const left = Math.min(Math.max(VIEWPORT_MARGIN, lookup.x), Math.max(VIEWPORT_MARGIN, maxLeft));
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, lookup.y + 8),
      Math.max(VIEWPORT_MARGIN, maxTop),
    );
    setPos({ left, top });
  }, [lookup]);

  // Escape key + outside mousedown close the popover.
  useEffect(() => {
    if (!lookup) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLookup(null);
    };
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setLookup(null);
      }
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [lookup, setLookup]);

  if (!lookup || !pos) return null;

  return (
    <div
      ref={ref}
      className="scroll-thin fixed z-50 max-h-96 w-80 overflow-auto rounded-xl border border-edge bg-panel2 p-3 shadow-xl"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-fg">{lookup.text}</span>
        <button
          type="button"
          onClick={() => setLookup(null)}
          aria-label="关闭"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-mut hover:bg-panel3 hover:text-fg"
        >
          <X size={14} weight="regular" />
        </button>
      </div>

      {dictFallback && (
        <span className="mt-1 inline-block rounded-full border border-gold/30 px-1.5 py-0 text-[10px] text-gold/80">
          词典
        </span>
      )}

      <div className="mt-2">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-mut">
            <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
            解释中…
          </div>
        )}

        {!loading && error && (
          <div className="text-xs text-warn">{error}</div>
        )}

        {!loading && !error && result && (
          <div className="space-y-2">
            {result.expressions.map((e, i) => (
              <div key={i} className="rounded-lg bg-panel p-2">
                <div className="font-medium text-fg">{e.expression}</div>
                <div className="mt-1 text-sm font-medium leading-[1.7] text-fg">
                  {e.chinese_explanation}
                </div>
                <div className="mt-1 text-xs text-mut">{e.plain_english}</div>
              </div>
            ))}
            {result.terms.map((t, i) => (
              <div key={i} className="rounded-lg bg-panel p-2">
                <div className="font-medium text-fg">{t.term}</div>
                <div className="mt-1 text-sm text-mut">{t.gloss_zh}</div>
              </div>
            ))}
            {result.expressions.length === 0 && result.terms.length === 0 && (
              <div className="text-xs text-mut">
                未检测到需要特别解释的表达
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
