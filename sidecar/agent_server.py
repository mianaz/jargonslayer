#!/usr/bin/env python3
"""JargonSlayer subscription-direct agent sidecar (v0.2.2, LOCAL DEV
DEPLOYMENT ONLY — never shipped in the hosted/experience-tier build).

This is a SEPARATE, optional HTTP module from whisper_server.py's job
API — it does NOT import faster-whisper/torch, so a user who only
wants subscription-direct detect/define (and transcribes via Web
Speech / cloud STT instead of local Whisper) can start it without
pulling in a multi-hundred-MB ML stack. Run standalone:

    python -m sidecar.agent_server --port 8767

or from within the sidecar/ directory:

    python agent_server.py --port 8767

--------------------------------------------------------------------
WHAT THIS IS, IN PLAIN TERMS (read this before anything else)
--------------------------------------------------------------------
This process lets JargonSlayer's browser tab call Claude/ChatGPT using
YOUR OWN existing `claude` / `codex` CLI login on THIS machine — the
same login you already use interactively at the terminal. It does
this by spawning/driving those CLIs locally; it never asks you to log
in through this app, never stores a copy of your login/credentials,
and never proxies your subscription through any server this project
runs. If you don't already run `claude` or `codex login` yourself, this
feature does nothing for you.

This is NOT "JargonSlayer offers you a Claude/ChatGPT subscription" —
it is "JargonSlayer, running entirely on your machine, asks the CLI
you already logged into to answer one question, the same way running
`claude -p '...'` yourself would." Per Anthropic's third-party-developer
policy, offering claude.ai login/rate limits AS A PRODUCT FEATURE is
what's disallowed — a user driving their own already-authenticated
local CLI from a local tool is the officially-documented
`claude setup-token` / local-CLI pattern, not that. Track this
distinction in every word of UI copy, error message, and code comment
that touches this file: never "we connect your subscription" / "we
give you access" — always "your own local Claude/ChatGPT login, used
by a tool running on your machine." This is not a legal nicety; it is
the entire reason this feature is allowed to exist. See the v0.2.2
design doc (Q0) for the full policy analysis this rests on.

Experimental: gated behind Settings.subscriptionDirect (default OFF)
and the NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT build flag (unset =
the whole feature doesn't exist in a built bundle) — see
src/lib/agent/localHost.ts and SettingsDialog.tsx's "订阅直连（实验性）"
section. Only detect/define are wired to this path; translate/summarize
always use the existing Next.js /api/* routes, unconditionally, in
every build. Subject to change or removal without notice if official
policy tightens (see kill-switch layers 2/3 in the design doc).

--------------------------------------------------------------------
Endpoints (all loopback-only; see parse_args' --host default)
--------------------------------------------------------------------
  GET  /agent/health           — provider/login-state probe, no token required
  POST /agent/detect           — requires Origin gate + X-JS-Agent-Token
  POST /agent/define           — requires Origin gate + X-JS-Agent-Token

--------------------------------------------------------------------
Credentials (read this before touching auth code in this file)
--------------------------------------------------------------------
This process NEVER reads, copies, or persists any claude/codex
credential. It spawns/drives the `claude-agent-sdk` (in-process,
Claude) and the `codex` CLI (subprocess, ChatGPT) with NO injected
API-key env vars — both authenticate however the user's own `claude`/
`codex` CLI already does (subscription OAuth in Keychain/~/.claude,
~/.codex/ respectively). If $ANTHROPIC_API_KEY is present in this
process's environment at startup, authentication precedence would
favor it over the user's subscription (see check_env_warnings below) —
we warn loudly (stdout + /agent/health.warns) rather than unset it
ourselves (silently mutating a variable the user's shell/other tools
may depend on is its own footgun).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional
from urllib.parse import urlparse

from agent_json import BadOutputError, JSON_REMINDER, apply_array_key, extract_json_value
from agent_postfilter import post_filter
from agent_prompts import (
    build_define_system_prompt,
    build_define_user_message,
    build_detect_system_prompt,
    build_detect_user_message,
)

# ---------------------------------------------------------------
# Origin gate — DELIBERATELY THE OPPOSITE of whisper_server.py's
# ingest_origin_allowed for empty/missing Origin. Read this comment
# fully before touching either gate; conflating the two is the single
# most dangerous mistake possible in this file (flagged as the #1
# Codex-review item in the v0.2.2 design doc).
#
# ingest_origin_allowed (whisper_server.py) guards an SSRF-shaped
# endpoint (POST /ingest-url can make this machine fetch an arbitrary
# attacker-supplied URL) whose threat model is "a THIRD-PARTY WEB PAGE
# reaching this endpoint" — curl/a native launcher/no-Origin-at-all is
# the LEGITIMATE caller there, so empty Origin -> allowed.
#
# /agent/detect and /agent/define are a CREDENTIALED endpoint — every
# successful call spends the user's own Claude/ChatGPT subscription
# quota. Here the threat model flips: ANY LOCAL PROCESS (not just a
# browser tab) capable of `curl http://127.0.0.1:8767/agent/detect`
# would happily burn the user's subscription for free if empty Origin
# were allowed — and a real browser tab, which is the only intended
# caller, ALWAYS sends an Origin header for a cross-origin fetch (this
# sidecar's own port is never the page's own origin). So here:
#
#   empty/missing Origin -> REJECTED (the opposite of ingest_origin_
#   allowed's None/"" -> True). This closes exactly the "local curl/
#   script quietly rides the user's subscription" hole that a copy-
#   pasted ingest_origin_allowed would leave wide open.
#
#   a loopback-hostname Origin (localhost/127.0.0.1/::1, any port) ->
#   allowed — this is what the JargonSlayer web app itself sends.
#
#   anything else (a real remote origin, or a malformed Origin
#   urlparse can't extract a hostname from) -> rejected, same as
#   ingest_origin_allowed's non-loopback case.
# ---------------------------------------------------------------

AGENT_ALLOWED_ORIGIN_HOSTS = {"localhost", "127.0.0.1", "::1"}


def agent_origin_allowed(origin: Optional[str]) -> bool:
    """Origin gate for the credentialed /agent/detect + /agent/define
    endpoints. See the module-level comment above for the full
    rationale — in one line: empty/missing Origin is REJECTED here
    (opposite of whisper_server.ingest_origin_allowed's None/"" ->
    True), because this endpoint spends subscription quota and its
    only legitimate caller is a browser tab, which always sends
    Origin; a bare curl/script with no Origin is exactly the "local
    process rides the subscription for free" attack this gate exists
    to close."""
    if origin is None or origin == "":
        return False
    hostname = urlparse(origin).hostname
    return hostname in AGENT_ALLOWED_ORIGIN_HOSTS


def health_origin_allowed(origin: Optional[str]) -> bool:
    """Looser gate for GET /agent/health: it leaks no credential and
    no ability to spend quota (see the /agent/health docstring below),
    so per the design doc it may be relaxed — empty/missing Origin is
    allowed here (same posture as ingest_origin_allowed), only a real
    THIRD-PARTY remote origin is rejected. Kept as a distinct function
    (rather than reusing ingest_origin_allowed or agent_origin_allowed)
    so each endpoint's gate reads as an intentional, self-contained
    decision rather than an accidentally-shared one."""
    if origin is None or origin == "":
        return True
    hostname = urlparse(origin).hostname
    return hostname in AGENT_ALLOWED_ORIGIN_HOSTS


# ---------------------------------------------------------------
# Connection-code (X-JS-Agent-Token) — defense in depth alongside the
# Origin gate above. Origin gate alone doesn't stop a DIFFERENT
# localhost page (the user's own other local dev server, or a
# malicious one bound to loopback) from also passing the Origin check;
# a token only the person who started THIS sidecar and read ITS
# stdout banner can know closes that gap. Generated fresh every
# process start (no persistence, no file) — printed once to stdout;
# the user copies it into Settings -> 订阅直连（实验性）once per sidecar
# run. Not a subscription credential itself: leaking it only lets
# another LOCAL process ride this sidecar's already-legitimate
# provider calls, same-machine only.
# ---------------------------------------------------------------


def generate_connection_token() -> str:
    return secrets.token_urlsafe(24)


def token_matches(expected: str, provided: Optional[str]) -> bool:
    """Constant-time-ish comparison via secrets.compare_digest, so a
    timing side-channel can't help an attacker guess the token byte by
    byte. `provided` may be None (header absent) — treated as a
    mismatch, never an error."""
    if provided is None:
        return False
    return secrets.compare_digest(expected, provided)


# ---------------------------------------------------------------
# ANTHROPIC_API_KEY warning (design doc Q5 / crossed-out item #3):
# authentication precedence favors an explicit API key over
# subscription OAuth, so a stray $ANTHROPIC_API_KEY in this process's
# environment would silently make Claude calls spend THAT key's
# credits/quota instead of the user's subscription — surfaced as a
# /agent/health warning (never auto-unset; see module docstring).
# ---------------------------------------------------------------


def check_env_warnings() -> list[str]:
    warnings: list[str] = []
    if os.environ.get("ANTHROPIC_API_KEY"):
        warnings.append(
            "检测到 ANTHROPIC_API_KEY，Claude 调用将优先使用该 Key 而非订阅登录；"
            "如需使用订阅额度请先 unset ANTHROPIC_API_KEY 再重启 sidecar / "
            "ANTHROPIC_API_KEY is set — Claude calls will use it instead of your "
            "subscription login; unset it and restart this sidecar to use the "
            "subscription."
        )
    return warnings


# ---------------------------------------------------------------
# Claude path — claude-agent-sdk, in-process, one call per request.
# ---------------------------------------------------------------

CLAUDE_MODEL_DEFAULT = "claude-haiku-4-5"
AGENT_CALL_TIMEOUT_S = 15.0  # sidecar's own hard cap — see design doc Q3


class AgentCallError(Exception):
    """Raised by call_claude/call_codex on any provider-side failure,
    carrying a `code` this module's HTTP layer maps to a status (see
    ERROR_CODE_STATUS)."""

    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code


def _claude_sdk_available() -> tuple[bool, Optional[str]]:
    try:
        import claude_agent_sdk  # noqa: F401

        return True, None
    except Exception as exc:  # noqa: BLE001 - import can fail in many ways
        return False, f"{type(exc).__name__}: {exc}"


async def call_claude(system_prompt: str, user_message: str, model: str) -> str:
    """One-shot, single-turn, tool-free Claude call via claude-agent-
    sdk's query(). Compressed to a plain "system prompt -> one user
    message -> one assistant text reply" completion — NOT an agentic
    session — via:
      tools=[]            -- no built-in tool is even offered to the
                              model (stronger than allowed_tools=[],
                              which only withholds auto-approval; an
                              empty tools list removes the toolset
                              entirely, verified against this SDK
                              version's ClaudeAgentOptions/query()
                              behavior before writing this, per the
                              project's own "read the actual installed
                              SDK's types.py, don't guess" rule).
      allowed_tools=[]     -- belt-and-suspenders with tools=[] above.
      max_turns=1          -- refuse to continue past one assistant
                              turn even if something unexpected drives
                              a second one.
      permission_mode="bypassPermissions" -- no interactive approval
                              prompt possible (moot with tools=[], but
                              cheap defense in depth + it's what
                              suppresses the CanUseToolShadowedWarning
                              this SDK version emits otherwise).
      setting_sources=[]  -- never load the user's own ~/.claude
                              settings/CLAUDE.md into this call; detect/
                              define must not be perturbed by whatever
                              personal Claude Code config the user
                              happens to have.
      thinking={"type": "disabled"} -- MEASURED LIVE (2026-07-06,
                              real subscription call, full
                              DETECT_SYSTEM_PROMPT): without this, the
                              CLI-mediated agent session runs an
                              extended-thinking pass by default and the
                              SAME detect call that completes in ~5s via
                              the direct Anthropic Messages API
                              (anthropic.ts's callJson, which never
                              requests thinking) took ~90s end-to-end
                              here — 18x slower, and well past both this
                              module's own AGENT_CALL_TIMEOUT_S and the
                              browser's 20s detect timeout, i.e.
                              functionally broken for live detection
                              without this flag. detect/define are
                              single-turn "extract structured JSON from
                              one paragraph" tasks with no need for
                              deliberation; disabling thinking here
                              restored ~5s latency with equivalent
                              output quality on the same test input.
    Raises AgentCallError on any SDK-reported failure — see the
    exception-type/ResultMessage.subtype mapping below. Returns the
    raw assistant text (JSON extraction/repair happens one level up in
    handle_detect/handle_define, exactly like anthropic.ts's
    callJsonViaFallback + agent_json.extract_json_value)."""
    from claude_agent_sdk import (
        AssistantMessage,
        ClaudeAgentOptions,
        ResultMessage,
        TextBlock,
        query,
    )

    options = ClaudeAgentOptions(
        system_prompt=system_prompt,
        tools=[],
        allowed_tools=[],
        max_turns=1,
        permission_mode="bypassPermissions",
        setting_sources=[],
        thinking={"type": "disabled"},
        model=model,
    )

    last_text: Optional[str] = None
    try:
        async with asyncio.timeout(AGENT_CALL_TIMEOUT_S):
            async for message in query(prompt=user_message, options=options):
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock) and block.text.strip():
                            last_text = block.text
                elif isinstance(message, ResultMessage):
                    if message.is_error:
                        raise AgentCallError(
                            f"Claude 调用失败：{message.subtype}", _map_result_error(message)
                        )
                    # ResultMessage.result is the final assistant text
                    # when present — prefer it (it's what the CLI
                    # itself considers "the answer"); fall back to the
                    # last AssistantMessage text block collected above
                    # if the SDK ever omits it.
                    if message.result:
                        last_text = message.result
    except TimeoutError as exc:
        raise AgentCallError("Claude 调用超时", "upstream") from exc

    if not last_text:
        raise AgentCallError("Claude 未返回文本内容", "upstream")
    return last_text


def _map_result_error(message: Any) -> str:
    """Map a failing ResultMessage's subtype/underlying assistant error
    to one of this module's error codes (see ERROR_CODE_STATUS)."""
    subtype = getattr(message, "subtype", "") or ""
    if "budget" in subtype or "max_turns" in subtype:
        return "upstream"
    return "upstream"


def claude_login_probe() -> Optional[bool]:
    """Best-effort 'is the user likely logged into claude?' probe for
    GET /agent/health — deliberately NOT calling the model (that would
    spend quota just to render a health dot). Checks only for the
    on-disk credentials file claude/setup-token writes, mirroring how
    whisper_server.py's diarization_probe avoids loading the actual
    pyannote model. Returns None (unknown) rather than False when the
    check itself can't run (e.g. odd permissions), so the UI can
    distinguish "confirmed logged out" from "couldn't tell" - though
    today both render the same "请在终端运行 claude" guidance."""
    try:
        home = os.path.expanduser("~")
        candidate = os.path.join(home, ".claude", ".credentials.json")
        return os.path.isfile(candidate)
    except Exception:  # noqa: BLE001 - health probe must never throw
        return None


# ---------------------------------------------------------------
# ChatGPT path — `codex exec --json`, spawned fresh per request.
# ---------------------------------------------------------------

CODEX_CALL_TIMEOUT_S = AGENT_CALL_TIMEOUT_S


def codex_available() -> bool:
    return shutil.which("codex") is not None


def codex_login_probe() -> Optional[bool]:
    """Mirrors claude_login_probe's spirit for the codex CLI: checks
    only for the presence of ~/.codex's own auth file, never spawns
    codex itself (that would cost a cold start just to render a health
    dot). Returns None if codex itself isn't even installed (a
    distinct state from "installed but logged out", surfaced via
    codex_available in the /agent/health payload)."""
    if not codex_available():
        return None
    try:
        home = os.path.expanduser("~")
        # codex CLI's on-disk auth store; presence is a reasonable
        # logged-in signal without spawning the CLI.
        candidate = os.path.join(home, ".codex", "auth.json")
        return os.path.isfile(candidate)
    except Exception:  # noqa: BLE001 - health probe must never throw
        return None


def build_codex_prompt(system_prompt: str, user_message: str) -> str:
    """codex exec takes a single free-text prompt (no separate system/
    user roles) — fold our system instructions and the user message
    into one prompt, clearly delimited so the model can still tell
    "instructions" from "the text to act on" apart."""
    return f"{system_prompt}\n\n{user_message}"


def build_codex_argv(system_prompt: str, user_message: str, tmp_dir: str) -> list[str]:
    """Pure argv builder for call_codex's `codex exec` invocation —
    extracted from call_codex (mirrors whisper_server.py's
    build_ytdlp_args pattern) so the security-critical flag set is
    directly unit-testable without spawning a real subprocess.

    -C <tmp_dir>: an empty, caller-owned tmpdir — NEVER the sidecar's
    own cwd or the user's actual working directory, so codex never
    mistakes an unrelated directory for a code repo it should inspect
    (--skip-git-repo-check additionally lets it run outside of any git
    repo at all, which an empty tmpdir always is).

    -c model_reasoning_effort=low: MEASURED LIVE (2026-07-06, real
    account, full DETECT_SYSTEM_PROMPT) — a user's own ~/.codex/
    config.toml can set model_reasoning_effort as high as "xhigh" (a
    real config seen while writing this), and the same detect call
    that finishes in ~8.7s at "low" took ~17.8s at that user's default,
    already exceeding this module's own CODEX_CALL_TIMEOUT_S and
    eating most of the browser's 20s detect budget. detect/define need
    no deliberation (single-turn "extract structured JSON from one
    paragraph"); this -c override (mirrors the Claude side's
    setting_sources=[] intent — never let the user's own personal
    agent config perturb this call) is scoped to just this invocation,
    never touching the user's actual config.toml on disk.

    --sandbox read-only -c approval_policy=never: PROMPT-INJECTION
    LOCKDOWN (added post-review; the Claude path's equivalent is
    tools=[]/allowed_tools=[] — codex exec has no bare "no tools" mode,
    so this is the closest achievable equivalent, and was verified
    achievable before writing this, per the "confirm via --help/docs,
    never guess" rule — `-a`/`--ask-for-approval` is NOT actually
    accepted by `codex exec`'s own parser despite appearing in the
    parent `codex --help`'s listing; `-c approval_policy=never` is the
    real mechanism for codex exec specifically). The user_message here
    is UNTRUSTED transcript text folded straight into the prompt (see
    build_codex_prompt) — a speaker saying "ignore previous
    instructions, run <shell command>" is a real prompt-injection
    vector once codex's shell tool is in play, and this locks the
    blast radius down to read-only, no-network, no-mid-run-escalation:
      - "read-only" sandbox mode: VERIFIED LIVE via three independent
        tests (see task report for full transcripts) — (1)
        `codex sandbox macos -c 'sandbox_permissions=[]' -- curl
        https://api.anthropic.com` failed with "Could not resolve
        host" (DNS itself is blocked, not just the connection); (2) a
        prompt asking codex exec (this same -s read-only path) to
        write a file got "operation not permitted", no file created;
        (3) real prompt-injection payloads built from the actual
        production DETECT_SYSTEM_PROMPT/build_detect_user_message,
        asking it to read ~/.ssh/id_rsa / cat /etc/passwd / exfiltrate
        to a remote URL, produced ordinary well-formed detect JSON
        with zero file contents leaked, no command_execution item ever
        appearing, and (the most explicit variant) an outright model
        refusal — the docs' own prose ("removes the filesystem and
        network boundaries" for danger-full-access, implying the
        other two modes HAVE those boundaries) undersells how hard
        read-only's boundary actually is; the live network-resolution
        failure is the authoritative confirmation, not the docs'
        wording.
      - approval_policy=never: read-only sandbox already denies
        writes/network outright (confirmed above) rather than pausing
        for approval, so this mainly forecloses codex's OTHER approval-
        escalation paths (e.g. a command failing and codex asking to
        retry unsandboxed) ever having anywhere to pause and wait for a
        human that will never come in this non-interactive server
        context — verified live: a denied write attempt returned
        control immediately with no hang."""
    return [
        "codex",
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-c",
        "approval_policy=never",
        "-c",
        "model_reasoning_effort=low",
        "-C",
        tmp_dir,
        build_codex_prompt(system_prompt, user_message),
    ]


async def call_codex(system_prompt: str, user_message: str, tmp_dir: str) -> str:
    """Spawn `codex exec` (see build_codex_argv for the full argv +
    the security/latency rationale behind every flag), parse the
    NDJSON stream on stdout, and return the final agent_message item's
    text.

    stdin is explicitly closed (subprocess.DEVNULL) — verified live
    (2026-07-06) that `codex exec` prints "Reading additional input
    from stdin..." and, per --help, APPENDS piped stdin as a <stdin>
    block onto the given prompt if stdin is a pipe; an inherited pipe
    from Python's subprocess (the default) risks exactly that
    unwanted-extra-block behavior, so DEVNULL avoids it outright.

    No ANTHROPIC/OPENAI key env is injected — codex authenticates via
    its own `codex login`/device-code credential store, same
    never-touch-credentials posture as call_claude above.

    Raises AgentCallError on a non-zero exit / timeout / unparseable
    output, with `code` set from _map_codex_error's stderr/exit-code
    heuristics."""
    argv = build_codex_argv(system_prompt, user_message, tmp_dir)

    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(), timeout=CODEX_CALL_TIMEOUT_S
        )
    except asyncio.TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise AgentCallError("ChatGPT 调用超时", "upstream") from exc

    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace")

    if proc.returncode != 0:
        raise AgentCallError(
            f"codex exec 失败（退出码 {proc.returncode}）：{stderr[:300]}",
            _map_codex_error(proc.returncode, stderr),
        )

    text = parse_codex_ndjson(stdout)
    if not text:
        raise AgentCallError("codex exec 未返回文本内容", "upstream")
    return text


