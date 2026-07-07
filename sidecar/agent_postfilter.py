"""Python port of src/app/api/detect/route.ts's postFilter — the anti-
hallucination + count-clamp pass applied to every detect result before
it reaches the client. Ported here (rather than shared) so the
subscription-direct path (agent_server.py) produces output of the same
quality as the existing Next.js /api/detect route: without this, the
subscription path would leak hallucinated "expression" spans that
don't actually appear in the analyzed text, and would skip the
MAX_EXPRESSIONS/MAX_TERMS clamp the Next path always applies.

See test_agent_postfilter.py for parity checks against the same
fixtures postFilter's TS behavior implies.
"""

from __future__ import annotations

from typing import Any

# Mirrors detect/route.ts's MAX_EXPRESSIONS/MAX_TERMS exactly.
MAX_EXPRESSIONS = 6
MAX_TERMS = 4


def clamp_confidence(n: Any) -> float:
    """Mirrors anthropic.ts's clampConfidence: non-finite -> 0,
    otherwise clamped to [0, 1]."""
    try:
        value = float(n)
    except (TypeError, ValueError):
        return 0.0
    if value != value or value in (float("inf"), float("-inf")):  # NaN check
        return 0.0
    return min(1.0, max(0.0, value))


def post_filter(res: dict[str, Any], new_text: str) -> dict[str, Any]:
    """Direct port of detect/route.ts's postFilter: drop any expression
    whose `expression` string doesn't actually appear (case-
    insensitively) in the analyzed text, clamp confidence, then clamp
    both lists to MAX_EXPRESSIONS/MAX_TERMS. `res` is the raw
    {"expressions": [...], "terms": [...]} dict already JSON-parsed
    from the model's output (schema-shape validation happens before
    this is called — see agent_server.py)."""
    haystack = new_text.lower()

    expressions = []
    for e in res.get("expressions", []):
        expression = e.get("expression", "")
        if not isinstance(expression, str) or expression.lower() not in haystack:
            continue
        expressions.append({**e, "confidence": clamp_confidence(e.get("confidence"))})
        if len(expressions) >= MAX_EXPRESSIONS:
            break

    terms = list(res.get("terms", []))[:MAX_TERMS]

    return {"expressions": expressions, "terms": terms}
