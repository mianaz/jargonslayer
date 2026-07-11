import type { DetectResponse, DetectionSource } from "@jargonslayer/core/types";
import { learnKey } from "./store";
import type { LearnRecord } from "@jargonslayer/core/learn/types";

export function filterSuppressed(
  res: DetectResponse,
  source: DetectionSource,
  learnset: Record<string, LearnRecord>,
): DetectResponse {
  if (source === "custom") return res;

  return {
    expressions: res.expressions.filter((expr) => {
      const record = learnset[learnKey("expression", expr.expression)];
      return !record?.suppressed;
    }),
    terms: res.terms.filter((term) => {
      const record = learnset[learnKey("term", term.term)];
      return !record?.suppressed;
    }),
  };
}
