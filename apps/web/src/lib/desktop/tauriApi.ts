// v0.4 S3 chunk 5 (docs/design-explorations/s3-tauri-uv-blueprint.md,
// §Chunk 5) — the ONLY module in this app that ever imports
// `@tauri-apps/*`. Every import below is a DYNAMIC import() gated by a
// LITERAL `process.env.NEXT_PUBLIC_DESKTOP === "1" ||
// process.env.NEXT_PUBLIC_IOS === "1"` check living in THIS SAME
// MODULE, directly beside each import() call — deliberately NOT the
// imported `IS_TAURI`/`IS_DESKTOP` re-exports (src/lib/platform/
// ios.ts, src/lib/platform/desktop.ts). Per src/lib/agent/localHost.ts's
// own SUBSCRIPTION_DIRECT_BUILT comment: webpack/Terser's DefinePlugin +
// ConstPlugin dead-branch elimination reliably prunes a DIRECT
// `process.env.NEXT_PUBLIC_X === "1"` literal at the call site, but
// does NOT always achieve the same for a re-exported const imported
// across a module boundary. Keeping every `@tauri-apps/*` import out of
// the ordinary web bundle is this file's entire reason to exist
// (verified by chunk 5's tree-shake grep — see task report), so this is
// the one spot where that stronger guarantee is worth the small
// duplication against IS_DESKTOP/IS_TAURI's own definitions — mirrors
// SettingsDialog.tsx's own choice to read process.env.NEXT_PUBLIC_X
// directly for the same reason. `IS_DESKTOP`/`IS_TAURI` themselves stay
// the right import everywhere else (provisionRunner.ts, bootstrap.ts)
// since those files never write an `import()` of their own.
//
// S13 (docs/design-explorations/s13-ios-blueprint.md, §6 D4, normative)
// — TAURI_BUILD widens this gate from "macOS desktop build" to "any
// Tauri shell build" (macOS desktop OR iOS): BOTH env-var checks stay
// inline literals for the exact same reason as above, so a pure web
// build (neither var set) still folds the whole expression to `false`
// at build time and every `@tauri-apps/*` import() below tree-shakes
// out of that bundle entirely.
//
// Callers never import `@tauri-apps/*` themselves — they take
// invoke/listen/fetch as plain injected function values (see
// provisionRunner.ts's RunnerDeps / bootstrap.ts's BootstrapDeps), so
// unit tests exercise them with fakes and import zero Tauri, the same
// contract chunk 4's provisionMachine.ts/uvCommands.ts already
// established for the pure layer.
const TAURI_BUILD = process.env.NEXT_PUBLIC_DESKTOP === "1" || process.env.NEXT_PUBLIC_IOS === "1";

/** Matches `@tauri-apps/api/core`'s `invoke` signature closely enough
 *  for every command this app calls: Tauri auto-camelCases each Rust
 *  command's snake_case parameter names for the JS-side arg object (see
 *  uvCommands.ts's own DesktopPaths comment for the same conversion on
 *  return-value struct fields) — every caller here already accounts for
 *  that (e.g. `tailLines` for Rust's `tail_lines`). */
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Matches `@tauri-apps/api/event`'s own Event<T> shape closely enough
 *  for this app's one consumer (uv://log) — trimmed to the fields
 *  callers actually read. */
export interface TauriEvent<T> {
  event: string;
  payload: T;
}

export type UnlistenFn = () => void;

/** Matches `@tauri-apps/api/event`'s `listen` signature. */
export type ListenFn = <T>(event: string, handler: (event: TauriEvent<T>) => void) => Promise<UnlistenFn>;

/** Matches the global `fetch` signature — `@tauri-apps/plugin-http`'s
 *  `fetch` is a drop-in Fetch API implementation, the same contract
 *  llmTransport.ts's own `Transport` type documents. */
export type TauriFetchFn = typeof fetch;

/** Matches `@tauri-apps/api/core`'s `Channel<ArrayBuffer>` closely
 *  enough for this app's one consumer (S9.3, docs/design-explorations/
 *  s9-app-audio-tap-blueprint.md's D5 — stt/appAudio.ts's AppAudioEngine
 *  receives the app-audio helper's batched PCM chunks over one of
 *  these) — trimmed to the one thing that caller does with it: read
 *  `onmessage` fires, same as InvokeFn/ListenFn's own "close enough"
 *  contract above. Monomorphic to ArrayBuffer (unlike Channel's own
 *  generic `<T>`) since that's the only payload shape any Channel in
 *  this app carries. */
export interface PcmChannel {
  onmessage: (data: ArrayBuffer) => void;
}

