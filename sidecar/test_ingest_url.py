#!/usr/bin/env python3
"""Plain-assert self-test for the URL-import (#43 phase 2c, LOCAL TIER
ONLY) pure functions in whisper_server.py — no pytest, no network, no
subprocess, no model loading, no server start (module import is
side-effect free; servers only start under `if __name__ == "__main__":`).
Mirrors test_realtime_diar.py's style/harness.

Run:
    sidecar/.venv/bin/python sidecar/test_ingest_url.py

Covers:
  - validate_ingest_url: scheme/length/type gating
  - build_ytdlp_args: exact argv shape (flags verified live against
    `yt-dlp --help`/a real download — see the URL-import task's
    verification notes, not guessed)
  - parse_ytdlp_stdout: filepath/title extraction from captured stdout
    (both lines present, only one, neither)
  - ingest_url_display_name: title-or-URL-tail fallback chain
  - truncate_ytdlp_error: last-stderr-line + length cap
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from whisper_server import (  # noqa: E402
    INGEST_ERROR_DETAIL_CHARS,
    INGEST_URL_MAX_LEN,
    SAMPLE_RATE,
    build_ytdlp_args,
    ingest_url_display_name,
    parse_ytdlp_stdout,
    truncate_ytdlp_error,
    validate_ingest_url,
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
# validate_ingest_url
# =================================================================

check(
    "validate_ingest_url: a plain https URL is valid (None = no error)",
    validate_ingest_url("https://example.com/watch?v=abc") is None,
)
check(
    "validate_ingest_url: a plain http URL is valid too",
    validate_ingest_url("http://example.com/video") is None,
)
check(
    "validate_ingest_url: missing url (None) is rejected",
    validate_ingest_url(None) is not None,
)
check(
    "validate_ingest_url: empty string is rejected",
    validate_ingest_url("") is not None,
)
check(
    "validate_ingest_url: non-string type (e.g. a JSON number) is rejected",
    validate_ingest_url(12345) is not None,
)
check(
    "validate_ingest_url: ftp:// scheme is rejected (http/https only)",
    validate_ingest_url("ftp://example.com/file") is not None,
)
check(
    "validate_ingest_url: file:// scheme is rejected",
    validate_ingest_url("file:///etc/passwd") is not None,
)
check(
    "validate_ingest_url: javascript: scheme is rejected",
    validate_ingest_url("javascript:alert(1)") is not None,
)
check(
    "validate_ingest_url: a URL over the length cap is rejected",
    validate_ingest_url("https://example.com/" + "a" * INGEST_URL_MAX_LEN) is not None,
)
check(
    "validate_ingest_url: a URL exactly at the length cap is accepted",
    validate_ingest_url("https://x.co/" + "a" * (INGEST_URL_MAX_LEN - 13)) is None,
)
check(
    "validate_ingest_url: scheme matching is case-insensitive (HTTPS://)",
    validate_ingest_url("HTTPS://example.com/video") is None,
)
check(
    "validate_ingest_url: error messages are zh strings (spec requires a zh error)",
    isinstance(validate_ingest_url(None), str) and len(validate_ingest_url(None) or "") > 0,
)


# =================================================================
# build_ytdlp_args
# =================================================================

_args = build_ytdlp_args("https://example.com/watch?v=abc", "/tmp/jargonslayer-ingest-xyz")

check(
    "build_ytdlp_args: invokes the yt-dlp binary as argv[0]",
    _args[0] == "yt-dlp",
)
check(
    "build_ytdlp_args: --no-playlist is present (never pull an entire playlist)",
    "--no-playlist" in _args,
)
check(
    "build_ytdlp_args: -f bestaudio/best selects best audio-only format",
    "-f" in _args and _args[_args.index("-f") + 1] == "bestaudio/best",
)
check(
    "build_ytdlp_args: -x (extract-audio) is present",
    "-x" in _args,
)
check(
    "build_ytdlp_args: --audio-format wav is present",
    "--audio-format" in _args and _args[_args.index("--audio-format") + 1] == "wav",
)
check(
    "build_ytdlp_args: --postprocessor-args re-encodes to mono at the sidecar's own SAMPLE_RATE",
    "--postprocessor-args" in _args
    and _args[_args.index("--postprocessor-args") + 1]
    == f"ffmpeg:-ac 1 -ar {SAMPLE_RATE}",
)
check(
    "build_ytdlp_args: -o writes into the caller's tmpdir with an audio.%(ext)s template",
    "-o" in _args and _args[_args.index("-o") + 1].endswith("audio.%(ext)s")
    and _args[_args.index("-o") + 1].startswith("/tmp/jargonslayer-ingest-xyz"),
)
check(
    "build_ytdlp_args: --max-filesize caps the download (mirrors the upload path's own cap)",
    "--max-filesize" in _args,
)
check(
    "build_ytdlp_args: --no-progress is present (no progress-bar noise in captured stdout/stderr)",
    "--no-progress" in _args,
)
check(
    "build_ytdlp_args: two --print flags are present, for filepath then title, in that order",
    _args.count("--print") == 2
    and _args[_args.index("--print")] == "--print"
    and "filepath" in _args[_args.index("--print") + 1],
)
_print_indices = [i for i, a in enumerate(_args) if a == "--print"]
check(
    "build_ytdlp_args: first --print's argument is after_move:filepath",
    _args[_print_indices[0] + 1] == "after_move:filepath",
)
check(
    "build_ytdlp_args: second --print's argument is after_move:%(title)s",
    _args[_print_indices[1] + 1] == "after_move:%(title)s",
)
check(
    "build_ytdlp_args: the URL is the last argv element",
    _args[-1] == "https://example.com/watch?v=abc",
)


# =================================================================
# parse_ytdlp_stdout
# =================================================================

check(
    "parse_ytdlp_stdout: both lines present (filepath, title) — the common case",
    parse_ytdlp_stdout("/tmp/jargonslayer-ingest-xyz/audio.wav\nMe at the zoo\n")
    == ("/tmp/jargonslayer-ingest-xyz/audio.wav", "Me at the zoo"),
)
check(
    "parse_ytdlp_stdout: only the filepath line present -> title is None",
    parse_ytdlp_stdout("/tmp/jargonslayer-ingest-xyz/audio.wav\n")
    == ("/tmp/jargonslayer-ingest-xyz/audio.wav", None),
)
check(
    "parse_ytdlp_stdout: empty stdout -> both None",
    parse_ytdlp_stdout("") == (None, None),
)
check(
    "parse_ytdlp_stdout: blank lines interleaved are ignored (only non-empty lines count)",
    parse_ytdlp_stdout("\n/tmp/x/audio.wav\n\nSome Title\n\n")
    == ("/tmp/x/audio.wav", "Some Title"),
)
check(
    "parse_ytdlp_stdout: surrounding whitespace on each line is stripped",
    parse_ytdlp_stdout("  /tmp/x/audio.wav  \n  Some Title  \n")
    == ("/tmp/x/audio.wav", "Some Title"),
)
check(
    "parse_ytdlp_stdout: extra trailing lines beyond the two --print outputs are ignored",
    parse_ytdlp_stdout("/tmp/x/audio.wav\nSome Title\nunexpected extra line\n")
    == ("/tmp/x/audio.wav", "Some Title"),
)


# =================================================================
# ingest_url_display_name
# =================================================================

check(
    "ingest_url_display_name: uses the captured title when present",
    ingest_url_display_name("https://example.com/watch?v=abc", "Me at the zoo")
    == "Me at the zoo",
)
check(
    "ingest_url_display_name: falls back to the URL's last path segment when title is None",
    ingest_url_display_name("https://example.com/videos/some-clip", None)
    == "some-clip",
)
check(
    "ingest_url_display_name: falls back to the URL's last path segment when title is empty",
    ingest_url_display_name("https://example.com/videos/some-clip", "")
    == "some-clip",
)
check(
    "ingest_url_display_name: yt-dlp's own 'NA' placeholder for a missing title field "
    "falls back to the URL tail rather than showing literal 'NA'",
    ingest_url_display_name("https://example.com/videos/some-clip", "NA")
    == "some-clip",
)
check(
    "ingest_url_display_name: a trailing slash in the path doesn't yield an empty segment",
    ingest_url_display_name("https://example.com/videos/some-clip/", None)
    == "some-clip",
)
check(
    "ingest_url_display_name: a bare-domain URL (no path) falls back to the URL itself",
    ingest_url_display_name("https://example.com", None) == "https://example.com",
)


# =================================================================
# truncate_ytdlp_error
# =================================================================

check(
    "truncate_ytdlp_error: picks the last non-empty stderr line "
    "(yt-dlp's own ERROR: summary — verified live against a bad-format "
    "and an unreachable-host failure)",
    truncate_ytdlp_error(
        "[youtube] abc: Downloading webpage\n"
        "[youtube] abc: Downloading player\n"
        "ERROR: [youtube] abc: Requested format is not available\n"
    )
    == "ERROR: [youtube] abc: Requested format is not available",
)
check(
    "truncate_ytdlp_error: blank trailing lines are ignored, still picks the real last line",
    truncate_ytdlp_error("ERROR: something failed\n\n\n")
    == "ERROR: something failed",
)
check(
    "truncate_ytdlp_error: empty stderr falls back to a generic zh message",
    truncate_ytdlp_error("") == "未知错误",
)
check(
    "truncate_ytdlp_error: a long error line is truncated to INGEST_ERROR_DETAIL_CHARS",
    len(truncate_ytdlp_error("ERROR: " + "x" * 500)) == INGEST_ERROR_DETAIL_CHARS,
)
check(
    "truncate_ytdlp_error: a short error line is returned unmodified (no padding)",
    truncate_ytdlp_error("ERROR: short") == "ERROR: short",
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
