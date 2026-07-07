#!/usr/bin/env python3
"""Plain-assert self-test for agent_postfilter.py's Python port of
src/app/api/detect/route.ts's postFilter — no pytest, no network.
Mirrors test_ingest_url.py/test_realtime_diar.py's existing style.

Run:
    sidecar/.venv/bin/python sidecar/test_agent_postfilter.py

Covers the anti-hallucination + clamp behavior that must stay
identical to the Next.js /api/detect route's postFilter, so the
subscription-direct path never leaks hallucinated expressions or skips
the MAX_EXPRESSIONS/MAX_TERMS cap the existing path always applies.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_postfilter import (  # noqa: E402
    MAX_EXPRESSIONS,
    MAX_TERMS,
    clamp_confidence,
    post_filter,
)

FAILURES: list[str] = []
CHECK_COUNT = 0


def check(label: str, cond: bool) -> None:
    global CHECK_COUNT
    CHECK_COUNT += 1
    if not cond:
        FAILURES.append(label)
        print(f"FAIL: {label}")
    else:
        print(f"ok:   {label}")


def make_expr(expression: str, confidence: float = 0.8) -> dict:
    return {
        "expression": expression,
        "category": "idiom",
        "meaning": "m",
        "chinese_explanation": "z",
        "plain_english": "p",
        "tone": "t",
        "confidence": confidence,
        "source_sentence": expression,
    }


# =================================================================
# clamp_confidence
# =================================================================

check("clamp_confidence: a mid-range value passes through unchanged", clamp_confidence(0.5) == 0.5)
check("clamp_confidence: a value above 1 is clamped to 1", clamp_confidence(1.5) == 1.0)
check("clamp_confidence: a negative value is clamped to 0", clamp_confidence(-0.3) == 0.0)
check("clamp_confidence: exactly 0 stays 0", clamp_confidence(0) == 0.0)
check("clamp_confidence: exactly 1 stays 1", clamp_confidence(1) == 1.0)
check("clamp_confidence: NaN becomes 0", clamp_confidence(float("nan")) == 0.0)
check("clamp_confidence: +inf becomes 0", clamp_confidence(float("inf")) == 0.0)
check("clamp_confidence: a non-numeric value becomes 0", clamp_confidence("not a number") == 0.0)
check("clamp_confidence: None becomes 0", clamp_confidence(None) == 0.0)

# =================================================================
# post_filter: anti-hallucination — expression must appear in new_text
# =================================================================

result = post_filter(
    {"expressions": [make_expr("boil the ocean")], "terms": []},
    "We should not boil the ocean on this.",
)
check(
    "post_filter: an expression that DOES appear (case-sensitive match) in new_text is kept",
    len(result["expressions"]) == 1 and result["expressions"][0]["expression"] == "boil the ocean",
)

result = post_filter(
    {"expressions": [make_expr("this was never said")], "terms": []},
    "We should not boil the ocean on this.",
)
check(
    "post_filter: a hallucinated expression NOT present in new_text is dropped (anti-hallucination)",
    len(result["expressions"]) == 0,
)

result = post_filter(
    {"expressions": [make_expr("BOIL THE OCEAN")], "terms": []},
    "We should not boil the ocean on this.",
)
check(
    "post_filter: the match is case-insensitive (model's casing may differ from the transcript's)",
    len(result["expressions"]) == 1,
)

# =================================================================
# post_filter: confidence clamping
# =================================================================

result = post_filter(
    {"expressions": [make_expr("boil the ocean", confidence=5.0)], "terms": []},
    "let's boil the ocean",
)
check(
    "post_filter: confidence is clamped even for a kept expression",
    result["expressions"][0]["confidence"] == 1.0,
)

# =================================================================
# post_filter: MAX_EXPRESSIONS / MAX_TERMS clamping
# =================================================================

many_exprs = [make_expr(f"phrase{i}") for i in range(MAX_EXPRESSIONS + 5)]
haystack = " ".join(e["expression"] for e in many_exprs)
result = post_filter({"expressions": many_exprs, "terms": []}, haystack)
check(
    f"post_filter: expressions are clamped to MAX_EXPRESSIONS ({MAX_EXPRESSIONS})",
    len(result["expressions"]) == MAX_EXPRESSIONS,
)
check(
    "post_filter: the FIRST MAX_EXPRESSIONS filtered-in items are kept, in order",
    [e["expression"] for e in result["expressions"]]
    == [f"phrase{i}" for i in range(MAX_EXPRESSIONS)],
)

many_terms = [{"term": f"T{i}", "type": "acronym", "gloss_en": "g", "gloss_zh": "z"} for i in range(MAX_TERMS + 3)]
result = post_filter({"expressions": [], "terms": many_terms}, "irrelevant")
check(
    f"post_filter: terms are clamped to MAX_TERMS ({MAX_TERMS}) — terms have no anti-hallucination filter",
    len(result["terms"]) == MAX_TERMS,
)

# =================================================================
# post_filter: empty input
# =================================================================

result = post_filter({"expressions": [], "terms": []}, "some text")
check(
    "post_filter: empty expressions/terms in -> empty out",
    result == {"expressions": [], "terms": []},
)


# =================================================================
# summary
# =================================================================

print()
if FAILURES:
    print(f"{len(FAILURES)} of {CHECK_COUNT} check(s) FAILED:")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
else:
    print(f"all {CHECK_COUNT} checks passed")
    sys.exit(0)
