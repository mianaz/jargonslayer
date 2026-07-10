#!/usr/bin/env python3
"""Plain-assert self-test for the subscription-direct agent sidecar's
pure functions (agent_server.py) — no pytest, no network, no model
calls, no server start (module import is side-effect free; the server
only starts under `if __name__ == "__main__":`). Mirrors test_ingest_
url.py/test_realtime_diar.py's existing style/harness.

Run:
    sidecar/.venv/bin/python sidecar/test_agent_server.py

Covers (per the v0.2.2 design doc's test-plan section):
  - agent_origin_allowed: empty Origin MUST be rejected here (the
    single most important check in this file — deliberately the
    OPPOSITE of whisper_server.ingest_origin_allowed's empty-Origin-
    allowed posture; conflating the two is the #1 Codex-review item
    called out in both the design doc and this module's own comments)
  - health_origin_allowed: looser gate, empty Origin allowed
  - token_matches: connection-code gate (missing/wrong/correct)
  - check_env_warnings: ANTHROPIC_API_KEY detection
  - parse_codex_ndjson: real-shape NDJSON extraction (verified live
    2026-07-06 against codex-cli 0.133.0's actual output)
  - _map_codex_error / ERROR_CODE_STATUS: error-code -> HTTP status map
  - generate_connection_token / token uniqueness
  - build_codex_argv: asserts the prompt-injection lockdown flags
    (--sandbox read-only, approval_policy=never) are always present —
    added post-adversarial-review (Codex), see build_codex_argv's own
    docstring for the live sandbox-escape smoke-test transcripts this
    guards against regressing
"""

from __future__ import annotations

import os
import sys
from http import HTTPStatus
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Guard against a stray ANTHROPIC_API_KEY in the dev shell polluting
# the check_env_warnings test below — this module's own tests must be
# deterministic regardless of the invoking shell's env.
_HAD_KEY = os.environ.pop("ANTHROPIC_API_KEY", None)

import agent_server as s  # noqa: E402

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
# agent_origin_allowed (credentialed endpoint gate — THE headline
# check: empty Origin is REJECTED, opposite of whisper_server.py's
# ingest_origin_allowed)
# =================================================================

check(
    "agent_origin_allowed: None (no Origin header) is REJECTED — "
    "opposite of ingest_origin_allowed's None -> True; a credentialed "
    "endpoint's only legitimate caller (a browser tab) ALWAYS sends "
    "Origin, so no-Origin here means some other local process trying "
    "to ride the subscription for free",
    s.agent_origin_allowed(None) is False,
)
check(
    "agent_origin_allowed: empty string Origin is REJECTED (same no-Origin case)",
    s.agent_origin_allowed("") is False,
)
check(
    "agent_origin_allowed: http://localhost:3000 (the app's own dev origin) is allowed",
    s.agent_origin_allowed("http://localhost:3000") is True,
)
check(
    "agent_origin_allowed: localhost on an arbitrary other port is allowed",
    s.agent_origin_allowed("http://localhost:5173") is True,
)
check(
    "agent_origin_allowed: http://127.0.0.1 with an arbitrary port is allowed",
    s.agent_origin_allowed("http://127.0.0.1:41234") is True,
)
check(
    "agent_origin_allowed: https://127.0.0.1 (scheme shouldn't matter, only hostname) is allowed",
    s.agent_origin_allowed("https://127.0.0.1:8443") is True,
)
check(
    "agent_origin_allowed: IPv6 loopback [::1] with a port is allowed",
    s.agent_origin_allowed("http://[::1]:3000") is True,
)
check(
    "agent_origin_allowed: a real third-party origin is rejected",
    s.agent_origin_allowed("https://evil.com") is False,
)
check(
    "agent_origin_allowed: a third-party origin masquerading with 'localhost' only in the path is still rejected",
    s.agent_origin_allowed("https://evil.com/localhost") is False,
)
check(
    "agent_origin_allowed: a malformed Origin urlparse can't extract a hostname from is rejected",
    s.agent_origin_allowed("not a url") is False,
)
check(
    "agent_origin_allowed: 'null' (the Origin browsers send for sandboxed/file:// contexts) is rejected",
    s.agent_origin_allowed("null") is False,
)

