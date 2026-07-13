// Renders the "历史记录" (history) section — S7 blueprint §2 decision C
// / §4: one row per saved LiteSession, each with 导出 Markdown/导出
// JSON/删除. Same vanilla-DOM convention as render.ts/renderLocked.ts:
// a pure function of its input, no module state, returns ONE detached
// root node the caller swaps in wholesale on every refresh (main.ts
// re-lists sessions after every save/delete and does
// `mount.replaceChildren(renderHistorySection(sessions, opts))`).
//
// Delete is an injected callback (`opts.onDelete`) — same convention
// render.ts's own save button uses (the ACTUAL storage write/refresh
// stays the caller's job, main.ts, mirroring how saveLookup lives in
// main.ts rather than render.ts). Export is the one deliberate
// exception (blueprint's own file-ownership note): building the
// Blob/object-URL/synthetic-<a>-click needs no injected dependency —
// sessionToMarkdown/sessionToJson/exportFilename are already pure — so
// this file owns that DOM download code directly, and is the ONLY
// place in the extension that does.

import { exportFilename, sessionToJson, sessionToMarkdown } from "../export/exportSession";
import type { LiteSession } from "../storage/history";

const EMPTY_HINT_TEXT = "还没有历史记录。聆听结束后会自动保存在这里。";

export interface RenderHistoryOptions {
  onDelete: (id: string) => void;
}

export function renderHistorySection(
  sessions: LiteSession[],
  opts: RenderHistoryOptions,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "js-history-section";

  const heading = document.createElement("h2");
  heading.className = "js-history-heading";
  heading.textContent = "历史记录";
  section.appendChild(heading);

  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "js-empty-hint";
    empty.textContent = EMPTY_HINT_TEXT;
    section.appendChild(empty);
    return section;
  }

  for (const session of sessions) {
    section.appendChild(renderHistoryRow(session, opts));
  }

  return section;
}

function renderHistoryRow(session: LiteSession, opts: RenderHistoryOptions): HTMLElement {
  const row = document.createElement("div");
  row.className = "js-history-row";

  const head = document.createElement("div");
  head.className = "js-history-row-head";

  const title = document.createElement("span");
  title.className = "js-history-row-title";
  title.textContent = session.title;

  const date = document.createElement("span");
  date.className = "js-history-row-date";
  date.textContent = new Date(session.startedAt).toLocaleString();

  head.append(title, date);

  const actions = document.createElement("div");
  actions.className = "js-row";
  actions.append(
    renderActionButton("导出 Markdown", () => downloadSession(session, "md")),
    renderActionButton("导出 JSON", () => downloadSession(session, "json")),
    renderActionButton("删除", () => opts.onDelete(session.id)),
  );

  row.append(head, actions);
  return row;
}

function renderActionButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "js-btn";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

/** Blob + a synthetic `<a download>` click — needs no `"downloads"`
 *  permission (blueprint §9). The object URL is revoked right after
 *  the click; the browser has already captured what it needs to start
 *  the download by then, same as apps/web's own export flow. */
function downloadSession(session: LiteSession, ext: "md" | "json"): void {
  const content = ext === "md" ? sessionToMarkdown(session) : sessionToJson(session);
  const type = ext === "md" ? "text/markdown" : "application/json";
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exportFilename(session, ext);
  anchor.click();
  URL.revokeObjectURL(url);
}
