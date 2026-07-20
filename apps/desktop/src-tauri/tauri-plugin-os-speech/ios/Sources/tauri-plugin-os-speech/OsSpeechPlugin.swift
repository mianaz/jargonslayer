import OsSpeechCore
import Speech
import SwiftRs
import Tauri
import UIKit
import WebKit

// S13 (docs/design-explorations/s13-ios-blueprint.md, §D1/§2, Lane B) —
// the Tauri iOS plugin entry point. Six thin `@objc` methods, one per
// `osspeech_ios.rs` bridge command (§2's pinned table); each does the
// SAME two things and nothing else: (1) an `#available(iOS 26.0, *)`
// pre-check (mirrors osspeech.rs's own `is_macos_26_or_later` runtime
// re-check — "UI gating is not a boundary"), (2) hand off to
// `OsSpeechController`/`OsSpeechSession` and resolve/reject. All real
// session logic lives in OsSpeechSession.swift/OsSpeechController.swift.

/// `run_mobile_plugin("startTranscribe", StartArgs { .. })`'s own
/// Decodable — camelCase keys match the Rust struct's `#[serde(rename_all
/// = "camelCase")]` exactly (`locale`, `contextualJson`).
class StartArgs: Decodable {
  let locale: String
  let contextualJson: String?
}

/// `run_mobile_plugin("preinstall", PreinstallArgs { .. })`'s own Decodable.
class PreinstallArgs: Decodable {
  let locale: String
}

class OsSpeechPlugin: Plugin {
  // `Any?` (not `OsSpeechController?` directly): the controller's own
  // type is `@available(iOS 26.0, *)`-gated (it stores an
  // `OsSpeechSession?`, itself gated — Speech/AVFoundation types all
  // the way down), so a STORED property of that type would force this
  // whole class under the same gate too. `Plugin` subclasses need to
  // exist/load unconditionally (Tauri registers them at app launch
  // regardless of OS version, mirrors macOS's own main.swift keeping
  // its top-level `switch` ungated while the types/functions it calls
  // ARE gated) — boxing in `Any` and downcasting inside the
  // `controller` accessor below (itself gated, only ever touched from
  // within an `#available` guard) sidesteps that without widening the
  // gate onto this class.
  private var controllerBox: Any?

