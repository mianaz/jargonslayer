// v0.4 S9.1 (docs/design-explorations/s9-app-audio-tap-blueprint.md,
// slice S9.1) — jargonslayer-audiocap: the CoreAudio process-tap
// helper, a second externalBin alongside uv (D2). This module is S9.1's
// own scope ONLY: the bare-file-name sidecar constant (mirrors uv.rs's
// UV_SIDECAR_PROGRAM) plus an env-gated spike rig that spawns the
// helper for a few seconds at app setup, so a PACKAGED build can be
// used to verify TCC attribution (D2's own spike gate: "responsible-
// process attribution depends on the spawn topology, so a terminal-
// launched helper proves nothing" — the packaged app itself has to do
// the spawning). No IPC commands here — that's S9.2's
// start_app_audio/stop_app_audio/capabilities() surface.
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::uv::emit_uv_log;

/// The program name handed to `Shell::sidecar` — the FILE NAME of
/// tauri.conf.json's `bundle.externalBin` entry ("binaries/
/// jargonslayer-audiocap"), never the entry itself. Same verbatim-join
/// vs bundler-flatten trap as UV_SIDECAR_PROGRAM (uv.rs, that
/// constant's own doc comment): `Shell::sidecar` joins the given path
/// VERBATIM onto the running exe's own directory, while the bundler
/// FLATTENS every externalBin into that directory
/// (binaries/jargonslayer-audiocap-<triple> -> Contents/MacOS/
/// jargonslayer-audiocap in the macOS bundle, target/<profile>/
/// jargonslayer-audiocap in dev) — passing the whole config entry
/// "binaries/jargonslayer-audiocap" would resolve to Contents/MacOS/
/// binaries/jargonslayer-audiocap: ENOENT, exactly the v0.4.0 uv
/// hotfix's own bug shape. Pinned against the config by
/// sidecar_program_is_a_bare_file_name_matching_external_bin below
/// (mirrors uv.rs's identically-named test).
pub const AUDIOCAP_SIDECAR_PROGRAM: &str = "jargonslayer-audiocap";

/// Buffers raw stderr byte chunks (`set_raw_out(true)` — D5: "Raw mode
/// applies to stderr too => Rust reassembles NDJSON status records
/// across arbitrary chunk boundaries") into complete '\n'-terminated
/// lines, matching jargonslayer-audiocap's own stderr convention (one
/// JSON object + one '\n' per record — StatusEvents.swift). A line
/// arriving split across two-or-more raw chunks is exactly the case
/// this exists to handle; a plain per-chunk split on '\n' would
/// silently corrupt/drop a line straddling a chunk boundary.
struct LineReassembler {
    pending: Vec<u8>,
}

impl LineReassembler {
    fn new() -> Self {
        Self { pending: Vec::new() }
    }

    /// Returns every complete line newly available after appending
    /// `chunk` (oldest first, '\n' stripped); any trailing partial line
    /// stays buffered for a later `feed`/`flush` call.
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

    /// Returns whatever's left buffered (a line that never got a
    /// trailing '\n' before the stream ended, if any) and clears it —
    /// call once after the process's stderr stream is done.
    fn flush(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let line_bytes = std::mem::take(&mut self.pending);
        Some(String::from_utf8_lossy(&line_bytes).into_owned())
    }
}

