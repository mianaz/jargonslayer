// `os(iOS)`-gated: stores an `OsSpeechSession` (OsSpeechSession.swift's
// own file-scope `#if os(iOS)` guard — see that file's header comment),
// which doesn't exist as a type at all on a macOS host build.
#if os(iOS)
import Foundation

// S13 (Lane B) — the single-flight guard for "at most one transcribe
// session, at most one preinstall, never both" (mirrors osspeech.rs's
// own `OsSpeechState`, macOS pattern source — see that struct's own doc
// comment for the full mutual-exclusion rationale this ports). Deliberately
// MUCH smaller than the Rust original: macOS needed atomics/Mutexes/
// generation counters/ABA-race "attempt" bookkeeping specifically because
// its state was shared across process boundaries and async channel
// callbacks with no single serialization point. iOS has neither — this
// plugin runs entirely in-process, and a Swift `actor` gives free,
// built-in mutual exclusion for everything below: every method body runs
// atomically w.r.t. every other call into this same actor, so a stale
// callback from a superseded generation simply finds the generation
// field it compares against already overwritten by the next claim — no
// separate "preempted_attempt" ledger needed (contrast osspeech.rs's own
// `preempted_attempt`/`take_preinstall_preempted`, R3's ABA fix for a
// problem that doesn't exist here).
@available(iOS 26.0, macOS 26.0, *)
public actor OsSpeechController {
  enum ControlError: Error, CustomStringConvertible {
    case busy(String)
    var description: String {
      switch self {
      case .busy(let message): return message
      }
    }
  }

  private var nextGeneration: UInt64 = 0

  private var session: OsSpeechSession?
  private var sessionGeneration: UInt64 = 0

  private var preinstallTask: Task<Void, Never>?
  private var preinstallGeneration: UInt64 = 0

  /// `public actor`s do NOT get an implicit public no-arg initializer
  /// (Swift only synthesizes one at the type's OWN access level) — the
  /// glue target (OsSpeechPlugin.swift, a different module) constructs
  /// this directly, so this needs to be explicit.
  public init() {}

  /// Claims the session slot — preempting an in-flight preinstall rather
  /// than rejecting the start (same product rationale as osspeech.rs's
  /// own `PREINSTALL_BUSY_MESSAGE` doc comment: the onboarding wizard
  /// fires a background preinstall right before the user may immediately
  /// start a real meeting) — and constructs+stores the new session
  /// ATOMICALLY (the `makeSession` factory runs inside this same actor
  /// call), so there is no window where a generation has been minted but
  /// no session object is attached yet for a racing stop/pause call to
  /// find.
  public func beginSession(_ makeSession: (UInt64) -> OsSpeechSession) throws -> OsSpeechSession {
    guard session == nil else {
      throw ControlError.busy("a transcribe session is already running")
    }
    preemptPreinstall()
    nextGeneration += 1
    let generation = nextGeneration
    let created = makeSession(generation)
    session = created
    sessionGeneration = generation
    return created
  }

  /// Clears the session slot IFF it's still THIS generation's own
  /// occupant — called exactly once, by the session's own `run()`
  /// caller after it returns (mirrors osspeech.rs's own `finish_session`
  /// generation check).
  public func endSession(_ generation: UInt64) {
    guard generation == sessionGeneration else { return }
    session = nil
  }

  /// Backs stop/pause/resume — idempotent, no-op-when-idle (§2's own
  /// pinned contract): callers get `nil` rather than an error when
  /// nothing is running.
  public func currentSession() -> OsSpeechSession? {
    session
  }

  /// Claims the preinstall slot — rejected (not preempted) by either a
  /// running session or another in-flight preinstall; only a SESSION
  /// start ever preempts a preinstall, never the reverse (same two-
  /// directions-resolve-differently posture osspeech.rs's own doc
  /// comment documents). `makeTask` is called inside this same atomic
  /// step for the same "no attach race" reason `beginSession` runs its
  /// own factory atomically.
  public func beginPreinstall(_ makeTask: (UInt64) -> Task<Void, Never>) throws -> UInt64 {
    guard session == nil else {
      throw ControlError.busy("busy: session or preinstall in progress")
    }
    guard preinstallTask == nil else {
      throw ControlError.busy("busy: session or preinstall in progress")
    }
    nextGeneration += 1
    let generation = nextGeneration
    preinstallGeneration = generation
    preinstallTask = makeTask(generation)
    return generation
  }

  /// `OsSpeechAssetInstaller`'s own `shouldAbort` closure for the
  /// preinstall lane, and the terminal-emission guard `OsSpeechPreinstall
  /// .run` checks right before its one possible failure emission — "am I
  /// still the current occupant of the preinstall slot" (this file's own
  /// header comment: the actor-isolated read that replaces osspeech.rs's
  /// `preempted_attempt` ledger).
  public func isCurrentPreinstall(_ generation: UInt64) -> Bool {
    generation == preinstallGeneration && preinstallTask != nil
  }

  /// Clears the preinstall slot IFF it's still THIS generation's own
  /// occupant.
  public func endPreinstall(_ generation: UInt64) {
    guard generation == preinstallGeneration else { return }
    preinstallTask = nil
  }

  /// Cancels the in-flight preinstall's Task (best-effort/immediate-ish
  /// — Swift's own cooperative cancellation, noticed whenever
  /// `ensureInstalled`'s poll loop next ticks) and clears the slot so a
  /// LATER preinstall call is never rejected by a preempted one's own
  /// stale occupancy. `isCurrentPreinstall`'s generation check is the
  /// correctness backstop regardless of how promptly cancellation is
  /// actually observed — see `OsSpeechAssetInstaller`'s own header
  /// comment.
  private func preemptPreinstall() {
    preinstallTask?.cancel()
    preinstallTask = nil
  }
}
#endif
