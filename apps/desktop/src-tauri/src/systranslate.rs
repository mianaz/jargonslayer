// v0.6 (Apple on-device translate lane) — the Rust supervisor for a
// THIRD jargonslayer-audiocap invocation family (`--probe-translate`/
// `--translate`, both new — see the Swift side's own main.swift for the
// wire contract these are coded against). Unlike osspeech.rs's
// transcribe lane (a streaming SESSION that fires Tauri events as things
// happen), this lane is a plain REQUEST/RESPONSE RPC: `system_translate`
// sends one batch of segments down the warm child's stdin and awaits
// exactly one correlated reply, so there is no `osspeech://status`-style
// event lane here at all — every command either resolves with its own
// answer or rejects with a `String` error.
//
// osspeech.rs is this module's own PATTERN SOURCE for the child-process
// lifecycle shape (single-flight slot with a generation guard, a private
// `LineReassembler` copy, a permissive-raw-then-strict NDJSON parser,
// spawn via `app.shell().sidecar(AUDIOCAP_SIDECAR_PROGRAM)`, a reader
// task that owns the spawned child's `CommandEvent` receiver for its
// whole lifetime) — mirrored here as an INDEPENDENT copy for the same
// reason osspeech.rs's own header comment gives for copying audiocap.rs:
// each lane's copy can evolve on its own without becoming a shared,
// cross-lane dependency. server.rs's `ServerState`/`kill_and_reap` is
// this module's OTHER pattern source, specifically for `system_translate
// _stop`'s own IMMEDIATE-kill posture (deliberately NOT osspeech's own
// graceful-drop-then-grace-period-watchdog dance — see that command's
// own doc comment for why the two lanes' stop semantics differ on
// purpose).
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;

use crate::audiocap::AUDIOCAP_SIDECAR_PROGRAM;
use crate::uv::emit_uv_log;

// ---- LineReassembler: private copy (see this module's own header
// comment — audiocap.rs's struct isn't pub, and osspeech.rs's own copy
// is private to that module too; byte-for-byte the same reassembly rule
// both of those document: one JSON object + one '\n' per record, a raw
// chunk boundary can land mid-line exactly the same way here). ----

struct LineReassembler {
    pending: Vec<u8>,
}

impl LineReassembler {
    fn new() -> Self {
        Self { pending: Vec::new() }
    }

    fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(pos) = self.pending.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = self.pending.drain(..pos).collect();
            self.pending.remove(0); // drop the '\n' itself, now at index 0
            lines.push(String::from_utf8_lossy(&line_bytes).into_owned());
        }
        lines
    }

    fn flush(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let line_bytes = std::mem::take(&mut self.pending);
        Some(String::from_utf8_lossy(&line_bytes).into_owned())
    }
}

// ---- macOS version gating: private copy (osspeech.rs's own copy is
// private to that module too — see this module's own header comment). ----

#[cfg(target_os = "macos")]
fn macos_version() -> (i64, i64) {
    use objc2_foundation::NSProcessInfo;
    let version = NSProcessInfo::processInfo().operatingSystemVersion();
    (version.majorVersion as i64, version.minorVersion as i64)
}

#[cfg(not(target_os = "macos"))]
fn macos_version() -> (i64, i64) {
    (0, 0)
}

/// The Translation-framework floor (T1: "macOS 26 added a HEADLESS
/// Translation framework initializer") — same major-version-only check
/// as osspeech.rs's own `is_macos_26_or_later` (a whole major version
/// above audiocap's own 14.2 floor, so minor is irrelevant either way).
fn is_macos_26_or_later((major, _minor): (i64, i64)) -> bool {
    major >= 26
}

const UNSUPPORTED_REASON: &str = "需要 macOS 26 或更高版本";

/// A dead/wedged `--translate` child (or one that never becomes ready)
/// must return a clear Err rather than hang a live meeting forever (T2's
/// own rule) — this one timeout backs BOTH `system_translate_prepare`'s
/// own ready-wait and `system_translate`'s own per-request reply-wait.
const TRANSLATE_TIMEOUT: Duration = Duration::from_secs(10);

fn poison_err<T>(_: std::sync::PoisonError<T>) -> String {
    "systranslate state lock was poisoned by an earlier panic".to_string()
}