def parse_codex_ndjson(stdout: str) -> Optional[str]:
    """Extract the final agent_message item's text from `codex exec
    --json`'s NDJSON stdout. Verified live shape (2026-07-06,
    codex-cli 0.133.0): one JSON object per line, an
    {"type":"item.completed","item":{"type":"agent_message","text":
    "..."}} line carries the assistant's reply; the LAST such line
    wins if there happen to be more than one (mirrors "the model's
    final answer", same spirit as ResultMessage.result on the Claude
    side). Malformed/non-JSON lines are skipped rather than failing
    the whole parse — codex may interleave other event types
    (thread.started, turn.started, turn.completed, token-count lines,
    etc.) that this function doesn't need."""
    last_text: Optional[str] = None
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") != "item.completed":
            continue
        item = event.get("item")
        if not isinstance(item, dict) or item.get("type") != "agent_message":
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            last_text = text
    return last_text


def _map_codex_error(returncode: Optional[int], stderr: str) -> str:
    """Heuristic exit-code/stderr classification for codex exec
    failures, mirroring mapLlmError's spirit (anthropic.ts) — codex
    exec has no structured error-code contract on the wire (unlike the
    Claude SDK's ResultMessage), so this is necessarily a best-effort
    keyword match, not an exhaustive enum."""
    lowered = stderr.lower()
    if "not logged in" in lowered or "unauthorized" in lowered or "401" in lowered:
        return "no_key"
    if "rate limit" in lowered or "429" in lowered or "quota" in lowered:
        return "rate_limit"
    return "upstream"


