"use client";

// v0.5 Wave-1 Feature 1 (per-segment speaker assignment, docs/design-
// explorations/v05-wave1-blueprint.md §1 Feature 1 + §5 A2): a single
// popover component covers BOTH the per-segment chip/"+ 说话人" flow
// (one segment) and the selection-mode bulk-assign flow (many segments)
// — `request.segmentIds` is a one-element array for the single case, so
// assignSegmentsSpeaker's own bulk contract (store.ts) covers both
// without a second code path. The single-segment-only extras
// (应用到本句及之后 / 跟随识别 / 重命名该说话人的所有发言) are gated on
// `request.single` being present — omitted entirely for a bulk request.
// Same viewport-clamp / outside-click / Escape pattern as
// TranscriptPanel.tsx's existing SpeakerRenamePopover.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApp } from "../lib/store";

const POPOVER_WIDTH = 240; // w-60 — fits well inside a 390px mobile viewport
const POPOVER_MAX_HEIGHT = 340;
const VIEWPORT_MARGIN = 8;

export interface SpeakerAssignRequest {
  segmentIds: string[];
  // Present only for a single-segment request (a chip click / "+ 说话人"
  // affordance) — gates the following/unlock/rename-all extras, which
  // don't make sense for a bulk (selection-mode) assign.
  single?: {
    currentSpeaker?: string;
    speakerLocked: boolean;
    // ITEM 7b fix (fix round, Opus sub-bar, lead-accepted): 跟随识别
    // (unlock) only makes sense when there's an sttSpeaker to fall back
    // TO — unlockSpeakerInSegments (store.ts) falls back to the
    // segment's own unchanged `speaker` when sttSpeaker is absent
    // ("nothing to follow back to", that function's own doc comment) —
    // an unlock in that case just clears the lock and hides this latch
    // mid-meeting without changing anything visible. Optional/falsy-
    // default so an older/bulk single object still compiles and simply
    // never shows the button, same posture speakerLocked's sibling
    // fields already have.
    hasSttSpeaker?: boolean;
  };
  x: number;
  y: number;
}

export default function SpeakerAssignPopover({
  request,
  onClose,
  onRenameAll,
  onAssigned,
}: {
  request: SpeakerAssignRequest;
  onClose: () => void;
  // "重命名该说话人的所有发言" hands off to the EXISTING rename-all path
  // (TranscriptPanel's own SpeakerRenamePopover) rather than duplicating
  // it here.
  onRenameAll: (speaker: string, x: number, y: number) => void;
  // Fired after an actual assignment (assign/following/create) — NOT
  // after unlock/rename-all, which aren't "assignments". Selection-mode
  // bulk-assign uses this to exit select mode; omitted for the
  // per-segment chip flow (nothing to exit).
  onAssigned?: () => void;
}) {
  const speakerRoster = useApp((s) => s.speakerRoster);
  const segments = useApp((s) => s.segments);
  const assignSegmentsSpeaker = useApp((s) => s.assignSegmentsSpeaker);
  const assignSpeakerFollowing = useApp((s) => s.assignSpeakerFollowing);
  const addSpeakerToRoster = useApp((s) => s.addSpeakerToRoster);
  const unlockSegmentSpeaker = useApp((s) => s.unlockSegmentSpeaker);
  const showToast = useApp((s) => s.showToast);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // §5 A2: "union of manual roster + unique displayed segment
  // speakers" — covers diarized names even with an empty roster.
  const names: string[] = [];
  {
    const seen = new Set<string>();
    for (const n of speakerRoster) {
      if (!seen.has(n)) {
        seen.add(n);
        names.push(n);
      }
    }
    for (const s of segments) {
      if (s.speaker && !seen.has(s.speaker)) {
        seen.add(s.speaker);
        names.push(s.speaker);
      }
    }
  }

  useLayoutEffect(() => {
    const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - POPOVER_MAX_HEIGHT - VIEWPORT_MARGIN;
    setPos({
      left: Math.min(Math.max(VIEWPORT_MARGIN, request.x), Math.max(VIEWPORT_MARGIN, maxLeft)),
      top: Math.min(Math.max(VIEWPORT_MARGIN, request.y + 6), Math.max(VIEWPORT_MARGIN, maxTop)),
    });
  }, [request]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [onClose]);

  if (!pos) return null;

  const assignThis = (name: string) => {
    assignSegmentsSpeaker(request.segmentIds, name);
    onAssigned?.();
    onClose();
  };
  const assignFollowing = (name: string) => {
    if (request.segmentIds.length !== 1) return;
    assignSpeakerFollowing(request.segmentIds[0], name);
    onAssigned?.();
    onClose();
  };
  const createAndAssign = () => {
    const name = addSpeakerToRoster();
    assignSegmentsSpeaker(request.segmentIds, name);
    onAssigned?.();
    onClose();
  };
  const unlock = () => {
    if (request.segmentIds.length !== 1) return;
    unlockSegmentSpeaker(request.segmentIds[0]);
    showToast("已恢复跟随识别");
    onClose();
  };

  return (
    <div
      ref={ref}
      data-testid="speaker-assign-popover"
      className="fixed z-50 w-60 border border-edge bg-panel2 glassable p-2 shadow-xl"
      style={{ left: pos.left, top: pos.top, maxHeight: POPOVER_MAX_HEIGHT }}
    >
      <div className="scroll-thin max-h-48 space-y-1 overflow-y-auto">
        {names.length === 0 && (
          <div className="px-2 py-1.5 text-xs leading-[1.6] text-mut2">
            暂无说话人，先新建一个
          </div>
        )}
        {names.map((name) => (
          <div key={name} className="flex items-center gap-1">
            <button
              type="button"
              data-testid={`speaker-assign-pick-${name}`}
              onClick={() => assignThis(name)}
              className="btn-tactile min-h-10 flex-1 truncate border border-edge2 px-2 text-left text-sm text-fg hover:bg-panel3"
            >
              {name}
            </button>
            {request.single && (
              <button
                type="button"
                data-testid={`speaker-assign-following-${name}`}
                onClick={() => assignFollowing(name)}
                title="应用到本句及之后"
                aria-label={`应用到本句及之后：${name}`}
                className="btn-tactile flex h-10 w-10 shrink-0 items-center justify-center border border-edge2 text-mut hover:bg-panel3 hover:text-fg"
              >
                ↓
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        data-testid="speaker-assign-new"
        onClick={createAndAssign}
        className="btn-tactile mt-1 min-h-10 w-full border border-edge2 px-2 text-sm text-fg hover:bg-panel3"
      >
        + 新建说话人
      </button>
      {request.single?.speakerLocked && request.single?.hasSttSpeaker && (
        <button
          type="button"
          data-testid="speaker-assign-unlock"
          onClick={unlock}
          className="btn-tactile mt-1 min-h-10 w-full border border-edge2 px-2 text-sm text-mut hover:bg-panel3 hover:text-fg"
        >
          跟随识别
        </button>
      )}
      {request.single?.currentSpeaker && (
        <button
          type="button"
          data-testid="speaker-assign-rename-all"
          onClick={() => onRenameAll(request.single!.currentSpeaker!, request.x, request.y)}
          className="btn-tactile mt-1 min-h-10 w-full border border-edge2 px-2 text-sm text-mut hover:bg-panel3 hover:text-fg"
        >
          重命名该说话人的所有发言
        </button>
      )}
    </div>
  );
}