// ---- wire types (pinned contract — the TS worker codes directly
// against these two shapes; do not deviate) ----

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemTranslateProbe {
    pub os_supported: bool,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranslateItem {
    pub id: String,
    pub text: String,
}

/// The outgoing `--translate` stdin request line's own shape (main.swift's
/// `TranslateRequestLine`) — `segments` reuses `TranslateItem` verbatim
/// since a request segment and a result item are the exact same
/// `{"id":...,"text":...}` shape on the wire.
#[derive(Debug, Serialize)]
struct WireRequest {
    id: String,
    segments: Vec<TranslateItem>,
}

// ---- NDJSON parsing (main.swift's TranslateEvents — four `kind`s,
// tagged "kind" rather than every other lane's "type") ----

/// Permissive raw parse, mirroring osspeech.rs's own `RawOsSpeechLine`:
/// every field optional here, `parse_translate_line` below is what
/// actually enforces which ones a given `kind` requires.
#[derive(Debug, Deserialize)]
struct RawTranslateLine {
    kind: String,
    #[serde(rename = "osSupported")]
    os_supported: Option<bool>,
    status: Option<String>,
    id: Option<String>,
    translations: Option<Vec<TranslateItem>>,
    code: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
enum ParsedTranslateLine {
    Probe {
        os_supported: bool,
        status: String,
    },
    Ready,
    TranslationResult {
        id: String,
        translations: Vec<TranslateItem>,
    },
    /// `id` is `Option` — R6-style (osspeech.rs's own `ParsedOsSpeechLine
    /// ::Locale` doc comment on the identical shape one lane over):
    /// Swift omits it for a startup-level failure with no request to
    /// correlate against (main.swift's TranslateEvents.ErrorRecord's own
    /// doc comment).
    Error {
        id: Option<String>,
        code: String,
        message: String,
    },
    /// Not valid JSON, valid JSON with an unrecognized/missing "kind", or
    /// a known "kind" missing the fields that shape requires — never a
    /// panic, always falls back here (mirrors `parse_osspeech_line`'s own
    /// identical posture).
    Unrecognized,
}

/// Pure line classifier — no I/O, no process spawn. Mirrors osspeech.rs's
/// own `parse_osspeech_line`: a permissive raw parse, then a strict
/// per-`kind` check that every field that shape requires actually showed
/// up (else `Unrecognized`, never a default/guess).
fn parse_translate_line(line: &str) -> ParsedTranslateLine {
    let Ok(raw) = serde_json::from_str::<RawTranslateLine>(line) else {
        return ParsedTranslateLine::Unrecognized;
    };
    match raw.kind.as_str() {
        "probe" => match (raw.os_supported, raw.status) {
            (Some(os_supported), Some(status)) => ParsedTranslateLine::Probe { os_supported, status },
            _ => ParsedTranslateLine::Unrecognized,
        },
        "ready" => ParsedTranslateLine::Ready,
        "result" => match (raw.id, raw.translations) {
            (Some(id), Some(translations)) => ParsedTranslateLine::TranslationResult { id, translations },
            _ => ParsedTranslateLine::Unrecognized,
        },
        // `id` deliberately NOT part of this match tuple (unlike code/
        // message) — see ParsedTranslateLine::Error's own doc comment for
        // why it stays optional even on an otherwise well-formed error
        // line (same "match on the required fields, thread the optional
        // one through separately" shape as parse_osspeech_line's own
        // "locale" arm).
        "error" => match (raw.code, raw.message) {
            (Some(code), Some(message)) => ParsedTranslateLine::Error { id: raw.id, code, message },
            _ => ParsedTranslateLine::Unrecognized,
        },
        _ => ParsedTranslateLine::Unrecognized,
    }
}

// ---- SystemTranslateState: single-flight slot + generation guard
// (clone of OsSpeechState's shape, minus everything pause/resume/asset/
// preinstall-specific that lane needs and this one doesn't) + a request-
// id-keyed pending-reply map (this lane's own addition — osspeech.rs has
// no analog, since it never correlates a specific reply to a specific
// caller) ----

struct RunningTranslate {
    child: CommandChild,
    source: String,
    target: String,
    /// Guards `finish_generation` against a STALE reader task (one whose
    /// child was superseded by a later `register_running_child` call)
    /// clearing a NEWER child's own slot entry — mirrors OsSpeechState::
    /// finish_session's identical generation check one lane over.
    generation: u64,
}

/// Managed Tauri state (`.manage(SystemTranslateState::default())`,
/// lib.rs). `pending`'s keys are request ids minted by `next_request_id`
/// — a single process-wide monotonic counter NEVER reset across a
/// generation change, which is what makes keying pending replies by id
/// ALONE (no generation tag needed on `pending` itself) safe: an id can
/// never collide across two different `--translate` children's own
/// requests (see `finish_generation`'s own doc comment for the one place
/// that DOES still need the separate `generation` guard — the `running`
/// slot itself, not `pending`).
#[derive(Default)]
pub struct SystemTranslateState {
    generation: AtomicU64,
    running: Mutex<Option<RunningTranslate>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Vec<TranslateItem>, String>>>>,
    next_request_id: AtomicU64,
}

/// Registers `running` as the new slot occupant, first taking + killing
/// whatever child (if any) was ALREADY there. Returns whether a stale
/// child was found (so the caller, which holds the real
/// `tauri::AppHandle` this fn deliberately doesn't take, can log it) —
/// byte-for-byte the same shape as server.rs's own `register_prewarm_
/// child` (that fn's own doc comment covers the exact race this closes:
/// a second concurrent `system_translate_prepare` call reaching
/// registration while an earlier call's own just-spawned child is still
/// in the slot must not silently orphan it via a bare `*guard =
/// Some(running)`).
fn register_running_child(state: &SystemTranslateState, running: RunningTranslate) -> Result<bool, String> {
    let mut guard = state.running.lock().map_err(poison_err)?;
    let stale = guard.replace(running);
    drop(guard);
    let had_stale = stale.is_some();
    if let Some(stale) = stale {
        let _ = stale.child.kill();
    }
    Ok(had_stale)
}

/// Clears `state.running` IFF `generation` is still its own occupant — a
/// stale reader task (superseded by a later `register_running_child`
/// call) must never clear a NEWER child's own slot entry. Also fails
/// every currently pending request when (and only when) this WAS the
/// current occupant: nobody will ever get a reply for them now that the
/// child that would have answered is gone. Takes `&SystemTranslateState`
/// directly (not a live `tauri::AppHandle`) purely for testability —
/// same "shape-only split" precedent as server.rs's own `register_
/// prewarm_child`/`poll_prewarm_slot`.
fn finish_generation(state: &SystemTranslateState, generation: u64) {
    let was_current = match state.running.lock() {
        Ok(mut guard) => {
            let is_current = matches!(guard.as_ref(), Some(running) if running.generation == generation);
            if is_current {
                *guard = None;
            }
            is_current
        }
        Err(_) => false,
    };
    if was_current {
        fail_all_pending(state, "jargonslayer-audiocap --translate exited");
    }
}

/// Resolves `id`'s pending reply, if anyone is still waiting on it — a
/// silent no-op for an unknown/already-resolved id (a stray/duplicate
/// line, or a caller that already gave up via its own timeout), same
/// "nothing left to report a further failure to" posture as
/// force_kill_pid's own ESRCH case (audiocap.rs).
fn resolve_pending(state: &SystemTranslateState, id: &str, result: Result<Vec<TranslateItem>, String>) {
    let sender = state.pending.lock().ok().and_then(|mut guard| guard.remove(id));
    if let Some(sender) = sender {
        let _ = sender.send(result);
    }
}

/// Drains and fails every currently pending request — request ids are
/// process-wide monotonic and never reused (`next_request_id`), so
/// draining the WHOLE map here is always safe even across a generation
/// change (see `SystemTranslateState`'s own doc comment).
fn fail_all_pending(state: &SystemTranslateState, message: &str) {
    if let Ok(mut guard) = state.pending.lock() {
        for (_, sender) in guard.drain() {
            let _ = sender.send(Err(message.to_string()));
        }
    }
}

/// Resolves `ready_tx`, if it hasn't fired yet, with an error — called
/// whenever the reader task ends (Terminated or rx-closed) before ever
/// seeing a `{"kind":"ready"}` line. Covers both "the child crashed
/// before becoming ready" and "this child was superseded/killed by a
/// newer `register_running_child` call before its own ready line" with
/// the SAME code path — no special-casing needed for either.
fn finish_ready(ready_tx: &mut Option<oneshot::Sender<Result<(), String>>>, message: String) {
    if let Some(tx) = ready_tx.take() {
        let _ = tx.send(Err(message));
    }
}

/// Applies one parsed stderr line's effect — resolving `ready_tx` and/or
/// a pending reply as appropriate. Takes `&SystemTranslateState` directly
/// (not `tauri::AppHandle`) for the same testability reason `finish_
/// generation` does.
fn handle_translate_line(state: &SystemTranslateState, line: &str, ready_tx: &mut Option<oneshot::Sender<Result<(), String>>>) {
    match parse_translate_line(line) {
        ParsedTranslateLine::Ready => {
            if let Some(tx) = ready_tx.take() {
                let _ = tx.send(Ok(()));
            }
        }
        ParsedTranslateLine::TranslationResult { id, translations } => {
            resolve_pending(state, &id, Ok(translations));
        }
        ParsedTranslateLine::Error { id: Some(id), code, message } => {
            resolve_pending(state, &id, Err(format!("{code}: {message}")));
        }
        ParsedTranslateLine::Error { id: None, code, message } => {
            // A startup-level error with no request to correlate against
            // (e.g. session construction itself failing) — fails the
            // pending ready signal, if this is still before the first
            // "ready" line; a silent no-op otherwise (nothing else this
            // id-less shape could possibly resolve).
            if let Some(tx) = ready_tx.take() {
                let _ = tx.send(Err(format!("{code}: {message}")));
            }
        }
        ParsedTranslateLine::Probe { .. } | ParsedTranslateLine::Unrecognized => {}
    }
}

// ---- system_translate_probe ----

#[tauri::command]
pub async fn system_translate_probe(app: tauri::AppHandle, source: String, target: String) -> Result<SystemTranslateProbe, String> {
    if !is_macos_26_or_later(macos_version()) {
        return Ok(SystemTranslateProbe {
            os_supported: false,
            status: "unsupported".to_string(),
        });
    }

    let command = app
        .shell()
        .sidecar(AUDIOCAP_SIDECAR_PROGRAM)
        .map_err(|e| format!("could not resolve the jargonslayer-audiocap sidecar: {e}"))?;
    let (mut rx, _child) = command
        .args(["--probe-translate", "--source", source.as_str(), "--target", target.as_str()])
        .spawn()
        .map_err(|e| format!("failed to spawn jargonslayer-audiocap --probe-translate: {e}"))?;

    let mut stderr_lines = LineReassembler::new();
    let mut result: Option<SystemTranslateProbe> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => {
                for line in stderr_lines.feed(&bytes) {
                    emit_uv_log(&app, "stderr", format!("[systranslate-probe] {line}"));
                    if let ParsedTranslateLine::Probe { os_supported, status } = parse_translate_line(&line) {
                        result = Some(SystemTranslateProbe { os_supported, status });
                    }
                }
            }
            CommandEvent::Error(message) => {
                emit_uv_log(&app, "stderr", format!("[systranslate-probe] shell error: {message}"));
            }
            _ => {}
        }
    }
    if let Some(line) = stderr_lines.flush() {
        emit_uv_log(&app, "stderr", format!("[systranslate-probe] {line}"));
    }
    result.ok_or_else(|| "jargonslayer-audiocap --probe-translate produced no result".to_string())
}

