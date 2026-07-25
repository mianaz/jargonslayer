// Renders the "词典库" (dictionary packs) section — catalog browse +
// install, installed list + remove, 官方/已导入 provenance badge. Same
// vanilla-DOM convention as render.ts/renderHistory.ts/renderLocked.ts:
// a pure function of its input, no module state; main.ts owns every
// actual fetch/install/remove call and re-renders this section wholesale
// (mount.replaceChildren(renderPacksSection(state, opts))) after every
// state change, same as renderHistorySection's own convention.
//
// Deliberately NOT apps/web's SettingsDialog 词典库 tab ported wholesale
// (this app's own visual idiom is much simpler, per panel.css's header) —
// no per-pack license/tags/source metadata, no update-checking, no
// manual URL/file import; just browse -> install -> see it in the
// installed list -> remove.
//
// Reuses render.ts's existing .js-card/.js-card-head/.js-card-headword/
// .js-card-badge/.js-card-gloss/.js-save-btn hook classes as-is (a
// catalog row's install button is structurally the exact same
// click-once-then-disable affordance as a term/expression card's own
// 收藏 button) — only a handful of NEW hook classes are added for the
// section/group chrome itself (see panel.css).

import type { CatalogPackEntry } from "../storage/dictCatalog";
import type { RemotePackSource } from "../storage/remotePacks";

export type CatalogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; packs: CatalogPackEntry[] };

export interface PacksSectionState {
  catalog: CatalogState;
  installed: RemotePackSource[];
  installingId: string | null;
  installError: string | null;
  removingKey: string | null;
}

export interface PacksSectionOptions {
  onInstall: (entry: CatalogPackEntry) => void;
  onRemove: (source: RemotePackSource) => void;
  onRetryCatalog: () => void;
}

// Per this worker's own spec (requirement 2): the extension's storage
// does NOT share IndexedDB with the web app, so packs installed here
// are per-surface — said explicitly rather than implied.
const DISCLOSURE_TEXT = "词典包只安装在这个浏览器扩展本地，和网页版分开存储，不会互相同步。";

export function renderPacksSection(state: PacksSectionState, opts: PacksSectionOptions): HTMLElement {
  const section = document.createElement("section");
  section.className = "js-packs-section";

  const heading = document.createElement("h2");
  heading.className = "js-packs-heading";
  heading.textContent = "词典库";
  section.appendChild(heading);

  const disclosure = document.createElement("p");
  disclosure.className = "js-sub";
  disclosure.textContent = DISCLOSURE_TEXT;
  section.appendChild(disclosure);

  if (state.installError) {
    const err = document.createElement("p");
    err.className = "js-status js-packs-error";
    err.textContent = state.installError;
    section.appendChild(err);
  }

  section.appendChild(renderInstalledGroup(state, opts));
  section.appendChild(renderCatalogGroup(state, opts));

  return section;
}

function renderInstalledGroup(state: PacksSectionState, opts: PacksSectionOptions): HTMLElement {
  const group = document.createElement("div");
  group.className = "js-packs-group";

  const label = document.createElement("h3");
  label.className = "js-packs-subheading";
  label.textContent = `已安装（${state.installed.length}）`;
  group.appendChild(label);

  if (state.installed.length === 0) {
    const empty = document.createElement("p");
    empty.className = "js-empty-hint";
    empty.textContent = "还没有安装任何词典包 — 在下面的目录里挑一个试试。";
    group.appendChild(empty);
    return group;
  }

  for (const source of state.installed) {
    group.appendChild(renderInstalledRow(source, state, opts));
  }
  return group;
}