  // F-S2 (S13 fix round, BLOCKER) — constructed EAGERLY, exactly once,
  // here in `init()` (plugin construction/registration time — Tauri's
  // iOS runtime constructs+registers one `OsSpeechPlugin` instance per
  // app launch, tied to the same main-thread WKWebView/UIViewController
  // bootstrap sequence). The PRIOR lazy-init-on-first-access shape had
  // an unguarded read-then-write race: two first-ever calls landing at
  // the same instant could each construct+store their OWN
  // `OsSpeechController`, yielding two live `AVAudioEngine` sessions
  // that could never both be reached by a single later `stop`. Eager,
  // single-shot construction during `init()` removes the race
  // structurally — there is no "first access" moment for two callers to
  // contend over, since Swift guarantees `init()` completes before any
  // other method can run against this instance.
  override init() {
    super.init()
    if #available(iOS 26.0, *) {
      controllerBox = OsSpeechController()
    }
  }

  // Read-only: `init()` above is the ONLY writer (see `controllerBox`'s
  // own doc comment for why the stored type is `Any?`, not
  // `OsSpeechController?` directly). A nil/wrong-type box here would
  // mean `init()` never ran, which Swift doesn't allow for a live
  // instance — `preconditionFailure` documents that as unreachable
  // rather than silently constructing a second controller.
  @available(iOS 26.0, *)
  private var controller: OsSpeechController {
    guard let existing = controllerBox as? OsSpeechController else {
      preconditionFailure("OsSpeechController must have been constructed eagerly in init()")
    }
    return existing
  }

  /// Wraps `Plugin.trigger(_:data:)` (throwing) into the plain closure
  /// shape `OsSpeechSession`/`OsSpeechPreinstall` expect — `try?`
  /// discards a serialization failure the same "never let an event-
  /// emission problem take down the session" way macOS's own
  /// `TranscriptEvents.write`/`StatusEvents.emit` do (`try?
  /// FileHandle.standardError.write`).
  ///
  /// F-OM1 (S13 fix round, MEDIUM) — `trigger` is called from THIS
  /// closure, which runs on whatever cooperative-pool thread the calling
  /// `Task` (OsSpeechSession/OsSpeechPreinstall) happens to be on, while
  /// `Plugin`'s own `listeners` dictionary (`.tauri/tauri-api/Sources/
  /// Tauri/Plugin/Plugin.swift`) is mutated by `registerListener`/
  /// `removeListener` arriving via IPC — an unsynchronized Dictionary
  /// read+write is undefined behavior. Marshaling onto `DispatchQueue
  /// .main` serializes every `trigger()` call this plugin ever makes
  /// against every other one — this is the ONE emitter closure both
  /// `startTranscribe` and `preinstall` hand out, so routing everything
  /// through it keeps event ORDER total too: `DispatchQueue.main.async`
  /// is FIFO per queue (order of enqueue), and since every emit from
  /// every source funnels through this single path, no two emitted
  /// events can ever be reordered relative to each other on the way to
  /// JS.
  private func emitter() -> (String, any Encodable) -> Void {
    { [weak self] event, data in
      DispatchQueue.main.async {
        try? self?.trigger(event, data: data)
      }
    }
  }

  @objc public func startTranscribe(_ invoke: Invoke) throws {
    guard #available(iOS 26.0, *) else {
      invoke.reject(OsSpeechFloor.unsupportedReason)
      return
    }
    // S13.1 spike finding: the version floor alone left a hole — a device
    // (or the Simulator) past the floor but with SpeechTranscriber
    // definitively unavailable would get a resolved start and a silently
    // stuck session. Same fail-closed rule as capabilities() (D9:
    // definitive-false refuses; "UI gating is not a boundary" — this is
    // the runtime re-check for callers that bypass the locked UI option).
    guard SpeechTranscriber.isAvailable else {
      invoke.reject(OsSpeechFloor.transcriberUnavailableReason)
      return
    }
    let args = try invoke.parseArgs(StartArgs.self)
    let emit = emitter()
    // `beginSession` is actor-isolated — implicitly async from this
    // (synchronous, non-actor) `@objc` method, so the whole claim+resolve
    // +run flow moves inside one `Task` (same pattern stop/pause/resume
    // already use below). `beginSession` itself is fast (pure
    // actor-isolated bookkeeping, no I/O), so `invoke.resolve()` still
    // fires essentially immediately — `session.run(...)` is what actually
    // takes real time, and it runs AFTER resolve, matching macOS's own
    // "spawn returns fast, real outcomes ride status events" contract.
    Task {
      do {
        let session = try await controller.beginSession { generation in
          OsSpeechSession(generation: generation, emit: emit)
        }
        invoke.resolve()
        await session.run(locale: args.locale, contextualJSON: args.contextualJson)
        await self.controller.endSession(session.generation)
      } catch {
        invoke.reject("\(error)")
      }
    }
  }

  @objc public func stopTranscribe(_ invoke: Invoke) throws {
    guard #available(iOS 26.0, *) else {
      invoke.resolve() // idempotent, matches §2's own contract
      return
    }
    Task {
      if let session = await controller.currentSession() {
        session.requestExplicitStop()
      }
      invoke.resolve()
    }
  }

  @objc public func pauseTranscribe(_ invoke: Invoke) throws {
    guard #available(iOS 26.0, *) else {
      invoke.resolve()
      return
    }
    Task {
      if let session = await controller.currentSession() {
        session.setPaused(true)
      }
      invoke.resolve()
    }
  }

  @objc public func resumeTranscribe(_ invoke: Invoke) throws {
    guard #available(iOS 26.0, *) else {
      invoke.resolve()
      return
    }
    Task {
      if let session = await controller.currentSession() {
        session.setPaused(false)
      }
      invoke.resolve()
    }
  }

  /// D9 fail-closed posture: `supported:false` ONLY when the OS version
  /// is definitively below the floor or `SpeechTranscriber.isAvailable`
  /// says so — never rejects (mirrors macOS's `os_speech_capabilities`
  /// own "never actually constructs an Err in practice" contract).
  @objc public func capabilities(_ invoke: Invoke) throws {
    guard #available(iOS 26.0, *) else {
      invoke.resolve(OsSpeechCapabilitiesPayload(supported: false, reason: OsSpeechFloor.unsupportedReason, locales: [], installedLocales: []))
      return
    }
    Task {
      let supported = SpeechTranscriber.isAvailable
      var locales: [String] = []
      var installed: [String] = []
      if supported {
        locales = await SpeechTranscriber.supportedLocales.map(\.identifier)
        installed = await SpeechTranscriber.installedLocales.map(\.identifier)
      }
      invoke.resolve(
        OsSpeechCapabilitiesPayload(
          supported: supported,
          reason: supported ? nil : "SpeechTranscriber.isAvailable == false",
          locales: locales,
          installedLocales: installed
        ))
    }
  }

  @objc public func preinstall(_ invoke: Invoke) throws {
    guard #available(iOS 26.0, *) else {
      invoke.reject(OsSpeechFloor.unsupportedReason)
      return
    }
    // Same S13.1 runtime re-check as startTranscribe — a definitive
    // transcriber-unavailable preinstall would download nothing useful.
    guard SpeechTranscriber.isAvailable else {
      invoke.reject(OsSpeechFloor.transcriberUnavailableReason)
      return
    }
    let args = try invoke.parseArgs(PreinstallArgs.self)
    let emit = emitter()
    Task {
      do {
        _ = try await controller.beginPreinstall { generation in
          Task {
            await OsSpeechPreinstall.run(
              locale: args.locale,
              emit: emit,
              isCurrent: { await self.controller.isCurrentPreinstall(generation) }
            )
            await self.controller.endPreinstall(generation)
          }
        }
        invoke.resolve()
      } catch {
        invoke.reject("\(error)")
      }
    }
  }
}

@_cdecl("init_plugin_os_speech")
func initPlugin() -> Plugin {
  return OsSpeechPlugin()
}