# =================================================================
# health_origin_allowed (looser gate — GET /agent/health leaks no
# credential, so per the design doc empty Origin is fine here)
# =================================================================

check(
    "health_origin_allowed: None (curl/CLI/native launcher) is allowed — health leaks no credential",
    s.health_origin_allowed(None) is True,
)
check(
    "health_origin_allowed: empty string is allowed (same no-Origin case)",
    s.health_origin_allowed("") is True,
)
check(
    "health_origin_allowed: http://localhost:3000 is allowed",
    s.health_origin_allowed("http://localhost:3000") is True,
)
check(
    "health_origin_allowed: a real third-party origin is still rejected",
    s.health_origin_allowed("https://evil.com") is False,
)

# =================================================================
# token_matches (connection-code gate)
# =================================================================

_TOKEN = s.generate_connection_token()

check(
    "token_matches: the exact correct token matches",
    s.token_matches(_TOKEN, _TOKEN) is True,
)
check(
    "token_matches: a wrong token does not match",
    s.token_matches(_TOKEN, "wrong-token-entirely") is False,
)
check(
    "token_matches: a missing token (header absent -> None) does not match",
    s.token_matches(_TOKEN, None) is False,
)
check(
    "token_matches: an empty-string token does not match",
    s.token_matches(_TOKEN, "") is False,
)
check(
    "token_matches: a token differing by one trailing character does not match",
    s.token_matches(_TOKEN, _TOKEN + "x") is False,
)

_TOKEN_B = s.generate_connection_token()
check(
    "generate_connection_token: two successive calls produce different tokens (not hardcoded/predictable)",
    _TOKEN != _TOKEN_B,
)
check(
    "generate_connection_token: produces a non-trivially-short token (enough entropy to resist guessing)",
    len(_TOKEN) >= 20,
)

# =================================================================
# check_env_warnings (ANTHROPIC_API_KEY detection — design doc Q5 /
# crossed-out item #3: never auto-unset, only warn)
# =================================================================

check(
    "check_env_warnings: no warnings when ANTHROPIC_API_KEY is absent",
    s.check_env_warnings() == [],
)

os.environ["ANTHROPIC_API_KEY"] = "sk-ant-test-fake-key-not-real"
try:
    warnings_with_key = s.check_env_warnings()
finally:
    del os.environ["ANTHROPIC_API_KEY"]

check(
    "check_env_warnings: exactly one warning is surfaced when ANTHROPIC_API_KEY is present",
    len(warnings_with_key) == 1,
)
check(
    "check_env_warnings: the warning text mentions ANTHROPIC_API_KEY and the precedence-over-subscription risk",
    "ANTHROPIC_API_KEY" in warnings_with_key[0] and "订阅" in warnings_with_key[0],
)
check(
    "check_env_warnings: after unsetting the key again, warnings clear (never auto-unset by this module — "
    "the test harness itself does the unset, mirroring what the real caller must do)",
    s.check_env_warnings() == [],
)

# =================================================================
# parse_codex_ndjson (real-shape NDJSON, verified live 2026-07-06
# against codex-cli 0.133.0's actual `codex exec --json` output)
# =================================================================

_REAL_NDJSON = (
    '{"type":"thread.started","thread_id":"019f3a51-6b18-7073-b654-f5f928e32422"}\n'
    '{"type":"turn.started"}\n'
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"ok\\":true}"}}\n'
    '{"type":"turn.completed","usage":{"input_tokens":28997,"output_tokens":29}}\n'
)