function renderInstalledRow(
  source: RemotePackSource,
  state: PacksSectionState,
  opts: PacksSectionOptions,
): HTMLElement {
  const row = document.createElement("article");
  row.className = "js-card";

  const head = document.createElement("div");
  head.className = "js-card-head";

  // <bdi> = a second, independent layer of defense against a bidi
  // control character reordering/hiding the badge next to it — the DOM
  // text itself is already stripped at validation time
  // (remotePacks.ts's clampDisplayStr), but this mirrors apps/web's own
  // belt-and-suspenders SettingsDialog rendering.
  const nameWrap = document.createElement("bdi");
  nameWrap.className = "js-card-headword";
  nameWrap.textContent = source.pack.name;

  const badge = document.createElement("span");
  badge.className =
    source.origin === "official" ? "js-card-badge js-badge-official" : "js-card-badge";
  badge.textContent = source.origin === "official" ? "官方" : "已导入";

  head.append(nameWrap, badge);
  row.appendChild(head);

  const meta = document.createElement("p");
  meta.className = "js-card-gloss";
  const count = source.pack.expressions.length + source.pack.terms.length;
  meta.textContent = `v${source.pack.version} · ${count} 条`;
  row.appendChild(meta);

  const key = source.url || source.pack.id;
  const removing = state.removingKey === key;
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "js-btn";
  removeBtn.textContent = removing ? "移除中…" : "移除";
  removeBtn.disabled = removing;
  removeBtn.addEventListener("click", () => opts.onRemove(source));
  row.appendChild(removeBtn);

  return row;
}

function renderCatalogGroup(state: PacksSectionState, opts: PacksSectionOptions): HTMLElement {
  const group = document.createElement("div");
  group.className = "js-packs-group";

  const head = document.createElement("div");
  head.className = "js-row";
  const label = document.createElement("h3");
  label.className = "js-packs-subheading";
  label.textContent = "目录";
  head.appendChild(label);

  if (state.catalog.status !== "loading") {
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "js-btn";
    retryBtn.textContent = "刷新目录";
    retryBtn.addEventListener("click", opts.onRetryCatalog);
    head.appendChild(retryBtn);
  }
  group.appendChild(head);

  if (state.catalog.status === "loading") {
    const loading = document.createElement("p");
    loading.className = "js-status";
    loading.textContent = "词典目录加载中…";
    group.appendChild(loading);
    return group;
  }

  if (state.catalog.status === "error") {
    const err = document.createElement("p");
    err.className = "js-status js-packs-error";
    err.textContent = state.catalog.message;
    group.appendChild(err);
    return group;
  }

  if (state.catalog.packs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "js-empty-hint";
    empty.textContent = "词典目录暂时是空的。";
    group.appendChild(empty);
    return group;
  }

  for (const entry of state.catalog.packs) {
    group.appendChild(renderCatalogRow(entry, state, opts));
  }
  return group;
}

function renderCatalogRow(
  entry: CatalogPackEntry,
  state: PacksSectionState,
  opts: PacksSectionOptions,
): HTMLElement {
  const row = document.createElement("article");
  row.className = "js-card";

  const head = document.createElement("div");
  head.className = "js-card-head";

  const nameWrap = document.createElement("bdi");
  nameWrap.className = "js-card-headword";
  nameWrap.textContent = entry.name;

  const countBadge = document.createElement("span");
  countBadge.className = "js-card-badge";
  countBadge.textContent = entry.entryCount != null ? `${entry.entryCount} 条` : `v${entry.version}`;

  head.append(nameWrap, countBadge);
  row.appendChild(head);

  if (entry.description) {
    const desc = document.createElement("p");
    desc.className = "js-card-gloss";
    desc.textContent = entry.description;
    row.appendChild(desc);
  }

  row.appendChild(renderInstallButton(entry, state, opts));
  return row;
}

function renderInstallButton(
  entry: CatalogPackEntry,
  state: PacksSectionState,
  opts: PacksSectionOptions,
): HTMLButtonElement {
  const alreadyInstalled = state.installed.some((s) => s.pack.id === entry.id);
  const installing = state.installingId === entry.id;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "js-save-btn";
  btn.textContent = alreadyInstalled ? "已安装 ✓" : installing ? "安装中…" : "安装";
  btn.disabled = alreadyInstalled || installing;
  btn.addEventListener("click", () => opts.onInstall(entry));
  return btn;
}