/** Constructs a real `Channel<ArrayBuffer>` pre-wired with `onmessage`
 *  — mirrors the real constructor's own `new Channel(onmessage)` shape,
 *  so appAudio.ts never needs to import `Channel` (or anything else
 *  from `@tauri-apps/*`) itself. */
export type ChannelFactory = (onmessage: (data: ArrayBuffer) => void) => PcmChannel;

/** Matches `@tauri-apps/plugin-opener`'s `openUrl` signature narrowed to
 *  this app's one call shape (lib/platform/openExternal.ts, S10
 *  field-fix Chunk A) — no `openWith` override, every desktop external
 *  link opens via the system's own default handler. */
export type OpenExternalFn = (url: string) => Promise<void>;

/** Matches `@tauri-apps/api/core`'s `PluginListener` closely enough for
 *  this app's one consumer (S13 blueprint §2 — stt/osSpeechTransport.ts's
 *  iOS event-transport shim, Lane D) — trimmed to the one thing that
 *  caller does with it: call `unregister()` to implement the shim's own
 *  `UnlistenFn` return, same "close enough" contract as PcmChannel/
 *  InvokeFn/ListenFn above. */
export interface PluginListenerHandle {
  unregister(): Promise<void>;
}

/** Matches `@tauri-apps/api/core`'s `addPluginListener` signature. */
export type AddPluginListenerFn = <T>(
  plugin: string,
  event: string,
  cb: (payload: T) => void,
) => Promise<PluginListenerHandle>;

let invokePromise: Promise<InvokeFn> | null = null;
let listenPromise: Promise<ListenFn> | null = null;
let tauriFetchPromise: Promise<TauriFetchFn> | null = null;
let channelFactoryPromise: Promise<ChannelFactory> | null = null;
let openerPromise: Promise<OpenExternalFn> | null = null;
let appVersionPromise: Promise<string> | null = null;
let addPluginListenerPromise: Promise<AddPluginListenerFn> | null = null;
let mainWindowPromise: Promise<MainWindowApi> | null = null;

/** Lazily imports `@tauri-apps/api/core` and resolves its `invoke`.
 *  Throws SYNCHRONOUSLY (before the import() is ever reached) outside a
 *  Tauri build — see this file's header comment for why the guard
 *  must sit right here, not behind a shared helper call. */
export function getInvoke(): Promise<InvokeFn> {
  if (!TAURI_BUILD) {
    throw new Error(
      "tauriApi.getInvoke: unavailable outside a Tauri build (NEXT_PUBLIC_DESKTOP !== \"1\" && NEXT_PUBLIC_IOS !== \"1\")",
    );
  }
  if (!invokePromise) {
    invokePromise = import("@tauri-apps/api/core").then((mod) => mod.invoke as InvokeFn);
  }
  return invokePromise;
}

/** Lazily imports `@tauri-apps/api/event` and resolves its `listen` —
 *  provisionRunner.ts's uv://log subscription (run_uv/prewarm_model
 *  both emit it, see apps/desktop/src-tauri/src/uv.rs's emit_uv_log)
 *  goes through this. */
export function getListen(): Promise<ListenFn> {
  if (!TAURI_BUILD) {
    throw new Error(
      "tauriApi.getListen: unavailable outside a Tauri build (NEXT_PUBLIC_DESKTOP !== \"1\" && NEXT_PUBLIC_IOS !== \"1\")",
    );
  }
  if (!listenPromise) {
    listenPromise = import("@tauri-apps/api/event").then((mod) => mod.listen as unknown as ListenFn);
  }
  return listenPromise;
}

/** Lazily imports `@tauri-apps/plugin-http` and resolves its `fetch` —
 *  the S3 registration target for llmTransport.ts's `setTransport()`
 *  (see bootstrap.ts's initDesktop). */
export function getTauriFetch(): Promise<TauriFetchFn> {
  if (!TAURI_BUILD) {
    throw new Error(
      "tauriApi.getTauriFetch: unavailable outside a Tauri build (NEXT_PUBLIC_DESKTOP !== \"1\" && NEXT_PUBLIC_IOS !== \"1\")",
    );
  }
  if (!tauriFetchPromise) {
    tauriFetchPromise = import("@tauri-apps/plugin-http").then((mod) => mod.fetch as TauriFetchFn);
  }
  return tauriFetchPromise;
}

/** Lazily imports `@tauri-apps/api/core` and resolves a `ChannelFactory`
 *  — see PcmChannel/ChannelFactory's own doc comments above. */