// ---- system_translate_prepare ----

#[tauri::command]
pub async fn system_translate_prepare(
    app: tauri::AppHandle,
    state: tauri::State<'_, SystemTranslateState>,
    source: String,
    target: String,
) -> Result<(), String> {
    // Runtime re-check (D6-style "UI gating is not a boundary" posture,
    // osspeech.rs's own start_os_speech/preinstall_os_speech precedent).
    if !is_macos_26_or_later(macos_version()) {
        return Err(UNSUPPORTED_REASON.to_string());
    }

    // Reuse: already warmed for this exact pair (T2: "spawns (or reuses)
    // the warm --translate child for this pair").
    {
        let guard = state.running.lock().map_err(poison_err)?;
        if matches!(guard.as_ref(), Some(running) if running.source == source && running.target == target) {
            return Ok(());
        }
    }

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();

    let command = app
        .shell()
        .sidecar(AUDIOCAP_SIDECAR_PROGRAM)
        .map_err(|e| format!("could not resolve the jargonslayer-audiocap sidecar: {e}"))?;
    let (rx, child) = command
        .args(["--translate", "--source", source.as_str(), "--target", target.as_str()])
        .spawn()
        .map_err(|e| format!("failed to spawn jargonslayer-audiocap --translate: {e}"))?;

    // F1-style fix (register_running_child's own doc comment): closes the
    // "two concurrent prepare() calls" race, on top of the ordinary
    // "a pair change must tear down and respawn" case this same call
    // handles too (T2's own rule) — one mechanism for both.
    if register_running_child(&state, RunningTranslate { child, source, target, generation })? {
        emit_uv_log(
            &app,
            "stderr",
            "[systranslate] a previous --translate child was still registered — killed it before starting this one",
        );
    }

    spawn_translate_reader_task(app, generation, rx, Some(ready_tx));

    match tokio::time::timeout(TRANSLATE_TIMEOUT, ready_rx).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(message))) => Err(message),
        Ok(Err(_)) => Err("jargonslayer-audiocap --translate exited before becoming ready".to_string()),
        Err(_) => Err(format!(
            "timed out after {}s waiting for jargonslayer-audiocap --translate to become ready",
            TRANSLATE_TIMEOUT.as_secs()
        )),
    }
}