check(
    "parse_codex_ndjson: extracts the agent_message text from a real captured NDJSON stream",
    s.parse_codex_ndjson(_REAL_NDJSON) == '{"ok":true}',
)
check(
    "parse_codex_ndjson: returns None when no agent_message item is present",
    s.parse_codex_ndjson('{"type":"thread.started","thread_id":"x"}\n{"type":"turn.started"}\n')
    is None,
)
check(
    "parse_codex_ndjson: returns None for completely empty stdout",
    s.parse_codex_ndjson("") is None,
)
check(
    "parse_codex_ndjson: a malformed/non-JSON line is skipped rather than raising",
    s.parse_codex_ndjson(
        "not json at all\n"
        '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}\n'
    )
    == "hello",
)
check(
    "parse_codex_ndjson: the LAST agent_message wins if more than one appears",
    s.parse_codex_ndjson(
        '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}\n'
        '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}\n'
    )
    == "second",
)
check(
    "parse_codex_ndjson: an agent_message with blank/whitespace-only text is ignored",
    s.parse_codex_ndjson(
        '{"type":"item.completed","item":{"type":"agent_message","text":"   "}}\n'
        '{"type":"item.completed","item":{"type":"agent_message","text":"real answer"}}\n'
    )
    == "real answer",
)
check(
    "parse_codex_ndjson: an item.completed of a non-agent_message type (e.g. reasoning) is ignored",
    s.parse_codex_ndjson(
        '{"type":"item.completed","item":{"type":"reasoning","text":"thinking..."}}\n'
        '{"type":"item.completed","item":{"type":"agent_message","text":"the answer"}}\n'
    )
    == "the answer",
)

# =================================================================
# _map_codex_error (heuristic stderr/exit-code -> error-code mapping)
# =================================================================

check(
    "_map_codex_error: 'not logged in' in stderr maps to no_key",
    s._map_codex_error(1, "Error: not logged in. Run `codex login` first.") == "no_key",
)
check(
    "_map_codex_error: 'unauthorized' in stderr maps to no_key",
    s._map_codex_error(1, "401 Unauthorized") == "no_key",
)
check(
    "_map_codex_error: 'rate limit' in stderr maps to rate_limit",
    s._map_codex_error(1, "Error: rate limit exceeded, try again later") == "rate_limit",
)
check(
    "_map_codex_error: 'quota' in stderr maps to rate_limit",
    s._map_codex_error(1, "quota exceeded for this account") == "rate_limit",
)
check(
    "_map_codex_error: an unrecognized failure maps to upstream (the safe default)",
    s._map_codex_error(1, "some unexpected internal error") == "upstream",
)

# =================================================================
# ERROR_CODE_STATUS (error code -> HTTP status mapping used by do_POST)
# =================================================================

check(
    "ERROR_CODE_STATUS: no_key maps to 401",
    s.ERROR_CODE_STATUS["no_key"] == HTTPStatus.UNAUTHORIZED,
)
check(
    "ERROR_CODE_STATUS: rate_limit maps to 429",
    s.ERROR_CODE_STATUS["rate_limit"] == HTTPStatus.TOO_MANY_REQUESTS,
)
check(
    "ERROR_CODE_STATUS: upstream maps to 502",
    s.ERROR_CODE_STATUS["upstream"] == HTTPStatus.BAD_GATEWAY,
)
check(
    "ERROR_CODE_STATUS: bad_request maps to 400",
    s.ERROR_CODE_STATUS["bad_request"] == HTTPStatus.BAD_REQUEST,
)

# =================================================================
# codex_login_probe / claude_login_probe never raise (best-effort
# health checks — must degrade to None/False, never throw, even on an
# odd filesystem)
# =================================================================

check(
    "claude_login_probe: never raises, returns a bool or None",
    s.claude_login_probe() in (True, False, None),
)
check(
    "codex_login_probe: never raises, returns a bool or None",
    s.codex_login_probe() in (True, False, None),
)

# =================================================================
# codex_available / _claude_sdk_available reflect this venv's actual
# install state (both are installed in sidecar/.venv per requirements.
# txt / pip install for this task, and codex CLI is on PATH on this
# machine — see the smoke-test report for the machine-dependent case)
# =================================================================

check(
    "_claude_sdk_available: returns (bool, Optional[str]) shape",
    isinstance(s._claude_sdk_available(), tuple) and len(s._claude_sdk_available()) == 2,
)
check(
    "codex_available: returns a plain bool",
    isinstance(s.codex_available(), bool),
)

# =================================================================
# build_codex_argv (prompt-injection lockdown — post-adversarial-review
# fix). Asserts the security-critical flags are always present in the
# real argv codex exec is spawned with — see build_codex_argv's own
# docstring for the live sandbox-escape smoke-test transcripts (network
# DNS resolution blocked, file write denied, real injection payloads
# built from the actual production prompts produced clean detect JSON
# with zero leaked file contents and no command_execution attempted).
# =================================================================

