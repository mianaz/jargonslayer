// v0.4 S10 field-fix (docs/design-explorations/s10-fieldfix-blueprint.md,
// Chunk A, item 2 + Q1 verdict) — the RFC 8252 loopback OAuth callback
// listener backing "Connect with OpenRouter" on desktop. Q1's own
// grounds (blueprint, docs-verified): OpenRouter's PKCE docs bless
// "localhost callbacks ... on any port" and never mention custom
// schemes; Tauri deep links on macOS are bundle-only (untestable in
// `tauri dev`); a loopback listener keeps the PKCE verifier in the JS
// closure for the whole hop (the webview itself never navigates away).
// A genuine open smoke-test item this file does NOT resolve: the docs
// bless the hostname `localhost`, not literally `127.0.0.1` — the BIND
// target here stays `127.0.0.1` regardless (that part is pinned), but
// if OpenRouter's `/auth` ever rejects a `callback_url` built against
// it, the fix is on the JS side (lib/oauth/openrouterDesktop.ts flips
// the callback URL's HOST string to `localhost:{port}`) — this file's
// own contract (bind address, port, event payload) is unaffected either
// way.
//
// F13 (MEDIUM, adversarial review): the callback's own nonce moved from
// a `?ns=` query param to a `/oauth/openrouter/{ns}` PATH segment (see
// parse_callback's own doc comment below) — a provider's redirect
// construction is free to rewrite/replace a callback_url's QUERY
// string wholesale when appending its own `?code=`/`?error=`
// (undocumented behavior either way, same category of open question as
// the hostname item just above), but never touches the PATH portion of
// a redirect_uri. This removes that query-retention ASSUMPTION the old
// `?ns=` shape silently depended on — an independent concern from the
// still-open hostname item above; this fix neither resolves nor
// depends on that one either way.
//
// Deliberately minimal HTTP: this is a ONE-SHOT single-request receiver,
// not a real server. Each accepted connection gets exactly one
// `BufRead::read_line` (the request line only — headers/body are never
// read, just left for the OS to discard once the socket closes) and one
// fixed plain-text response; no persistent connections, no routing
// beyond "does the path carry the expected /oauth/openrouter/{ns}
// prefix+nonce, and does the query string carry a `code`/`error`".
//
// Single-flight via a bare generation counter (mirrors audiocap.rs's own
// AtomicU64-generation guard — see that file's AudiocapState doc comment
// for the shared "a stale/superseded session's late work must never
// reach a newer session" rationale) — simpler here than AudiocapState's
// full Mutex<Option<...>> shape because there is no external process
// handle to hold onto: the TcpListener lives only as the spawned
// thread's own local variable, and gets dropped (freeing the port) the
// instant that thread notices its generation is no longer current. No
// shared mutable resource, so no mutex is needed at all.
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager};

/// PINNED CONTRACT: `lib/oauth/openrouterDesktop.ts` subscribes to
/// exactly this event name before ever calling `oauth_loopback_start`.
const EVENT_NAME: &str = "oauth://openrouter";

/// "~300s overall deadline" (blueprint) — generous relative to JS's own
/// ~180s timeout (openrouterDesktop.ts) so Rust is never the side that
/// gives up first; JS settling first and calling `oauth_loopback_cancel`
/// is the expected common path, this deadline is the backstop for a
/// caller that never settles at all.
const OVERALL_DEADLINE: Duration = Duration::from_secs(300);

/// Per-connection read timeout for the one `read_line` call below — the
/// browser's own redirect request arrives near-instantly over loopback;
/// this only guards against a stalled/incomplete connection (e.g. a
/// port-scanner) tying up the accept loop.
const CONNECTION_READ_TIMEOUT: Duration = Duration::from_secs(5);

/// Spacing for the non-blocking accept loop's poll — short enough that
/// both `oauth_loopback_cancel` and the overall deadline are noticed
/// promptly, long enough to not busy-loop.
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// PINNED CONTRACT: exact zh success body (blueprint item 2).
const SUCCESS_BODY: &str = "已连接，可关闭此页并返回 JargonSlayer";

/// PINNED CONTRACT: `oauth://openrouter` event payload shape.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthCallbackPayload {
    pub code: Option<String>,
    pub error: Option<String>,
}

