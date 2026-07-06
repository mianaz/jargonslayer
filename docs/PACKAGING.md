# JargonSlayer Packaging and Form-Factor Roadmap

Realistic paths and trade-offs for four form factors (desktop app / menu-bar app / phone / iPad).

## Available now: PWA (already built in)

The manifest and icons are already configured; once `npm run dev` (or `npm run build && npm start`) is running:

- **Desktop (Chrome/Edge)**: click "安装 JargonSlayer" (Install JargonSlayer) at the right of the address bar → a standalone window, Dock/taskbar icon, no browser chrome. Feels like a desktop app.
- **iPad / iPhone (Safari)**: Share → "添加到主屏幕" (Add to Home Screen). iOS 16.4+'s PWA support includes microphone permission, so the browser recognition engine works; the local Whisper engine needs network access to whichever machine is running the sidecar (on the same LAN, point `whisperUrl` at the computer's IP, e.g. `ws://192.168.1.x:8765`).
- Note: the PWA still needs the Next.js server running somewhere (locally, or on a machine on the LAN). Keeping `npm start` running is enough.

One codebase covers 90% of the experience across all four form factors — this is the highest-ROI step, which is why it was built first.

## Recommended v2 form factor: Tauri menu-bar app (macOS)

The ideal form factor for meetings is a persistent menu-bar presence: click the icon to start/stop listening, a floating panel shows cards, no Dock footprint.

Path (roughly a day of work):

1. `npm create tauri-app`, or add `src-tauri/` to this repo (Tauri 2);
2. Package Next.js as a **sidecar process**: `tauri.conf.json`'s `externalBin` carries the standalone output of `next start` (add `output: "standalone"` to `next.config.mjs`); Tauri launches local port 3000 on startup, then loads `http://localhost:3000`;
3. Tray: `tauri-plugin-positioner` + `TrayIcon`, clicking pops a 420×640 floating panel below the tray icon (matching the right-column cards panel's size);
4. Global shortcut: `tauri-plugin-global-shortcut` bound to start/stop listening;
5. Microphone permission: on macOS, add `NSMicrophoneUsageDescription` to `Info.plist`.

**Why Tauri, not Electron**: install size ~10MB vs 150MB+, memory footprint several times smaller; this tool's UI is already web-based, and Tauri's system WebView is sufficient.

**Fully offline combination**: Tauri + local Whisper sidecar + an OpenAI-compatible endpoint pointed at local Ollama (e.g. `http://localhost:11434/v1` + a qwen-family model) = a complete privacy loop where neither audio nor text ever leaves the machine.

## Not recommended: native iOS/Android

The PWA already covers the mobile "listen in + watch cards" scenario; going native would require rewriting the audio pipeline (AVAudioEngine/AudioRecord) + an app-store submission process — poor ROI for a personal tool. If the need genuinely arises, Tauri 2's mobile target is the lowest-migration-cost path (reuses the entire frontend).

## Icons

- `src/app/icon.svg`: the product's signature icon (dark transcript line + gold-highlighted expression + dashed underline), automatically used by Next.js as the favicon;
- `src/app/apple-icon.png`: iOS home-screen icon (auto-mounted);
- `public/icon-maskable.svg`: Android maskable variant (inset within the safe zone).
</content>