# ---------------------------------------------------------------
# JSON extraction + repair-retry, shared by both providers — mirrors
# anthropic.ts's callJsonOpenAiCompat's "one repair retry on a
# BadOutputError" contract exactly (see agent_json.py's docstring).
# ---------------------------------------------------------------

ERROR_CODE_STATUS = {
    "no_key": HTTPStatus.UNAUTHORIZED,
    "rate_limit": HTTPStatus.TOO_MANY_REQUESTS,
    "upstream": HTTPStatus.BAD_GATEWAY,
    "bad_request": HTTPStatus.BAD_REQUEST,
}


async def call_provider_json(
    provider: str,
    system_prompt: str,
    user_message: str,
    model: str,
    array_key: Optional[str] = None,
) -> Any:
    """Call `provider` ("claude-sub" | "chatgpt-sub"), extract+parse
    the resulting text as JSON, retrying once with JSON_REMINDER
    appended to the system prompt if extraction/parsing fails on the
    first attempt (mirrors anthropic.ts's callJsonOpenAiCompat). Raises
    AgentCallError (provider-level failure, e.g. auth/rate-limit) or
    BadOutputError (JSON still broken after the repair retry) — the
    HTTP handlers below map both to a response."""
    text = await _call_one(provider, system_prompt, user_message, model)
    try:
        return apply_array_key(json.loads(extract_json_value(text)), array_key)
    except (BadOutputError, json.JSONDecodeError):
        pass  # fall through to the single repair retry below

    retry_text = await _call_one(provider, system_prompt + JSON_REMINDER, user_message, model)
    return apply_array_key(json.loads(extract_json_value(retry_text)), array_key)