impl OauthCallbackPayload {
    fn error(reason: &str) -> Self {
        Self {
            code: None,
            error: Some(reason.to_string()),
        }
    }
}

// ---- OauthState: single-flight generation guard ----

/// Managed Tauri state (`.manage(OauthState::default())`, lib.rs). See
/// this module's own header comment for why a bare counter (no Mutex,
/// no held resource) is enough here, unlike AudiocapState's fuller
/// single-flight shape.
#[derive(Default)]
pub struct OauthState {
    generation: AtomicU64,
}

impl OauthState {
    /// Bumps and returns the new generation. Called by BOTH
    /// `oauth_loopback_start` (a fresh listener claims the new value)
    /// and `oauth_loopback_cancel` (which bumps with no new listener to
    /// claim it — the bump alone orphans whatever generation WAS
    /// current, identical in effect to swapping in a listener that
    /// immediately exits).
    fn advance(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Cheap, lock-free — polled on every iteration of the listener's
    /// own accept loop (mirrors AudiocapState::is_current's identical
    /// "hot enough to matter" posture).
    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }
}

// ---- pure request-line / query parsing (unit-tested directly) ----

/// Every genuine callback target's path must start with this, followed
/// immediately by the nonce as the next (and last) path segment — see
/// `parse_callback`'s own doc comment for why the nonce lives in the
/// PATH rather than a `?ns=` query param.
const CALLBACK_PATH_PREFIX: &str = "/oauth/openrouter/";

/// Parses an HTTP request line's target (`GET <target> HTTP/1.1`) and
/// decides whether it's a genuine OpenRouter OAuth callback for THIS
/// listener's own nonce. Pure — no I/O, no tauri types — the seam
/// `handle_connection`'s single `read_line` result is fed through.
///
/// F13 (MEDIUM, adversarial review): the nonce is a PATH segment
/// (`/oauth/openrouter/{ns}`), never a `?ns=` query param — the old
/// query-param shape silently bet on OpenRouter's redirect PRESERVING
/// an arbitrary query string on the callback_url when appending its
/// own `?code=`/`?error=` (undocumented either way); a redirect's PATH
/// is never rewritten that way, so this removes the bet entirely (see
/// this module's own header comment). The nonce segment must be the
/// path's LAST segment (an extra trailing slash — or anything else
/// after it — is rejected, never guessed at: `ns` itself,
/// generateCodeVerifier's RFC 7636 charset, never contains a `/`) and
/// is percent-decoded (`percent_encoding`, NOT `url::form_urlencoded` —
/// a path segment has no query-string `+`-means-space substitution)
/// before comparing against `expected_ns`. `code`/`error` are still
/// read from the query string OpenRouter itself appends.
///
/// `Some(payload)` only when the path's nonce segment, once decoded,
/// equals `expected_ns` AND the query string carries at least one of
/// `code`/`error` — anything else (wrong/missing/malformed nonce
/// segment, no `code`/`error` at all, a malformed or empty line) is
/// `None`, which callers must treat as "not a match, keep listening" —
/// never as an error in its own right.
fn parse_callback(request_line: &str, expected_ns: &str) -> Option<OauthCallbackPayload> {
    let target = request_line.split_whitespace().nth(1)?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));

    let raw_ns = path.strip_prefix(CALLBACK_PATH_PREFIX)?;
    if raw_ns.is_empty() || raw_ns.contains('/') {
        return None;
    }
    let ns = percent_encoding::percent_decode_str(raw_ns).decode_utf8_lossy();
    if ns != expected_ns {
        return None;
    }

    let mut code: Option<String> = None;
    let mut error: Option<String> = None;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            _ => {}
        }
    }

    if code.is_none() && error.is_none() {
        return None;
    }
    Some(OauthCallbackPayload { code, error })
}

/// S10 field-fix (LOW, adversarial review): hard cap on the request
/// line — this is a loopback-only, single-shot receiver, but a client
/// (or a stray port-scanner) that never sends a newline would
/// otherwise let `BufRead::read_line` grow its buffer unbounded. 8 KiB
/// comfortably covers the longest real callback (`ns` + a full-length
/// OAuth `code`) with room to spare.
const MAX_REQUEST_LINE_BYTES: u64 = 8192;

