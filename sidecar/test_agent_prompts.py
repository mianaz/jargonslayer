#!/usr/bin/env python3
"""Plain-assert self-test for agent_prompts.py's zh/en system-prompt
variant selection — no pytest, no network. Mirrors test_agent_json.py's
existing style/harness.

Run:
    sidecar/.venv/bin/python sidecar/test_agent_prompts.py

Why this file exists: DETECT_SYSTEM_PROMPT_EN / DEFINE_SYSTEM_PROMPT_EN
are built from the zh originals via chained str.replace() calls — a
construction that SILENTLY NO-OPS when someone edits the zh source
string without updating the matching replace() needle (the parity test
against prompts.ts covers zh<->TS drift, but a no-opped replace leaves
both sides "in sync" while the EN variant quietly regresses to Chinese-
audience copy). Every check below that asserts a zh-only phrase is
ABSENT from the EN variant is a tripwire for exactly that failure:
build_detect_system_prompt / build_define_system_prompt themselves were
never called by any test before this file.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_prompts import (  # noqa: E402
    DEFINE_SYSTEM_PROMPT,
    DEFINE_SYSTEM_PROMPT_EN,
    DETECT_SYSTEM_PROMPT,
    DETECT_SYSTEM_PROMPT_EN,
    build_define_system_prompt,
    build_detect_system_prompt,
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


# =================================================================
# build_detect_system_prompt / build_define_system_prompt: selection
# =================================================================

check(
    "build_detect_system_prompt('zh') returns the canonical zh prompt",
    build_detect_system_prompt("zh") is DETECT_SYSTEM_PROMPT,
)
check(
    "build_detect_system_prompt('en') returns the en variant",
    build_detect_system_prompt("en") is DETECT_SYSTEM_PROMPT_EN,
)
check(
    "build_detect_system_prompt: any non-'zh' value falls through to en "
    "(mirrors prompts.ts's buildDetectSystemPrompt)",
    build_detect_system_prompt("fr") is DETECT_SYSTEM_PROMPT_EN,
)
check(
    "build_define_system_prompt('zh') returns the canonical zh prompt",
    build_define_system_prompt("zh") is DEFINE_SYSTEM_PROMPT,
)
check(
    "build_define_system_prompt('en') returns the en variant",
    build_define_system_prompt("en") is DEFINE_SYSTEM_PROMPT_EN,
)
check(
    "build_define_system_prompt: any non-'zh' value falls through to en",
    build_define_system_prompt("") is DEFINE_SYSTEM_PROMPT_EN,
)

# =================================================================
# DETECT_SYSTEM_PROMPT_EN: every replace() actually fired
# (source phrase gone, replacement present)
# =================================================================

check(
    "detect en: variant is not just the zh prompt",
    DETECT_SYSTEM_PROMPT_EN != DETECT_SYSTEM_PROMPT,
)
check(
    "detect en: audience swap fired (zh-audience phrase gone)",
    "for a Chinese professional" not in DETECT_SYSTEM_PROMPT_EN,
)
check(
    "detect en: audience swap fired (en-audience phrase present)",
    "for a non-native English speaker" in DETECT_SYSTEM_PROMPT_EN,
)
check(
    "detect en: chinese_explanation spec swap fired (zh spec gone)",
    "自然的商务中文解释" not in DETECT_SYSTEM_PROMPT_EN,
)
check(
    "detect en: chinese_explanation spec swap fired (en spec present)",
    "simple everyday-English explanation, <=25 words" in DETECT_SYSTEM_PROMPT_EN,
)
check(
    "detect en: gloss_zh spec swap fired (zh spec gone)",
    "中文简释" not in DETECT_SYSTEM_PROMPT_EN,
)
check(
    "detect en: gloss_zh spec swap fired (en spec present)",
    '"gloss_zh": "<short plain-English gloss, <=15 words>"' in DETECT_SYSTEM_PROMPT_EN,
)
check(
    "detect en: rule-6 swap fired (zh spacing rule gone)",
    "In all Chinese output" not in DETECT_SYSTEM_PROMPT_EN,
)
check(
    "detect en: rule-6 swap fired (plain-English wording present)",
    "explaining quickly in plain simple English" in DETECT_SYSTEM_PROMPT_EN,
)

# Wire compatibility: the FIELD NAMES never change with the language —
# only their spec text does (prompts.ts's applyLangVariant contract).
check(
    "detect en: chinese_explanation field name survives the swap",
    '"chinese_explanation"' in DETECT_SYSTEM_PROMPT_EN,
)
check(
    "detect en: gloss_zh field name survives the swap",
    '"gloss_zh"' in DETECT_SYSTEM_PROMPT_EN,
)

# =================================================================
# DEFINE_SYSTEM_PROMPT_EN: every replace() actually fired
# =================================================================

check(
    "define en: variant is not just the zh prompt",
    DEFINE_SYSTEM_PROMPT_EN != DEFINE_SYSTEM_PROMPT,
)
check(
    "define en: audience swap fired (zh-audience phrase gone)",
    "that a Chinese professional deliberately selected" not in DEFINE_SYSTEM_PROMPT_EN,
)
check(
    "define en: audience swap fired (en-audience phrase present)",
    "that a non-native English speaker deliberately selected" in DEFINE_SYSTEM_PROMPT_EN,
)
check(
    "define en: chinese_explanation spec swap fired (zh spec gone)",
    "自然的商务中文解释" not in DEFINE_SYSTEM_PROMPT_EN,
)
check(
    "define en: chinese_explanation spec swap fired (en spec present)",
    "simple everyday-English explanation, <=30 words" in DEFINE_SYSTEM_PROMPT_EN,
)
check(
    "define en: rule-3 swap fired (zh spacing rule gone)",
    "Put a half-width space between Chinese characters" not in DEFINE_SYSTEM_PROMPT_EN,
)
check(
    "define en: rule-3 swap fired (plain-English wording present)",
    "explaining quickly in plain simple English" in DEFINE_SYSTEM_PROMPT_EN,
)
check(
    "define en: chinese_explanation field name survives the swap",
    '"chinese_explanation"' in DEFINE_SYSTEM_PROMPT_EN,
)

# The zh originals keep their zh-audience anchors — a sanity check that
# the EN-absence checks above are non-vacuous (if these anchors ever
# leave the zh prompt, the replace() needles above went stale WITH them,
# and both sides of the tripwire need re-deriving together).
check(
    "detect zh: canonical prompt still targets the zh audience",
    "for a Chinese professional" in DETECT_SYSTEM_PROMPT,
)
check(
    "define zh: canonical prompt still targets the zh audience",
    "that a Chinese professional deliberately selected" in DEFINE_SYSTEM_PROMPT,
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