_argv = s.build_codex_argv("system prompt text", "untrusted user text", "/tmp/some-empty-dir")

check(
    "build_codex_argv: invokes the codex binary with the exec subcommand",
    _argv[0] == "codex" and _argv[1] == "exec",
)
check(
    "build_codex_argv: --sandbox read-only is present (blocks filesystem "
    "writes and network access — the prompt-injection blast-radius lockdown)",
    "--sandbox" in _argv and _argv[_argv.index("--sandbox") + 1] == "read-only",
)
check(
    "build_codex_argv: -c approval_policy=never is present (forecloses any "
    "mid-run approval escalation — this is a non-interactive server with no "
    "human to ever answer a prompt)",
    "approval_policy=never" in _argv,
)
check(
    "build_codex_argv: -c model_reasoning_effort=low is present (latency fix, "
    "preserved alongside the new sandbox flags, not replaced by them)",
    "model_reasoning_effort=low" in _argv,
)
check(
    "build_codex_argv: --skip-git-repo-check is still present (unrelated to "
    "the sandbox lockdown, must not have been dropped by the refactor)",
    "--skip-git-repo-check" in _argv,
)
check(
    "build_codex_argv: -C points at the caller's tmp_dir, never a hardcoded path",
    "-C" in _argv and _argv[_argv.index("-C") + 1] == "/tmp/some-empty-dir",
)
check(
    "build_codex_argv: the folded prompt (system+user text) is the final argv element",
    _argv[-1] == s.build_codex_prompt("system prompt text", "untrusted user text"),
)
check(
    "build_codex_argv: --json is present (NDJSON output contract parse_codex_ndjson depends on)",
    "--json" in _argv,
)

# =================================================================
# Background-profile hint passthrough (#48 s1 review item 7): the
# subscription-direct path must send the same AUDIENCE: hint the
# Next.js path already splices in — see agent_prompts.py's
# build_detect_user_message/build_define_user_message and this
# module's _extract_profile.
# =================================================================

import agent_prompts as p  # noqa: E402

check(
    "_extract_profile: a present, non-empty profile is trimmed and returned",
    s._extract_profile({"profile": "  行业：互联网  "}) == "行业：互联网",
)
check(
    "_extract_profile: an empty-string profile is treated as absent (None)",
    s._extract_profile({"profile": ""}) is None,
)
check(
    "_extract_profile: a whitespace-only profile is treated as absent (None)",
    s._extract_profile({"profile": "   "}) is None,
)
check(
    "_extract_profile: a missing profile key returns None",
    s._extract_profile({}) is None,
)
check(
    "_extract_profile: a non-string profile value returns None",
    s._extract_profile({"profile": 12345}) is None,
)
check(
    "_extract_profile: a long profile is capped to PROFILE_MAX_CHARS server-side (defense in depth)",
    len(s._extract_profile({"profile": "x" * 500})) == s.PROFILE_MAX_CHARS,
)
check(
    "build_detect_user_message: no profile -> unchanged from the pre-#48-step-3 shape, no AUDIENCE line",
    p.build_detect_user_message("ctx", "new text")
    == "CONTEXT:\nctx\n\nNEW:\nnew text",
)
check(
    "build_detect_user_message: a profile hint prepends exactly one AUDIENCE: line",
    p.build_detect_user_message("ctx", "new text", "行业：互联网")
    == "AUDIENCE:\n行业：互联网\n\nCONTEXT:\nctx\n\nNEW:\nnew text",
)
check(
    "build_define_user_message: no profile -> unchanged, no AUDIENCE line",
    p.build_define_user_message("circle back", "ctx")
    == "PHRASE:\ncircle back\n\nCONTEXT:\nctx",
)
check(
    "build_define_user_message: a profile hint prepends exactly one AUDIENCE: line",
    p.build_define_user_message("circle back", "ctx", "角色：工程师")
    == "AUDIENCE:\n角色：工程师\n\nPHRASE:\ncircle back\n\nCONTEXT:\nctx",
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