/// Reads at most one request line off `reader`, capped at
/// `MAX_REQUEST_LINE_BYTES` (including the trailing `\n`) — generic
/// over `BufRead` so this is directly unit-testable against a
/// `Cursor<&[u8]>` below, no real socket required (mirrors
/// `parse_callback`'s own "pure seam, unit-tested directly" posture).
/// `None` for anything that isn't a COMPLETE line within the cap:
/// overlong (capped mid-line, no `\n` found yet) and incomplete (the
/// reader hit EOF/closed before a `\n` arrived) are rejected
/// identically — never partially trusted as a request line.
fn read_capped_line<R: BufRead>(reader: R) -> Option<String> {
    let mut line = String::new();
    match reader.take(MAX_REQUEST_LINE_BYTES).read_line(&mut line) {
        Ok(_) if line.ends_with('\n') => Some(line),
        _ => None,
    }
}

/// Pure HTTP/1.1 response builder — `status` is only ever 200 (a match)
/// or 204 (everything else) from this file's own callers, so the reason
/// phrase lookup below is deliberately not a general-purpose table.
/// `Content-Length` is measured in BYTES via `str::len()` (already a
/// byte count, never a char count — NOT `chars().count()`), load-bearing
/// for `SUCCESS_BODY`'s own zh text. `Connection: close` — this is a
/// one-shot receiver, never a persistent server (see module header
/// comment); the caller closes the socket right after writing this out
/// regardless, but the header keeps the client from expecting otherwise.
fn build_http_response(status: u16, body: &str) -> String {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        _ => "",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

// ---- the listener thread ----

/// Reads exactly one request line off `stream`, decides match/no-match
/// via `parse_callback`, and writes the corresponding fixed response.
/// Returns the callback payload on a match (caller emits + shuts the
/// listener down), `None` otherwise (caller keeps accepting).
fn handle_connection(mut stream: TcpStream, expected_ns: &str) -> Option<OauthCallbackPayload> {
    // Accepted sockets inherit the LISTENING socket's non-blocking flag
    // on some platforms — force blocking-with-timeout explicitly rather
    // than depend on that, so set_read_timeout below actually blocks-
    // then-times-out instead of surfacing a spurious WouldBlock on the
    // very first read.
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(CONNECTION_READ_TIMEOUT));

    // A cloned handle for reading only — keeps `stream` itself free for
    // the response write below without fighting BufReader's own
    // ownership of its inner reader. read_capped_line's own cap
    // rejects an overlong/incomplete line outright (see its own doc
    // comment) rather than letting a missing/never-arriving newline
    // grow the buffer unbounded.
    let request_line = match stream.try_clone() {
        Ok(read_half) => read_capped_line(BufReader::new(read_half)).unwrap_or_default(),
        Err(_) => String::new(),
    };

    match parse_callback(&request_line, expected_ns) {
        Some(payload) => {
            let _ = stream.write_all(build_http_response(200, SUCCESS_BODY).as_bytes());
            let _ = stream.flush();
            Some(payload)
        }
        None => {
            let _ = stream.write_all(build_http_response(204, "").as_bytes());
            let _ = stream.flush();
            None
        }
    }
}

fn emit_result(app: &tauri::AppHandle, generation: u64, payload: OauthCallbackPayload) {
    if !app.state::<OauthState>().is_current(generation) {
        return; // superseded between accept() and here — a newer/cancelled flow owns the UI now
    }
    let _ = app.emit(EVENT_NAME, payload);
}

