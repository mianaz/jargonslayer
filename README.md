# JargonSlayer · 英文会议实时理解助手

开英文会时它在旁边听，把 **商务俚语、隐喻、委婉说法、专有名词** 实时变成简短的中文卡片；会议结束一键生成 **双语纪要 + 全文翻译 + 学习卡片**。为非英语母语者设计，数据全部留在本机。

```
┌──────────────────────────────┬──────────────────────┐
│  实时转录（分段/说话人/时间戳）  │  实时解释卡片          │
│                              │  · move the needle   │
│  Sarah: We need something    │    产生实质性影响…     │
│  that can really move the    │  · 术语: ARR OKR …    │
│  needle this quarter.        │  ────────────────    │
│                              │  纪要与导出            │
└──────────────────────────────┴──────────────────────┘
```

## 功能一览

- **实时转录**：三种引擎 —— 内置演示（零依赖）、浏览器识别（Web Speech API）、本地 Whisper（隐私模式，音频不出本机）。
- **实时表达检测**：LLM 结合前后语境判断，只解释"字面意思 ≠ 实际意思"的表达；专有名词/缩写单独成术语条。没有 API Key 时自动切换内置词典（60+ 俚语、25+ 缩写），开箱即用。
- **卡片体验**：新卡片金色高亮 4 秒；同一表达 8 分钟内重复出现只计数不刷屏；转录里被检测的表达带金色虚线下划线，点击即定位卡片；选中任意文字可即席查询。
- **会后产物**：双语结构化纪要（主题/要点/决定/行动项）、逐段中英对照全文、学习卡片（实时检测 + 全文查漏合并）；导出 Markdown / Anki TSV / JSON。
- **会议历史**：全部存浏览器 IndexedDB，支持搜索曾出现过的表达。

## 快速开始

```bash
cd jargonslayer
npm install
npm run dev
# 打开 http://localhost:3000
```

第一次打开会弹出新手引导。**先点顶部「▶ 演示」**——不需要麦克风、不需要 API Key，就能看到完整的转录 → 检测 → 卡片 → 会后报告流程（无 Key 时演示走内置词典）。

## 配置 API Key（解锁 AI 检测与会后报告）

内置词典只能匹配固定短语；填入 Anthropic API Key 后才有上下文感知的 AI 检测（能分清 "table this" 是"搁置议题"还是真的把东西放桌上）和会后纪要/翻译。两种方式任选：

1. **UI 里填**（推荐个人使用）：右上角 ⚙ 设置 → AI 检测 → API Key。Key 只存在你本机浏览器里，随请求直发，不写入任何服务器。
2. **环境变量**：项目根目录建 `.env.local`：
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   然后重启 `npm run dev`。

