#!/usr/bin/env python3
"""Plain-assert self-test for the realtime speaker diarization (beta)
pure functions in whisper_server.py — no pytest, no network, no model
loading, no server start (module import is side-effect free; servers
only start under `if __name__ == "__main__":`).

Run:
    sidecar/.venv/bin/python sidecar/test_realtime_diar.py

Covers (per the approved architecture blueprint):
  - first pass mints stable ids in order of first appearance
  - second pass with shifted-but-overlapping turns keeps ids
  - swap-resistant: two speakers whose pyannote local numbers permute
    across passes keep their stable ids
  - short blip (< min_speech) gets no id
  - cap folding: beyond DIAR_MAX_SPEAKERS, folds into best-overlap anchor
  - segment back-assignment picks max overlap (speaker_for_turns)
  - changed-only diffing (only segments whose label changed are sent)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from whisper_server import (  # noqa: E402
    match_clusters,
    overlap_seconds,
    speaker_for_turns,
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
# overlap_seconds
# =================================================================

check(
    "overlap_seconds: simple overlapping pair sums correctly",
    overlap_seconds([(0.0, 10.0)], [(5.0, 15.0)]) == 5.0,
)
check(
    "overlap_seconds: disjoint intervals contribute 0",
    overlap_seconds([(0.0, 5.0)], [(10.0, 15.0)]) == 0.0,
)
check(
    "overlap_seconds: touching-but-not-overlapping ([0,5) vs [5,10)) contributes 0",
    overlap_seconds([(0.0, 5.0)], [(5.0, 10.0)]) == 0.0,
)
check(
    "overlap_seconds: sums multiple pairwise intersections",
    overlap_seconds([(0.0, 10.0), (20.0, 30.0)], [(5.0, 25.0)]) == (5.0 + 5.0),
)
check(
    "overlap_seconds: empty lists on either side yield 0",
    overlap_seconds([], [(0.0, 10.0)]) == 0.0 and overlap_seconds([(0.0, 10.0)], []) == 0.0,
)


# =================================================================
# match_clusters — first pass: mints in order of first appearance
# =================================================================

# Registry starts empty (no previous pass). Iteration order of a
# Python dict is insertion order, so "order of first appearance" means
# the dict-iteration order of `new_clusters`.
first_pass_clusters = {
    "SPEAKER_00": [(0.0, 5.0)],   # first-appearing local label
    "SPEAKER_01": [(6.0, 12.0)],  # second-appearing local label
}
first_pass_map = match_clusters(first_pass_clusters, {})
check(
    "match_clusters: first pass mints SPEAKER_1 for the first-appearing local label",
    first_pass_map.get("SPEAKER_00") == "SPEAKER_1",
)
check(
    "match_clusters: first pass mints SPEAKER_2 for the second-appearing local label",
    first_pass_map.get("SPEAKER_01") == "SPEAKER_2",
)
check(
    "match_clusters: first pass mints exactly 2 ids, no extras",
    sorted(first_pass_map.values()) == ["SPEAKER_1", "SPEAKER_2"],
)

# Build the registry as run_realtime_diar would after pass 1: replace
# each matched/minted stable id's turns with this pass's turns.
registry_after_pass1: dict[str, list[tuple[float, float]]] = {}
for local_label, stable_id in first_pass_map.items():
    registry_after_pass1[stable_id] = list(first_pass_clusters[local_label])


# =================================================================
# match_clusters — second pass: shifted-but-overlapping turns keep ids
# =================================================================

# Same two speakers, turns shifted slightly later but still
# overlapping their previous-pass turns by >= min_overlap (2.0s).
second_pass_clusters = {
    "SPEAKER_00": [(1.0, 6.0)],   # overlaps SPEAKER_1's [0,5) by 4s
    "SPEAKER_01": [(7.0, 13.0)],  # overlaps SPEAKER_2's [6,12) by 5s
}
second_pass_map = match_clusters(second_pass_clusters, registry_after_pass1)
check(
    "match_clusters: shifted-but-overlapping turns keep the same stable id (speaker A)",
    second_pass_map.get("SPEAKER_00") == "SPEAKER_1",
)
check(
    "match_clusters: shifted-but-overlapping turns keep the same stable id (speaker B)",
    second_pass_map.get("SPEAKER_01") == "SPEAKER_2",
)


# =================================================================
# match_clusters — swap-resistant: pyannote local numbers permute
# across passes but stable ids don't
# =================================================================

# pyannote's own local numbering for a pass has no relationship across
# passes — here the local labels for what was previously SPEAKER_1/2
# come back as SPEAKER_01/SPEAKER_00 (swapped names), but turn-overlap
# matching must still recover the correct stable ids.
swapped_pass_clusters = {
    "SPEAKER_01": [(6.5, 12.5)],  # this is actually still speaker B (SPEAKER_2)
    "SPEAKER_00": [(1.5, 6.5)],   # this is actually still speaker A (SPEAKER_1)
}
swapped_map = match_clusters(swapped_pass_clusters, registry_after_pass1)
check(
    "match_clusters: swap-resistant — local label reused for A now still resolves to SPEAKER_1",
    swapped_map.get("SPEAKER_00") == "SPEAKER_1",
)
check(
    "match_clusters: swap-resistant — local label reused for B now still resolves to SPEAKER_2",
    swapped_map.get("SPEAKER_01") == "SPEAKER_2",
)


# =================================================================
# match_clusters — short blip (< min_speech) gets no id
# =================================================================

blip_clusters = {
    "SPEAKER_00": [(0.0, 5.0)],   # 5s — real speaker, mints
    "SPEAKER_02": [(10.0, 12.0)],  # 2s total — below default min_speech=3.0
}
blip_map = match_clusters(blip_clusters, {})
check(
    "match_clusters: a real (>= min_speech) unmatched cluster still mints",
    blip_map.get("SPEAKER_00") == "SPEAKER_1",
)
check(
    "match_clusters: a short blip (< min_speech) gets no id at all",
    "SPEAKER_02" not in blip_map,
)

# Blip below threshold with a non-default min_speech: exactly at the
# boundary is inclusive (>= min_speech, not >).
boundary_map = match_clusters(
    {"SPEAKER_00": [(0.0, 3.0)]}, {}, min_speech=3.0
)
check(
    "match_clusters: a cluster exactly at min_speech (3.0s) DOES mint (boundary inclusive)",
    boundary_map.get("SPEAKER_00") == "SPEAKER_1",
)


# =================================================================
# match_clusters — cap folding
# =================================================================

# Registry already at cap (8 stable speakers). A 9th unmatched cluster
# (>= min_speech, but zero/low overlap with any existing anchor) must
# fold into whichever existing anchor it overlaps most, rather than
# minting SPEAKER_9 — regardless of the min_overlap threshold.
full_registry = {f"SPEAKER_{i}": [(float(i * 100), float(i * 100 + 5))] for i in range(1, 9)}
check("cap-folding test setup: registry is exactly at cap", len(full_registry) == 8)

# SPEAKER_3's registry turn is (300.0, 305.0). A new cluster at
# (304.5, 309.5) overlaps it by only 0.5s — below the 2.0s min_overlap
# threshold, so ordinary matching would leave it unmatched. At cap,
# folding must still pick SPEAKER_3 (its only/best overlap) rather
# than dropping it or minting SPEAKER_9.
overflow_clusters = {
    "SPEAKER_00": [(304.5, 309.5)],  # overlaps SPEAKER_3's [300,305) by only 0.5s
}
overflow_map = match_clusters(overflow_clusters, full_registry)
check(
    "match_clusters: at cap, a cluster with sub-threshold overlap still folds into the best-overlap anchor",
    overflow_map.get("SPEAKER_00") == "SPEAKER_3",
)
check(
    "match_clusters: cap folding never grows the registry beyond cap (folded label maps to an EXISTING id)",
    overflow_map.get("SPEAKER_00") in full_registry,
)

# At cap with a cluster that overlaps NOTHING at all: dropped (no
# sensible anchor to fold into), not minted.
no_overlap_clusters = {"SPEAKER_00": [(10_000.0, 10_010.0)]}
no_overlap_map = match_clusters(no_overlap_clusters, full_registry)
check(
    "match_clusters: at cap, a cluster overlapping nothing is dropped (not folded, not minted)",
    "SPEAKER_00" not in no_overlap_map,
)

# Sanity: with room under the cap (7 existing), a genuinely new
# far-away speaker still mints normally instead of folding.
almost_full_registry = {f"SPEAKER_{i}": [(float(i * 100), float(i * 100 + 5))] for i in range(1, 8)}
new_speaker_map = match_clusters({"SPEAKER_00": [(10_000.0, 10_010.0)]}, almost_full_registry)
check(
    "match_clusters: under cap, a genuinely new speaker (>= min_speech, no overlap) still mints",
    new_speaker_map.get("SPEAKER_00") == "SPEAKER_8",
)


# =================================================================
# match_clusters — minted numbers only ever grow (never reused)
# =================================================================

# A registry where SPEAKER_1 aged out (no longer present) but
# SPEAKER_2 remains — next mint must be SPEAKER_3, not SPEAKER_1.
aged_registry = {"SPEAKER_2": [(0.0, 5.0)]}
regrowth_map = match_clusters({"SPEAKER_00": [(50.0, 60.0)]}, aged_registry)
check(
    "match_clusters: minted ids only ever grow — next mint after SPEAKER_2 is SPEAKER_3, not SPEAKER_1",
    regrowth_map.get("SPEAKER_00") == "SPEAKER_3",
)


# =================================================================
# match_clusters — one-to-one greedy matching (no double-booking)
# =================================================================

# Two local clusters both overlap the SAME single registry id, but
# only one can claim it; the other must either match a different
# existing id or mint fresh (never both mapping to the same stable id).
one_to_one_registry = {"SPEAKER_1": [(0.0, 10.0)]}
one_to_one_clusters = {
    "SPEAKER_00": [(0.0, 10.0)],  # perfect 10s overlap
    "SPEAKER_01": [(1.0, 5.0)],  # 4s overlap — less than SPEAKER_00's
}
one_to_one_map = match_clusters(one_to_one_clusters, one_to_one_registry)
check(
    "match_clusters: one-to-one — the higher-overlap cluster wins the contested stable id",
    one_to_one_map.get("SPEAKER_00") == "SPEAKER_1",
)
check(
    "match_clusters: one-to-one — the loser does not also claim SPEAKER_1",
    one_to_one_map.get("SPEAKER_01") != "SPEAKER_1",
)
check(
    "match_clusters: one-to-one — the loser mints instead (its own speech is >= min_speech)",
    one_to_one_map.get("SPEAKER_01") == "SPEAKER_2",
)


# =================================================================
# speaker_for_turns — segment back-assignment picks max overlap
# =================================================================

turns_for_backassign = [
    (0.0, 5.0, "SPEAKER_1"),
    (5.0, 8.0, "SPEAKER_2"),
    (8.0, 20.0, "SPEAKER_1"),
]
check(
    "speaker_for_turns: a segment fully inside one turn picks that turn's label",
    speaker_for_turns((1.0, 4.0), turns_for_backassign) == "SPEAKER_1",
)
check(
    "speaker_for_turns: a segment spanning a boundary picks the label with MAX overlap, not the first",
    # span [4, 9): overlaps SPEAKER_1's [0,5) by 1s, SPEAKER_2's [5,8) by
    # 3s, SPEAKER_1's [8,20) by 1s -> SPEAKER_2 wins on total per-turn max
    # (it's a single-turn 3s block vs each SPEAKER_1 turn only 1s).
    speaker_for_turns((4.0, 9.0), turns_for_backassign) == "SPEAKER_2",
)
check(
    "speaker_for_turns: no positive overlap with anything returns None",
    speaker_for_turns((100.0, 105.0), turns_for_backassign) is None,
)
check(
    "speaker_for_turns: empty turns list returns None",
    speaker_for_turns((0.0, 5.0), []) is None,
)


# =================================================================
# changed-only diffing — integration-style test of the
# "assignments include ONLY segments whose label changed" rule, as
# run_realtime_diar applies it via a seg_id -> last-sent-label map.
# =================================================================


def diff_assignments(
    segment_log: list[tuple[int, float, float]],
    turns: list[tuple[float, float, str]],
    last_sent: dict[int, str],
) -> list[dict[str, object]]:
    """Mirrors run_realtime_diar's per-pass diffing loop exactly (seg_id,
    start, end) tuples in, `{"seg_id", "speaker"}` dicts out, mutating
    `last_sent` in place — same contract as the real code."""
    assignments: list[dict[str, object]] = []
    for seg_id, start, end in segment_log:
        label = speaker_for_turns((start, end), turns)
        if label is None:
            continue
        if last_sent.get(seg_id) == label:
            continue
        last_sent[seg_id] = label
        assignments.append({"seg_id": seg_id, "speaker": label})
    return assignments


# seg_id 2 (20.0, 25.0) starts out past every turn in
# turns_for_backassign (last turn ends at 20.0) — realistic for a
# freshly-finalized segment the diarization window hasn't caught up to
# yet. It should get no label in pass 1, then gain one once a later
# pass's window covers it (pass 3, below).
seg_log = [(0, 0.0, 4.0), (1, 4.0, 9.0), (2, 20.0, 25.0)]
last_sent_state: dict[int, str] = {}

pass1_assignments = diff_assignments(seg_log, turns_for_backassign, last_sent_state)
check(
    "changed-only diffing: pass 1 (nothing sent yet) includes every CURRENTLY LABELED segment",
    {a["seg_id"] for a in pass1_assignments} == {0, 1},
)
check(
    "changed-only diffing: pass 1 omits the not-yet-covered segment (seg_id 2) entirely",
    all(a["seg_id"] != 2 for a in pass1_assignments),
)
check(
    "changed-only diffing: pass 1 labels match speaker_for_turns directly",
    {a["seg_id"]: a["speaker"] for a in pass1_assignments} == {0: "SPEAKER_1", 1: "SPEAKER_2"},
)

# Pass 2: identical turns (nothing actually changed) -> empty assignments.
pass2_assignments = diff_assignments(seg_log, turns_for_backassign, last_sent_state)
check(
    "changed-only diffing: pass 2 with unchanged labels sends NO assignments",
    pass2_assignments == [],
)

# Pass 3: the diarization window has grown to cover seg_id 2 now, AND
# seg_id 1's label flips (its span now overlaps SPEAKER_2 further, but
# more importantly a boundary shift moves it) — seg_id 0 stays put.
# Only the segments whose label actually changed (1 gaining a
# different label is not exercised here to keep it crisp — instead we
# flip seg_id 1 from SPEAKER_2 to SPEAKER_1 outright) and seg_id 2
# (gaining its first label) should appear; seg_id 0 must not.
turns_pass3 = [
    (0.0, 9.0, "SPEAKER_1"),  # now covers what was SPEAKER_1 + SPEAKER_2's span -> seg 1 flips to SPEAKER_1
    (9.0, 25.0, "SPEAKER_2"),  # newly extends far enough to cover seg_id 2
]
pass3_assignments = diff_assignments(seg_log, turns_pass3, last_sent_state)
check(
    "changed-only diffing: pass 3 sends exactly the segments whose label changed (1 and 2), and NOT seg_id 0",
    {a["seg_id"] for a in pass3_assignments} == {1, 2},
)
check(
    "changed-only diffing: seg_id 1 flips from SPEAKER_2 to SPEAKER_1",
    {a["seg_id"]: a["speaker"] for a in pass3_assignments}[1] == "SPEAKER_1",
)
check(
    "changed-only diffing: seg_id 2 gains its first label (SPEAKER_2) now that the window covers it",
    {a["seg_id"]: a["speaker"] for a in pass3_assignments}[2] == "SPEAKER_2",
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
