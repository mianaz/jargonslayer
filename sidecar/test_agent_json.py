#!/usr/bin/env python3
"""Plain-assert self-test for agent_json.py's Python port of anthropic.
ts's extractJsonValue — no pytest, no network. Mirrors test_ingest_url.
py/test_realtime_diar.py's existing style/harness.

Run:
    sidecar/.venv/bin/python sidecar/test_agent_json.py

Covers the same three real-world failure modes extract_json_value must
tolerate (mirrors anthropic.ts's own test coverage for extractJsonValue):
  - a bare top-level array instead of an object
  - ```json ... ``` markdown fences around the payload
  - <think>...</think> reasoning preambles that may contain stray braces
  - apply_array_key wrapping
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_json import BadOutputError, apply_array_key, extract_json_value  # noqa: E402

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


# =================================================================
# extract_json_value: plain object / plain array
# =================================================================

check(
    "extract_json_value: a clean JSON object with no surrounding text",
    extract_json_value('{"ok": true}') == '{"ok": true}',
)
check(
    "extract_json_value: a clean bare JSON array",
    extract_json_value('[{"a": 1}, {"b": 2}]') == '[{"a": 1}, {"b": 2}]',
)
check(
    "extract_json_value: leading/trailing prose around an object is stripped",
    extract_json_value('Sure, here you go:\n{"ok": true}\nHope that helps!')
    == '{"ok": true}',
)
check(
    "extract_json_value: nested braces inside string values don't break depth tracking",
    extract_json_value('{"text": "a { b } c", "n": 1}')
    == '{"text": "a { b } c", "n": 1}',
)
check(
    "extract_json_value: escaped quotes inside a string don't end the string early",
    extract_json_value('{"text": "she said \\"hi\\""}')
    == '{"text": "she said \\"hi\\""}',
)

# =================================================================
# extract_json_value: ```json fenced blocks
# =================================================================

check(
    "extract_json_value: a ```json fenced object is extracted from the fence content",
    extract_json_value('```json\n{"ok": true}\n```') == '{"ok": true}',
)
check(
    "extract_json_value: a bare ``` fence (no 'json' language tag) still works",
    extract_json_value('```\n{"ok": true}\n```') == '{"ok": true}',
)
check(
    "extract_json_value: prose before/after a fenced block is ignored",
    extract_json_value('Here is the JSON:\n```json\n{"ok": true}\n```\nDone.')
    == '{"ok": true}',
)

# =================================================================
# extract_json_value: <think> preambles
# =================================================================

check(
    "extract_json_value: a <think> block before the JSON is stripped",
    extract_json_value('<think>Let me consider {this}.</think>{"ok": true}')
    == '{"ok": true}',
)
check(
    "extract_json_value: <thinking> (long form tag) is also stripped",
    extract_json_value('<thinking>reasoning here</thinking>{"ok": true}')
    == '{"ok": true}',
)
check(
    "extract_json_value: a <think> block containing stray braces doesn't confuse extraction",
    extract_json_value('<think>{"fake": "json in thinking"}</think>{"real": true}')
    == '{"real": true}',
)
check(
    "extract_json_value: <think> block combined with a ```json fence",
    extract_json_value('<think>hmm</think>```json\n{"ok": true}\n```')
    == '{"ok": true}',
)

# =================================================================
# extract_json_value: failure modes
# =================================================================


def _check_raises(label: str, fn) -> None:
    try:
        fn()
        check(label, False)
    except BadOutputError:
        check(label, True)


_check_raises(
    "extract_json_value: no JSON start found raises BadOutputError",
    lambda: extract_json_value("just plain prose, no JSON here"),
)
_check_raises(
    "extract_json_value: an unclosed JSON object raises BadOutputError",
    lambda: extract_json_value('{"ok": true'),
)
_check_raises(
    "extract_json_value: an unclosed JSON array raises BadOutputError",
    lambda: extract_json_value('[{"ok": true}'),
)

# =================================================================
# apply_array_key
# =================================================================

check(
    "apply_array_key: a bare list is wrapped under the given key",
    apply_array_key([{"id": "a"}], "translations") == {"translations": [{"id": "a"}]},
)
check(
    "apply_array_key: a dict is passed through unchanged even with array_key set",
    apply_array_key({"translations": []}, "translations") == {"translations": []},
)
check(
    "apply_array_key: array_key=None leaves a bare list unwrapped",
    apply_array_key([{"id": "a"}], None) == [{"id": "a"}],
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
