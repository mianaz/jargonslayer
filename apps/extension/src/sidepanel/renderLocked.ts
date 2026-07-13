// Renders the "更多能力" locked-features section — S7 Decision D
// (blueprint §2D): visible-but-disabled rows naming where each
// capability unlocks, adapted from apps/web's `本地版功能` idiom
// (PreviewLockedBadge.tsx) to Lite's own unlock ladder (完整版/桌面版).
// Same vanilla-DOM convention as render.ts: a pure function of its
// input, no module state, returns a detached node the caller appends
// — nothing here queries the document or reaches into main.ts.
//
// Class reuse audit (S7 chunk 5 report has the full write-up): `.js-
// sub`, `.js-card`, `.js-card-head`, `.js-card-headword`, `.js-card-
// badge`, `.js-empty-hint` are EXISTING panel.css rules, reused as-is
// because they already match the wanted look (muted subtitle; a
// bordered card with a headword/badge head row where the badge lands
// on the right via `.js-card-head`'s space-between; muted one-line
// hint text for the description). `.js-locked-section`,
// `.js-locked-title`, `.js-locked-row` are NEW hook classes with no
// panel.css rule yet — they render unstyled (inherit body defaults)
// until the integration chunk (sole owner of panel.css) adds rules.

import { LOCKED_FEATURES, LOCKED_SECTION_SUBTITLE, LOCKED_SECTION_TITLE } from "../locked/lockedFeatures";
import type { LockedFeature } from "../locked/lockedFeatures";

export function renderLockedSection(features: LockedFeature[] = LOCKED_FEATURES): HTMLElement {
  const section = document.createElement("section");
  section.className = "js-locked-section";

  const title = document.createElement("h2");
  title.className = "js-locked-title";
  title.textContent = LOCKED_SECTION_TITLE;

  const subtitle = document.createElement("p");
  subtitle.className = "js-sub";
  subtitle.textContent = LOCKED_SECTION_SUBTITLE;

  section.append(title, subtitle);
  for (const feature of features) {
    section.appendChild(renderLockedRow(feature));
  }

  return section;
}

function renderLockedRow(feature: LockedFeature): HTMLElement {
  const row = document.createElement("div");
  row.className = "js-card js-locked-row";

  const head = document.createElement("div");
  head.className = "js-card-head";

  const headword = document.createElement("span");
  headword.className = "js-card-headword";
  headword.textContent = feature.title;

  const badge = document.createElement("span");
  badge.className = "js-card-badge";
  badge.textContent = feature.badge;

  head.append(headword, badge);

  const desc = document.createElement("p");
  desc.className = "js-empty-hint";
  desc.textContent = feature.desc;

  row.append(head, desc);
  return row;
}
