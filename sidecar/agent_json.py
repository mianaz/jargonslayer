"""Python port of src/lib/llm/anthropic.ts's extractJsonValue + the
OPENAI_COMPAT_JSON_REMINDER repair-retry contract, for the subscription-
direct agent server (agent_server.py). Kept a direct line-by-line mirror
of the TS implementation (same three tolerated real-world failure modes:
<think> preambles, ```json fences, bare top-level arrays) so the
subscription path and the existing Next.js /api/detect+/api/define path
produce byte-for-byte identical extraction behavior on the same raw
model text — divergence here would silently degrade JSON reliability
on only one of the two paths.

No pytest/third-party JSON schema lib dependency — see
test_agent_json.py for the plain-assert harness (mirrors
test_ingest_url.py/test_realtime_diar.py's existing style).
"""

from __future__ import annotations

import re
from typing import Any, Optional

# Mirrors anthropic.ts's THINK_BLOCK_RE / FENCED_CODE_RE exactly (same
# flags: case-insensitive, dot-matches-newline via [\s\S] in JS ==
# re.DOTALL's semantics for `.` in Python).
_THINK_BLOCK_RE = re.compile(r"<think(?:ing)?>.*?</think(?:ing)?>", re.IGNORECASE | re.DOTALL)
_FENCED_CODE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.IGNORECASE | re.DOTALL)


class BadOutputError(Exception):
    """Mirrors anthropic.ts's BadOutputError — raised for any JSON-
    extraction/parse failure so callers can map it to a 502 upstream
    error (see agent_server.py's error mapping)."""


def extract_json_value(text: str) -> str:
    """Direct port of extractJsonValue (anthropic.ts): strip <think>
    blocks, prefer a ```json fenced block if present, then balanced-
    scan from the first "{" or "[" (whichever comes first) tracking
    both brace/bracket depth and string/escape state. Raises
    BadOutputError on no JSON start found or an unclosed value —
    mirrors the TS function's two failure messages (translated to
    English here since this is an internal/log-facing exception, not
    a user-facing zh string like the HTTP error bodies elsewhere in
    this sidecar)."""
    without_think = _THINK_BLOCK_RE.sub("", text)

    fence_match = _FENCED_CODE_RE.search(without_think)
    candidate = fence_match.group(1) if fence_match else without_think

    brace_start = candidate.find("{")
    bracket_start = candidate.find("[")
    if brace_start == -1:
        start = bracket_start
    elif bracket_start == -1:
        start = brace_start
    else:
        start = min(brace_start, bracket_start)

    if start == -1:
        raise BadOutputError("no JSON found in model output")

    opener = candidate[start]
    closer = "}" if opener == "{" else "]"

    depth = 0
    in_string = False
    escaped = False

    for i in range(start, len(candidate)):
        ch = candidate[i]

        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
        elif ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return candidate[start : i + 1]

    raise BadOutputError("unclosed JSON value in model output")


def apply_array_key(parsed: Any, array_key: Optional[str]) -> Any:
    """Mirrors anthropic.ts's applyArrayKey: if `parsed` is a bare list
    and `array_key` is set, wrap it as {array_key: parsed} before
    schema validation — lets a model that (incorrectly, but commonly)
    returns a bare array still validate against an object schema."""
    if array_key and isinstance(parsed, list):
        return {array_key: parsed}
    return parsed


# Mirrors anthropic.ts's OPENAI_COMPAT_JSON_REMINDER verbatim (English
# text — this is a model-facing instruction, not a user-facing zh
# string, so keeping the exact same wording as the TS path is what
# matters, not translating it).
JSON_REMINDER = (
    "\n\nCRITICAL: Respond with ONLY a raw JSON value that matches the "
    "required shape. No markdown code fences, no <think> blocks, no "
    "commentary before or after."
)
