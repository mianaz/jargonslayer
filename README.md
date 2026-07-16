<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/icon-ui-dark.png" />
  <img src="apps/web/public/icon-ui-light.png" width="150" alt="JargonSlayer icon" />
</picture>

# JargonSlayer

**Real-time English-meeting comprehension assistant · your meeting, as a running process**

*英文会议实时理解助手 · 把会议变成一个正在运行的进程*

[![Release](https://img.shields.io/github/v/release/mianaz/jargonslayer?style=flat-square&color=4ADE80&labelColor=121212)](https://github.com/mianaz/jargonslayer/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-22D3EE?style=flat-square&labelColor=121212)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-2347%20passing-4ADE80?style=flat-square&labelColor=121212)](apps/web/src/lib/__tests__)
[![Data paths](https://img.shields.io/badge/data-transparent%20paths-FFAA44?style=flat-square&labelColor=121212)](#privacy)

**English** · [简体中文](README.zh-CN.md) · [**Try It Live**](https://apps.bioinfospace.com/jargonslayer) · [**Website & Docs**](https://mianaz.github.io/jargonslayer/)

<img src="assets/live.png" alt="JargonSlayer live meeting view: block-flow transcript with highlighted expressions on the left, real-time explanation cards on the right" width="920" />

</div>

---

It sits beside your English meetings and turns **business slang, idioms, metaphors, indirect phrasing, and jargon** into short Chinese cards in real time. When the meeting ends, one click produces a **bilingual summary, a full transcript translation, and study cards**. Local-first: with the desktop app and local Whisper, audio is processed entirely on your machine.

> The product UI is Simplified Chinese — it is built for non-native English speakers (Chinese-speaking professionals and researchers first).

## Get it

- **macOS desktop app** (Apple Silicon, recommended) — download the DMG from [Releases](https://github.com/mianaz/jargonslayer/releases/latest). The first-run wizard installs local Whisper into the app's own directory (nothing downloads without consent; deleting the directory is a clean uninstall). **System/app audio** (macOS 14.4+) transcribes meetings running in native apps — Zoom, Teams, WeChat — directly, with no virtual audio device.
- **Web app** — [try the hosted preview](https://apps.bioinfospace.com/jargonslayer) (built-in demo AI key, rate-limited), or self-host: `npm install && npm run build && npm start` with Node 20+. Details in the [docs](https://mianaz.github.io/jargonslayer/docs/).
- **Chrome extension (JargonSlayer Lite)** — live captions and jargon cards in a side panel; grab the zip from [Releases](https://github.com/mianaz/jargonslayer/releases) and load it unpacked (Web Store listing pending).

## Features

- **Real-time jargon cards** — slang, idioms, metaphors, acronyms → short Chinese explanations as they are spoken; LLM-powered (bring your own key) or the instant offline dictionary (428 entries), one toggle apart.
- **Multiple transcription engines** — local Whisper (fully on-device), system/app audio (desktop), tab audio (web), browser recognition; the status bar always shows where your audio goes.
- **Speaker diarization** — who-said-what labels, live and for imported recordings (pyannote, optional one-click install).
- **Meeting reports** — bilingual minutes, full transcript translation, exports to Anki / Markdown / JSON, webhooks.
- **Learning loop** — flip-card review with spaced repetition, a word cloud, and a personal glossary that suppresses what you already know.
- **Imports** — audio/video files and URLs, transcribed locally in the browser or by the sidecar.
- **Bit** 🐉 — the pixel dragon perched on the status line. Click it. Click it three times fast.

## Privacy

Transparent by default, fully local when you choose. Local Whisper and system/app audio never leave your machine — the status line shows 「音频在本地处理」; every other engine and tier states exactly where audio and text go. The full data-path table lives on the [privacy page](https://mianaz.github.io/jargonslayer/privacy.html).

## Docs

Setup guides (API keys, speaker diarization, troubleshooting), the per-platform engine matrix, and the FAQ all live on the website: **[mianaz.github.io/jargonslayer](https://mianaz.github.io/jargonslayer/)** · [Docs (EN)](https://mianaz.github.io/jargonslayer/docs/) · [文档（中文）](https://mianaz.github.io/jargonslayer/docs/zh/)

## Contributing & forks

Issues, pull requests, forks, and modified versions are all welcome — the license exists to make that easy, not to guard the code. This is a best-effort side project, so reviews may be slow; forking ahead instead of waiting is a perfectly good answer. If you build on it, keep the copyright and license notices intact (the AGPL requires this), and a visible link back to this repository in whatever you publish is appreciated. Contributions you submit are accepted under the project's AGPL-3.0 license.

## License

[AGPL-3.0](LICENSE) © 2026 Miana Zeng. Free to use anywhere, including at work; if you modify it and redistribute or host it as a service, you must share your source under the same terms. Releases up to and including v0.3.0 were published under MIT and remain so.

This is a personal side project, maintained on a best-effort basis — no support, uptime, or fitness for any purpose is promised (see the license's warranty disclaimer).