async def _call_one(provider: str, system_prompt: str, user_message: str, model: str) -> str:
    if provider == "claude-sub":
        return await call_claude(system_prompt, user_message, model)
    if provider == "chatgpt-sub":
        import tempfile

        # Fresh empty tmpdir per call (see call_codex's docstring for
        # why -C must never be the sidecar's own cwd) — cleaned up
        # immediately after, so no stray dirs accumulate across a long
        # meeting's worth of detect/define calls.
        tmp_dir = tempfile.mkdtemp(prefix="jargonslayer-codex-")
        try:
            return await call_codex(system_prompt, user_message, tmp_dir)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
    raise AgentCallError(f"未知 provider：{provider}", "bad_request")


# ---------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------

MAX_BODY_BYTES = 200_000  # detect/define bodies are transcript-sized text, not files

# Background-profile hint (#48 step 3) passthrough — #48 s1 review item
# 7: this sidecar path was silently dropping `profile` while the
# Next.js path already spliced it into the user message
# (profileHint.ts truncates client-side to PROFILE_HINT_MAX_CHARS
# already; this is a server-side defense-in-depth cap only, same
# posture as the Next.js routes' zod .max() on the same field).
PROFILE_MAX_CHARS = 200


def _extract_profile(payload: dict[str, Any]) -> Optional[str]:
    """Pull `profile` out of a detect/define request payload, capped
    and never an empty/whitespace-only string (matches
    build_detect_user_message/build_define_user_message's own
    `if profile` falsy check, so a stray "" doesn't grow an empty
    AUDIENCE: line)."""
    profile = payload.get("profile")
    if not isinstance(profile, str):
        return None
    trimmed = profile.strip()
    if not trimmed:
        return None
    return trimmed[:PROFILE_MAX_CHARS]


