import Foundation
import Translation

// v0.6 (Apple on-device translation, iOS lane) — the in-process port of
// the macOS lane's own Translation.framework usage (pattern source:
// apps/desktop/src-tauri/audiocap-helper/Sources/jargonslayer-audiocap/
// main.swift:497-684 — `runProbeTranslate`/`translateStatusWireValue`/
// `runTranslate`/`handleTranslateRequestLine`). Same three framework
// calls, reused here exactly as spike-verified there: `LanguageAvailability
// ().status(from:to:)` (async), `TranslationSession(installedSource:
// target:)` (a PLAIN, non-throwing, non-async convenience init — builds
// successfully even for an uninstalled pair), and `session.translations(
// from:)` (async throwing, matches `TranslationError.notInstalled` via
// `~=`, not `==` — the type isn't `Equatable`).
//
// Deliberately NOT ported: main.swift's own `runOnMainRunLoop`/
// `RunLoopPumpBox` (that file's own doc comment, lines 409-495). That
// hack exists ONLY because a bare CLI helper's main thread has no run
// loop being pumped for Translation.framework's async result to arrive
// through (an XPC reply, most likely — main.swift's own words). This
// controller runs IN-PROCESS inside the app, where UIKit already pumps
// the main run loop continuously (that's how every other `await` in this
// whole app process — including OsSpeechSession's own SpeechAnalyzer/
// AVAudioEngine work one file over — already resumes correctly), so a
// plain `await` on the real async work is enough here; no polling loop
// of any kind is needed or wanted.
@available(iOS 26.0, macOS 26.0, *)
@MainActor
public final class SysTranslateController {
  private var sessions: [String: TranslationSession] = [:]
  private var generation: UInt64 = 0

  /// Fix-round (Sol MEDIUM 2b) — the LATEST `prepare(...)` call's own
  /// best-effort warm-up `Task` (see `prepare`'s own doc comment below),
  /// stored so `stop(generation:)` can cancel it: without this, a
  /// `stop()` landing while the warm-up is still probing/awaiting
  /// `prepareTranslation()` left that detached work running with no way
  /// to interrupt it. Cancellation here is COOPERATIVE (same posture as
  /// `TimeoutRaceBox` below) — an in-flight `prepareTranslation()` call
  /// that ignores `Task.isCancelled` may still run to completion after
  /// `stop()` returns; its result goes nowhere either way (the warm-up
  /// throws its own result away via `try?`), so this is accepted, not
  /// fixed further.
  private var prepareWarmupTask: Task<Void, Never>?

  /// `nonisolated` — needs to be explicit at all for the same reason
  /// `OsSpeechController.init()`'s own doc comment gives (no implicit
  /// public no-arg init synthesized at this access level); ADDITIONALLY
  /// `nonisolated` here specifically because `OsSpeechPlugin.init()`
  /// (OsSpeechPlugin.swift) — a plain, non-isolated `override init()` on
  /// an NSObject subclass — is this type's one and only construction
  /// call site (eager, at plugin-registration time, boxed in `Any?`
  /// exactly like `OsSpeechController` is there), and a MainActor-isolated
  /// init can't be called from a synchronous non-isolated context. Every
  /// stored property above already has a plain default value, so there's
  /// nothing actor-isolated left to actually do inside the init body.
  public nonisolated init() {}

  private static func pairKey(source: String, target: String) -> String {
    "\(source)|\(target)"
  }

  private func sessionFor(source: String, target: String) -> TranslationSession {
    let key = Self.pairKey(source: source, target: target)
    if let existing = sessions[key] { return existing }
    let created = TranslationSession(
      installedSource: Locale.Language(identifier: source),
      target: Locale.Language(identifier: target)
    )
    sessions[key] = created
    return created
  }