/// Owns one listener's entire lifetime: non-blocking accept loop, one
/// `handle_connection` per accepted socket, until either a match is
/// found (emit + return, dropping `listener` and freeing the port),
/// `OVERALL_DEADLINE` elapses (emit `{error:"timeout"}` + return), or
/// `generation` is superseded (a newer `oauth_loopback_start` or an
/// `oauth_loopback_cancel` — return silently, no emit: whichever call
/// superseded this one owns telling JS what happened next, not a dying
/// listener that's no longer the authoritative one).
fn run_listener(app: tauri::AppHandle, listener: TcpListener, expected_ns: String, generation: u64) {
    let deadline = Instant::now() + OVERALL_DEADLINE;
    loop {
        if !app.state::<OauthState>().is_current(generation) {
            return;
        }
        if Instant::now() >= deadline {
            emit_result(&app, generation, OauthCallbackPayload::error("timeout"));
            return;
        }
        match listener.accept() {
            Ok((stream, _addr)) => {
                if let Some(payload) = handle_connection(stream, &expected_ns) {
                    emit_result(&app, generation, payload);
                    return; // shuts down the listener: `listener` drops when this fn returns
                }
                // Non-matching request (favicon, wrong/missing ns, ...)
                // already got its 204 inside handle_connection — keep
                // waiting for the real callback.
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(ACCEPT_POLL_INTERVAL);
            }
            Err(_) => {
                // Unexpected accept() error (e.g. transient resource
                // exhaustion) — back off the same as WouldBlock rather
                // than tearing the whole 300s window down over one
                // blip; the generation/deadline checks above still
                // bound how long this can spin.
                thread::sleep(ACCEPT_POLL_INTERVAL);
            }
        }
    }
}

// ---- command surface ----

/// PINNED CONTRACT (blueprint item 2 + Q1 verdict): binds an ephemeral
/// `127.0.0.1` port, returns it, and spawns a background thread that
/// waits for OpenRouter's browser redirect back to
/// `http://127.0.0.1:{port}/oauth/openrouter/{ns}` (F13: ns is a PATH
/// segment now, not a `?ns=` query param — see parse_callback's own
/// doc comment) (or a `localhost` host — see this module's own header
/// comment; either way the LISTENER always binds `127.0.0.1`).
/// Single-flight: calling this
/// again — or `oauth_loopback_cancel` — invalidates whatever listener
/// is already running; it notices on its own next poll tick (within
/// `ACCEPT_POLL_INTERVAL`) and exits without emitting anything.
#[tauri::command]
pub fn oauth_loopback_start(app: tauri::AppHandle, state: tauri::State<'_, OauthState>, ns: String) -> Result<u16, String> {
    let generation = state.advance();
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("failed to bind the local oauth callback listener: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("failed to configure the local oauth callback listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("failed to read the local oauth callback listener's own port: {e}"))?
        .port();
    thread::spawn(move || run_listener(app, listener, ns, generation));
    Ok(port)
}

/// PINNED CONTRACT: `connectOpenRouterDesktop`'s own settle path
/// (openrouterDesktop.ts) calls this exactly once regardless of
/// outcome — belt-and-suspenders against a listener that already
/// stopped on its own (success/timeout both already invalidate
/// themselves by returning), and the real stop signal for a JS-side
/// abandonment (its own ~180s timeout firing, or the user navigating
/// away) that would otherwise leave Rust listening for up to the full
/// `OVERALL_DEADLINE`. Idempotent — a no-op ("nothing was running")
/// reads identically to "stopped one" from the caller's own POV either
/// way, so this never needs to report which case it was.
#[tauri::command]
pub fn oauth_loopback_cancel(state: tauri::State<'_, OauthState>) -> Result<(), String> {
    state.advance();
    Ok(())
}

// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    // ---- parse_callback (F13: the nonce moved from a `?ns=` query
    // param to a /oauth/openrouter/{ns} PATH segment — see this
    // function's own doc comment) ----

    #[test]
    fn matches_a_code_callback_with_the_correct_nonce() {
        let result = parse_callback("GET /oauth/openrouter/abc123?code=auth-code-1 HTTP/1.1\r\n", "abc123");
        assert_eq!(
            result,
            Some(OauthCallbackPayload {
                code: Some("auth-code-1".to_string()),
                error: None,
            })
        );
    }

    #[test]
    fn matches_an_error_callback_with_the_correct_nonce() {
        let result = parse_callback("GET /oauth/openrouter/abc123?error=access_denied HTTP/1.1\r\n", "abc123");
        assert_eq!(
            result,
            Some(OauthCallbackPayload {
                code: None,
                error: Some("access_denied".to_string()),
            })
        );
    }

    #[test]
    fn nonce_mismatch_is_not_a_match() {
        let result = parse_callback("GET /oauth/openrouter/WRONG?code=auth-code-1 HTTP/1.1\r\n", "abc123");
        assert_eq!(result, None);
    }

    #[test]
    fn missing_nonce_segment_entirely_is_not_a_match() {
        // The bare prefix path, no /{ns} segment appended at all.
        let result = parse_callback("GET /oauth/openrouter?code=auth-code-1 HTTP/1.1\r\n", "abc123");
        assert_eq!(result, None);
    }

    #[test]
    fn empty_nonce_segment_after_the_trailing_slash_is_not_a_match() {
        let result = parse_callback("GET /oauth/openrouter/?code=auth-code-1 HTTP/1.1\r\n", "abc123");
        assert_eq!(result, None);
    }

    #[test]
    fn a_trailing_slash_after_an_otherwise_correct_nonce_is_not_a_match() {
        // The nonce must be the LAST path segment — an extra trailing
        // slash is rejected outright rather than tolerated (ns's own
        // RFC 7636 charset — generateCodeVerifier, openrouterPkce.ts —
        // never contains a `/`, so this can never be a genuine
        // callback either way).
        let result = parse_callback("GET /oauth/openrouter/abc123/?code=auth-code-1 HTTP/1.1\r\n", "abc123");
        assert_eq!(result, None);
    }

    #[test]
    fn correct_nonce_but_neither_code_nor_error_is_not_a_match() {
        // e.g. a bare favicon request that happens to echo the ns back.
        let result = parse_callback("GET /oauth/openrouter/abc123 HTTP/1.1\r\n", "abc123");
        assert_eq!(result, None);
    }

    #[test]
    fn url_encoded_query_values_are_percent_decoded() {
        let result = parse_callback(
            "GET /oauth/openrouter/abc123?error=access%20denied%20%28user%29 HTTP/1.1\r\n",
            "abc123",
        );
        assert_eq!(
            result,
            Some(OauthCallbackPayload {
                code: None,
                error: Some("access denied (user)".to_string()),
            })
        );
    }

    #[test]
    fn url_encoded_nonce_path_segment_is_decoded_before_comparison() {
        // The nonce itself arrives percent-encoded on the wire (path
        // segments are percent-encoded like query values, just WITHOUT
        // query-string `+`-means-space substitution — percent_encoding::
        // percent_decode_str, not url::form_urlencoded); the comparison
        // must be against the DECODED value.
        let result = parse_callback("GET /oauth/openrouter/abc%2B123?code=x HTTP/1.1\r\n", "abc+123");
        assert!(result.is_some());
    }

    #[test]
    fn unknown_extra_query_params_are_ignored() {
        let result = parse_callback(
            "GET /oauth/openrouter/abc123?code=auth-code-1&state=unused&foo=bar HTTP/1.1\r\n",
            "abc123",
        );
        assert_eq!(result.map(|p| p.code), Some(Some("auth-code-1".to_string())));
    }

    #[test]
    fn empty_request_line_is_garbage_not_a_match() {
        assert_eq!(parse_callback("", "abc123"), None);
    }

    #[test]
    fn request_line_with_no_target_is_garbage_not_a_match() {
        assert_eq!(parse_callback("GET\r\n", "abc123"), None);
    }

    #[test]
    fn completely_unstructured_garbage_is_not_a_match() {
        assert_eq!(parse_callback("not even an http request\r\n", "abc123"), None);
    }

    #[test]
    fn a_request_for_an_unrelated_path_is_not_a_match() {
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1\r\n", "abc123"), None);
    }

    // ---- build_http_response ----

    #[test]
    fn success_response_carries_the_exact_zh_body_and_byte_length_content_length() {
        let response = build_http_response(200, SUCCESS_BODY);
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.ends_with(SUCCESS_BODY));
        // The zh body is multi-byte per char — Content-Length must count
        // BYTES, not chars, or a client honoring it would truncate.
        // str::len() already IS the byte count (never chars) — asserted
        // against chars().count() here to make that gap concrete.
        let expected_len = SUCCESS_BODY.len();
        assert!(expected_len > SUCCESS_BODY.chars().count());
        assert!(response.contains(&format!("Content-Length: {expected_len}\r\n")));
    }

    #[test]
    fn no_content_response_has_zero_length_and_no_body() {
        let response = build_http_response(204, "");
        assert!(response.starts_with("HTTP/1.1 204 No Content\r\n"));
        assert!(response.contains("Content-Length: 0\r\n"));
        assert!(response.ends_with("\r\n\r\n"));
    }

    // ---- read_capped_line (S10 field-fix, LOW: bounded request-line read) ----

    #[test]
    fn a_short_well_formed_line_is_read_intact() {
        let input = "GET /oauth/openrouter/abc123?code=x HTTP/1.1\r\n";
        let result = read_capped_line(std::io::Cursor::new(input.as_bytes()));
        assert_eq!(result.as_deref(), Some(input));
    }

    #[test]
    fn a_line_exactly_at_the_cap_including_its_newline_is_still_accepted() {
        // MAX_REQUEST_LINE_BYTES total, the final byte being the `\n` —
        // entirely within the cap, must not be rejected as overlong.
        let mut input = vec![b'a'; MAX_REQUEST_LINE_BYTES as usize - 1];
        input.push(b'\n');
        assert_eq!(input.len(), MAX_REQUEST_LINE_BYTES as usize);
        let result = read_capped_line(std::io::Cursor::new(input.as_slice()));
        assert!(result.is_some());
        assert_eq!(result.unwrap().len(), MAX_REQUEST_LINE_BYTES as usize);
    }

    #[test]
    fn an_overlong_line_with_no_newline_within_the_cap_is_rejected() {
        // No `\n` anywhere — a client that never terminates its line
        // (or a port-scanner) must not grow the buffer unbounded.
        let input = vec![b'a'; MAX_REQUEST_LINE_BYTES as usize * 2];
        let result = read_capped_line(std::io::Cursor::new(input.as_slice()));
        assert_eq!(result, None);
    }

    #[test]
    fn a_newline_that_arrives_just_past_the_cap_is_still_rejected_as_overlong() {
        // The `\n` exists, but one byte beyond what the cap allows
        // reading — `take` never lets read_line see it.
        let mut input = vec![b'a'; MAX_REQUEST_LINE_BYTES as usize];
        input.push(b'\n');
        let result = read_capped_line(std::io::Cursor::new(input.as_slice()));
        assert_eq!(result, None);
    }

    #[test]
    fn an_incomplete_line_that_ends_without_ever_reaching_a_newline_is_rejected() {
        // Well under the cap, but the "connection" (Cursor) simply ends
        // (EOF) before a `\n` ever arrives — same rejection as overlong,
        // never partially trusted.
        let input = b"GET /oauth/openrouter/abc123?code=x";
        let result = read_capped_line(std::io::Cursor::new(input.as_slice()));
        assert_eq!(result, None);
    }

    #[test]
    fn an_empty_input_is_rejected_not_an_empty_match() {
        let result = read_capped_line(std::io::Cursor::new(b"".as_slice()));
        assert_eq!(result, None);
    }

    #[test]
    fn only_the_first_line_is_ever_read_a_second_line_in_the_buffer_is_left_untouched() {
        let input = "GET /oauth/openrouter/abc123?code=x HTTP/1.1\r\nHost: 127.0.0.1\r\n";
        let result = read_capped_line(std::io::Cursor::new(input.as_bytes()));
        assert_eq!(result.as_deref(), Some("GET /oauth/openrouter/abc123?code=x HTTP/1.1\r\n"));
    }

    // ---- OauthState single-flight generation guard ----

    #[test]
    fn first_advance_is_current() {
        let state = OauthState::default();
        let generation = state.advance();
        assert!(state.is_current(generation));
    }

    #[test]
    fn a_later_advance_invalidates_the_earlier_generation() {
        let state = OauthState::default();
        let first = state.advance();
        let second = state.advance();
        assert!(!state.is_current(first), "a superseded generation must never read as current again");
        assert!(state.is_current(second));
    }

    #[test]
    fn cancel_style_advance_invalidates_the_current_generation_with_no_new_owner() {
        let state = OauthState::default();
        let first = state.advance();
        assert!(state.is_current(first));
        state.advance(); // mirrors oauth_loopback_cancel: bump with no listener claiming it
        assert!(!state.is_current(first));
    }
}
