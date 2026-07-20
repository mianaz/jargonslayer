import Speech

// S13 (Lane B) — the locale-resolve + asset-ensure steps shared by both
// OsSpeechSession (a real transcribe session) and OsSpeechPreinstall (a
// background warm-up, §A2 on macOS) — factored into free functions
// (rather than duplicated verbatim in both places the way macOS's own
// SpeechAnalyzerSession.run/preinstall duplicate their locale-resolve
// block) since iOS's two callers share the exact same `emit`-closure
// wiring and there is no macOS-style "two independent CLI modes" reason
// to keep them apart here.
//
// Pattern source: apps/desktop/src-tauri/audiocap-helper/Sources/
// AudioCapCore/SpeechAnalyzerSession.swift's own `ensureAssetInstalled`
// (§Q5/spike "Asset model", FIX S5) — ported with `shouldAbort` widened
// to `async` (checked every ~200ms poll tick, same cadence as the
// progress-emission itself): iOS's abort signal isn't only "did the user
// press stop" (a same-process flag check would suffice for that alone)
// but ALSO "was I preempted by a session start" for the preinstall
// caller, which is an actor-isolated question (OsSpeechController) that
// can only be answered with `await`. Same "best-effort, not a hard
// guarantee" posture macOS's own FIX S5 doc comment accepts.
@available(iOS 26.0, macOS 26.0, *)
enum OsSpeechLocale {
  /// Resolves `bcp47` and emits the SAME single "status" event macOS's
  /// Rust side produces for a supported locale (`locale-resolved`,
  /// `resolvedLocale` set) — throws `OsSpeechError.unsupportedLocale`
  /// for the caller's own unified catch to map to the `unsupported-locale`
  /// kind (osspeech.rs's own "unsupported is signaled by a SEPARATE,
  /// deferred error record" — same shape here, just via Swift's own
  /// throw/catch instead of a deferred record).
  static func resolve(
    bcp47: String,
    source: OsSpeechEventSource,
    emit: (String, any Encodable) -> Void
  ) async throws -> Locale {
    let resolver = LocaleResolver(provider: SpeechTranscriberLocaleProvider())
    switch await resolver.resolve(bcp47: bcp47) {
    case .resolved(_, let locale):
      emit(OsSpeechEvent.status, OsSpeechStatusPayload(kind: .localeResolved, source: source, resolvedLocale: locale.identifier))
      return locale
    case .unsupported:
      throw OsSpeechError.unsupportedLocale(bcp47)
    }
  }
}

/// Wraps `SpeechTranscriber.supportedLocale(equivalentTo:)` — the one
/// line `LocaleResolver`'s own seam protocol exists to isolate.
@available(iOS 26.0, macOS 26.0, *)
struct SpeechTranscriberLocaleProvider: LocaleEquivalenceProviding {
  func supportedLocale(equivalentTo locale: Locale) async -> Locale? {
    await SpeechTranscriber.supportedLocale(equivalentTo: locale)
  }
}

/// Thrown by `OsSpeechAssetInstaller.ensureInstalled` exactly when
/// `shouldAbort()` trips while its download is still in flight — an
/// internal-only control-flow signal, never itself mapped to a status
/// kind; each caller (OsSpeechSession/OsSpeechPreinstall) catches it
/// separately and decides what "aborted mid-download" means for ITS OWN
/// terminal status (a session emits a clean `.ended`; a preempted
/// preinstall emits nothing at all — see each caller's own catch site).
struct OsSpeechAbort: Error {}

@available(iOS 26.0, macOS 26.0, *)
enum OsSpeechAssetInstaller {
  /// §Q5/spike "Asset model" (macOS pattern source): `AssetInventory
  /// .status(forModules:)` is per-module-configuration; installs
  /// (checking/downloading-with-progress/installed events) only if not
  /// already installed — a re-run when already installed is a fast,
  /// event-only no-op. Throws `OsSpeechAbort` (not a status emission) if
  /// `shouldAbort()` trips mid-download; throws a real `OsSpeechError`
  /// (`.assetUnavailable`/`.assetDownloadFailed`) for an actual failure
  /// — the caller's own unified catch maps that to `.assetFailed`.
  static func ensureInstalled(
    transcriber: SpeechTranscriber,
    source: OsSpeechEventSource,
    shouldAbort: () async -> Bool,
    emit: (String, any Encodable) -> Void
  ) async throws {
    emit(OsSpeechEvent.status, OsSpeechStatusPayload(kind: .assetChecking, source: source))
    let status = await AssetInventory.status(forModules: [transcriber])
    // F-S1(c) — the 200ms poll loop below covers its OWN wait, but these
    // two awaits sit OUTSIDE that loop entirely: without a check here, a
    // stop requested while either is in flight would only be noticed
    // once the (possibly slow) download itself starts polling, or not at
    // all if `status == .installed` short-circuits before ever reaching
    // the loop.
    if await shouldAbort() { throw OsSpeechAbort() }
    guard status != .installed else {
      emit(OsSpeechEvent.status, OsSpeechStatusPayload(kind: .assetInstalled, source: source))
      return
    }
    guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
      throw OsSpeechError.assetUnavailable("AssetInventory.assetInstallationRequest(supporting:) returned nil for a non-installed module")
    }
    if await shouldAbort() { throw OsSpeechAbort() }