Key 从 [console.anthropic.com](https://console.anthropic.com/) 获取。默认模型：实时检测 `claude-haiku-4-5`（快、便宜），会后报告 `claude-sonnet-5`（质量），设置里都能换。

**成本参考**：60 分钟、约 9000 词的会议 —— 实时检测约 $0.5，会后报告约 $0.3–0.55，合计约 $1/场；纯词典模式 $0。

## 三种转录引擎

| | 配置成本 | 音频去向 | 建议场景 |
|---|---|---|---|
| 演示模式 | 无 | 无音频 | 第一次体验、给别人演示 |
| 浏览器识别 | 无 | 浏览器厂商语音服务 | 日常、非敏感会议（Chrome/Edge） |
| 本地 Whisper | 装一次 Python 环境 | **不出本机** | 敏感内容、离线、想要更稳的识别 |

### 本地 Whisper（隐私模式）

```bash
cd sidecar
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python whisper_server.py --model small
# 看到 "ws://127.0.0.1:8765 等待连接" 后，
# 回到网页：设置 → 转录引擎 → 本地 Whisper → 开始监听
```

模型建议（Apple Silicon 实测量级）：

| 模型 | 质量 | 速度 | 适用 |
|---|---|---|---|
| `tiny` / `base` | 一般 | 极快 | 低配机器试跑 |
| `small`（默认） | 好 | 实时无压力 | **日常推荐** |
| `medium` | 更好 | 接近实时 | 口音重、专业词多 |
| `large-v3` | 最好 | 偏慢 | 会后重转录，不建议实时 |

常用参数：`--language en`（默认）、`--partials`（说话过程中也出灰色中间结果，更费 CPU）、`--save-audio meeting.wav`（保留录音，供会后说话人分离）。

### ⚠️ 转录"对方的声音"（线上会议必读）

麦克风只能听到**你自己**。Zoom/Teams/Meet 里对方的声音从扬声器出来，需要把**系统音频**变成一个"输入设备"：

- **macOS**：装 [BlackHole](https://github.com/ExistentialAudio/BlackHole)（免费虚拟声卡）→ 系统设置里建一个"多输出设备"（耳机 + BlackHole，你照常听声）→ JargonSlayer 设置里把麦克风选成 BlackHole，引擎用**本地 Whisper**（浏览器识别引擎不认虚拟设备选择，始终用系统默认输入）。
- **Windows**：VB-Cable 同理。
- 想同时转录你和对方：macOS「聚合设备」把麦克风 + BlackHole 合成一个输入。

## 使用流程

1. 选引擎 → 「开始监听」（浏览器会请求麦克风权限）。
2. 左侧看转录，右侧「实时解释」看卡片；金色虚线的表达可点；选中一段文字会弹出即席解释。
3. 「停止」→ 自动存入历史 → 右侧「纪要与导出」→ 「生成会议报告」。
4. 导出 Markdown 报告 / Anki 卡片（TSV 可直接导入 Anki：文件 → 导入，字段以 Tab 分隔）。
5. 🕘 历史里可以重新打开任何一场会，支持按表达搜索（"那个 boil the ocean 是哪次会说的？"）。

## 说话人分离（进阶，可选）

实时说话人分离对延迟影响太大，JargonSlayer 采用**会后处理**路径：

```bash
# 1. 开会时让 sidecar 留下录音
python whisper_server.py --model small --save-audio meeting.wav

# 2. 会后用 pyannote 打说话人标签（需要 HuggingFace token，首次会下载模型）
pip install pyannote.audio
python - <<'EOF'
from pyannote.audio import Pipeline
p = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token="hf_...")
for turn, _, spk in p("meeting.wav").itertracks(yield_label=True):
    print(f"{turn.start:.1f}s - {turn.end:.1f}s: {spk}")
EOF
```

把输出的时间段和导出的 JSON transcript（每段带时间戳）对齐即可标注说话人。后续版本计划把这一步做进 UI。

## 隐私边界（明确说清楚）

| 数据 | 去向 |
|---|---|
| 音频（本地 Whisper） | 仅本机，websocket 走 127.0.0.1 |
| 音频（浏览器识别） | 浏览器厂商的语音服务（Google/Apple） |
| 转录文本（AI 检测开启时） | 发送到 Anthropic API 用于检测/纪要 |
| 转录文本（词典模式） | 仅本机 |
| 会议历史、设置、API Key | 仅本机浏览器（IndexedDB / localStorage） |

不想让任何文本出本机：设置里开「仅词典模式」。

## 常见问题

- **「浏览器不支持语音识别」**：Safari/Firefox 对 Web Speech API 支持差，用 Chrome/Edge，或直接上本地 Whisper。
- **Whisper 连不上**：确认 sidecar 终端还开着、地址是 `ws://localhost:8765`；防火墙放行本地端口。
- **卡片太少/太多**：设置里调「置信度阈值」（低=多），或换检测模型。
- **会议在后台标签页时检测变慢**：正常，浏览器会节流后台定时器；切回来会立即补检。已尽量用事件驱动缓解。
- **生成报告很慢**：长会议的全文翻译是分块并行跑的，1–2 分钟正常；只想要卡片可以不生成报告直接导出。

## 技术栈与架构

Next.js 15 (App Router) + TypeScript + Tailwind + zustand + IndexedDB；LLM 走 Anthropic Messages API（服务端路由代理，支持结构化输出）；本地转录 faster-whisper sidecar（websocket + 能量 VAD）。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [docs/PRODUCT.md](docs/PRODUCT.md)。