export function getChannelFactory(): Promise<ChannelFactory> {
  if (!TAURI_BUILD) {
    throw new Error(
      "tauriApi.getChannelFactory: unavailable outside a Tauri build (NEXT_PUBLIC_DESKTOP !== \"1\" && NEXT_PUBLIC_IOS !== \"1\")",
    );
  }
  if (!channelFactoryPromise) {
    channelFactoryPromise = import("@tauri-apps/api/core").then(
      (mod) => (onmessage: (data: ArrayBuffer) => void) => new mod.Channel<ArrayBuffer>(onmessage),
    );
  }
  return channelFactoryPromise;
}

/** Lazily imports `@tauri-apps/plugin-opener` and resolves a thin
 *  `(url) => Promise<void>` wrapper around its `openUrl` — S10
 *  field-fix Chunk A's `lib/platform/openExternal.ts` is the one
 *  caller. Scoped by capabilities/default.json's own
 *  opener:allow-open-url grant (openrouter.ai/github.com/
 *  huggingface.co — extended only via a future audit finding, never
 *  widened here). */
export function getOpener(): Promise<OpenExternalFn> {
  if (!TAURI_BUILD) {
    throw new Error(
      "tauriApi.getOpener: unavailable outside a Tauri build (NEXT_PUBLIC_DESKTOP !== \"1\" && NEXT_PUBLIC_IOS !== \"1\")",
    );
  }
  if (!openerPromise) {
    openerPromise = import("@tauri-apps/plugin-opener").then((mod) => (url: string) => mod.openUrl(url));
  }
  return openerPromise;
}

/** Lazily imports `@tauri-apps/api/app`, calls its `getVersion`, and
 *  resolves the version STRING itself (unlike every getter above, which
 *  resolves to a reusable function) — the running app's own version
 *  never changes mid-session, so caching the resolved string is
 *  strictly more useful to callers than making each one invoke a getter
 *  function itself. S10 field-fix Chunk A's `lib/desktop/updateCheck.ts`
 *  (semver compare against the GitHub releases feed) is the one caller. */
export function getAppVersion(): Promise<string> {
  if (!TAURI_BUILD) {
    throw new Error(
      "tauriApi.getAppVersion: unavailable outside a Tauri build (NEXT_PUBLIC_DESKTOP !== \"1\" && NEXT_PUBLIC_IOS !== \"1\")",
    );
  }
  if (!appVersionPromise) {
    appVersionPromise = import("@tauri-apps/api/app").then((mod) => mod.getVersion());
  }
  return appVersionPromise;
}

/** Lazily imports `@tauri-apps/api/core` and resolves its
 *  `addPluginListener` — S13 blueprint §2/§6's iOS event-transport shim
 *  (stt/osSpeechTransport.ts, Lane D) is the one caller: macOS keeps
 *  using getListen()'s existing `osspeech://…` global-event path, iOS
 *  has no such path (Swift `trigger()` delivers to plugin-scoped
 *  listeners only) and subscribes via this getter instead
 *  (`addPluginListener("os-speech", "transcript"|"status", cb)`). Cross-
 *  lane pinned contract (blueprint §6): exported under exactly this
 *  name. */
export function getAddPluginListener(): Promise<AddPluginListenerFn> {
  if (!TAURI_BUILD) {
    throw new Error(
      "tauriApi.getAddPluginListener: unavailable outside a Tauri build (NEXT_PUBLIC_DESKTOP !== \"1\" && NEXT_PUBLIC_IOS !== \"1\")",
    );
  }
  if (!addPluginListenerPromise) {
    addPluginListenerPromise = import("@tauri-apps/api/core").then(
      (mod) => mod.addPluginListener as unknown as AddPluginListenerFn,
    );
  }
  return addPluginListenerPromise;
}

/** Physical-pixel window rect — matches `@tauri-apps/api/window`'s own
 *  `outerPosition()`/`outerSize()` (PhysicalPosition/PhysicalSize)
 *  shape closely enough for this file's one consumer (S14 —
 *  captionWindow.ts's desktop-host caption-mode enter/exit): trimmed
 *  to the four numbers that caller actually records and restores. */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Matches the handful of `@tauri-apps/api/window`'s `Window` instance
 *  methods (plus the module-level `currentMonitor()`) that
 *  captionWindow.ts's desktop caption-mode enter/exit actually calls —
 *  same "close enough" contract as every other interface in this file.
 *  Bundled as one object (unlike the one-getter-per-capability shape
 *  above) because every method shares the SAME lazily-resolved
 *  `Window` instance and captionWindow.ts is the one caller, always
 *  using the whole set together — mirrors PcmChannel's own
 *  "object of related methods" shape more than InvokeFn's bare
 *  function one. */
