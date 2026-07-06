# MeetLingo 打包与形态路线

四种形态（桌面 app / 菜单栏 app / 手机 / iPad）的现实路径与取舍。

## 现在就能用：PWA（已内置）

manifest + 图标已配置，`npm run dev`（或 `npm run build && npm start`）跑起来后：

- **桌面（Chrome/Edge）**：地址栏右侧「安装 MeetLingo」→ 独立窗口、Dock/任务栏图标、无浏览器 UI。体验上就是桌面 app。
- **iPad / iPhone（Safari）**：分享 → 「添加到主屏幕」。iOS 16.4+ 的 PWA 支持麦克风权限，浏览器识别引擎可用；本地 Whisper 引擎需要能访问跑 sidecar 的机器（同一局域网时把 `whisperUrl` 指到电脑 IP，如 `ws://192.168.1.x:8765`）。
- 注意：PWA 依然需要 Next 服务在某处运行（本机或局域网内一台机器）。`npm start` 常驻即可。

一份代码覆盖四种形态的 90% 体验，这是投入产出比最高的一步，所以先做了它。

## v2 推荐形态：Tauri 菜单栏应用（macOS）

会议场景的理想形态是 menubar 常驻：点图标开始/停止监听，浮窗显示卡片，不占 Dock。

路径（约一天工作量）：

1. `npm create tauri-app` 或在本仓库加 `src-tauri/`（Tauri 2）；
2. Next 以 **sidecar 进程**方式打包：`tauri.conf.json` 的 `externalBin` 带上 `next start` 的 standalone 输出（`next.config.mjs` 加 `output: "standalone"`），Tauri 启动时拉起本地 3000 端口再加载 `http://localhost:3000`；
3. 托盘：`tauri-plugin-positioner` + `TrayIcon`，点击在托盘下方弹 420×640 浮窗（正好是右栏卡片面板的尺寸）；
4. 全局快捷键：`tauri-plugin-global-shortcut` 绑定开始/停止监听；
5. 麦克风权限：macOS 需要在 `Info.plist` 加 `NSMicrophoneUsageDescription`。

**为什么 Tauri 不是 Electron**：安装包 ~10MB vs 150MB+，内存占用差数倍；本工具 UI 已经是 Web 的，Tauri 用系统 WebView 足够。

**全离线组合**：Tauri + 本地 Whisper sidecar + OpenAI 兼容端点指向本机 Ollama（如 `http://localhost:11434/v1` + qwen 系列）= 音频和文本都不出本机的完整隐私闭环。

## 不建议：原生 iOS/Android

PWA 已覆盖移动端的"旁听 + 看卡片"场景；原生化需要重写音频管线（AVAudioEngine/AudioRecord）+ 上架流程，对个人工具投入产出比过低。真有需求时 Tauri 2 的 mobile target 是迁移成本最低的路径（复用全部前端）。

## 图标

- `src/app/icon.svg`：产品签名图标（深色转录行 + 金色高亮表达 + 虚线下划线），Next 自动作为 favicon；
- `src/app/apple-icon.png`：iOS 主屏幕图标（自动挂载）；
- `public/icon-maskable.svg`：Android maskable 变体（安全区内缩）。