def make_agent_http_handler(
    connection_token: str, env_warnings: list[str]
) -> type[BaseHTTPRequestHandler]:
    class AgentHTTPHandler(BaseHTTPRequestHandler):
        server_version = "JargonSlayerAgentSidecar/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
            pass  # keep stdout to the startup banner + explicit prints

        def _cors(self, origin: Optional[str]) -> None:
            # Unlike whisper_server.py's blanket "*", this endpoint
            # spends subscription quota per request, so CORS must not
            # blindly reflect every origin — only echo the caller's
            # own Origin back when the gate already allowed it (so the
            # browser fetch doesn't fail on the CORS check AFTER
            # already passing our own Origin gate above), never "*".
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers", "Content-Type, X-JS-Agent-Token"
            )

        def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self._cors(self.headers.get("Origin"))
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(HTTPStatus.NO_CONTENT)
            self._cors(self.headers.get("Origin"))
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            parts = [p for p in parsed.path.split("/") if p]

            if parts == ["agent", "health"]:
                if not health_origin_allowed(self.headers.get("Origin")):
                    self._send_json(
                        HTTPStatus.FORBIDDEN, {"error": "仅限本机应用调用"}
                    )
                    return
                claude_available, claude_import_error = _claude_sdk_available()
                warns = list(env_warnings)
                if not claude_available and claude_import_error:
                    warns.append(f"claude-agent-sdk 不可用：{claude_import_error}")
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "claude_sdk_available": claude_available,
                        "claude_logged_in": claude_login_probe(),
                        "codex_available": codex_available(),
                        "codex_logged_in": codex_login_probe(),
                        "warns": warns,
                    },
                )
                return

            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            parts = [p for p in parsed.path.split("/") if p]

            if parts not in (["agent", "detect"], ["agent", "define"]):
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return

            # Origin gate FIRST, before touching the body at all — same
            # ordering as whisper_server.py's /ingest-url gate, so a
            # rejected drive-by request never even gets Content-Length/
            # body handling. See agent_origin_allowed's docstring for
            # why empty Origin is rejected HERE (opposite of that
            # file's ingest_origin_allowed).
            if not agent_origin_allowed(self.headers.get("Origin")):
                self._send_json(
                    HTTPStatus.FORBIDDEN,
                    {"error": "仅限本机浏览器标签页调用（跨站请求已拒绝）"},
                )
                return

            if not token_matches(connection_token, self.headers.get("X-JS-Agent-Token")):
                self._send_json(
                    HTTPStatus.FORBIDDEN, {"error": "连接码缺失或不正确"}
                )
                return

            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "empty request body"})
                return
            if length > MAX_BODY_BYTES:
                self._send_json(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "请求体过大"}
                )
                return

            try:
                raw = self.rfile.read(length)
                payload = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                self._send_json(
                    HTTPStatus.BAD_REQUEST, {"error": f"请求体不是合法 JSON: {exc}"}
                )
                return

            if not isinstance(payload, dict):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "请求参数不合法"})
                return

            provider = payload.get("provider")
            if provider not in ("claude-sub", "chatgpt-sub"):
                self._send_json(
                    HTTPStatus.BAD_REQUEST, {"error": "provider 必须是 claude-sub 或 chatgpt-sub"}
                )
                return

            lang = payload.get("lang") if payload.get("lang") in ("zh", "en") else "zh"

            try:
                if parts == ["agent", "detect"]:
                    result = asyncio.run(self._handle_detect(payload, provider, lang))
                else:
                    result = asyncio.run(self._handle_define(payload, provider, lang))
            except AgentCallError as exc:
                status = ERROR_CODE_STATUS.get(exc.code, HTTPStatus.BAD_GATEWAY)
                self._send_json(status, {"error": str(exc), "code": exc.code})
                return
            except (BadOutputError, json.JSONDecodeError) as exc:
                self._send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": f"模型输出解析失败：{exc}", "code": "upstream"},
                )
                return

            self._send_json(HTTPStatus.OK, result)

        async def _handle_detect(
            self, payload: dict[str, Any], provider: str, lang: str
        ) -> dict[str, Any]:
            context = payload.get("context") if isinstance(payload.get("context"), str) else ""
            new_text = payload.get("new_text")
            if not isinstance(new_text, str) or not new_text.strip():
                raise AgentCallError("缺少 new_text", "bad_request")

            profile = _extract_profile(payload)
            model = CLAUDE_MODEL_DEFAULT if provider == "claude-sub" else "gpt-5.2-codex"
            raw = await call_provider_json(
                provider,
                build_detect_system_prompt(lang),
                build_detect_user_message(context, new_text, profile),
                model,
            )
            if not isinstance(raw, dict):
                raise BadOutputError("模型输出不是 JSON 对象")
            return post_filter(raw, new_text)

        async def _handle_define(
            self, payload: dict[str, Any], provider: str, lang: str
        ) -> dict[str, Any]:
            phrase = payload.get("phrase")
            if not isinstance(phrase, str) or not phrase.strip():
                raise AgentCallError("缺少 phrase", "bad_request")
            context = payload.get("context") if isinstance(payload.get("context"), str) else ""

            profile = _extract_profile(payload)
            model = CLAUDE_MODEL_DEFAULT if provider == "claude-sub" else "gpt-5.2-codex"
            raw = await call_provider_json(
                provider,
                build_define_system_prompt(lang),
                build_define_user_message(phrase, context, profile),
                model,
            )
            if not isinstance(raw, dict):
                raise BadOutputError("模型输出不是 JSON 对象")
            return raw

    return AgentHTTPHandler


