// DOM-building helpers for the side panel. Deliberately plain
// document.createElement calls — no React/JSX (see the S6 report for
// the vanilla-vs-React decision and rationale). Each function below
// maps 1:1 to what would become a component if a later session moves
// this to React, which is the "keep it swappable" requirement: nothing
// here reaches into module-level state, everything is passed in and
// returned as a detached DOM node the caller appends.

import type { DetectedExpression, DetectedTerm, ExpressionCategory } from "@jargonslayer/core/types";

// Mirrors apps/web/src/components/CardsPanel.tsx's category labels/
// color convention (see panel.css's .js-card--* rules for the color
// side of this pairing).
const CATEGORY_LABEL: Record<ExpressionCategory, string> = {
  idiom: "习语",
  slang: "俚语",
  phrase: "短语",
  metaphor: "隐喻",
  indirect: "委婉语",
  other: "其他",
};

export interface SaveButtonOptions {
  saved: boolean;
  onSave: () => void;
}

export function renderExpressionCard(
  expr: DetectedExpression,
  opts: SaveButtonOptions,
): HTMLElement {
  const card = document.createElement("article");
  card.className = `js-card js-card--${expr.category}`;

  const head = document.createElement("div");
  head.className = "js-card-head";

  const headword = document.createElement("span");
  headword.className = "js-card-headword";
  headword.textContent = expr.expression;

  const badge = document.createElement("span");
  badge.className = "js-card-badge";
  badge.textContent = CATEGORY_LABEL[expr.category] ?? expr.category;

  head.append(headword, badge);

  const gloss = document.createElement("p");
  gloss.className = "js-card-gloss";
  gloss.textContent = expr.chinese_explanation;

  const sentence = document.createElement("blockquote");
  sentence.className = "js-card-sentence";
  sentence.textContent = expr.source_sentence;

  card.append(head, gloss, sentence, renderSaveButton(opts));
  return card;
}

export function renderTermCard(term: DetectedTerm, opts: SaveButtonOptions): HTMLElement {
  const card = document.createElement("article");
  card.className = "js-card js-card--term";

  const head = document.createElement("div");
  head.className = "js-card-head";

  const headword = document.createElement("span");
  headword.className = "js-card-headword";
  headword.textContent = term.term;

  const badge = document.createElement("span");
  badge.className = "js-card-badge";
  badge.textContent = term.type;

  head.append(headword, badge);

  const gloss = document.createElement("p");
  gloss.className = "js-card-gloss";
  gloss.textContent = term.gloss_zh;

  card.append(head, gloss, renderSaveButton(opts));
  return card;
}

function renderSaveButton(opts: SaveButtonOptions): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "js-save-btn";
  btn.textContent = opts.saved ? "已收藏 ✓" : "收藏";
  btn.disabled = opts.saved;
  btn.addEventListener("click", opts.onSave);
  return btn;
}

export function clearChildren(el: HTMLElement): void {
  el.replaceChildren();
}