/// S9.1's own go/no-go spike rig (blueprint D2's spike gate): spawns
/// jargonslayer-audiocap for a few seconds so a PACKAGED build's TCC
/// prompt attribution can be verified interactively with Miana against
/// a real Developer-ID build (D2: "against a packaged Developer-ID
/// build ... a terminal-launched helper proves nothing"). Inert (a
/// no-op) unless armed by ONE of:
///   - the `--spike-audiocap` argv flag — the PRIMARY gate: the
///     TCC-correct invocation is `open -a JargonSlayer.app --args
///     --spike-audiocap`, because a LaunchServices launch makes the app
///     its own TCC responsible process, whereas a binary launched
///     directly from a terminal can be attributed to the TERMINAL —
///     which would make the spike read false. `open` also drops
///     environment variables, hence an argv flag at all;
///   - JARGONSLAYER_SPIKE_AUDIOCAP=1 in the environment (dev/terminal
///     convenience only — see the attribution caveat above).
/// The packaged app itself has to be the one spawning the helper for
/// the spike to mean anything, so this hook lives at app setup, not
/// behind any UI affordance.
///
/// Excludes THIS APP's own pid (`std::process::id()`) per D3 — the
/// Tauri GUI app is "the only thing of ours that could ever render
/// audio," not the helper — with `--duration 5` so the spike auto-stops
/// rather than needing a manual kill. Every spike line is TEED three
/// ways: the uv://log event lane (uv::emit_uv_log), stderr (eprintln),
/// and append-only `<app_log_dir>/audiocap-spike.log` — the file is the
/// one Miana can actually read, since a provisioned machine never shows
/// the wizard's 详细日志 pane and an `open`-launched app has no
/// terminal. stdout (the framing v1 PCM stream) is never logged as
/// text; only its byte count is reported once the process exits.
pub fn maybe_spawn_spike(app: &tauri::AppHandle) {
    let env_armed = std::env::var("JARGONSLAYER_SPIKE_AUDIOCAP").ok().as_deref() == Some("1");
    let arg_armed = std::env::args().any(|a| a == "--spike-audiocap");
    if !env_armed && !arg_armed {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Best-effort file tee — see this fn's doc comment for why the
        // file is the spike's primary evidence channel. None (with a
        // stderr note) rather than an error if the log dir can't be
        // resolved/created: the spike should still run and emit to the
        // other two channels.
        let mut spike_file: Option<std::fs::File> = {
            use tauri::Manager;
            app.path()
                .app_log_dir()
                .ok()
                .and_then(|dir| {
                    std::fs::create_dir_all(&dir).ok()?;
                    std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(dir.join("audiocap-spike.log"))
                        .ok()
                })
        };
        if spike_file.is_none() {
            eprintln!("[audiocap-spike] could not open audiocap-spike.log — continuing with event lane + stderr only");
        }
        let mut tee = move |app: &tauri::AppHandle, stream: &'static str, line: String| {
            let message = format!("[audiocap-spike] {line}");
            eprintln!("{message}");
            if let Some(f) = spike_file.as_mut() {
                use std::io::Write;
                let _ = writeln!(f, "[{stream}] {message}");
            }
            emit_uv_log(app, stream, message);
        };

        let now_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let own_pid = std::process::id().to_string();
        tee(
            &app,
            "stdout",
            format!("--- spike run (unix {now_unix}) — spawning {AUDIOCAP_SIDECAR_PROGRAM} --exclude-pid {own_pid} --duration 5 ---"),
        );

        let command = match app.shell().sidecar(AUDIOCAP_SIDECAR_PROGRAM) {
            Ok(command) => command,
            Err(e) => {
                tee(&app, "stderr", format!("could not resolve sidecar: {e}"));
                return;
            }
        };
        let command = command
            .args(["--exclude-pid", &own_pid, "--duration", "5"])
            .set_raw_out(true);

        let (mut rx, _child) = match command.spawn() {
            Ok(pair) => pair,
            Err(e) => {
                tee(&app, "stderr", format!("failed to spawn: {e}"));
                return;
            }
        };

        let mut stderr_lines = LineReassembler::new();
        let mut stdout_bytes: u64 = 0;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    stdout_bytes += bytes.len() as u64;
                }
                CommandEvent::Stderr(bytes) => {
                    for line in stderr_lines.feed(&bytes) {
                        tee(&app, "stderr", line);
                    }
                }
                CommandEvent::Error(message) => {
                    tee(&app, "stderr", format!("error: {message}"));
                }
                CommandEvent::Terminated(payload) => {
                    tee(&app, "stdout", format!("exited (code {:?})", payload.code));
                }
                _ => {}
            }
        }
        if let Some(line) = stderr_lines.flush() {
            tee(&app, "stderr", line);
        }

        tee(&app, "stdout", format!("stdout bytes: {stdout_bytes}"));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- AUDIOCAP_SIDECAR_PROGRAM vs tauri.conf.json (mirrors uv.rs's
    // identically-shaped/named test for UV_SIDECAR_PROGRAM) ----

    #[test]
    fn sidecar_program_is_a_bare_file_name_matching_external_bin() {
        assert_eq!(
            std::path::Path::new(AUDIOCAP_SIDECAR_PROGRAM).components().count(),
            1,
            "AUDIOCAP_SIDECAR_PROGRAM must be a bare file name, never a path"
        );

        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        let external_bins = conf["bundle"]["externalBin"].as_array().expect("bundle.externalBin is an array");
        assert!(
            external_bins
                .iter()
                .filter_map(|b| b.as_str())
                .any(|b| std::path::Path::new(b).file_name().is_some_and(|n| n == AUDIOCAP_SIDECAR_PROGRAM)),
            "no bundle.externalBin entry has file name '{AUDIOCAP_SIDECAR_PROGRAM}'"
        );
    }

    // ---- LineReassembler ----

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
        assert_eq!(r.feed(b"{\"type\":\"stat"), Vec::<String>::new(), "no complete line yet");
        assert_eq!(r.feed(b"us\"}\n"), vec!["{\"type\":\"status\"}".to_string()]);
    }

    #[test]
    fn feed_handles_a_line_split_across_three_chunks() {
        let mut r = LineReassembler::new();
        assert!(r.feed(b"ab").is_empty());
        assert!(r.feed(b"cd").is_empty());
        assert_eq!(r.feed(b"ef\n"), vec!["abcdef".to_string()]);
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

    #[test]
    fn consecutive_newlines_yield_an_empty_line_not_a_dropped_one() {
        let mut r = LineReassembler::new();
        let lines = r.feed(b"a\n\nb\n");
        assert_eq!(lines, vec!["a".to_string(), "".to_string(), "b".to_string()]);
    }
}
