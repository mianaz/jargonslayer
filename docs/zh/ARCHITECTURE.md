# JargonSlayer 技术架构

> **语言:** [English](../ARCHITECTURE.md) · 简体中文（英文版为权威原文，不同步时以英文版为准）

## 总览

```
浏览器（Next.js 客户端）
│
│  ┌─ 音频/转录层 ────────────────────────────┐
│  │ demo.ts        内置脚本回放（无音频）      │
│  │ webSpeech.ts   Web Speech API            │
│  │ whisperSocket  麦克风→AudioWorklet(16k    │
│  │                int16)→ ws://localhost:8765│──► sidecar/whisper_server.py
│  └──────────────┬───────────────────────────┘    (faster-whisper + 能量VAD)
│                 │ onInterim / onFinal
│                 ▼
│        zustand store（唯一总线）
│   segments · interim · cards · terms
│   summary · settings · sessions
│                 │ pushSegment(seg)
│                 ▼
│  ┌─ 检测层 ────────────────────────────────┐
│  │ scheduler.ts  批量凑批(140字符/3.5s/句末) │
│  │               ≤2并发 · 乱序丢弃 · 降级    │──► POST /api/detect ──► Anthropic
│  │ dictionary.ts 离线词典兜底                │      (Haiku, 结构化输出)
│  │ dedupe.ts     8分钟TTL去重 · 计数合并     │
│  └─────────────────────────────────────────┘
│                 │ applyDetection
│                 ▼
│        UI（TranscriptPanel / CardsPanel / SummaryPanel / …）
│
└─ 会后: POST /api/summarize ──► 纪要1次 + 翻译分块并行(≤4) + 查漏1次 ──► SummaryResult
        历史: IndexedDB (idb-keyval)          导出: Markdown / Anki TSV / JSON
```

## 模块边界（文件所有权）

| 层 | 文件 | 职责 |
|---|---|---|
| 契约 | `src/lib/types.ts` | 全部跨模块类型；LLM JSON 字段名是 wire 契约 |
| 契约 | `src/lib/store.ts` | zustand 总线；STT 层与检测层互不 import，只经 store |
| 契约 | `src/lib/llm/prompts.ts` | 4 个系统提示词（检测/纪要/翻译/查漏）集中管理 |
| 转录 | `src/lib/stt/*`, `src/lib/audio/*`, `public/worklets/*` | 三引擎统一实现 `STTEngine` 接口 |
| 转录 | `src/hooks/useMeeting.ts` | 引擎与调度器的生命周期编排 |
| 检测 | `src/lib/detect/scheduler.ts` | 实时凑批与降级状态机（详下） |
| 检测 | `src/lib/detect/dedupe.ts` | 纯函数合并：TTL 去重、计数、词典→LLM 内容升级 |
| 检测 | `src/lib/detect/dictionary.ts` | 离线词典（371 条：10 主题包，含学术会议包；支持远程社区包） |
| 服务端 | `src/app/api/detect/route.ts` | 校验→调用 Haiku→反幻觉过滤（表达必须逐字出现在原文）→限幅 |
| 服务端 | `src/app/api/summarize/route.ts` | 三阶段编排：纪要 → 分块翻译（索引对齐+缺失重试）→ 查漏 |
| 存储 | `src/lib/history/*` | IndexedDB 会话持久化；Markdown/Anki/JSON 导出 |
| UI | `src/components/*`, `src/app/page.tsx` | 深色主题；page.tsx 只做布局与弹层编排 |
| 本地 STT | `sidecar/whisper_server.py` | ws 实时（16k int16→能量 VAD→faster-whisper）+ HTTP 任务接口（录音上传批转录 + pyannote 说话人分离） |
| 词库/复习 | `src/lib/history/glossary.ts`, `src/app/review/*` | 个人词库（跨会议高亮、掌握状态）与学习中心 |
| Agent 出口 | `src/lib/history/autoExport.ts` | 自动落盘（File System Access）、webhook、全量备份 |

## 实时检测管线的关键决策