export interface MainWindowApi {
  /** Physical pixels — outerPosition() + innerSize() combined (one
   *  round trip) — records the pre-caption-mode rect. innerSize(), NOT
   *  outerSize(): setRect() below restores via setSize(), which Tauri
   *  treats as the window's INNER (client-area) size — pairing THAT
   *  restore with an outerSize() (chrome-inclusive) reading grew the
   *  window by the title-bar height on every caption-mode cycle (S14
   *  fix-round finding 2). Both innerSize()/outerPosition() are already
   *  Physical* types, same as setRect()'s restore below — no scale
   *  math either way. v1 ceiling (accepted, not fixed here): a
   *  maximized/fullscreen window, or one that already had always-on-top
   *  set before caption mode, doesn't round-trip through this rect —
   *  getRect()/setRect() only ever see/restore plain windowed
   *  geometry. */
  getRect(): Promise<WindowRect>;
  /** Physical pixels — restores a rect captured by getRect(). */
  setRect(rect: WindowRect): Promise<void>;
  /** Logical pixels (DPI-independent) — the caption-mode strip size. */
  setLogicalSize(width: number, height: number): Promise<void>;
  /** Logical pixels — best-effort reposition near the top-right corner
   *  of whichever monitor the window is currently on. A no-op (never
   *  throws) when the runtime reports no monitor info (currentMonitor()
   *  resolving null) — a caption strip that resized but didn't move is
   *  a far softer failure than crashing caption-mode entry over it. */
  moveToTopRight(logicalWidth: number, marginLogical?: number): Promise<void>;
  setAlwaysOnTop(alwaysOnTop: boolean): Promise<void>;
}

/** Lazily imports `@tauri-apps/api/window` (which itself re-exports
 *  LogicalSize/LogicalPosition/PhysicalSize/PhysicalPosition — no
 *  separate `@tauri-apps/api/dpi` import needed) and resolves a
 *  MainWindowApi wrapping `getCurrentWindow()`. captionWindow.ts's
 *  desktop enter/exit (S14) is the one caller. Requires capabilities/
 *  default.json's core:window:allow-set-size / allow-set-position /
 *  allow-set-always-on-top grants — outer-position/outer-size/
 *  current-monitor are already covered by core:default's own
 *  core:window:default set (verified against gen/schemas/
 *  desktop-schema.json's own reference — see that capabilities file's
 *  own comment for the exact grants this adds and why). */
export function getMainWindow(): Promise<MainWindowApi> {
  if (!TAURI_BUILD) {
    throw new Error(
      "tauriApi.getMainWindow: unavailable outside a Tauri build (NEXT_PUBLIC_DESKTOP !== \"1\" && NEXT_PUBLIC_IOS !== \"1\")",
    );
  }
  if (!mainWindowPromise) {
    mainWindowPromise = import("@tauri-apps/api/window").then((mod) => {
      const win = mod.getCurrentWindow();
      return {
        async getRect() {
          const [pos, size] = await Promise.all([win.outerPosition(), win.innerSize()]);
          return { x: pos.x, y: pos.y, width: size.width, height: size.height };
        },
        async setRect(rect: WindowRect) {
          await win.setSize(new mod.PhysicalSize(rect.width, rect.height));
          await win.setPosition(new mod.PhysicalPosition(rect.x, rect.y));
        },
        async setLogicalSize(width: number, height: number) {
          await win.setSize(new mod.LogicalSize(width, height));
        },
        async moveToTopRight(logicalWidth: number, marginLogical = 24) {
          const monitor = await mod.currentMonitor();
          if (!monitor) return;
          const sf = monitor.scaleFactor;
          const areaX = monitor.workArea.position.x / sf;
          const areaY = monitor.workArea.position.y / sf;
          const areaWidth = monitor.workArea.size.width / sf;
          await win.setPosition(
            new mod.LogicalPosition(areaX + areaWidth - logicalWidth - marginLogical, areaY + marginLogical),
          );
        },
        async setAlwaysOnTop(alwaysOnTop: boolean) {
          await win.setAlwaysOnTop(alwaysOnTop);
        },
      };
    });
  }
  return mainWindowPromise;
}

/** Test-only reset — clears the memoized import promises. Mirrors
 *  llmTransport.ts's resetTransport / client.ts's
 *  resetSubscriptionToastLatch convention for module-level state that
 *  must never leak between independent `it()` blocks (relevant if a
 *  future test stubs NEXT_PUBLIC_DESKTOP/NEXT_PUBLIC_IOS +
 *  `vi.resetModules()`s this file mid-suite). */
export function resetTauriApiCache(): void {
  invokePromise = null;
  listenPromise = null;
  tauriFetchPromise = null;
  channelFactoryPromise = null;
  openerPromise = null;
  appVersionPromise = null;
  addPluginListenerPromise = null;
  mainWindowPromise = null;
}
