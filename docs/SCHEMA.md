# JargonSlayer Data Schema (agent-native output contract)

Every external data payload carries a `schemaVersion` field; additive changes only within a major version; breaking changes bump the version. Current **schemaVersion: 1**.

## 1. Session JSON (auto-saved `.json` / manual export)

```jsonc
{
  "schemaVersion": 1,
  "exportedAt": 1751800000000,        // epoch ms
  "session": {
    "id": "uuid",
    "title": "会议 2026-07-06 14:30",
    "startedAt": 1751790000000,
    "endedAt": 1751793600000,
    "engine": "whisper",              // demo | webspeech | whisper | tabaudio
    "segments": [{
      "id": "uuid", "index": 0,
      "startedAt": 1751790000300, "endedAt": 1751790002300,
      "speaker": "SPEAKER_1",         // optional; provided by diarization or demo mode (becomes the display name after user renames it)
      "text": "…", "engine": "whisper"
    }],
    "speakerAliases": {                // optional; user-rename mapping under real-time diarization (beta)
      "SPEAKER_1": "Elena"             // key = stable speaker id, value = user-renamed display name
    },
    "cards": [{                        // detected expressions (includes bookmark fields)
      "expression": "move the needle",
      "category": "idiom",            // idiom|slang|phrase|metaphor|indirect|other
      "meaning": "…", "chinese_explanation": "…",
      "plain_english": "…", "tone": "…",
      "confidence": 0.95, "source_sentence": "…",
      "id": "uuid", "normKey": "move the needle",
      "firstSeenAt": 0, "lastSeenAt": 0, "count": 2,
      "source": "llm"                 // llm | dictionary | custom
    }],
    "terms": [{
      "term": "ARR", "type": "metric", // acronym|company|product|tech|metric|person|other
      "gloss_en": "…", "gloss_zh": "…",
      "id": "uuid", "normKey": "ARR",
      "firstSeenAt": 0, "lastSeenAt": 0, "count": 3, "source": "llm"
    }],
    "summary": {                       // optional; present after report generation
      "summary": {
        "topic": {"en": "…", "zh": "…"},
        "key_points": [{"en": "…", "zh": "…"}],
        "decisions": [{"en": "…", "zh": "…"}],
        "action_items": [{"owner": "…", "en": "…", "zh": "…", "due": ""}]
      },
      "translations": [{"index": 0, "zh": "…"}],
      "flashcards": [{"front": "…", "back_zh": "…", "back_en": "…", "example": "…", "tags": ["idiom","expression"]}],
      "generatedAt": 0, "model": "claude-sonnet-5"
    }
  }
}
```

## 2. Markdown frontmatter (saved to `.md`, Obsidian/Dataview friendly)

```yaml
---
title: "会议 2026-07-06 14:30"
date: 2026-07-06T14:30:00.000Z
duration_min: 60
engine: "whisper"
expressions: ["move the needle", "circle back"]
terms: ["ARR", "OKR"]
source: jargonslayer
schemaVersion: 1
---
```

## 3. Webhook payload (post-meeting POST)

```jsonc
{
  "schemaVersion": 1,
  "event": "meeting.saved",
  "exportedAt": 1751800000000,
  "session": { /* same session object as above */ }
}
```

8s timeout, fire-and-forget, no retry; the receiving end should return 200 quickly and process asynchronously.

## 4. Full backup

```jsonc
{
  "schemaVersion": 1,
  "kind": "jargonslayer-backup",      // the importer also accepts the legacy "meetlingo-backup"
  "exportedAt": 0,
  "sessions": [ /* MeetingSession[] */ ],
  "glossary": [ /* CustomEntry[] */ ],
  "settings": { /* skipped on import, never silently overwritten */ }
}
```

## 5. Remote dictionary pack (community pack format)

Published as publicly accessible JSON (GitHub raw / jsDelivr):

```jsonc
{
  "id": "biotech-terms",              // globally unique, lowercase-hyphenated
  "name": "生物医药术语包",
  "description": "…",                 // optional
  "version": "1.2.0",                 // string or number; any change triggers an update
  "expressions": [{
    "expression": "de-risk the asset",
    "variants": ["de-risk"],          // optional
    "category": "phrase",
    "meaning": "reduce the risk profile of a drug program",
    "chinese_explanation": "降低这条管线的风险敞口",   // ≤40 characters, natural business Chinese, half-width space between Chinese and English
    "plain_english": "make it less risky",
    "tone": "neutral, biotech jargon",
    "confidence": 0.9
  }],
  "terms": [{
    "term": "IND", "type": "acronym",
    "gloss_en": "Investigational New Drug application (FDA)",
    "gloss_zh": "美国 FDA 新药临床试验申请"
  }]
}
```

Entries without a `pack` field are auto-assigned the pack's id; non-conforming entries are dropped with a warning at import time. Same quality standard as the built-in dictionary: no dictionary-speak, length caps, Pangu spacing.

## 6. Compatibility commitments

- Legacy `meetlingo:*` IndexedDB keys are copy-migrated one-way at startup (original data is not deleted).
- Legacy `meetlingo-backup` backup files remain importable indefinitely.
- The `chinese_explanation` / `gloss_zh` field names are a wire contract; under `explainLanguage: "en"` mode their content is plain English (the field name stays unchanged).
</content>
