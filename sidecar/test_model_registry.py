#!/usr/bin/env python3
"""Plain-assert self-test for whisper_server.py's S12a model->(repo_id,
allow_patterns) registry (docs/design-explorations/s12-mlx-blueprint.md
§C R1, §B findings 10/12) — no pytest. Split out of test_download.py
(which deliberately never imports huggingface_hub/faster_whisper — see
its own module docstring) because these checks need a controlled fake
import surface for BOTH packages to prove things at the huggingface_hub
call-argument level (token/allow_patterns/cache_dir) without ever
touching the network or installing anything into any venv. Mirrors
test_whisper_protocol.py's sys.modules-fake idiom (used there for
pyannote.audio) and test_download.py's shutil.disk_usage save/restore
idiom.

Run:
    sidecar/.venv/bin/python sidecar/test_model_registry.py

Covers:
  - MODEL_CHOICES/PARAKEET_MODEL/PARAKEET_REPO_ID/PARAKEET_ALLOW_
    PATTERNS/MODEL_DOWNLOAD_ALLOW_PATTERNS/WHISPER_REPO_IDS: exact
    constant values
  - _repo_id_for_model / _allow_patterns_for_model (the registry's two
    halves): parakeet resolves to its static PARAKEET_REPO_ID; every
    whisper-family model resolves via the static WHISPER_REPO_IDS map
    — NO faster_whisper import at all (S12a fix round F3, HIGH, Sol3,
    docs/design-explorations/s12-mlx-blueprint.md §D — the ORIGINAL
    lazy `from faster_whisper.utils import _MODELS` lookup broke
    switching back from parakeet to a whisper model once the server
    ran under the mlx venv, which never installs faster_whisper).
    Two dedicated F3 sections: (1) a base-venv drift guard asserting
    WHISPER_REPO_IDS matches the REAL installed faster_whisper.utils.
    _MODELS exactly (guarded/SKIP if unavailable); (2) an import-
    BLOCKED test (faster_whisper genuinely unimportable via
    sys.modules, mirroring test_whisper_protocol.py's pyannote idiom)
    resolving EVERY MODEL_CHOICES id, RED-verified against the pre-fix
    code (see git history / the worker report for the red-run
    transcript)
  - download_model_snapshot, driven end-to-end against a FAKE
    huggingface_hub (sys.modules-faked HfApi/constants/
    snapshot_download — never a real import/network call):
      - resolves the right repo_id per model
      - threads hf_token into BOTH HfApi().model_info() and
        snapshot_download() (S12a Q6/F11)
      - passes the model's own allow_patterns (parakeet's 2-file set
        vs. whisper's 5-pattern set) to snapshot_download, and NEVER
        an extra cache_dir kwarg (the cache-root invariant, §B finding
        10 — see below)
      - the sidecar-side ×1.2 disk precheck (check_disk_space, faked
        to just capture its argument) receives the HONEST allow_
        patterns-filtered total: parakeet's model.safetensors
        (2,508,288,736B, live 2026-07-16) + config.json (244,093B) =
        2,508,532,829B (~2.51GB) — excluding the repo's tokenizer/
        vocab files entirely (§B finding 12: the earlier ~1GB estimate
        was off by 2.5x)
  - cache-root invariant (§B finding 10), against the REAL installed
    huggingface_hub (guarded — SKIP if not importable, same posture as
    test_download.py's tqdm-optional section): hf_hub_download (what
    parakeet_mlx.from_pretrained calls, S12b) and snapshot_download
    (what download_model_snapshot calls) both default an unset
    cache_dir to the literal SAME constants.HF_HUB_CACHE module
    attribute — a structural guarantee, not a coincidence — and that
    attribute derives from HF_HOME as <HF_HOME>/hub when not
    independently overridden (live subprocess probe, controlled env)
  - parse_args(): --model accepts the parakeet id via MODEL_CHOICES
  - normalize_hf_token / parse_args's ONE normalization point (S12a fix
    round F8, LOW, Sol8, §D): a whitespace-only --hf-token/$HF_TOKEN
    value becomes None (was truthy pre-fix — falsely advertised
    diarization as armed and sent garbage as an Authorization value);
    covers the pure function directly plus both real sources parse_args()
    unifies (CLI flag + $HF_TOKEN env fallback, via os.environ mutation
    — no faking needed, argparse's own default reads it fresh per call)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import whisper_server  # noqa: E402 - module import, for monkeypatching below

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


_UNSET = object()


# =================================================================
# Constants — exact values (regression guard against an accidental
# edit during the registry refactor).
# =================================================================

check(
    "PARAKEET_MODEL: exactly 'parakeet-tdt-0.6b-v3', the id MODEL_CHOICES/"
    "validate_download_model/argparse all gate on",
    whisper_server.PARAKEET_MODEL == "parakeet-tdt-0.6b-v3",
)
check(
    "PARAKEET_REPO_ID: exactly mlx-community/parakeet-tdt-0.6b-v3",
    whisper_server.PARAKEET_REPO_ID == "mlx-community/parakeet-tdt-0.6b-v3",
)
check(
    "PARAKEET_ALLOW_PATTERNS: exactly the 2 files parakeet_mlx.from_pretrained "
    "reads (verified live against the installed parakeet_mlx==0.5.2 wheel's "
    "utils.from_pretrained source, unzipped — not installed into any venv — "
    "see whisper_server.py's own docstring) — no tokenizer/vocab files",
    whisper_server.PARAKEET_ALLOW_PATTERNS == ["config.json", "model.safetensors"],
)
check(
    "MODEL_DOWNLOAD_ALLOW_PATTERNS: unchanged, still exactly the 5 faster-"
    "whisper entries (byte-identical to pre-S12a)",
    whisper_server.MODEL_DOWNLOAD_ALLOW_PATTERNS
    == [
        "config.json",
        "preprocessor_config.json",
        "model.bin",
        "tokenizer.json",
        "vocabulary.*",
    ],
)
check(
    "MODEL_CHOICES: PARAKEET_MODEL is the literal constant used, not a "
    "hand-duplicated string",
    whisper_server.MODEL_CHOICES[-1] is whisper_server.PARAKEET_MODEL
    or whisper_server.MODEL_CHOICES[-1] == whisper_server.PARAKEET_MODEL,
)


# =================================================================
# _repo_id_for_model / _allow_patterns_for_model — the registry's two
# halves. Since the S12a fix round (F3, HIGH, Sol3 — docs/design-
# explorations/s12-mlx-blueprint.md §D), _repo_id_for_model no longer
# imports faster_whisper AT ALL for whisper-family models — it's a
# static WHISPER_REPO_IDS dict lookup. The two sections below are F3's
# own required tests: (1) a base-venv drift guard against the REAL
# installed faster_whisper.utils._MODELS (guarded/SKIP if unavailable,
# same posture as the cache-root-invariant section further down); (2)
# an import-BLOCKED test (faster_whisper made unimportable via
# sys.modules — the exact "= None" force-ImportError idiom test_
# whisper_protocol.py uses for pyannote) proving every MODEL_CHOICES
# id still resolves. (2) is RED-verified: run against the pre-fix
# whisper_server.py (which lazily imported faster_whisper.utils inside
# the non-parakeet branch), the same block reproduces Sol's finding —
# `_repo_id_for_model("medium")` raised ModuleNotFoundError.
# =================================================================

check(
    "_repo_id_for_model: parakeet resolves to PARAKEET_REPO_ID",
    whisper_server._repo_id_for_model(whisper_server.PARAKEET_MODEL)
    == whisper_server.PARAKEET_REPO_ID,
)
check(
    "_repo_id_for_model: every whisper-family MODEL_CHOICES entry resolves "
    "via the static WHISPER_REPO_IDS map",
    all(
        whisper_server._repo_id_for_model(m) == whisper_server.WHISPER_REPO_IDS[m]
        for m in whisper_server.MODEL_CHOICES
        if m != whisper_server.PARAKEET_MODEL
    ),
)
_raised: Exception | None = None
try:
    whisper_server._repo_id_for_model("unknown-model-xyz")
except ValueError as exc:  # noqa: BLE001 - capturing intentionally
    _raised = exc
check(
    "_repo_id_for_model: an unknown non-parakeet model still raises "
    "ValueError with the 未知模型 zh message, unchanged",
    _raised is not None and "未知模型" in str(_raised),
)

check(
    "_allow_patterns_for_model: parakeet returns PARAKEET_ALLOW_PATTERNS exactly",
    whisper_server._allow_patterns_for_model(whisper_server.PARAKEET_MODEL)
    == whisper_server.PARAKEET_ALLOW_PATTERNS,
)
check(
    "_allow_patterns_for_model: every whisper model keeps "
    "MODEL_DOWNLOAD_ALLOW_PATTERNS, unchanged",
    whisper_server._allow_patterns_for_model("small")
    == whisper_server.MODEL_DOWNLOAD_ALLOW_PATTERNS,
)
check(
    "WHISPER_REPO_IDS: covers exactly the 6 whisper-family MODEL_CHOICES "
    "entries, no more/fewer",
    set(whisper_server.WHISPER_REPO_IDS)
    == set(whisper_server.MODEL_CHOICES) - {whisper_server.PARAKEET_MODEL},
)


# =================================================================
# F3 test (1): base-venv drift guard — WHISPER_REPO_IDS must match the
# REAL installed faster_whisper.utils._MODELS exactly, for every key it
# claims. Guarded/SKIP if faster_whisper isn't importable (this file's
# own posture elsewhere — see the cache-root-invariant section further
# down); when it IS available (this repo's own sidecar/.venv, base
# pins), this is a real, non-faked assertion against the live package,
# not a fixture — a future faster-whisper bump that moves one of these
# 6 entries fails this check loudly instead of silently drifting.
# =================================================================

try:
    from faster_whisper.utils import _MODELS as _REAL_FASTER_WHISPER_MODELS

    _FW_AVAILABLE = True
except ImportError as exc:  # pragma: no cover - only if faster_whisper truly isn't installed
    _FW_AVAILABLE = False
    print(f"SKIP: WHISPER_REPO_IDS drift-guard section (faster_whisper not importable: {exc})")

if _FW_AVAILABLE:
    for _model, _expected_repo_id in whisper_server.WHISPER_REPO_IDS.items():
        check(
            f"WHISPER_REPO_IDS drift guard: '{_model}' matches the live installed "
            "faster_whisper.utils._MODELS exactly",
            _REAL_FASTER_WHISPER_MODELS.get(_model) == _expected_repo_id,
        )


# =================================================================
# F3 test (2): import-BLOCKED — faster_whisper made unimportable via
# sys.modules (the "= None" idiom; a dotted import needs the PARENT
# key blocked too), mirroring test_whisper_protocol.py's pyannote-not-
# installed idiom exactly. Every MODEL_CHOICES id (whisper-family AND
# parakeet) must still resolve via _repo_id_for_model AND survive a
# full download_model_snapshot() call (huggingface_hub itself faked
# below too, so this stays fully offline) — the literal real-world
# regression: switching from parakeet back to a whisper model inside
# the mlx venv, where faster_whisper is genuinely absent.
# =================================================================


def _block_faster_whisper() -> dict[str, object]:
    saved: dict[str, object] = {
        name: sys.modules.get(name, _UNSET)
        for name in ("faster_whisper", "faster_whisper.utils")
    }
    sys.modules.pop("faster_whisper", None)
    sys.modules["faster_whisper.utils"] = None  # type: ignore[assignment]
    return saved


def _unblock_faster_whisper(saved: dict[str, object]) -> None:
    for name, prev in saved.items():
        if prev is _UNSET:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = prev  # type: ignore[assignment]


_saved_fw_block = _block_faster_whisper()
try:
    _raised_blocked: Exception | None = None
    try:
        import faster_whisper.utils  # noqa: F401 - proving the block actually works
    except ImportError as exc:  # noqa: BLE001 - capturing intentionally
        _raised_blocked = exc
    check(
        "import-blocked harness sanity: `import faster_whisper.utils` genuinely "
        "raises ImportError while blocked (the block itself works)",
        _raised_blocked is not None,
    )

    check(
        "_repo_id_for_model: resolves EVERY MODEL_CHOICES id (incl. parakeet) "
        "with faster_whisper fully unimportable — the exact scenario a server "
        "running under the mlx venv (S12b) is in when a user switches back to "
        "a whisper model",
        all(
            whisper_server._repo_id_for_model(m)
            == (
                whisper_server.PARAKEET_REPO_ID
                if m == whisper_server.PARAKEET_MODEL
                else whisper_server.WHISPER_REPO_IDS[m]
            )
            for m in whisper_server.MODEL_CHOICES
        ),
    )
finally:
    _unblock_faster_whisper(_saved_fw_block)


# =================================================================
# download_model_snapshot end-to-end, against a FAKE huggingface_hub
# (sys.modules-faked — never a real import/network call). Proves
# token threading, allow_patterns wiring, the honest disk-precheck
# total, AND that no cache_dir kwarg is ever introduced (the cache-
# root invariant a real from_pretrained(cache_dir=None) load later
# relies on — see the live-package section below).
# =================================================================

# Exactly the live 2026-07-16 file listing for mlx-community/parakeet-
# tdt-0.6b-v3 (verified via the public HF Hub API, no auth needed —
# see whisper_server.py's PARAKEET_ALLOW_PATTERNS docstring), so this
# section's "honest total" assertion is checked against REAL sizes,
# not made-up round numbers.
_PARAKEET_SAFETENSORS_SIZE = 2_508_288_736
_PARAKEET_CONFIG_JSON_SIZE = 244_093
_PARAKEET_HONEST_TOTAL_BYTES = _PARAKEET_SAFETENSORS_SIZE + _PARAKEET_CONFIG_JSON_SIZE


class _FakeSibling:
    def __init__(self, rfilename: str, size: int) -> None:
        self.rfilename = rfilename
        self.size = size


class _FakeModelInfo:
    def __init__(self, siblings: list[_FakeSibling]) -> None:
        self.siblings = siblings


_FAKE_SIBLINGS = [
    _FakeSibling(".gitattributes", 1519),
    _FakeSibling("README.md", 1081),
    _FakeSibling("config.json", _PARAKEET_CONFIG_JSON_SIZE),
    _FakeSibling("model.safetensors", _PARAKEET_SAFETENSORS_SIZE),
    _FakeSibling("tokenizer.model", 360916),
    _FakeSibling("tokenizer.vocab", 101024),
    _FakeSibling("vocab.txt", 46772),
]


class _FakeHfApi:
    """Records every model_info(...) call's kwargs (repo_id/
    files_metadata/token — and any UNEXPECTED kwarg, via **kwargs, so
    a future cache_dir= addition here would show up as a captured call
    with an extra key rather than silently vanishing) and returns a
    fixed ModelInfo built from _FAKE_SIBLINGS."""

    model_info_calls: list[dict[str, object]] = []

    def model_info(self, repo_id, *, files_metadata=False, token=None, **kwargs):
        type(self).model_info_calls.append(
            {
                "repo_id": repo_id,
                "files_metadata": files_metadata,
                "token": token,
                "extra_kwargs": kwargs,
            }
        )
        return _FakeModelInfo(_FAKE_SIBLINGS)


snapshot_download_calls: list[dict[str, object]] = []


def _fake_snapshot_download(repo_id, *, allow_patterns=None, token=None, tqdm_class=None, **kwargs):
    snapshot_download_calls.append(
        {
            "repo_id": repo_id,
            "allow_patterns": allow_patterns,
            "token": token,
            "tqdm_class": tqdm_class,
            # Anything landing here (e.g. a cache_dir=) would be the
            # exact §B finding 10 regression — download_model_snapshot
            # must NEVER pass one; see the cache-root-invariant checks
            # below for why.
            "extra_kwargs": kwargs,
        }
    )
    return f"/fake/cache/{repo_id}"


_FAKE_HF_HUB_CACHE_DIR = str(Path(__file__).resolve().parent)  # any existing dir


def _set_fake_huggingface_hub() -> dict[str, object]:
    saved: dict[str, object] = {
        name: sys.modules.get(name, _UNSET)
        for name in ("huggingface_hub", "huggingface_hub.constants")
    }
    fake_hub = types.ModuleType("huggingface_hub")
    fake_hub.HfApi = _FakeHfApi  # type: ignore[attr-defined]
    fake_constants = types.ModuleType("huggingface_hub.constants")
    fake_constants.HF_HUB_CACHE = _FAKE_HF_HUB_CACHE_DIR  # type: ignore[attr-defined]
    fake_hub.constants = fake_constants  # type: ignore[attr-defined]
    fake_hub.snapshot_download = _fake_snapshot_download  # type: ignore[attr-defined]
    sys.modules["huggingface_hub"] = fake_hub
    sys.modules["huggingface_hub.constants"] = fake_constants
    return saved


def _restore_huggingface_hub(saved: dict[str, object]) -> None:
    for name, prev in saved.items():
        if prev is _UNSET:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = prev  # type: ignore[assignment]


_real_check_disk_space = whisper_server.check_disk_space
_captured_disk_check: list[tuple[int, str]] = []


def _fake_check_disk_space(total_bytes, check_dir):
    _captured_disk_check.append((total_bytes, check_dir))
    # Never raises — this section's own disk-precheck coverage is
    # test_download.py's job; here we only care about the `total`
    # this function was HANDED.


_saved_hub = _set_fake_huggingface_hub()
whisper_server.check_disk_space = _fake_check_disk_space
try:
    _FakeHfApi.model_info_calls.clear()
    snapshot_download_calls.clear()
    _captured_disk_check.clear()

    repo_id = whisper_server.download_model_snapshot(
        whisper_server.PARAKEET_MODEL, hf_token="probe-token"
    )

    check(
        "download_model_snapshot(parakeet): returns PARAKEET_REPO_ID",
        repo_id == whisper_server.PARAKEET_REPO_ID,
    )
    check(
        "download_model_snapshot(parakeet): HfApi().model_info() receives the "
        "exact repo_id",
        _FakeHfApi.model_info_calls[0]["repo_id"] == whisper_server.PARAKEET_REPO_ID,
    )
    check(
        "download_model_snapshot(parakeet): threads hf_token into HfApi()."
        "model_info() too (the metadata call is itself rate-limited — S12a Q6)",
        _FakeHfApi.model_info_calls[0]["token"] == "probe-token",
    )
    check(
        "download_model_snapshot(parakeet): HfApi().model_info() never receives "
        "a cache_dir (it doesn't take one — sanity: no stray extra kwargs at all)",
        _FakeHfApi.model_info_calls[0]["extra_kwargs"] == {},
    )
    check(
        "download_model_snapshot(parakeet): snapshot_download receives "
        "allow_patterns == PARAKEET_ALLOW_PATTERNS exactly (config.json + "
        "model.safetensors, no tokenizer/vocab files)",
        snapshot_download_calls[0]["allow_patterns"] == ["config.json", "model.safetensors"],
    )
    check(
        "download_model_snapshot(parakeet): threads hf_token into "
        "snapshot_download itself",
        snapshot_download_calls[0]["token"] == "probe-token",
    )
    check(
        "download_model_snapshot(parakeet): NEVER passes cache_dir to "
        "snapshot_download (cache-root invariant, §B finding 10) — omitting it "
        "lets both this download and a later from_pretrained(cache_dir=None) "
        "resolve the exact same default root",
        snapshot_download_calls[0]["extra_kwargs"] == {},
    )
    check(
        "download_model_snapshot(parakeet): the sidecar-side ×1.2 disk precheck "
        "receives the HONEST allow_patterns-filtered total — model.safetensors "
        "(2,508,288,736B) + config.json (244,093B) = 2,508,532,829B (~2.51GB), "
        "excluding the repo's unused tokenizer.model/tokenizer.vocab/vocab.txt/"
        ".gitattributes/README.md siblings entirely (§B finding 12: NOT the "
        "earlier ~1GB estimate, off by 2.5x)",
        _captured_disk_check[-1][0] == _PARAKEET_HONEST_TOTAL_BYTES,
    )
finally:
    whisper_server.check_disk_space = _real_check_disk_space
    _restore_huggingface_hub(_saved_hub)


# Whisper-family path through the SAME download_model_snapshot, driven
# through the SAME fake huggingface_hub, with faster_whisper BLOCKED
# entirely (F3's own literal regression scenario: a server running
# under the mlx venv — where faster_whisper is genuinely absent — gets
# a /download-model request for a whisper model, e.g. switching back
# from parakeet). Pre-fix, this exact call raised ModuleNotFoundError
# (red-confirmed live before landing WHISPER_REPO_IDS); post-fix it
# must succeed end-to-end, proving the static map removed the
# dependency from the whole download path, not just _repo_id_for_model
# in isolation.
_saved_fw3 = _block_faster_whisper()
_saved_hub2 = _set_fake_huggingface_hub()
whisper_server.check_disk_space = _fake_check_disk_space
try:
    _FakeHfApi.model_info_calls.clear()
    snapshot_download_calls.clear()
    _captured_disk_check.clear()

    repo_id = whisper_server.download_model_snapshot("small", hf_token=None)

    check(
        "download_model_snapshot('small'): succeeds with faster_whisper fully "
        "unimportable (F3 — the switch-back-from-parakeet-inside-the-mlx-venv "
        "regression) and resolves the correct static repo id",
        repo_id == whisper_server.WHISPER_REPO_IDS["small"],
    )
    check(
        "download_model_snapshot('small'): snapshot_download still receives "
        "the ORIGINAL MODEL_DOWNLOAD_ALLOW_PATTERNS (5 entries), byte-identical "
        "to pre-S12a",
        snapshot_download_calls[0]["allow_patterns"]
        == whisper_server.MODEL_DOWNLOAD_ALLOW_PATTERNS,
    )
    check(
        "download_model_snapshot('small'): an unset hf_token (None) still "
        "reaches both HfApi().model_info() and snapshot_download() explicitly "
        "as None (implicit huggingface_hub token resolution still applies — "
        "see whisper_server.py's own docstring), not silently omitted",
        _FakeHfApi.model_info_calls[0]["token"] is None
        and snapshot_download_calls[0]["token"] is None,
    )
finally:
    whisper_server.check_disk_space = _real_check_disk_space
    _unblock_faster_whisper(_saved_fw3)
    _restore_huggingface_hub(_saved_hub2)


# =================================================================
# Cache-root invariant (§B finding 10), against the REAL installed
# huggingface_hub — guarded (SKIP if not importable), same posture as
# test_download.py's tqdm-optional section. The fake-hub section above
# proves download_model_snapshot never passes cache_dir; THIS section
# proves the derivation it relies on instead (an omitted cache_dir
# defaulting to constants.HF_HUB_CACHE, itself derived from HF_HOME)
# is real, live, and shared by hf_hub_download too — the exact call
# parakeet_mlx.from_pretrained(repo, cache_dir=None) makes (S12b),
# verified against the wheel's own source in whisper_server.py's
# PARAKEET_ALLOW_PATTERNS docstring.
# =================================================================

try:
    import huggingface_hub  # noqa: F401 - presence probe only
    from huggingface_hub import file_download as _real_file_download
    from huggingface_hub import _snapshot_download as _real_snapshot_download_mod

    _HUB_AVAILABLE = True
except ImportError as exc:  # pragma: no cover - only if huggingface_hub truly isn't installed
    _HUB_AVAILABLE = False
    print(f"SKIP: cache-root-invariant section (huggingface_hub not importable: {exc})")

if _HUB_AVAILABLE:
    import inspect

    _hf_hub_download_src = inspect.getsource(_real_file_download.hf_hub_download)
    _snapshot_download_src = inspect.getsource(_real_snapshot_download_mod.snapshot_download)

    check(
        "cache-root invariant: the installed huggingface_hub's hf_hub_download "
        "(what parakeet_mlx.from_pretrained calls, S12b) defaults an unset "
        "cache_dir to constants.HF_HUB_CACHE",
        "if cache_dir is None" in _hf_hub_download_src
        and "cache_dir = constants.HF_HUB_CACHE" in _hf_hub_download_src,
    )
    check(
        "cache-root invariant: the installed huggingface_hub's snapshot_download "
        "(what download_model_snapshot calls) defaults an unset cache_dir to the "
        "literal SAME constants.HF_HUB_CACHE attribute — a structural guarantee "
        "(both read the one module-level constant), not a coincidence — so "
        "neither this process's download nor a later from_pretrained(cache_dir="
        "None) load ever diverges from the other's cache root",
        "if cache_dir is None" in _snapshot_download_src
        and "cache_dir = constants.HF_HUB_CACHE" in _snapshot_download_src,
    )

    def _hf_hub_cache_for_home(hf_home: str, python_exe: str) -> str:
        """Spawn `python_exe` with a controlled env (HF_HOME set to
        `hf_home`; HF_HUB_CACHE/HUGGINGFACE_HUB_CACHE explicitly
        removed so they can't override the derivation under test) and
        print huggingface_hub.constants.HF_HUB_CACHE right after
        import — a pure import + attribute read, no network."""
        env = dict(os.environ)
        env.pop("HF_HUB_CACHE", None)
        env.pop("HUGGINGFACE_HUB_CACHE", None)
        env["HF_HOME"] = hf_home
        result = subprocess.run(
            [python_exe, "-c", "from huggingface_hub import constants; print(constants.HF_HUB_CACHE)"],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            raise AssertionError(f"subprocess probe failed: {result.stderr}")
        return result.stdout.strip()

    _fake_hf_home = tempfile.mkdtemp(prefix="jargonslayer-test-hf-home-")
    try:
        _resolved_cache = _hf_hub_cache_for_home(_fake_hf_home, sys.executable)
        check(
            "cache-root invariant (live subprocess, controlled env): "
            "HF_HUB_CACHE derives from HF_HOME as <HF_HOME>/hub when not "
            "independently overridden — exactly the Rust launcher's existing "
            "HF_HOME=<models_dir> env (server.rs :172/:344) anchoring BOTH a "
            "parakeet download and its later from_pretrained load to one root",
            _resolved_cache == os.path.join(_fake_hf_home, "hub"),
        )
    finally:
        shutil.rmtree(_fake_hf_home, ignore_errors=True)


# =================================================================
# parse_args(): --model accepts the parakeet id (argparse choices=
# MODEL_CHOICES, s12-mlx-blueprint.md task item 5 — "every allowlist").
# =================================================================

_saved_argv = sys.argv
try:
    sys.argv = ["whisper_server.py", "--model", whisper_server.PARAKEET_MODEL]
    args = whisper_server.parse_args()
    check(
        "parse_args: --model accepts the parakeet id (argparse choices=MODEL_"
        "CHOICES already includes it)",
        args.model == whisper_server.PARAKEET_MODEL,
    )
finally:
    sys.argv = _saved_argv


# =================================================================
# normalize_hf_token / parse_args's ONE normalization point (S12a fix
# round F8, LOW, Sol8 — docs/design-explorations/s12-mlx-blueprint.md
# §D): a whitespace-only --hf-token/$HF_TOKEN value must become None,
# not a truthy garbage token (pre-fix, print_banner's diarize_enabled=
# bool(args.hf_token) would falsely advertise diarization as armed,
# and JobManager/WhisperServer would send the garbage as an actual
# Authorization value). Covers the pure function directly AND both
# real sources parse_args() unifies through the one args.hf_token
# attribute — the CLI flag and the $HF_TOKEN env fallback (--hf-
# token's own argparse default reads os.environ.get("HF_TOKEN") fresh
# on every parse_args() call, so mutating os.environ before calling it
# genuinely exercises the env path, no faking needed).
# =================================================================

check(
    "normalize_hf_token: None stays None",
    whisper_server.normalize_hf_token(None) is None,
)
check(
    "normalize_hf_token: an empty string becomes None",
    whisper_server.normalize_hf_token("") is None,
)
check(
    "normalize_hf_token: a whitespace-only string becomes None",
    whisper_server.normalize_hf_token("   ") is None,
)
check(
    "normalize_hf_token: tabs/newlines-only also becomes None",
    whisper_server.normalize_hf_token("\t\n  \n") is None,
)
check(
    "normalize_hf_token: a real token passes through unchanged",
    whisper_server.normalize_hf_token("hf_abc123") == "hf_abc123",
)
check(
    "normalize_hf_token: a real token with surrounding whitespace is stripped",
    whisper_server.normalize_hf_token("  hf_abc123  ") == "hf_abc123",
)

_saved_argv2 = sys.argv
_saved_hf_token_env = os.environ.get("HF_TOKEN", _UNSET)
try:
    # (a) CLI arg, whitespace-only -> None
    os.environ.pop("HF_TOKEN", None)
    sys.argv = ["whisper_server.py", "--hf-token", "   "]
    args = whisper_server.parse_args()
    check(
        "parse_args: a whitespace-only --hf-token CLI value normalizes to None",
        args.hf_token is None,
    )

    # (b) CLI arg, real value -> passes through (stripped)
    sys.argv = ["whisper_server.py", "--hf-token", "  hf_real_token  "]
    args = whisper_server.parse_args()
    check(
        "parse_args: a real --hf-token CLI value survives normalization (stripped)",
        args.hf_token == "hf_real_token",
    )

    # (c) env fallback, whitespace-only -> None — the SAME normalization
    # point covers both sources, since --hf-token's own argparse default
    # already unifies them into one args.hf_token attribute.
    os.environ["HF_TOKEN"] = "   "
    sys.argv = ["whisper_server.py"]
    args = whisper_server.parse_args()
    check(
        "parse_args: a whitespace-only $HF_TOKEN env fallback normalizes to "
        "None too (one normalization point, both sources)",
        args.hf_token is None,
    )

    # (d) env fallback, real value -> passes through
    os.environ["HF_TOKEN"] = "hf_env_token"
    sys.argv = ["whisper_server.py"]
    args = whisper_server.parse_args()
    check(
        "parse_args: a real $HF_TOKEN env fallback survives normalization",
        args.hf_token == "hf_env_token",
    )

    # (e) neither set -> None (sanity, unaffected by the fix)
    os.environ.pop("HF_TOKEN", None)
    sys.argv = ["whisper_server.py"]
    args = whisper_server.parse_args()
    check(
        "parse_args: no --hf-token/$HF_TOKEN at all -> None, unaffected",
        args.hf_token is None,
    )
finally:
    sys.argv = _saved_argv2
    if _saved_hf_token_env is _UNSET:
        os.environ.pop("HF_TOKEN", None)
    else:
        os.environ["HF_TOKEN"] = _saved_hf_token_env


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
