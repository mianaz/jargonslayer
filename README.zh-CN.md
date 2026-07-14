<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/icon-ui-dark.png" />
  <img src="apps/web/public/icon-ui-light.png" width="150" alt="JargonSlayer icon" />
</picture>

# JargonSlayer

**英文会议实时理解助手 · 把会议变成一个正在运行的进程**

*Real-time English-meeting comprehension assistant · your meeting, as a running process*

[![Release](https://img.shields.io/github/v/release/mianaz/jargonslayer?style=flat-square&color=4ADE80&labelColor=121212)](https://github.com/mianaz/jargonslayer/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-22D3EE?style=flat-square&labelColor=121212)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-1903%20passing-4ADE80?style=flat-square&labelColor=121212)](apps/web/src/lib/__tests__)
[![Data paths](https://img.shields.io/badge/data-transparent%20paths-FFAA44?style=flat-square&labelColor=121212)](#隐私)

**简体中文** · [English](README.md) · [**在线体验**](https://apps.bioinfospace.com/jargonslayer) · [**官网与文档**](https://mianaz.github.io/jargonslayer/)

<img src="assets/live.png" alt="JargonSlayer 会议实时视图：左侧为分块转录流，高亮标注表达；右侧为实时释义卡片" width="920" />

</div>

---

开着它上英文会议，**商务黑话、习语、隐喻、拐弯抹角的措辞、行业术语**会被实时拆解成简短的中文释义卡片。会后一键生成**双语摘要、全文译文和学习卡片**。本地优先：桌面端搭配本地 Whisper，音频在本地处理，不出你的电脑。

> 产品界面为简体中文——面向母语非英语的中文使用者（职场人士和科研人员优先）。

## 获取方式

- **macOS 桌面端**（Apple Silicon，推荐）— 从 [Releases](https://github.com/mianaz/jargonslayer/releases/latest) 下载 DMG。首次启动的引导向导会把本地 Whisper 安装到应用自身目录（未经同意不会下载任何文件；删除目录即为干净卸载）。**系统/App 音频**（macOS 14.4+）可直接转录 Zoom、Teams、微信等原生应用中的会议音频，无需虚拟音频设备。
- **Web 应用** — [在线体验托管版](https://apps.bioinfospace.com/jargonslayer)（内置演示 AI key，有频率限制），也可自行部署：`npm install && npm run build && npm start`，需要 Node 20+。详见[文档](https://mianaz.github.io/jargonslayer/docs/)。
- **Chrome 扩展（JargonSlayer Lite）** — 侧边栏实时字幕 + 术语卡片；从 [Releases](https://github.com/mianaz/jargonslayer/releases) 下载 zip 后以开发者模式加载（Web Store 上架审核中）。

## 功能

- **实时术语卡片** — 黑话、习语、隐喻、缩写，说出口的瞬间就变成简短中文释义；LLM 驱动（自带 key）或离线词典（428 条），一键切换。
- **多转录引擎** — 本地 Whisper（全程在设备上运行）、系统/App 音频（桌面端）、标签页音频（Web 端）、浏览器语音识别；状态栏始终显示音频去向。
- **说话人分离** — 谁说了什么，实时标注，导入录音后也能标注（pyannote，可选一键安装）。
- **会议报告** — 双语会议纪要、全文翻译、导出到 Anki / Markdown / JSON、Webhook 推送。
- **学习闭环** — 翻转卡片搭配间隔重复、词云、个人词汇本（已掌握的词自动不再提示）。
- **导入** — 音视频文件和 URL，在浏览器端或 sidecar 本地转录。
- **Bit** 🐉 — 趴在状态栏上的像素小龙。点它。快速连点三下试试。

## 隐私

默认透明，按需全离线。本地 Whisper 和系统/App 音频的数据不会离开你的电脑——状态栏会显示「音频在本地处理」；其他引擎和层级都会明确标出音频和文本的去向。完整的数据路径表见[隐私页面](https://mianaz.github.io/jargonslayer/privacy.html)。

## 文档

API key 配置、说话人分离设置、故障排查、各平台引擎对照表、FAQ 都在官网：**[mianaz.github.io/jargonslayer](https://mianaz.github.io/jargonslayer/)** · [Docs (EN)](https://mianaz.github.io/jargonslayer/docs/) · [文档（中文）](https://mianaz.github.io/jargonslayer/docs/zh/)

## 贡献与 Fork

欢迎提 issue、发 pull request、fork、做修改版——许可证是为了让这些事变容易，不是拿来护着代码的。这是业余时间维护的个人项目，review 可能会慢；不想等的话直接 fork 也完全没问题。如果你在此基础上做了衍生版本，请保留版权和许可声明（AGPL 的要求），在发布物中放一个指回本仓库的可见链接，我会很感激。你提交的贡献按本项目的 AGPL-3.0 许可证接受。

## 许可证

[AGPL-3.0](LICENSE) © 2026 Miana Zeng。可以自由使用，包括工作场景；如果你修改后再分发或作为服务托管，需要以相同条款公开你的源代码。v0.3.0 及更早的版本以 MIT 发布，仍然适用 MIT。

这是个人业余项目，尽力维护——不承诺支持、可用性或适用于任何特定用途（详见许可证中的免责声明）。