    // `outcomeBox` (not `downloadTask.isCancelled`/`.value`) is what this
    // loop checks below — a plain `Task` has no non-blocking "have you
    // finished yet" property — so the child Task records its own outcome
    // the instant it's known, decoupling "did the download finish" from
    // this loop's independent ~200ms cadence.
    let outcomeBox = DownloadOutcomeBox()
    let downloadTask = Task {
      do {
        try await request.downloadAndInstall()
        outcomeBox.record(.success(()))
      } catch {
        outcomeBox.record(.failure(error))
      }
    }

    let progress = request.progress
    var lastEmitted = -1.0
    while outcomeBox.value == nil {
      if await shouldAbort() {
        downloadTask.cancel()
        progress.cancel()
        throw OsSpeechAbort()
      }
      let fraction = progress.fractionCompleted
      if fraction - lastEmitted >= 0.01 {
        emit(OsSpeechEvent.status, OsSpeechStatusPayload(kind: .assetDownloading, source: source, progress: fraction))
        lastEmitted = fraction
      }
      try? await Task.sleep(nanoseconds: 200_000_000) // 200ms
    }

    if case .failure(let error) = outcomeBox.value {
      throw OsSpeechError.assetDownloadFailed("asset download/install failed: \(error)")
    }
    emit(OsSpeechEvent.status, OsSpeechStatusPayload(kind: .assetInstalled, source: source))
  }
}

/// Publishes `ensureInstalled`'s own child download `Task`'s eventual
/// outcome WITHOUT the poll loop ever having to `await`/block on the
/// Task itself (that would defeat the whole point of making the download
/// abortable). Written at most once, from the child Task's own body;
/// read every ~200ms by the poll loop. `@unchecked Sendable` + `NSLock`:
/// same posture as every other small cross-context box in this package
/// (OsSpeechSession.swift's own `PauseGenerationBox`/`ResumeOnceBox`).
final class DownloadOutcomeBox: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Result<Void, Error>?
  func record(_ result: Result<Void, Error>) {
    lock.lock(); defer { lock.unlock() }
    if stored == nil { stored = result }
  }
  var value: Result<Void, Error>? {
    lock.lock(); defer { lock.unlock() }
    return stored
  }
}

/// §A2 (macOS pattern source) — `preinstall_os_speech`'s own flow:
/// locale resolve + asset ensure only, no tap/analyzer/results loop.
/// Mirrors `SpeechAnalyzerSession.preinstall` + osspeech.rs's own R7
/// `preinstall_terminal_kind`: a clean finish emits NOTHING further (the
/// JS preinstall tracker already settled its task row off the
/// `asset-installed` event `ensureInstalled` itself just emitted); ANY
/// other outcome — including a locale that turns out unsupported — is,
/// from that tracker's point of view, simply "the model failed to
/// install": always `.assetFailed`, never a more specific kind.
@available(iOS 26.0, macOS 26.0, *)
public enum OsSpeechPreinstall {
  /// `isCurrent` is checked right before the one possible terminal
  /// emission (never before the success path, which emits nothing to
  /// suppress) — see `OsSpeechController.isCurrentPreinstall`'s own doc
  /// comment for the preemption race this closes: a session start
  /// preempting this attempt mid-download must never let this attempt's
  /// own stale failure/success message land on the task row the NEWER
  /// session has since taken over.
  public static func run(
    locale bcp47: String,
    emit: @escaping (String, any Encodable) -> Void,
    isCurrent: @escaping () async -> Bool
  ) async {
    do {
      let locale = try await OsSpeechLocale.resolve(bcp47: bcp47, source: .preinstall, emit: emit)
      let transcriber = SpeechTranscriber(locale: locale, preset: .timeIndexedProgressiveTranscription)
      try await OsSpeechAssetInstaller.ensureInstalled(
        transcriber: transcriber,
        source: .preinstall,
        shouldAbort: { !(await isCurrent()) },
        emit: emit
      )
      // Clean finish: nothing further to emit (R7 parity).
    } catch is OsSpeechAbort {
      // Preempted mid-download — emit nothing (R3/R7 parity): the
      // session that preempted this attempt continues the SAME
      // asset-lifecycle progression under its own source:"session".
    } catch let error as OsSpeechError {
      guard await isCurrent() else { return }
      emit(OsSpeechEvent.status, OsSpeechStatusPayload(kind: .assetFailed, source: .preinstall, message: error.message))
    } catch {
      guard await isCurrent() else { return }
      emit(OsSpeechEvent.status, OsSpeechStatusPayload(kind: .assetFailed, source: .preinstall, message: "\(error)"))
    }
  }
}
