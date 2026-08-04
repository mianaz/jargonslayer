<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/icon-ui-dark.png" />
  <img src="apps/web/public/icon-ui-light.png" width="150" alt="JargonSlayer icon" />
</picture>

# JargonSlayer

**私有、全本地的 Mac 双语会议引擎**

*Private, fully local bilingual meeting engine for your Mac.*

[![Release](https://img.shields.io/github/v/release/mianaz/jargonslayer?style=flat-square&color=4ADE80&labelColor=121212)](https://github.com/mianaz/jargonslayer/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/mianaz/jargonslayer/ci.yml?branch=main&style=flat-square&label=CI&labelColor=121212)](https://github.com/mianaz/jargonslayer/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-AGPL--3.0-22D3EE?style=flat-square&labelColor=121212)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-4996%20passing-4ADE80?style=flat-square&labelColor=121212)](apps/web/src/lib/__tests__)
[![Data paths](https://img.shields.io/badge/data-transparent%20paths-FFAA44?style=flat-square&labelColor=121212)](#隐私)

**简体中文** · [English](README.md) · [**在线体验**](https://apps.bioinfospace.com/jargonslayer) · [**官网与文档**](https://mianaz.github.io/jargonslayer/)

<img src="assets/live.png" alt="JargonSlayer 会议实时视图：左侧为分块转录流，高亮标注表达；右侧为实时释义卡片" width="920" />

</div>

---

JargonSlayer 同时收录系统音频和麦克风两路声音，回声消除后自动标注为「我」和「对方」（macOS 26+）。本地 Whisper、系统识别、系统翻译组成默认引擎，全部本机运行，音频和文字不出这台 Mac；云端引擎均为可选。中英双语的实时字幕逐句滚动，会议结束一键把双语纪要存进 Obsidian，或复制成 Notion 即贴的格式。遇到黑话，还会顺手弹一张中文解释卡片。

> 产品界面为简体中文——面向母语非英语的中文使用者（职场人士和科研人员优先）。

## 获取方式

- **macOS 桌面端**（Apple Silicon，推荐）— 从 [Releases](https://github.com/mianaz/jargonslayer/releases/latest) 下载 DMG。首次启动的引导向导会把本地 Whisper 安装到应用自身目录（未经同意不会下载任何文件；删除目录即为干净卸载）。**系统/App 音频**（macOS 14.4+）可直接转录 Zoom、Teams、微信等原生应用中的会议音频，无需虚拟音频设备。
- **Web 应用** — [在线体验托管版](https://apps.bioinfospace.com/jargonslayer)（内置演示 AI key，有频率限制），也可自行部署：`npm install && npm run build && npm start`，需要 Node 20+。详见[文档](https://mianaz.github.io/jargonslayer/docs/)。手机浏览器也可直接使用。
- **iOS 测试版** — TestFlight 受邀测试，可[通过网站联系](https://mianaz.github.io/jargonslayer/)获取邀请；系统本机语音识别 + 系统本机翻译（Apple Translation，无需 Key），需 iOS 26+。
- **Chrome 扩展（JargonSlayer Lite）** — 侧边栏实时字幕 + 术语卡片。手动安装（正式安装方式，暂不上架 Web Store）：从 [Releases](https://github.com/mianaz/jargonslayer/releases) 下载 zip 并解压，打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」选中解压后的文件夹。[分步指南](https://mianaz.github.io/jargonslayer/docs/zh/#quickstart)。

## 功能

- **双路收音** — 系统声音和麦克风一起收，回声消除（AEC）避免麦克风又录到喇叭放出来的会议声音；无需虚拟音频设备（桌面端，macOS 26+）。
- **默认全本地** — 本地 Whisper、系统识别、系统翻译都跑在本机，选它们时音频和文字不出这台 Mac；云端引擎（自带密钥）为可选项，界面有明确标注。
- **中英双语实时字幕** — 英文原声和中文译文逐句同屏滚动。
- **我/对方 说话人标注** — 麦克风和会议声音自动分成「我」「对方」两路；pyannote 说话人分离（可选一键安装）能在多人会议或导入的录音里进一步区分每个人。
- **导出到你的知识库** — 一键把双语纪要和全文译文存进 Obsidian，或复制成 Notion 即贴的格式并自动打开 Notion；也支持 Anki、Markdown、JSON 和 Webhook。
- **术语卡片（实时辅助）** — 黑话、习语、隐喻、缩写，说出口的瞬间就变成简短中文释义；默认走词典模式（1000+ 条，纯本地、无需 Key），可选 AI 模式（Beta，需自备 Key），一键切换。
- **学习中心** — 个人词典、翻转卡片、间隔重复、词云、已掌握词自动不再提示，整合在一处。
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