  /// Ported from `runProbeTranslate` (main.swift:503-528) — the mapping
  /// logic itself lives in `statusWireValue` below so it's
  /// host-unit-testable on its own (SysTranslateControllerTests.swift);
  /// the framework call + 8s timeout race stay here since neither is
  /// pure. `osSupported` is unconditionally `true` on every return from
  /// this function (mirrors main.swift's own comment on
  /// `runProbeTranslate`: the `false` wire value is the OTHER branch —
  /// OsSpeechPlugin.swift's own `#available(iOS 26.0, *)` pre-check —
  /// never reached by a call that makes it into this function at all).
  ///
  /// Fix-round (Sol MEDIUM 1) — timeout (8s, same deadline `translate`
  /// below uses) THROWS rather than resolving `(true, "unsupported")`.
  /// The original "just say unsupported" posture was wrong: JS's own
  /// `systemProbeCache` (providers.ts) caches every successfully
  /// RESOLVED probe result indefinitely and deliberately does NOT cache
  /// a failed one — a resolved-but-timed-out probe would poison that
  /// cache with a false "unsupported" for the rest of the app's
  /// lifetime, over one transient framework hiccup. Throwing routes this
  /// through `sysTranslateProbe`'s own `catch` -> `invoke.reject(...)`
  /// (OsSpeechPlugin.swift), which lands in JS's catch path and is NOT
  /// cached — a later probe call gets a real retry. The below-iOS-26
  /// `#available` guard one layer up is NOT affected: that one still
  /// resolves `{osSupported:false,status:"unsupported"}` since it's a
  /// DEFINITIVE, cacheable answer (the OS version can't un-downgrade
  /// mid-session).
  public func probe(source: String, target: String) async throws -> (osSupported: Bool, status: String) {
    let status = await Self.withTimeout {
      await LanguageAvailability().status(
        from: Locale.Language(identifier: source),
        to: Locale.Language(identifier: target)
      )
    }
    guard let status else {
      throw SysTranslateError.timeout
    }
    return (osSupported: true, status: Self.statusWireValue(status))
  }

  /// `LanguageAvailability.Status` -> the probe wire contract's own
  /// three string values — byte-identical to main.swift's own
  /// `translateStatusWireValue` (main.swift:536-544), including the same
  /// `@unknown default` fold to "unsupported" for a future case this
  /// port hasn't seen yet (the case list isn't `@frozen`). `nonisolated`
  /// — pure logic, touches no MainActor-isolated state (`static`, no
  /// `self` at all), so it shouldn't force callers (including
  /// SysTranslateControllerTests.swift, a plain synchronous XCTestCase)
  /// to hop through the main actor just to exercise a switch statement.
  public nonisolated static func statusWireValue(_ status: LanguageAvailability.Status) -> String {
    switch status {
    case .installed: return "installed"
    case .supported: return "supported"
    case .unsupported: return "unsupported"
    @unknown default: return "unsupported"
    }
  }

  /// Get-or-creates the session for this pair and bumps the shared
  /// generation counter SYNCHRONOUSLY (mirrors `OsSpeechController
  /// .beginSession`'s own "mint the generation and attach the object
  /// atomically" posture — single-threaded here since `@MainActor`
  /// already serializes every call into this class) — the caller
  /// (`sysTranslatePrepare`) gets its generation back immediately,
  /// before any framework I/O has even started.
  ///
  /// DEVICE-VERIFY ITEM: the best-effort warm-up below fires AFTER
  /// returning, detached from the caller's own await chain (handle
  /// stored in `prepareWarmupTask` so `stop()` can cancel it — see that
  /// property's own doc comment). Apple's documented shape for this API
  /// pair (per Sol's fix-round citation) is that a session obtained from
  /// `TranslationSession(installedSource:target:)` — a direct,
  /// non-`.translationTask`-vended init — is meant for an ALREADY
  /// installed language pair; the actual download-consent flow is
  /// documented against a session vended by SwiftUI's `.translationTask`
  /// modifier instead, so calling `prepareTranslation()` here is LIKELY
  /// a no-op on a real device rather than the "presents a sheet" outcome
  /// an earlier draft of this comment assumed. Kept anyway — it's cheap
  /// and harmless even if it does nothing — but the real install path
  /// for an uninstalled pair is the system 翻译 (Translate) app; another
  /// lane's settings-row hint covers directing the user there. A device
  /// run decides whether this call does anything at all. Every error is
  /// swallowed on purpose either way: a failed/no-op warm-up changes
  /// nothing about `translate`'s own behavior below — a still-
  /// uninstalled pair simply throws `.notInstalled` on the first real
  /// request regardless.
  public func prepare(source: String, target: String) -> UInt64 {
    let session = sessionFor(source: source, target: target)
    generation += 1
    let mintedGeneration = generation

    prepareWarmupTask = Task {
      guard let probeResult = try? await self.probe(source: source, target: target),
        probeResult.status == "supported"
      else { return }
      try? await session.prepareTranslation()
    }

    return mintedGeneration
  }

