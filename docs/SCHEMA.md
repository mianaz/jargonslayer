# JargonSlayer 数据 Schema（agent-native 输出契约）

所有对外数据带 `schemaVersion` 字段；同一大版本内只做加法（新增字段），破坏性变更升版本号。当前 **schemaVersion: 1**。

## 1. 会话 JSON（自动落盘 `.json` / 手动导出）

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
      "speaker": "SPEAKER_1",         // 可选；diarization 或演示模式提供
      "text": "…", "engine": "whisper"
    }],
    "cards": [{                        // 检测到的表达（含书签字段）
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
    "summary": {                       // 可选；生成报告后存在
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

## 2. Markdown frontmatter（落盘 `.md`，Obsidian/Dataview 友好）

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

## 3. Webhook payload（会后 POST）

```jsonc
{
  "schemaVersion": 1,
  "event": "meeting.saved",
  "exportedAt": 1751800000000,
  "session": { /* 同上 session 对象 */ }
}
```

超时 8s、fire-and-forget、无重试；接收端应快速 200 并异步处理。

## 4. 全量备份

```jsonc
{
  "schemaVersion": 1,
  "kind": "jargonslayer-backup",      // 导入端同时接受旧 "meetlingo-backup"
  "exportedAt": 0,
  "sessions": [ /* MeetingSession[] */ ],
  "glossary": [ /* CustomEntry[] */ ],
  "settings": { /* 导入时跳过，不静默覆盖 */ }
}
```

## 5. 远程词典包（社区包格式）

发布为可公开访问的 JSON（GitHub raw / jsDelivr）：

```jsonc
{
  "id": "biotech-terms",              // 全局唯一，小写-连字符
  "name": "生物医药术语包",
  "description": "…",                 // 可选
  "version": "1.2.0",                 // 字符串或数字；变更即触发更新
  "expressions": [{
    "expression": "de-risk the asset",
    "variants": ["de-risk"],          // 可选
    "category": "phrase",
    "meaning": "reduce the risk profile of a drug program",
    "chinese_explanation": "降低这条管线的风险敞口",   // ≤40 字、自然商务中文、中英文间半角空格
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

条目未带 `pack` 字段时自动归属包 id；不合规条目在导入时丢弃并告警。质量规范同内置词典：无词典腔、长度上限、盘古之白。

## 6. 兼容承诺

- 旧 `meetlingo:*` IndexedDB key 在启动时单向复制迁移（不删除原数据）。
- 旧 `meetlingo-backup` 备份文件永久可导入。
- `chinese_explanation` / `gloss_zh` 字段名是 wire 契约；`explainLanguage: "en"` 模式下其内容为简明英文（字段名不变）。
