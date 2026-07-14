<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/icon-ui-dark.png" />
  <img src="apps/web/public/icon-ui-light.png" width="150" alt="JargonSlayer 图标" />
</picture>

# JargonSlayer

**英文会议实时理解助手 · 把会议变成一个正在运行的进程**

*Real-time English-meeting comprehension assistant · your meeting, as a running process*

[![Release](https://img.shields.io/github/v/release/mianaz/jargonslayer?style=flat-square&color=4ADE80&labelColor=121212)](https://github.com/mianaz/jargonslayer/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-22D3EE?style=flat-square&labelColor=121212)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-1903%20passing-4ADE80?style=flat-square&labelColor=121212)](apps/web/src/lib/__tests__)
[![数据路径](https://img.shields.io/badge/data-transparent%20paths-FFAA44?style=flat-square&labelColor=121212)](#隐私边界明确说清楚)

[English](README.md) · **简体中文** · [**立即体验**](https://apps.bioinfospace.com/jargonslayer) · [网站](https://mianaz.github.io/jargonslayer/)

<img src="assets/live.png" alt="JargonSlayer 实时会议界面：左侧分段转录文本中高亮标注表达，右侧实时解释卡片" width="920" />

</div>

---

开英文会时它在旁边听，把**商务俚语、习语、隐喻、委婉说法、行业术语**实时变成简短的中文卡片；会议结束一键生成**双语纪要 + 全文翻译 + 学习卡片**。数据处理**默认透明，想全本地随时可选**：每个引擎、每个版本都写明音频和文本去哪（见[隐私边界](#隐私边界明确说清楚)），纯词典零 API 模式永远只差一个开关。

> 产品界面为简体中文，面向非英语母语者（中文职场人士与研究者优先）。

## 为什么做这个

非母语者在会议里卡住，很少因为词汇量不够。真正卡住的是两件事：

1. **非字面表达** — *move the needle*、*boil the ocean*、*table this*。每个词都认识，整句就是不解析，等反应过来会议已经过去了。
2. **专有名词和缩写** — ARR、OKR、Series B、内部代号。母语者一秒略过，你要花那一秒去检索。

JargonSlayer 就是坐你旁边的同事：从不打断，只在侧边栏安静地告诉你那句话到底什么意思。

## 功能一览

- **实时转录** — 浏览器识别 / 本地 Whisper / 标签页音频（后两者音频不出本机），每个引擎带「本地 / 云端」数据去向标识；内置演示零依赖看完整流程。Chrome 139+ 上浏览器识别优先走**设备端识别**——音频留在本机，状态栏亮起绿色「音频在本地处理」，本地语言包不可用时才回落到厂商云端。另有实验性 **Soniox** 实时引擎（自备 Key），面向中英夹杂的实时场景。浏览器识别加了语音活动检测兜底：分段切换只挑真正的停顿点下手，断线恢复不会丢掉已经缓存的语音，识别语种持续对不上时只提醒一次，不会悄悄丢字。
- **实时表达检测** — LLM 结合前后语境判断，只解释"字面意思 ≠ 实际意思"的表达（能分清 *table this* 是"搁置议题"还是真的在说桌子）；专有名词/缩写单独成术语卡。内置词典（430+ 条、11 个主题包可选，含商务/学术/医药生物科技，还能从 GitHub 装社区词包）是始终在线的即时底层——命中立刻出卡，AI 再就地升级解释；关掉 AI 就是纯离线模式。解释语言可切中文或英文。
- **双语转录**（可选）——在设置中开启后，会议进行时每句定稿的转录下方都会实时出现中文翻译，而不是等到会后报告才能看译文。
- **卡片体验** — 表达卡和术语卡统一卡牌样式，分类色条区分；重复出现只计数不刷屏；转录内带下划线的表达可点击跳到对应卡片；选中任意文字即席查询并可一键收进「我的词典」。
- **说话人** — 上传录音自动转录 + 说话人分离（后台进度，完成自动载入）；实时分离 beta（本地运行，标签随会议逐步修正）；说话人标签点击即可改名。
- **导入文稿**——已有文字记录？粘贴或上传 .txt / .srt / .vtt（Zoom、Otter 等导出），自动解析说话人和时间戳、生成术语卡片、可选逐句中文对照，存入历史可编辑。
- **导入音视频文件** — 上传 .wav/.mp3/.m4a/.flac 音频或 .mp4/.webm/.mov 视频（ffmpeg.wasm 自动提取音轨），Whisper 在 Web Worker 内本地转录（优先 WebGPU，退而 WASM），文件不离开浏览器；体验版开箱即用，转录结果接入与文稿导入相同的检测/翻译管线。
- **导入视频链接**（仅本地 sidecar）— 粘贴链接，sidecar 调 yt-dlp 下载后走与上传录音一致的转录管线；体验版刻意不提供此功能——服务端代抓第三方视频违反平台 TOS 且触碰 DMCA §1201（参考 *Cordova v. Huneault* 2026），只能在你自己的机器、你自己的账号下风险自负地跑。
- **一个导入入口 + 后台任务中心** — 文件、粘贴文稿、链接统一走「导入」一个入口，顶栏里跟直播引擎模式并排放着，历史抽屉里也能打开；进度交给状态栏的任务托盘，关掉抽屉不中断，任务做完自动跳去对应会话，任务生命周期事件（`task.started/done/error`）还能 POST 到你配置的 webhook。
- **会后产物** — 双语纪要（主题/要点/决定/行动项）、逐段对照翻译、学习卡片、**康奈尔笔记**（正文高亮 + 右栏批注，可导出 PNG 图片/Markdown）；另有 Markdown / Anki TSV / JSON 导出、自动落盘、webhook。
- **学习闭环** — 卡片标「太简单/别再提示」后这个表达就不再出现在实时检测里（两次确认 + 撤销兜底，90 天后自动复检，避免误标的词悄悄从检测里消失）；`/review` 新增「到期复习」模式（不认识/模糊/认识三档 SM-2-lite 排期，连续打卡天数、每日到期数），跟自由翻卡并存，还有「已知词」列表随时取消抑制；个人词典自动收录，持续参与后续会议的检测。
- **BYOK / 多模型** — Anthropic 直连或任意 OpenAI 兼容端点（DeepSeek / Qwen / OpenRouter / Ollama）；也可一键 OAuth 连接 OpenRouter 账号（授权后自动生成 Key），或选 Poe 订阅预设。Key 存在本机浏览器，调用时经本应用自己的接口内存转发（不落盘），也可用环境变量彻底不进浏览器。
- **简单/高级设置** — 新用户默认只看到三块（转录引擎、AI 检测、显示）；点开「高级」才会看到 BYOK、分任务模型、说话人分离、数据与联动这些。只要你已经配置过任何高级项，会自动切到高级视图，不会把你在用的东西藏起来。
- **背景画像**（默认关闭）— 告诉 AI 你的行业、角色、英语水平，解释风格会跟着调；只作为一行长度受限的提示随请求发送，默认不开，也不影响 prompt 缓存。
- **诊断信息可以直接发给我** — 出错的 toast 会带一个短编号（像 `[JS-K3F9]`）和「复制诊断」按钮；高级设置 → 数据与联动里还有完整的「诊断信息」面板，一键「复制诊断信息」，报告已经脱敏，可以直接拿去提 issue。
- **深浅色主题** — 七套内置主题跑在严格 17-token 主题引擎上：终端深色（默认）、纸感浅色、高对比深色，再加水墨（宣纸朱批）、魔典（哥特烫金）、黑金（黑色电影）、青绿（矿彩山水）。每套主题（含浅色）的对比度都在测试里按 WCAG AA 逐项校验；原生控件、滚动条、应用图标都会跟随当前深浅方案。另有字号调节，全局与转录可分开设置。
- **免账号历史** — 全部存浏览器 IndexedDB，支持搜索曾出现过的表达；设置里可导出全量备份（含会话、个人词典、学习记录）、导入恢复。

<div align="center">
<table>
  <tr>
    <td><img src="assets/home.png" alt="终端风格空状态的待机首页" /></td>
    <td><img src="assets/summary.png" alt="会后纪要与导出面板" /></td>
  </tr>
  <tr>
    <td align="center"><sub>待机中的 REPL</sub></td>
    <td align="center"><sub>纪要与导出</sub></td>
  </tr>
  <tr>
    <td><img src="assets/live-light.png" alt="内置浅色主题下的实时会议界面" /></td>
    <td><img src="assets/review.png" alt="/review 学习中心：统计、词云、高频 Top 10" /></td>
  </tr>
  <tr>
    <td align="center"><sub>同一场会，浅色主题</sub></td>
    <td align="center"><sub>学习中心</sub></td>
  </tr>
</table>
</div>

## 本地安装与运行

*（本节英文版：[README.md](README.md#local-setup)）*

两件独立的事：**应用本体**（一个 Next.js 服务，必装）和**本地 Whisper sidecar**（一个 Python 进程，可选——只有想要音频完全不出本机时才需要）。先把应用本体跑起来；什么时候想用本地转录了，再装 sidecar。

### 准备工作

- **git** —— `git --version` 确认已装；没有就去 [git-scm.com](https://git-scm.com/downloads) 装
- **Node.js ≥ 20**（本仓库自己的开发环境用 24）—— `node -v` 确认版本；去 [nodejs.org](https://nodejs.org/) 装，或用 nvm/fnm 之类的版本管理器
- **Python ≥ 3.9** —— 只有第二步会用到；`python3 --version` 确认版本；没有就去 [python.org](https://www.python.org/downloads/) 装

### 第一步：应用本体

```bash
git clone https://github.com/mianaz/jargonslayer.git
cd jargonslayer
npm ci
npm run build && npm start
# 开发模式改用：npm run dev
# 打开 http://localhost:3000
```

`npm ci` 按 lockfile 精确安装，不会改动锁定文件。项目从 v0.4 起变成 npm workspace（根目录 + `apps/web` + `packages/core`），上面的命令没变；但如果你是拉更新一个更早的旧 clone，`git pull` 之后要重新跑一遍 `npm ci`，把新的 workspace 结构装齐。

> 本地跑永远不要设 `NEXT_PUBLIC_DEPLOY_TIER`。这个环境变量只给体验版的构建用，会切成共享演示 Key、精简版模型列表那一套。不设（默认）就是完整的本地版。

第一次打开会弹出新手引导。**先点右上角 ≡ 菜单里的「演示」** — 不需要麦克风、不需要 API Key，就能看到完整的转录 → 检测 → 卡片 → 会后报告流程（无 Key 时演示走内置词典）。词典检测不用装任何东西，立即可用、完全离线；AI 检测和会后报告要配 Key，见下面的[配置 API Key](#配置-api-key解锁-ai-检测与会后报告)。

### 第二步：本地 Whisper sidecar（可选，建议装）

装这个能解锁本地 Whisper 麦克风引擎、标签页音频（抓线上会议对方的声音，或任意标签页/流媒体）、以及文件和链接导入的本地路线（上传录音走 sidecar 转录质量更好，还能自动分离说话人；链接导入 / `yt-dlp` 只能走这条路）。这几条路音频都不出本机。

```bash
cd sidecar
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python whisper_server.py --model medium
```

等横幅打印出来再回网页操作。第一次运行会先从 Hugging Face 下载模型，端口要等下载和模型加载都完成才会打开。视模型大小和网速，这一步可能要等一会儿才有任何输出——是正常现象，不是卡住了。大概会看到这样的内容：

```
============================================================
JargonSlayer 本地 Whisper 服务 / local Whisper sidecar
  model:     medium
  device:    cpu
  load:      12.34s
  diarize:   off
ws://127.0.0.1:8765 等待连接 — 在 JargonSlayer 设置中选择「本地 Whisper」
http://127.0.0.1:8766 录音上传任务 API — PUT /transcribe, POST /ingest-url, GET /jobs
============================================================
```

看到 `ws://... 等待连接` 这行，回到网页：设置 → 转录引擎 → 本地 Whisper → 开始监听。

说话过程中先出灰色中间结果（打字机效果）现在由 App 内设置控制，默认开启：设置 → 转录引擎 → 「实时转录预览」，按需每场会议单独切换，不用重启 sidecar。sidecar 自己的 `--partials` 参数还在，但只作为旧版 App（不会发送这个设置）连接时的服务端默认值。

| 模型 | 质量 | 速度 | 建议场景 |
|---|---|---|---|
| `tiny` / `base` | 一般 | 极快 | 低配机器，图个快速试跑 |
| `small`（sidecar 默认） | 好 | 实时有富余 | 轻量，干净的纯英文音频够用 |
| `medium` | 更好 | 接近实时 | **推荐——中英夹杂实时转录的最佳平衡点** |
| `large-v3` | 最好 | Apple Silicon 上实时跑不动 | 精度最高——Mac 上适合会后重转录，有 NVIDIA 显卡的话实时也能上 |
| `large-v3-turbo` | 高，部分中文场景稍弱 | 比 `large-v3` 快约 4 倍 | 英语为主偶尔夹中文——不支持 translate 任务 |

经验法则：Apple Silicon 开实时会议选 `medium`；有 NVIDIA 显卡实时也能上 `large-v3`；机器老或没独显就用 `small`。这几个模型都做不到句内中英切换零误差——Whisper 每约 30 秒的窗口只认一种语言；真正撑起双语体验的是上面那层术语检测和中文注释，不是转录本身。

**该选哪个引擎**：只用麦克风 → 本地 Whisper。要听线上会议对方的声音，或者抓任意标签页/流媒体 → 标签页音频（同一个 sidecar，照样不出本机）。什么都不想装 → 浏览器识别，零配置兜底方案——Chrome 139+ 优先设备端识别（音频留在本机）；没有本地语言包时话说清楚：音频会送到 Chrome 的语音服务（Google）。状态栏实时显示当前走的是哪条路。

### 安装排错

- **`无法连接本地 Whisper` 提示** —— sidecar 没启动，或者还在下载/加载模型（等上面说的横幅出现）。用 `nc -z localhost 8765 && echo UP || echo DOWN` 查。
- **`pip install -r requirements.txt` 卡在 `claude-agent-sdk`** —— 这个依赖需要 Python ≥ 3.10，而且只服务于另一个独立、可选的[订阅直连](#订阅直连实验性仅本地开发档) agent sidecar，跟转录无关。只装转录要用的三个依赖就行：`pip install "faster-whisper>=1.0,<2.0" "websockets>=12,<14" "numpy>=1.24,<3.0"`。
- **`npm start` 报错**，提示 "Could not find a production build in the '.next' directory" —— 先跑一遍 `npm run build`；`start` 只负责启动已经打包好的产物。
- **端口被占用** —— 给 `whisper_server.py` 传 `--port <n>`，然后去 设置 → 转录引擎 → Whisper 地址 里改成一致的地址。

> **桌面版**：已经有早期开发版可以跑了，见下面的[桌面版（开发中）](#桌面版开发中)。免终端的正式安装包会在 v0.4 后续（S8）发布。

### 桌面版（开发中）

原生桌面外壳（Tauri）把同一个应用包起来，本地 Whisper sidecar 由应用自己托管——上面第二步的 `pip`/终端操作都不用手动做了。目前还在开发中（v0.4 S3–S5），走的是开发者路线，还不是签名安装包。

```bash
npm ci
npm run dev:desktop
```

第一次打开会弹出一个全屏向导，先征求同意（点「开始安装」之前什么都不会下载），然后把独立的 Python 运行环境、faster-whisper、你在向导里选的 Whisper 模型（四档可选，预选 `medium`）全部装进应用自己的数据目录——不碰系统 Python，把那个目录删掉就是干净卸载：

- macOS：`~/Library/Application Support/com.bioinfospace.jargonslayer/`（Python/venv、模型缓存、安装记录）和 `~/Library/Logs/com.bioinfospace.jargonslayer/whisper_server.log`

这个版本的 设置 → 转录引擎 里会多一个「托管模式」开关：**由应用管理**（默认——应用自己安装/启动/异常退出后自动重启 sidecar，Whisper 地址固定）或**外部**——照旧用上面第二步自己启动的 sidecar，跟普通网页版一样。

托管模式下设置里还有两个网页版没有的入口：**更换模型**——新模型在现有服务*旁边*下载，下载完成才切换；下载中途开会的话切换自动取消，正在跑的服务不会被拆掉。**说话人分离**——一键安装分离扩展（锁定版本的 pyannote + torch，约 1 GB；下方[说话人分离](#说话人分离可选)一节的 HuggingFace token 和许可条款步骤照旧）。

## 配置 API Key（解锁 AI 检测与会后报告）

内置词典只能匹配固定短语。填入 Anthropic API Key 后才有上下文感知的 AI 检测（能分清 "table this" 是"搁置议题"还是真的把东西放桌上）和会后纪要/翻译。两种方式任选：

1. **UI 里填**：≡ 菜单 → 「设置」 → 顶部切到「高级」 → AI 检测 → API Key。Key 存在你本机浏览器（IndexedDB），每次调用经本应用自己的 `/api/*` 接口内存中转一次再转发给模型商——不落盘、不写日志，但会经过这台服务器的内存，跟"完全不碰任何服务器"不是一回事，本地自建时这台服务器就是你自己的机器。
2. **环境变量**（推荐，最硬核的姿势）：Key 完全不进浏览器，只活在服务端进程里。项目根目录建 `.env.local`：
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
   然后重启 `npm run dev`。

Key 从 [console.anthropic.com](https://console.anthropic.com/) 获取。默认模型：实时检测 `claude-haiku-4-5`（快、便宜），会后报告 `claude-sonnet-5`（质量），设置里都能换。

**成本参考**：60 分钟、约 9000 词的会议，实时检测约 $0.5，会后报告约 $0.3–0.55，合计约 **$1/场**；纯词典模式 $0。

## 转录引擎

| | 配置成本 | 音频去向 | 建议场景 |
|---|---|---|---|
| 浏览器识别 | 无 | Chrome 139+ 可用设备端识别时**不出本机**，否则走浏览器厂商语音服务（**云端**）——状态栏实时显示当前是哪条路 | 日常会议（Chrome/Edge），零配置 |
| 本地 Whisper | 装一次 Python 环境 | **不出本机** | 敏感内容、离线、想要更稳的识别 |
| 标签页音频 | 同上（走本地 sidecar） | **不出本机** | 线上会议转录对方声音（免虚拟声卡） |
| Soniox（实验） | 自备 Soniox API Key | Soniox 实时接口（**云端**，用你自己的 Key 直连 WSS） | 中英夹杂实时场景；通过内部基准测试前保持「实验」标记 |

「演示」不是引擎，而是一个菜单入口，回放预录会议，零配置看完整流程。

### 本地 Whisper（隐私模式）

安装步骤、"就绪"横幅、模型怎么选、排错，都在[本地安装与运行 → 第二步](#第二步本地-whisper-sidecar可选建议装)里。

跑起来之后常用参数：`--language en`（默认）、`--save-audio meeting.wav`（保留录音，供会后说话人分离）。`--partials`（说话过程中出灰色中间结果，更费 CPU）现在由 App 的「实时转录预览」设置按会话控制（默认开启）——这个参数只在旧版 App（不会发送该设置）连接时作为 sidecar 的默认值生效。

### ⚠️ 转录"对方的声音"（线上会议必读）

麦克风只能听到**你自己**。Zoom/Teams/Meet 里对方的声音从扬声器出来，需要把系统音频变成一个输入设备：

- **macOS**：装 [BlackHole](https://github.com/ExistentialAudio/BlackHole)（免费虚拟声卡）→ 系统设置里建一个"多输出设备"（耳机 + BlackHole，你照常听声）→ JargonSlayer 设置里把麦克风选成 BlackHole，引擎用**本地 Whisper**（浏览器识别引擎不认虚拟设备选择，始终用系统默认输入）。
- **Windows**：VB-Cable 同理。
- 想同时转录你和对方：macOS「聚合设备」把麦克风 + BlackHole 合成一个输入。

## 使用流程

1. 选引擎 → 「开始监听」（浏览器会请求麦克风权限）。
2. 左侧看转录，右侧「实时解释」看卡片。带下划线的表达可点；选中一段文字会弹出即席解释。
3. 「停止」→ 自动存入历史 → 「纪要与导出」→ 「生成会议报告」。
4. 导出 Markdown / Anki TSV（可直接导入 Anki：文件 → 导入，字段以 Tab 分隔）/ JSON。
5. ≡ 菜单 → 「历史」可以重新打开任何一场会，支持按表达搜索（"那个 *boil the ocean* 是哪次会说的？"）。

## 说话人分离（可选）

两条路都已内置到 UI。一次性准备工作：

1. `pip install -r requirements-diar.txt`（装进 sidecar 的 `.venv`；这是锁定版本、装机验证过的一组依赖。桌面版可以跳过这一步——设置 → 说话人分离 里一键安装）；
2. HuggingFace 免费账号 → 依次接受三个模型的使用条款：[segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)、[speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)、[speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)（pyannote 4.x 新增的依赖，漏掉会 403）；
3. 建一个 Read 权限的 token，填进 设置 → 说话人分离（或启动 sidecar 时传 `--hf-token`）。

**上传录音自动分离**：≡ 菜单 → 「历史」→ 「导入」→「文件」标签，选音频文件（m4a/mp3/wav），后台转录 + 分离，完成后自动载入。点说话人标签即可改名（SPEAKER_1 → Elena）。

**实时分离（beta）**：设置 → 说话人分离 → 「实时说话人分离（beta）」。开会时标签延迟数秒出现并随会议进行逐步修正，会多占一些 CPU；转录本身不受影响。

> 注意：sidecar 的 `.venv` 内是绝对路径，移动或重命名项目目录后需要删掉重建（`rm -rf .venv && python3 -m venv .venv && pip install -r requirements.txt`）。

## 订阅直连（实验性，仅本地开发档）

**这不是"我们帮你接通订阅"，而是让本机的 JargonSlayer 用你自己已经登录的 `claude` / `codex` CLI 回答一个问题**——与你自己在终端跑 `claude -p '...'` / `codex exec '...'` 完全同一件事，只是由本机的一个进程替你敲了这行命令。凭据始终留在你自己的 `claude`/`codex` 登录态里，本项目永不读取、永不落盘任何副本，也不经过任何服务器（包括体验版的 Vercel 服务端）。仅 **detect**（实时检测）与 **define**（即席解释）两个场景接入，翻译/纪要生成永远走现有路径不受影响。依官方第三方开发者政策可能随时变化，三层开关随时可关（本地开关 / 构建旗标 / 远程熔断）。

一次性准备工作：

1. 终端跑 `claude`（或 `claude setup-token`）完成 Claude 订阅登录，或 `codex login` 完成 ChatGPT 登录——JargonSlayer 不提供登录入口，只会检测你是否已登录并告诉你该在终端敲哪个命令；
2. `cd sidecar && pip install -r requirements.txt`（新增依赖 `claude-agent-sdk`，装进 sidecar 的 `.venv`）；
3. 单独起这个 agent sidecar（与转录用的 whisper sidecar 是两个独立进程，互不依赖）：

```bash
cd sidecar
python -m sidecar.agent_server --port 8767
# 启动日志会打印一次性「连接码」，例如：
#   连接码（复制到 设置 → 订阅直连（实验性）→ 连接码）：xxxxxxxx
```

4. 网页：设置 → 「订阅直连（实验性）」→ 勾选启用 → 选择 Provider（Claude / ChatGPT）→ 把上一步的连接码粘贴进去。

宿主状态、Claude/ChatGPT 各自的登录状态都会在设置区块里显示；额度用尽或未登录时会自动切换到内置离线词典并弹一次提示，不会静默改用你配置的 BYOK Key。

> 需要构建时设置 `NEXT_PUBLIC_ENABLE_SUBSCRIPTION_DIRECT=1` 才会出现该功能——不设时，这段 UI 与调用代码完全不出现在构建产物里（体验版构建不设，因此体验版永远没有这个入口）。

## 版本

同一个产品按**形态**分层（不是按付费分层——全部免费开源，AGPL 许可）：

| 能力 | Chrome 插件（Lite，规划中） | 体验版（[在线](https://apps.bioinfospace.com/jargonslayer)） | 本地版 / 桌面版 |
|---|---|---|---|
| 词典检测（即时、离线） | ✓ | ✓ | ✓ |
| 转录 | Web Speech | Web Speech | Web Speech（可用时走设备端） · 本地 Whisper · 标签页音频 · Soniox（自备 Key，实验） |
| AI 检测 / 翻译 / 纪要 | — | ✓ 内置演示 Key（限流、固定模型列表） | ✓ 自己的 Key（BYOK） |
| 导入文稿 / 音频 / 视频（浏览器内处理） | — | ✓ | ✓ |
| URL 导入（yt-dlp） | — | 可见，需本地 sidecar | ✓ |
| 说话人分离 | — | 可见，需本地 sidecar | ✓ |
| BYOK / OAuth 一键连接 | — | 可见但置灰 | ✓ |

体验版里需要本地 sidecar 或自有凭据的功能不隐藏、只置灰并标「本地版功能」——你看到的就是完整产品，不是阉割版。

## 隐私边界（明确说清楚）

**定位：默认透明，想全本地随时可选。**各版本数据去向：

| 数据 | 去向 |
|---|---|
| 音频（本地 Whisper / 标签页音频） | 仅本机，websocket 走 127.0.0.1 |
| 音频（浏览器识别 / Web Speech） | Chrome 139+ 且本地语言包可用时：**仅本机**（自动优先，状态栏绿色提示）。否则：浏览器厂商的语音服务（如 Google）——**所有**用 Web Speech 的版本都一样，包括插件 |
| 音频（Soniox 引擎，自备 Key） | 用**你自己的** Key 经 WSS 直连 Soniox 实时接口——适用 Soniox 的隐私条款；Key 本身不会出现在日志、诊断或导出里 |
| 音频/视频文件导入 | 仅本机——浏览器内转录（Whisper WebGPU/WASM、ffmpeg.wasm），不上传 |
| 转录文本（体验版，AI 开启） | 经我们服务器**内存中转（不存储）**→ 转发 OpenRouter，**带 `provider.data_collection="allow"`**（演示 Key 的模型路由所需——体验版文本请当作可能被模型提供方留存） |
| 转录文本（本地版，BYOK AI 开启） | 直连**你自己**配置的端点；**不带** `data_collection` 标志，适用你所选提供方的隐私条款 |
| 转录文本（订阅直连开启时，仅 detect/define） | 你自己机器上的 `claude`/`codex` CLI，不经过任何服务器 |
| 转录文本（AI 关闭 / 词典模式） | 仅本机 |
| 会议历史、设置、API Key | 仅本机浏览器（IndexedDB / localStorage） |

不想让任何文本出本机：设置里关掉「AI 检测」，内置词典照常即时检测，完全离线。vim 风格状态栏始终显示当前音频去向（「音频在本地处理」/「音频经浏览器厂商云端识别」）。

## 认识 Bit 🐉

<img src="assets/bit.png" align="right" width="220" alt="Bit，像素小龙吉祥物" />

蹲在状态栏上的像素小龙叫 **Bit**：光标块瞳孔像光标一样眨眼，背鳍在监听时像信号格一样亮起，有新卡片落地时喷出 ANSI 彩色像素火焰。会议结束 30 秒后它会睡着。

它还能互动。试试点它。试试快速连点三次。试试按住不放。

<br clear="right" />

## 常见问题

- **「浏览器不支持语音识别」** — Safari/Firefox 对 Web Speech API 支持差，用 Chrome/Edge，或直接上本地 Whisper。
- **Whisper 连不上** — 确认 sidecar 终端还开着、地址是 `ws://localhost:8765`；防火墙放行本地端口。
- **卡片太少/太多** — 设置里调「置信度阈值」（低=多），或换检测模型。
- **会议在后台标签页时检测变慢** — 正常，浏览器会节流后台定时器；切回来会立即补检。已尽量用事件驱动缓解。
- **生成报告很慢** — 长会议的全文翻译是分块并行跑的，1–2 分钟正常；只想要卡片可以不生成报告直接导出。

## 技术栈

Next.js 15 (App Router) + TypeScript + Tailwind + zustand + IndexedDB，npm workspaces 结构（`apps/web` + `packages/core`，共享核心为纯 TS）；LLM 调用走服务端路由代理（Anthropic Messages API 或 OpenAI 兼容端点，结构化输出 + 修复重试）；本地转录 faster-whisper sidecar（websocket + 能量 VAD）；说话人分离 pyannote 4.x。桌面版（`apps/desktop`）用 Tauri v2 外壳包同一个应用，Rust 核心通过版本锁定、校验和验证的 `uv` 安装独立 Python 运行环境——参数按固定形状白名单校验，webview 拿不到 shell。

## 参与、修改与分叉

欢迎提 issue、发 PR、fork、发布你自己的修改版——这个许可就是为了让这些事变得容易，不是为了看守代码。这是个业余项目，review 可能很慢，等不及就直接 fork，这是完全正当的做法。基于本项目构建时，请保留版权与许可声明（AGPL 本身要求这一点）；如果能在你发布的版本里放一个指回本仓库的链接，就更感谢了。提交的贡献按项目的 AGPL-3.0 许可接受。

## 许可证

[AGPL-3.0](LICENSE) © 2026 Miana Zeng。在任何场合（包括工作中）都可以免费使用；若修改后再分发、或改造后作为服务对外提供，必须以相同许可公开你的源码。v0.3.0 及更早的已发布版本仍按当时的 MIT 许可提供。

这是个人业余项目，只做力所能及的维护——不承诺任何支持、可用性或适用性（详见许可证的免责条款）。