  /// Ported from `handleTranslateRequestLine` (main.swift:611-684): same
  /// get-or-create session, same request construction, same
  /// `TranslationError.notInstalled` match via `~=` (spike-verified — the
  /// type isn't `Equatable`), same re-correlate-by-`clientIdentifier`
  /// defensive posture (pulled out into `SysTranslateRecorrelation
  /// .recorrelate` below so it's host-unit-testable without a real
  /// `TranslationSession.Response`), same 8s timeout race.
  public func translate(items: [(id: String, text: String)], source: String, target: String) async throws -> [(id: String, text: String)] {
    let session = sessionFor(source: source, target: target)
    let requests = items.map { TranslationSession.Request(sourceText: $0.text, clientIdentifier: $0.id) }

    // Local outcome enum — main.swift's own `TranslationOutcome`
    // (main.swift:627-631), same reason: carries the batch result (or a
    // typed failure) out of the timeout race below without needing a
    // top-level type nothing else uses.
    enum TranslateOutcome {
      case ok([TranslationSession.Response])
      case notInstalled
      case failed(String)
    }

    let outcome = await Self.withTimeout { () -> TranslateOutcome in
      do {
        return .ok(try await session.translations(from: requests))
      } catch TranslationError.notInstalled {
        return .notInstalled
      } catch {
        return .failed("\(error)")
      }
    }

    guard let outcome else {
      throw SysTranslateError.timeout
    }

    switch outcome {
    case .ok(let responses):
      let pairs = responses.map { (id: $0.clientIdentifier, text: $0.targetText) }
      return SysTranslateRecorrelation.recorrelate(items: items, responses: pairs)
    case .notInstalled:
      throw SysTranslateError.notInstalled
    case .failed(let message):
      throw SysTranslateError.failed(message)
    }
  }

  /// `nil` -> clear every session (a full plugin-level reset); non-nil
  /// -> clear only if it's still the CURRENT generation — see
  /// `SysTranslateGenerationGuard.shouldClear`'s own doc comment (pulled
  /// out pure/testable, mirrors `OsSpeechController.endSession`'s own
  /// generation-guarded clear one file over: a stale stop from a
  /// PREVIOUS meeting must never kill a session a LATER `prepare(...)`
  /// call already replaced).
  public func stop(generation requestedGeneration: UInt64?) {
    guard SysTranslateGenerationGuard.shouldClear(requestedGeneration: requestedGeneration, currentGeneration: generation) else { return }
    // Fix-round (Sol MEDIUM 2b) — cancel any still-running `prepare(...)`
    // warm-up BEFORE clearing (both the clear-all and generation-matched
    // branches land here, same as `sessions.removeAll()` below); see
    // `prepareWarmupTask`'s own doc comment for the residual "may still
    // run to completion" acceptance this doesn't try to eliminate.
    prepareWarmupTask?.cancel()
    prepareWarmupTask = nil
    sessions.removeAll()
  }