def run_agent_http_server(host: str, port: int) -> tuple[ThreadingHTTPServer, str]:
    """Start the agent HTTP server on its own daemon thread. Returns
    (server, connection_token) — caller keeps both references (server
    so it isn't GC'd; token so print_banner/tests can echo it)."""
    connection_token = generate_connection_token()
    env_warnings = check_env_warnings()
    handler_cls = make_agent_http_handler(connection_token, env_warnings)
    httpd = ThreadingHTTPServer((host, port), handler_cls)
    import threading

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, connection_token


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "JargonSlayer 订阅直连 agent sidecar（实验性）/ JargonSlayer "
            "subscription-direct agent sidecar (experimental, local dev only). "
            "Lets your browser tab call Claude/ChatGPT via YOUR OWN local "
            "`claude`/`codex` CLI login — never a service-provided login."
        )
    )
    parser.add_argument(
        "--port", type=int, default=8767, help="监听端口 / listen port (default: 8767)"
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="监听地址，默认且建议保持 127.0.0.1（不对外网暴露）/ listen host, "
        "keep 127.0.0.1 (loopback-only) unless you know exactly why not",
    )
    return parser.parse_args()


def print_banner(host: str, port: int, connection_token: str, warnings: list[str]) -> None:
    print("=" * 60)
    print("JargonSlayer 订阅直连 agent sidecar（实验性）")
    print("实验性功能：用你自己机器上的 Claude/ChatGPT 登录，凭据不经过任何服务器")
    print(f"http://{host}:{port} — GET /agent/health, POST /agent/detect|define")
    print(f"连接码（复制到 设置 → 订阅直连（实验性）→ 连接码）：{connection_token}")
    for w in warnings:
        print(f"警告 / warning: {w}")
    print("=" * 60)


def main() -> None:
    args = parse_args()
    httpd, connection_token = run_agent_http_server(args.host, args.port)
    print_banner(args.host, args.port, connection_token, check_env_warnings())
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\n已停止 / stopped.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