1. **凑批触发**：未分析文本 ≥140 字符，或距首个未分析分段 3.5s，或句末（`.?!`）且 ≥60 字符 —— 三者先到先触发。硬上限 1200 字符防长独白撑爆。实测大多数卡片在说完后 2–5 秒内出现。
2. **并发与乱序**：最多 2 个请求在途；每批记录转录流的字符偏移，响应回来时若其覆盖区间已被更新的批次应用过则整批丢弃。卡片顺序由检测时间决定，与响应到达顺序无关。
3. **后台节流**：浏览器把后台标签页定时器节流到分钟级，因此 flush 由「分段到达事件」驱动，`visibilitychange` 时强制刷一次，定时器只兜底。
4. **降级链**：无 Key（401）→ 词典模式；连续 2 次上游失败 → 词典模式；429 → 单次抖动重试。降级只 toast 一次，UI 常驻「词典模式」徽标。
5. **去重语义**：表达按规范化 key（小写、去边缘标点、末词轻词形还原）去重，8 分钟 TTL 内重复 → 原卡计数 +1 并脉冲提示；词典卡片后续被 LLM 命中时**就地升级**内容（语境化解释替换模板解释），计数保留。
6. **反幻觉**：服务端丢弃任何未逐字出现在 `new_text` 里的 expression；提示词要求 `source_sentence` 必须原样引用。
7. **结构化输出**：优先 `messages.parse` + `zodOutputFormat` 强制 schema；模型不支持时回退到普通调用 + 括号平衡扫描解析。两条路都过 zod 校验。
8. **成本控制**：系统提示词打 `cache_control` 缓存（每次调用省约 65% 输入 token）；60 分钟会议约 300 次调用 ≈ $0.5。

## 会后管线

单击「生成会议报告」→ 一个 `/api/summarize` 请求，服务端内部编排：

1. **纪要**（1 次，Sonnet）：全文 → `{topic, key_points, decisions, action_items}` 双语 JSON。
2. **翻译**（分块并行）：每块 ≤25 段且 ≤500 词，并发 4；输入输出都带段索引 `i`，逐索引校验；缺失索引汇总做一次修补调用，仍缺的填占位符 —— 单块失败不拖垮整体。
3. **查漏**（1 次）：全文 + 已捕获表达排除清单 → 补充漏检项（≤10 表达/≤6 术语）。
4. **闪卡**：代码拼装（不让 LLM 排版）—— 实时卡片 + 查漏结果去重合并。

## 隐私设计

- 音频路径：本地 Whisper 全程 127.0.0.1；Web Speech 走浏览器厂商服务（UI 与教程明示）。
- 文本路径：AI 检测/纪要经 Next.js 路由代理到 Anthropic；「仅词典模式」下零外发。
- 持久化：全部在浏览器 IndexedDB；API Key 存本机，请求时经 `x-jargonslayer-key` 头直传路由，服务端不落盘。
- 服务端路由无状态，可整机离线运行（词典模式）。

## 实时说话人分离（beta）

对「pyannote 流式延迟不可接受」的解法不是流式模型，而是**尾窗批量再分离**：ws 连接把全部 16k PCM 存入连接内缓冲，每 ~20s（且有新 final 时）在后台线程对最近 ≤600s 的窗口跑一次完整 pyannote 管线，再按时间重叠把稳定标签回写到已发送的 `final`（`speaker_update` 消息，按 `seg_id` 定位、只发变化项）。关键设计：

- **标签稳定性**：连接维护说话人注册表（stable id → 上一轮 turns），新一轮聚类与注册表按 turn 重叠秒数贪心一对一匹配（阈值 2s），匹配即沿用 id，不匹配且语音 ≥3s 才铸新 id——id 只增不换，pyannote 每轮内部编号的随机置换不会泄漏到 UI。
- **重命名必胜**：前端 store 维护 `speakerAliases`（stable id → 用户显示名），自动回写永远先过 alias 映射，用户改名后后续每轮更新都重新套用改名。
- **降级**：单飞锁（跑不过来就跳轮，标签晚到但转录零阻塞）；pyannote 不可用发一次 `diar_status` 后彻底闭嘴；共享管线单例加载与推理均有锁（ws 线程与 HTTP job 线程互斥）。
- 时间轴以墙钟为准，与音频缓冲在 1x 实时下天然对齐；快于实时的重放请走 HTTP 任务接口（那条路按音频时间戳分离）。

## 已知边界

- Web Speech API 的 final 结果偶发修订（Safari 尤甚），v1 视 final 为不可变——检测偏移以首次 final 为准。
- 实时分离为 beta：首轮要付管线加载成本（标签迟 5-15s），说话人静默超出 600s 窗口后再开口可能获得新编号。
- 浏览器识别引擎不支持选麦克风设备（API 限制），虚拟声卡方案需配本地 Whisper。