  /// 8s — same default deadline main.swift's own `runOnMainRunLoop` uses
  /// (main.swift:480), kept for the same reason that comment gives:
  /// comfortably under Rust's own `systranslate.rs` `TRANSLATE_TIMEOUT`
  /// (10s)/hard-kill margin for the DESKTOP lane's identical framework
  /// call, so both lanes report a clean timeout on roughly the same
  /// budget even though iOS has no child process or Rust-side backstop
  /// timer of its own to race against.
  ///
  /// First-resume-wins race against the real work, via `TimeoutRaceBox`
  /// below — NOT `runOnMainRunLoop`'s polling loop (see this file's own
  /// header comment for why that doesn't apply here): a plain
  /// `withCheckedContinuation`, resumed by whichever of the two
  /// unstructured `Task`s below finishes first, is enough once the
  /// calling actor's run loop is already being pumped by UIKit.
  ///
  /// Fix-round (Sol MEDIUM 2a) — both Task handles are now registered
  /// with the box, and whichever side resumes first CANCELS the other
  /// (`TimeoutRaceBox.resume(_:isWork:)`'s own doc comment covers what
  /// cancellation does/doesn't guarantee for each side): the timeout
  /// side, if it loses, no longer keeps its `Task.sleep` alive for
  /// nothing after `body()` already won; the work side, if it loses to a
  /// real timeout, is asked to cancel too — best-effort only, since nothing
  /// here can force `body()` (e.g. `session.translations(from:)`, which
  /// isn't documented to check `Task.isCancelled`) to actually stop early.
  private static func withTimeout<T>(_ body: @escaping () async -> T) async -> T? {
    await withCheckedContinuation { (continuation: CheckedContinuation<T?, Never>) in
      let box = TimeoutRaceBox<T>(continuation)
      let workTask = Task {
        box.resume(await body(), isWork: true)
      }
      let timeoutTask = Task {
        try? await Task.sleep(nanoseconds: 8_000_000_000)
        guard !Task.isCancelled else { return }
        box.resume(nil, isWork: false)
      }
      box.attach(work: workTask, timeout: timeoutTask)
    }
  }
}

/// First-resume-wins race between the real work and the timeout `Task`
/// above — same NSLock-guarded posture as OsSpeechSession.swift's own
/// `ResumeOnceBox`/main.swift's own `RunLoopPumpBox<T>`, fused into one
/// generic type here since this needs BOTH a value-carrying result AND a
/// continuation resumed exactly once. Can't reuse either of those two
/// directly: `ResumeOnceBox` is `Void`-only and file-scoped inside
/// OsSpeechSession.swift's own `#if os(iOS)` gate (which would make THIS
/// file — needed on a plain macOS host too, for `swift test` — fail to
/// even see the type there); `RunLoopPumpBox<T>` is a polled-value box
/// for the run-loop-pump hack this file deliberately does not port.
/// Plain Foundation/Concurrency only (no Translation import) — gated at
/// Swift Concurrency's OWN floor (`CheckedContinuation` requires it),
/// not at `SysTranslateController`'s stricter iOS 26/macOS 26 floor;
/// it's a private implementation detail of that gated class either way.
@available(iOS 13.0, macOS 10.15, *)
private final class TimeoutRaceBox<T>: @unchecked Sendable {
  private let lock = NSLock()
  private var resumed = false
  private let continuation: CheckedContinuation<T?, Never>
  private var workTask: Task<Void, Never>?
  private var timeoutTask: Task<Void, Never>?

  init(_ continuation: CheckedContinuation<T?, Never>) {
    self.continuation = continuation
  }

  /// Registered right after both `Task`s are created (`withTimeout`
  /// above) — can't be passed into `init` since each `Task`'s own
  /// closure needs to capture THIS box first.
  func attach(work: Task<Void, Never>, timeout: Task<Void, Never>) {
    lock.lock()
    workTask = work
    timeoutTask = timeout
    lock.unlock()
  }

  /// `isWork` — which side is resuming, so the LOSER's own `Task` gets
  /// cancelled: if `body()` won, the still-sleeping timeout `Task` is
  /// cancelled (its `Task.sleep` throws immediately instead of firing
  /// 8s late into an already-resolved continuation); if the timeout won,
  /// the still-running work `Task` is cancelled too, best-effort — see
  /// `withTimeout`'s own doc comment for why that can't be guaranteed to
  /// actually stop `body()` early. Cancelling unconditionally (not just
  /// on the FIRST resume) is deliberate and harmless: cancelling an
  /// already-finished `Task` is a no-op.
  func resume(_ value: T?, isWork: Bool) {
    lock.lock()
    let alreadyResumed = resumed
    resumed = true
    let loser = isWork ? timeoutTask : workTask
    lock.unlock()
    loser?.cancel()
    guard !alreadyResumed else { return }
    continuation.resume(returning: value)
  }
}