// ---- system_translate ----

#[tauri::command]
pub async fn system_translate(
    state: tauri::State<'_, SystemTranslateState>,
    items: Vec<TranslateItem>,
    source: String,
    target: String,
) -> Result<Vec<TranslateItem>, String> {
    // A dead/absent child (or one warmed for a DIFFERENT pair) must
    // return a clear Err rather than hang waiting for a reply that will
    // never come (T2's own rule). This is a defensive re-check, not a
    // spawn: callers are expected to have already awaited
    // system_translate_prepare(source, target) — system_translate itself
    // never spawns, the warm-session lifecycle lives entirely in
    // prepare/stop.
    {
        let guard = state.running.lock().map_err(poison_err)?;
        match guard.as_ref() {
            Some(running) if running.source == source && running.target == target => {}
            Some(_) => {
                return Err("system_translate: a different language pair is currently warmed — call system_translate_prepare first".to_string())
            }
            None => return Err("system_translate: no --translate child is running — call system_translate_prepare first".to_string()),
        }
    }

    let request_id = state.next_request_id.fetch_add(1, Ordering::SeqCst).to_string();
    let (tx, rx) = oneshot::channel();
    state.pending.lock().map_err(poison_err)?.insert(request_id.clone(), tx);

    let mut line = serde_json::to_vec(&WireRequest {
        id: request_id.clone(),
        segments: items,
    })
    .map_err(|e| format!("failed to encode translate request: {e}"))?;
    line.push(b'\n');

    let write_result = {
        let mut guard = state.running.lock().map_err(poison_err)?;
        match guard.as_mut() {
            Some(running) => running
                .child
                .write(&line)
                .map_err(|e| format!("failed to write to jargonslayer-audiocap --translate stdin: {e}")),
            None => Err("system_translate: the --translate child disappeared before the request could be sent".to_string()),
        }
    };
    if let Err(e) = write_result {
        state.pending.lock().map_err(poison_err)?.remove(&request_id);
        return Err(e);
    }

    match tokio::time::timeout(TRANSLATE_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        // The oneshot sender was dropped without ever sending — the
        // reader task exited (child died) before a reply arrived.
        Ok(Err(_)) => Err("system_translate: the --translate child exited before replying".to_string()),
        Err(_) => {
            state.pending.lock().map_err(poison_err)?.remove(&request_id);
            Err(format!(
                "system_translate: timed out after {}s waiting for a reply",
                TRANSLATE_TIMEOUT.as_secs()
            ))
        }
    }
}