/// The one error `translate(...)` ever throws — `description` (not a raw
/// enum case name) is what `"\(error)"` string-interpolates to at every
/// catch site (OsSpeechPlugin.swift's `sysTranslate`), same
/// `CustomStringConvertible` idiom `OsSpeechController.ControlError`
/// already uses one file over. Plain Foundation only — left ungated
/// (unlike `SysTranslateController` itself) since nothing here touches
/// Translation-framework types directly.
public enum SysTranslateError: Error, CustomStringConvertible {
  /// The wire contract's own fourth outcome — `description` MUST contain
  /// the exact substring "not-installed": the JS layer string-matches on
  /// it verbatim (apps/web/src/lib/translate/providers.ts:451), same
  /// substring the DESKTOP lane's own `system_translate` rejection
  /// carries for the identical `TranslationError.notInstalled` case
  /// (systranslate.rs prefixes its `code: "not-installed"` onto the
  /// message it forwards — see that file's own test literal
  /// `"not-installed: pack missing"`).
  case notInstalled
  /// The 8s race lost — `description` MUST contain the substring
  /// "timeout" (every other timeout message in this codebase —
  /// systranslate.rs's own `code: "timeout"`, main.swift's own
  /// `TranslateEvents.emitError(..., code: "timeout", ...)` — uses that
  /// exact word, so this stays consistent with it).
  case timeout
  /// Everything else `session.translations(from:)` can throw — rethrown
  /// with the original error folded into a descriptive message (mirrors
  /// main.swift's own `.failed("\(error)")` case).
  case failed(String)

  public var description: String {
    switch self {
    case .notInstalled: return "translation language pack not-installed"
    case .timeout: return "translation timeout: session.translations(from:) did not return within 8s"
    case .failed(let message): return "translation failed: \(message)"
    }
  }
}

/// Pure re-correlation logic pulled OUT of `translate(...)` above so
/// it's host-unit-testable without constructing a real
/// `TranslationSession.Response` (mirrors RouteChangePolicy.swift's own
/// "match against a plain representation, don't import the gated
/// framework type" posture) — ports main.swift:667-683's exact defensive
/// contract: re-correlates the framework's own returned
/// (clientIdentifier, targetText) pairs against the ORIGINAL items by id
/// rather than trusting the framework's own return-array order to
/// already match; a duplicate id keeps the FIRST response seen for it
/// (`Dictionary(uniqueKeysWithValues:)` would trap this long-lived
/// session over one malformed/duplicate-id batch); a MISSING id (the
/// framework didn't return anything for it, or returned a `nil`
/// `clientIdentifier`) falls back to that item's own original source
/// text rather than dropping it.
public enum SysTranslateRecorrelation {
  public static func recorrelate(items: [(id: String, text: String)], responses: [(id: String?, text: String)]) -> [(id: String, text: String)] {
    var textByID: [String: String] = [:]
    for response in responses {
      guard let id = response.id, textByID[id] == nil else { continue }
      textByID[id] = response.text
    }
    return items.map { item in (id: item.id, text: textByID[item.id] ?? item.text) }
  }
}

/// Pure generation-comparison logic pulled OUT of `stop(generation:)`
/// above — mirrors `OsSpeechController.endSession`'s own generation
/// check, extracted so it's host-unit-testable without constructing a
/// real `SysTranslateController` (which needs the `@MainActor` +
/// Translation-framework availability gate this type deliberately stays
/// free of).
public enum SysTranslateGenerationGuard {
  /// `nil` -> unconditional clear (`stop(generation: nil)`'s own
  /// "clear everything" contract). A non-nil `requestedGeneration` only
  /// clears when it still matches the CURRENT counter — a stale stop
  /// arriving from a PREVIOUS meeting/pair must never tear down a
  /// session a LATER `prepare(...)` call already replaced.
  public static func shouldClear(requestedGeneration: UInt64?, currentGeneration: UInt64) -> Bool {
    guard let requestedGeneration else { return true }
    return requestedGeneration == currentGeneration
  }
}