// ---- system_translate_stop ----

#[tauri::command]
pub async fn system_translate_stop(state: tauri::State<'_, SystemTranslateState>) -> Result<(), String> {
    let stale = state.running.lock().map_err(poison_err)?.take();
    if let Some(running) = stale {
        // Immediate kill (tauri-plugin-shell's own CommandChild::kill —
        // SIGKILL, consumes the handle), NOT the graceful drop-to-close-
        // stdin-then-grace-period-watchdog dance audiocap.rs/osspeech.rs
        // use for THEIR stop paths: unlike a capture/transcribe session,
        // --translate holds no audio device and no in-flight asset
        // download to let finish gracefully, so a grace period would buy
        // nothing here — mirrors server.rs's own immediate `kill_and_reap`
        // posture for the whisper_server.py child, one file over, for
        // the identical "no teardown work worth waiting for" reason.
        let _ = running.child.kill();
    }
    fail_all_pending(&state, "system_translate_stop: the --translate child was stopped");
    Ok(())
}

// ---- the reader task (owns the spawned child's CommandEvent receiver
// for its entire lifetime — mirrors osspeech.rs's own spawn_os_speech_
// session_task) ----

fn spawn_translate_reader_task(
    app: tauri::AppHandle,
    generation: u64,
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    ready_tx: Option<oneshot::Sender<Result<(), String>>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut ready_tx = ready_tx;
        let mut stderr_lines = LineReassembler::new();

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => {
                    for line in stderr_lines.feed(&bytes) {
                        emit_uv_log(&app, "stderr", format!("[systranslate] {line}"));
                        let state = app.state::<SystemTranslateState>();
                        handle_translate_line(&state, &line, &mut ready_tx);
                    }
                }
                CommandEvent::Error(message) => {
                    emit_uv_log(&app, "stderr", format!("[systranslate] shell error: {message}"));
                }
                CommandEvent::Terminated(payload) => {
                    emit_uv_log(&app, "stderr", format!("[systranslate] --translate exited (code {:?})", payload.code));
                    let state = app.state::<SystemTranslateState>();
                    finish_generation(&state, generation);
                    finish_ready(
                        &mut ready_tx,
                        "jargonslayer-audiocap --translate exited before becoming ready".to_string(),
                    );
                    return;
                }
                _ => {}
            }
        }

        // rx closed without ever yielding Terminated — shouldn't happen
        // (see osspeech.rs's own identical safety net), kept so the
        // running slot can never get stuck open forever.
        if let Some(line) = stderr_lines.flush() {
            emit_uv_log(&app, "stderr", format!("[systranslate] {line}"));
        }
        let state = app.state::<SystemTranslateState>();
        finish_generation(&state, generation);
        finish_ready(
            &mut ready_tx,
            "jargonslayer-audiocap --translate ended without a final status".to_string(),
        );
    });
}

// ---- app-exit cleanup ----

/// Called from lib.rs's RunEvent::ExitRequested/Exit handler, right next
/// to audiocap::kill_held_session_on_exit/osspeech::kill_held_session_on_exit
/// — same best-effort, no-grace-period posture (server::kill_held_child_
/// on_exit's own doc comment covers the force-quit gap this can't catch
/// either, accepted the same way there).
pub fn kill_held_translate_on_exit(app: &tauri::AppHandle) {
    let state = app.state::<SystemTranslateState>();
    let stale = match state.running.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => return,
    };
    if let Some(running) = stale {
        let _ = running.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- LineReassembler (copy of osspeech.rs's own tests) ----

    #[test]
    fn feed_returns_complete_lines_from_a_single_chunk() {
        let mut r = LineReassembler::new();
        let lines = r.feed(b"{\"a\":1}\n{\"b\":2}\n");
        assert_eq!(lines, vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]);
        assert_eq!(r.flush(), None, "nothing should remain buffered");
    }

    #[test]
    fn feed_buffers_a_line_split_across_two_chunks() {
        let mut r = LineReassembler::new();
        assert_eq!(r.feed(b"{\"kind\":\"rea"), Vec::<String>::new(), "no complete line yet");
        assert_eq!(r.feed(b"dy\"}\n"), vec!["{\"kind\":\"ready\"}".to_string()]);
    }

    #[test]
    fn feed_keeps_a_trailing_partial_line_buffered_and_returns_completed_ones() {
        let mut r = LineReassembler::new();
        let lines = r.feed(b"one\ntwo\nthree-partial");
        assert_eq!(lines, vec!["one".to_string(), "two".to_string()]);
        assert_eq!(r.flush(), Some("three-partial".to_string()));
    }

    #[test]
    fn flush_returns_none_when_nothing_is_buffered() {
        let mut r = LineReassembler::new();
        assert_eq!(r.flush(), None);
    }

    #[test]
    fn flush_clears_the_buffer_so_a_second_flush_returns_none() {
        let mut r = LineReassembler::new();
        r.feed(b"no newline yet");
        assert_eq!(r.flush(), Some("no newline yet".to_string()));
        assert_eq!(r.flush(), None);
    }

    #[test]
    fn empty_chunk_yields_no_lines() {
        let mut r = LineReassembler::new();
        assert!(r.feed(b"").is_empty());
    }

    // ---- macOS version gating ----

    #[test]
    fn version_below_26_is_unsupported() {
        assert!(!is_macos_26_or_later((14, 4)));
        assert!(!is_macos_26_or_later((15, 9)));
        assert!(!is_macos_26_or_later((25, 9)));
    }

    #[test]
    fn version_26_and_above_is_supported_regardless_of_minor() {
        assert!(is_macos_26_or_later((26, 0)));
        assert!(is_macos_26_or_later((27, 0)));
    }

    // ---- parse_translate_line: valid lines (canned, one per kind) ----

    #[test]
    fn parses_a_probe_line() {
        let line = r#"{"kind":"probe","osSupported":true,"status":"installed"}"#;
        assert_eq!(
            parse_translate_line(line),
            ParsedTranslateLine::Probe {
                os_supported: true,
                status: "installed".to_string(),
            }
        );
    }

    #[test]
    fn parses_a_probe_line_reporting_os_unsupported() {
        let line = r#"{"kind":"probe","osSupported":false,"status":"unsupported"}"#;
        assert_eq!(
            parse_translate_line(line),
            ParsedTranslateLine::Probe {
                os_supported: false,
                status: "unsupported".to_string(),
            }
        );
    }

    #[test]
    fn parses_a_ready_line() {
        assert_eq!(parse_translate_line(r#"{"kind":"ready"}"#), ParsedTranslateLine::Ready);
    }

    #[test]
    fn parses_a_result_line_with_multiple_translations() {
        let line = r#"{"kind":"result","id":"req-1","translations":[{"id":"seg-1","text":"你好"},{"id":"seg-2","text":"再见"}]}"#;
        assert_eq!(
            parse_translate_line(line),
            ParsedTranslateLine::TranslationResult {
                id: "req-1".to_string(),
                translations: vec![
                    TranslateItem { id: "seg-1".to_string(), text: "你好".to_string() },
                    TranslateItem { id: "seg-2".to_string(), text: "再见".to_string() },
                ],
            }
        );
    }

    #[test]
    fn parses_a_result_line_with_an_empty_translations_array() {
        let line = r#"{"kind":"result","id":"req-1","translations":[]}"#;
        assert_eq!(
            parse_translate_line(line),
            ParsedTranslateLine::TranslationResult {
                id: "req-1".to_string(),
                translations: Vec::new(),
            }
        );
    }

    #[test]
    fn parses_a_per_request_error_line_carrying_an_id() {
        let line = r#"{"kind":"error","id":"req-1","code":"not-installed","message":"translation language pack not installed"}"#;
        assert_eq!(
            parse_translate_line(line),
            ParsedTranslateLine::Error {
                id: Some("req-1".to_string()),
                code: "not-installed".to_string(),
                message: "translation language pack not installed".to_string(),
            }
        );
    }

    #[test]
    fn parses_a_startup_error_line_with_no_id() {
        let line = r#"{"kind":"error","code":"failed","message":"session could not be constructed"}"#;
        assert_eq!(
            parse_translate_line(line),
            ParsedTranslateLine::Error {
                id: None,
                code: "failed".to_string(),
                message: "session could not be constructed".to_string(),
            }
        );
    }

    // ---- parse_translate_line: garbage / partial / malformed ----

    #[test]
    fn garbage_text_is_unrecognized() {
        for line in ["", "not json at all", "Traceback (most recent call last):", "null", "42"] {
            assert_eq!(parse_translate_line(line), ParsedTranslateLine::Unrecognized, "{line:?} should be Unrecognized");
        }
    }

    #[test]
    fn partial_or_truncated_json_is_unrecognized() {
        for line in [
            r#"{"kind":"result","id":"req-1","translations":[{"id":"seg-1""#,
            r#"{"kind":"probe","osSupported":tr"#,
            "{",
        ] {
            assert_eq!(parse_translate_line(line), ParsedTranslateLine::Unrecognized, "{line:?} should be Unrecognized");
        }
    }

    #[test]
    fn valid_json_with_an_unrecognized_kind_is_unrecognized() {
        assert_eq!(parse_translate_line(r#"{"kind":"something_else","x":1}"#), ParsedTranslateLine::Unrecognized);
    }

    #[test]
    fn valid_json_missing_the_kind_field_is_unrecognized() {
        assert_eq!(parse_translate_line(r#"{"osSupported":true,"status":"installed"}"#), ParsedTranslateLine::Unrecognized);
    }

    #[test]
    fn a_probe_line_missing_status_is_unrecognized() {
        assert_eq!(parse_translate_line(r#"{"kind":"probe","osSupported":true}"#), ParsedTranslateLine::Unrecognized);
    }

    #[test]
    fn a_result_line_missing_translations_is_unrecognized() {
        assert_eq!(parse_translate_line(r#"{"kind":"result","id":"req-1"}"#), ParsedTranslateLine::Unrecognized);
    }

    #[test]
    fn an_error_line_missing_message_is_unrecognized() {
        assert_eq!(parse_translate_line(r#"{"kind":"error","id":"req-1","code":"failed"}"#), ParsedTranslateLine::Unrecognized);
    }

    // ---- response correlation: real oneshot channels, no Tauri app
    // context needed (channel construction/send/try_recv are all plain
    // sync operations — see this module's own header comment on why
    // finish_generation/handle_translate_line/resolve_pending/
    // fail_all_pending all take &SystemTranslateState directly rather
    // than a live AppHandle). ----

    #[test]
    fn resolve_pending_routes_a_reply_to_the_matching_id_only() {
        let state = SystemTranslateState::default();
        let (tx1, mut rx1) = oneshot::channel();
        let (tx2, mut rx2) = oneshot::channel();
        state.pending.lock().unwrap().insert("1".to_string(), tx1);
        state.pending.lock().unwrap().insert("2".to_string(), tx2);

        resolve_pending(&state, "2", Ok(vec![TranslateItem { id: "seg".to_string(), text: "你好".to_string() }]));

        assert_eq!(
            rx2.try_recv().unwrap(),
            Ok(vec![TranslateItem { id: "seg".to_string(), text: "你好".to_string() }])
        );
        assert!(rx1.try_recv().is_err(), "id 1's receiver must be untouched by a reply for id 2");
        assert!(!state.pending.lock().unwrap().contains_key("2"), "a resolved id must be removed from the pending map");
        assert!(state.pending.lock().unwrap().contains_key("1"), "an unrelated id must stay pending");
    }

    #[test]
    fn resolve_pending_handles_replies_arriving_out_of_order() {
        let state = SystemTranslateState::default();
        let (tx1, mut rx1) = oneshot::channel();
        let (tx2, mut rx2) = oneshot::channel();
        let (tx3, mut rx3) = oneshot::channel();
        state.pending.lock().unwrap().insert("1".to_string(), tx1);
        state.pending.lock().unwrap().insert("2".to_string(), tx2);
        state.pending.lock().unwrap().insert("3".to_string(), tx3);

        // Swift/the reader task has no reason to reply in request order —
        // resolve 3, then 1, then 2, and confirm every receiver still
        // gets exactly its own answer.
        resolve_pending(&state, "3", Ok(vec![TranslateItem { id: "s3".to_string(), text: "三".to_string() }]));
        resolve_pending(&state, "1", Ok(vec![TranslateItem { id: "s1".to_string(), text: "一".to_string() }]));
        resolve_pending(&state, "2", Err("failed: boom".to_string()));

        assert_eq!(rx1.try_recv().unwrap().unwrap()[0].text, "一");
        assert_eq!(rx2.try_recv().unwrap(), Err("failed: boom".to_string()));
        assert_eq!(rx3.try_recv().unwrap().unwrap()[0].text, "三");
        assert!(state.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn resolve_pending_is_a_noop_for_an_unknown_id() {
        let state = SystemTranslateState::default();
        let (tx1, mut rx1) = oneshot::channel();
        state.pending.lock().unwrap().insert("1".to_string(), tx1);

        // A reply for an id nobody registered (already timed out and gave
        // up, or a stray/duplicate line) must not panic and must not
        // touch an unrelated pending entry.
        resolve_pending(&state, "does-not-exist", Ok(Vec::new()));

        assert!(rx1.try_recv().is_err(), "id 1 must be untouched");
        assert!(state.pending.lock().unwrap().contains_key("1"));
    }

    #[test]
    fn fail_all_pending_drains_and_fails_every_entry() {
        let state = SystemTranslateState::default();
        let (tx1, mut rx1) = oneshot::channel();
        let (tx2, mut rx2) = oneshot::channel();
        state.pending.lock().unwrap().insert("1".to_string(), tx1);
        state.pending.lock().unwrap().insert("2".to_string(), tx2);

        fail_all_pending(&state, "child gone");

        assert_eq!(rx1.try_recv().unwrap(), Err("child gone".to_string()));
        assert_eq!(rx2.try_recv().unwrap(), Err("child gone".to_string()));
        assert!(state.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn fail_all_pending_is_a_noop_when_nothing_is_pending() {
        let state = SystemTranslateState::default();
        fail_all_pending(&state, "unused");
        assert!(state.pending.lock().unwrap().is_empty());
    }

    // ---- handle_translate_line: ready/result/error routing ----

    #[test]
    fn handle_translate_line_resolves_ready_tx_on_a_ready_line() {
        let state = SystemTranslateState::default();
        let (tx, mut rx) = oneshot::channel();
        let mut ready_tx = Some(tx);

        handle_translate_line(&state, r#"{"kind":"ready"}"#, &mut ready_tx);

        assert!(ready_tx.is_none(), "ready_tx must be consumed");
        assert_eq!(rx.try_recv().unwrap(), Ok(()));
    }

    #[test]
    fn handle_translate_line_routes_a_result_line_to_the_pending_map_not_ready_tx() {
        let state = SystemTranslateState::default();
        let (pending_tx, mut pending_rx) = oneshot::channel();
        state.pending.lock().unwrap().insert("req-1".to_string(), pending_tx);
        let (ready_tx, mut ready_rx) = oneshot::channel();
        let mut ready_tx = Some(ready_tx);

        let line = r#"{"kind":"result","id":"req-1","translations":[{"id":"seg-1","text":"你好"}]}"#;
        handle_translate_line(&state, line, &mut ready_tx);

        assert_eq!(
            pending_rx.try_recv().unwrap(),
            Ok(vec![TranslateItem { id: "seg-1".to_string(), text: "你好".to_string() }])
        );
        assert!(ready_tx.is_some(), "a result line must never consume ready_tx");
        assert!(ready_rx.try_recv().is_err());
    }

    #[test]
    fn handle_translate_line_routes_a_per_request_error_to_the_pending_map() {
        let state = SystemTranslateState::default();
        let (pending_tx, mut pending_rx) = oneshot::channel();
        state.pending.lock().unwrap().insert("req-1".to_string(), pending_tx);
        let mut ready_tx: Option<oneshot::Sender<Result<(), String>>> = None;

        let line = r#"{"kind":"error","id":"req-1","code":"not-installed","message":"pack missing"}"#;
        handle_translate_line(&state, line, &mut ready_tx);

        assert_eq!(pending_rx.try_recv().unwrap(), Err("not-installed: pack missing".to_string()));
    }

    #[test]
    fn handle_translate_line_routes_an_id_less_error_to_ready_tx() {
        let state = SystemTranslateState::default();
        let (tx, mut rx) = oneshot::channel();
        let mut ready_tx = Some(tx);

        let line = r#"{"kind":"error","code":"failed","message":"boom"}"#;
        handle_translate_line(&state, line, &mut ready_tx);

        assert!(ready_tx.is_none());
        assert_eq!(rx.try_recv().unwrap(), Err("failed: boom".to_string()));
    }

    #[test]
    fn handle_translate_line_ignores_a_probe_line_and_garbage() {
        let state = SystemTranslateState::default();
        let mut ready_tx: Option<oneshot::Sender<Result<(), String>>> = None;
        handle_translate_line(&state, r#"{"kind":"probe","osSupported":true,"status":"installed"}"#, &mut ready_tx);
        handle_translate_line(&state, "not json", &mut ready_tx);
        // No panic, no pending entries touched (there were none) — the
        // assertion here is simply that this returns normally.
        assert!(state.pending.lock().unwrap().is_empty());
    }

    // ---- finish_generation: the stale-vs-current slot-clearing guard.
    // The "still current" arm (clears `running` + drains `pending`) needs
    // a real `RunningTranslate`, which needs a real `CommandChild` —
    // `CommandChild` has no test-reachable constructor (osspeech.rs's own
    // doc comment on this identical limitation, one lane over), so that
    // arm is verified live instead (this worker's own report covers the
    // real --translate round trip, including a clean exit that reaches
    // this exact function). The "not current" arm below — an empty or
    // already-superseded slot must never touch an unrelated pending
    // entry — needs no CommandChild at all and is fully unit-testable. ----

    #[test]
    fn finish_generation_is_a_noop_against_an_empty_slot() {
        let state = SystemTranslateState::default();
        let (tx, mut rx) = oneshot::channel();
        state.pending.lock().unwrap().insert("1".to_string(), tx);

        finish_generation(&state, 1);

        assert!(rx.try_recv().is_err(), "an empty slot must never fail an unrelated pending entry");
        assert!(state.pending.lock().unwrap().contains_key("1"), "pending must be untouched when the slot was never current");
    }
}
