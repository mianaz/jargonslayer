// W2 field-context fix — observability for whatever proxy the app's own
// network layer (tauri-plugin-http's reqwest client) will actually see.
// tauri-plugin-http 2.5.9 already enables reqwest's macos-system-
// configuration feature (Cargo.toml's default features), so the SYSTEM
// proxy (macOS Network preferences) already works today with zero code
// here — this command exists purely so a user/support conversation can
// SEE what that auto-detection saw. The field report this answers: a
// user's OpenRouter key works fine in Terminal (their shell exports
// http_proxy/https_proxy) but a Finder-launched build fails with no-
// status network errors — Finder-launched apps inherit NONE of a
// shell's own env vars, so "but it works in Terminal!" is exactly the
// confusion this command is meant to surface a trail for. Two
// independent sources, both reported: (1) macOS's own System Settings
// proxy config (`scutil --proxy`), which reqwest already honors
// automatically; (2) http_proxy/https_proxy/all_proxy/no_proxy env
// vars, which the packaged app itself never inherits when Finder-
// launched but are still worth reporting (a user who insists their
// proxy IS configured, when it has only ever been a shell export, is
// the exact case this makes legible).
use std::collections::HashMap;
use std::env;

use url::Url;

/// Pure parse of `scutil --proxy`'s own key-value dictionary text —
/// split out from the real command so canned output (proxies on/off/
/// PAC/weird-missing-keys) is unit-testable with zero process spawn.
/// Host/port stay plain strings (never parsed as numbers): both are
/// only ever concatenated for display below, so there is no arithmetic
/// that would need a numeric type, and no parse-failure mode to handle
/// for a garbled port.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScutilProxy {
    pub http_enabled: bool,
    pub http_host: Option<String>,
    pub http_port: Option<String>,
    pub https_enabled: bool,
    pub https_host: Option<String>,
    pub https_port: Option<String>,
    pub socks_enabled: bool,
    pub socks_host: Option<String>,
    pub socks_port: Option<String>,
    pub pac_enabled: bool,
    pub pac_url: Option<String>,
}

/// `scutil --proxy` prints one top-level `<dictionary> { key : value
/// ... }`, with exactly one nested `<array> { ... }` inside it
/// (`ExceptionsList`, a list of bypass host patterns — see this
/// module's own test canned output). `depth` tracks bracket nesting so
/// a stray `0 : *.local` entry inside that array is never mistaken for
/// a top-level key, without hardcoding "skip ExceptionsList by name"
/// (robust to whatever else scutil nests the same way). Every key this
/// module actually cares about lives at depth 1 (directly inside the
/// outer dictionary); unrecognized/weird keys at depth 1 are collected
/// into the map too but simply never read below — an unknown key can
/// never panic this parser, only be silently ignored.
fn parse_scutil_dict(output: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut depth: i32 = 0;
    for raw_line in output.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if line.ends_with('{') {
            depth += 1;
            continue;
        }
        if line == "}" {
            depth -= 1;
            continue;
        }
        if depth != 1 {
            continue;
        }
        if let Some((key, value)) = line.split_once(" : ") {
            map.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    map
}

pub fn parse_scutil_proxy(output: &str) -> ScutilProxy {
    let map = parse_scutil_dict(output);
    let is_on = |key: &str| map.get(key).map(|v| v == "1").unwrap_or(false);
    let get = |key: &str| map.get(key).filter(|v| !v.is_empty()).cloned();

    ScutilProxy {
        http_enabled: is_on("HTTPEnable"),
        http_host: get("HTTPProxy"),
        http_port: get("HTTPPort"),
        https_enabled: is_on("HTTPSEnable"),
        https_host: get("HTTPSProxy"),
        https_port: get("HTTPSPort"),
        socks_enabled: is_on("SOCKSEnable"),
        socks_host: get("SOCKSProxy"),
        socks_port: get("SOCKSPort"),
        pac_enabled: is_on("ProxyAutoConfigEnable"),
        pac_url: get("ProxyAutoConfigURLString"),
    }
}

/// SECURITY: a raw value that might carry `user:pass@` userinfo (env
/// proxy vars commonly do — `http://user:pass@proxy:8080`) is never
/// echoed verbatim into the summary. Parses as a URL and renders
/// `scheme://host[:port]` only, dropping userinfo entirely; anything
/// that doesn't parse as an absolute URL (a bare host list like
/// `no_proxy` usually is, garbage, ...) falls back to the honest-but-
/// silent "已设置" rather than guessing at a shape to strip credentials
/// from.
fn mask_proxy_value(raw: &str) -> String {
    let Ok(url) = Url::parse(raw) else {
        return "已设置".to_string();
    };
    let Some(host) = url.host_str() else {
        return "已设置".to_string();
    };
    match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    }
}

/// scutil's own HTTPProxy/HTTPSProxy/SOCKSProxy values are documented
/// to be a bare hostname/IP (no userinfo, no scheme — never a full URL
/// the way an env var's value is), so this never actually strips
/// anything in practice. Kept anyway per this module's own "mask
/// userinfo before including any value" rule applied uniformly: a
/// malformed network profile that somehow smuggled a `user:pass@`
/// prefix into this field must not leak it into the summary just
/// because scutil itself doesn't produce that shape today.
fn sanitize_scutil_host(host: &str) -> String {
    match host.rsplit_once('@') {
        Some((_, after)) => after.to_string(),
        None => host.to_string(),
    }
}

/// Renders one HTTP/HTTPS/SOCKS line: "未启用" when off (regardless of
/// whatever stale host/port a previously-configured-then-disabled
/// proxy left behind in scutil's own dictionary — those are never
/// shown), else `host[:port]`, or an explicit "地址缺失" placeholder
/// for the (weird, scutil-shouldn't-do-this) case of enabled:1 with no
/// host at all — never panics, never silently renders an empty string.
fn describe_endpoint(enabled: bool, host: Option<&str>, port: Option<&str>) -> String {
    if !enabled {
        return "未启用".to_string();
    }
    let Some(host) = host else {
        return "已启用（地址缺失）".to_string();
    };
    let host = sanitize_scutil_host(host);
    match port {
        Some(port) if !port.is_empty() => format!("{host}:{port}"),
        _ => host,
    }
}

/// The four conventional proxy env vars, both-case — some tools only
/// ever check lowercase, some only uppercase (curl famously treats
/// `http_proxy` specially vs `HTTP_PROXY` for CGI-injection reasons),
/// so both are checked and reported independently rather than treating
/// one as authoritative over the other.
const ENV_PROXY_VARS: [&str; 8] = [
    "http_proxy",
    "HTTP_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
    "all_proxy",
    "ALL_PROXY",
    "no_proxy",
    "NO_PROXY",
];

/// `get` is injected (rather than this function calling `std::env::var`
/// directly) purely so it's unit-testable with a deterministic fake —
/// mirrors secret.rs's own promote_devfile_value_on_keychain_miss
/// closure-injection precedent for the identical reason: reading real
/// process env vars from parallel `cargo test` threads would be racy
/// (env is process-global mutable state), so the real env::var call is
/// pushed out to the one call site in os_proxy_summary() below and
/// never exercised by a test directly. A present-but-empty value reads
/// as unset, matching how curl/every other proxy-aware tool treats
/// `http_proxy=""`.
fn describe_env_vars(get: impl Fn(&str) -> Option<String>) -> String {
    let parts: Vec<String> = ENV_PROXY_VARS
        .iter()
        .filter_map(|name| {
            let value = get(name)?;
            if value.is_empty() {
                return None;
            }
            Some(format!("{name}={}", mask_proxy_value(&value)))
        })
        .collect();
    if parts.is_empty() {
        "无".to_string()
    } else {
        parts.join(", ")
    }
}

/// Assembles the ONE human-readable Chinese summary line from an
/// already-parsed `ScutilProxy` + an already-rendered env-var segment —
/// pure, so every scenario (proxies on/off/PAC/weird) is assertable end
/// to end without a real scutil spawn.
fn render_summary(scutil: &ScutilProxy, env_vars_desc: &str) -> String {
    let http = describe_endpoint(scutil.http_enabled, scutil.http_host.as_deref(), scutil.http_port.as_deref());
    let https = describe_endpoint(scutil.https_enabled, scutil.https_host.as_deref(), scutil.https_port.as_deref());
    let socks = describe_endpoint(scutil.socks_enabled, scutil.socks_host.as_deref(), scutil.socks_port.as_deref());
    let pac = if scutil.pac_enabled { "已启用" } else { "未启用" };

    let mut summary = format!(
        "系统代理: HTTP={http} · HTTPS={https} · SOCKS={socks} · PAC={pac} · 环境变量: {env_vars_desc}"
    );
    if scutil.pac_enabled {
        // PAC scripts are arbitrary JS the OS itself evaluates per-
        // request (WPAD/manual .pac URL) — tauri-plugin-http's reqwest
        // client has no PAC engine of its own and can't execute one, so
        // a PAC-only network is a real "the app can't see what you see"
        // gap manual Settings.proxyUrl (W2 Task 4) is the escape hatch
        // for. Appended rather than folded into the PAC= field itself
        // so the field stays a plain on/off status, matching HTTP/
        // HTTPS/SOCKS above.
        summary.push_str(
            "（检测到 PAC 自动代理：应用无法执行 PAC 脚本，如遇网络问题请在设置中配置手动代理）",
        );
    }
    summary
}

#[tauri::command]
pub fn os_proxy_summary() -> String {
    os_proxy_summary_impl()
}

#[cfg(target_os = "macos")]
fn os_proxy_summary_impl() -> String {
    let env_vars_desc = describe_env_vars(|name| env::var(name).ok());
    match run_scutil_proxy() {
        Some(scutil) => render_summary(&scutil, &env_vars_desc),
        // A spawn failure or nonzero exit means "couldn't check", never
        // silently rendered as "everything's off" — this command's
        // whole point is a trustworthy diagnostic trail, and claiming
        // no proxy is configured when the truth is merely unknown would
        // actively mislead a field-support conversation.
        None => format!("系统代理: 读取失败（scutil 不可用）· 环境变量: {env_vars_desc}"),
    }
}

#[cfg(target_os = "macos")]
fn run_scutil_proxy() -> Option<ScutilProxy> {
    let output = std::process::Command::new("scutil").arg("--proxy").output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(parse_scutil_proxy(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(not(target_os = "macos"))]
fn os_proxy_summary_impl() -> String {
    "不适用（非 macOS）".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- canned scutil output, verified against a real `scutil
    // --proxy` run on this machine for the "all off" shape (proxies
    // simply omit their *Enable/*Proxy/*Port keys entirely rather than
    // emitting an explicit 0/empty value) ----

    const ALL_OFF: &str = "\
<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
}
";

    const PROXIES_ON: &str = "\
<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : 127.0.0.1
}
";

    const PAC_ON: &str = "\
<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
  }
  FTPPassive : 1
  HTTPEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://intranet.example.com/proxy.pac
}
";

    // Weird/missing keys: HTTPEnable:1 with NO HTTPProxy at all (scutil
    // shouldn't produce this, but the parser must survive it), plus an
    // entirely unrecognized key that must be silently ignored rather
    // than panicking.
    const WEIRD_MISSING: &str = "\
<dictionary> {
  HTTPEnable : 1
  SomeFutureKeyThisParserHasNeverSeen : surprise
  SOCKSEnable : 1
  SOCKSProxy : 127.0.0.1
}
";

    #[test]
    fn parse_scutil_proxy_all_off_reports_every_endpoint_disabled() {
        let parsed = parse_scutil_proxy(ALL_OFF);
        assert_eq!(parsed, ScutilProxy::default());
    }

    #[test]
    fn parse_scutil_proxy_reads_host_and_port_for_every_enabled_endpoint() {
        let parsed = parse_scutil_proxy(PROXIES_ON);
        assert_eq!(
            parsed,
            ScutilProxy {
                http_enabled: true,
                http_host: Some("127.0.0.1".to_string()),
                http_port: Some("7890".to_string()),
                https_enabled: true,
                https_host: Some("127.0.0.1".to_string()),
                https_port: Some("7890".to_string()),
                socks_enabled: true,
                socks_host: Some("127.0.0.1".to_string()),
                socks_port: Some("7891".to_string()),
                pac_enabled: false,
                pac_url: None,
            }
        );
    }

    #[test]
    fn parse_scutil_proxy_reads_pac_url_and_leaves_manual_proxies_off() {
        let parsed = parse_scutil_proxy(PAC_ON);
        assert!(parsed.pac_enabled);
        assert_eq!(parsed.pac_url.as_deref(), Some("http://intranet.example.com/proxy.pac"));
        assert!(!parsed.http_enabled);
    }

    #[test]
    fn parse_scutil_proxy_never_mistakes_a_nested_array_entry_for_a_top_level_key() {
        // "0 : *.local" / "1 : 169.254/16" live inside ExceptionsList's
        // nested <array> { ... } — must never surface as stray keys "0"/"1".
        let map = parse_scutil_dict(PROXIES_ON);
        assert!(!map.contains_key("0"));
        assert!(!map.contains_key("1"));
    }

    #[test]
    fn parse_scutil_proxy_survives_an_enabled_flag_with_no_host_and_an_unknown_key() {
        let parsed = parse_scutil_proxy(WEIRD_MISSING);
        assert!(parsed.http_enabled);
        assert_eq!(parsed.http_host, None);
        assert_eq!(parsed.socks_host.as_deref(), Some("127.0.0.1"));
    }

    #[test]
    fn parse_scutil_proxy_on_empty_input_is_the_all_off_default() {
        assert_eq!(parse_scutil_proxy(""), ScutilProxy::default());
    }

    // ---- describe_endpoint ----

    #[test]
    fn describe_endpoint_disabled_ignores_any_leftover_host_or_port() {
        // A previously-configured-then-disabled proxy: scutil can leave
        // HTTPProxy/HTTPPort sitting in the dictionary even with
        // HTTPEnable:0 — must never be shown.
        assert_eq!(describe_endpoint(false, Some("127.0.0.1"), Some("7890")), "未启用");
    }

    #[test]
    fn describe_endpoint_enabled_renders_host_colon_port() {
        assert_eq!(describe_endpoint(true, Some("127.0.0.1"), Some("7890")), "127.0.0.1:7890");
    }

    #[test]
    fn describe_endpoint_enabled_with_no_port_renders_host_only() {
        assert_eq!(describe_endpoint(true, Some("127.0.0.1"), None), "127.0.0.1");
    }

    #[test]
    fn describe_endpoint_enabled_with_no_host_is_an_explicit_placeholder_not_a_panic() {
        assert_eq!(describe_endpoint(true, None, Some("7890")), "已启用（地址缺失）");
    }

    // ---- mask_proxy_value (SECURITY) ----

    #[test]
    fn mask_proxy_value_strips_userinfo_and_keeps_scheme_host_port() {
        assert_eq!(mask_proxy_value("http://user:secret@127.0.0.1:7890"), "http://127.0.0.1:7890");
    }

    #[test]
    fn mask_proxy_value_never_leaks_the_username_or_password_substrings() {
        let masked = mask_proxy_value("socks5://sensitiveuser:sensitivepass@proxy.example.com:1080");
        assert!(!masked.contains("sensitiveuser"));
        assert!(!masked.contains("sensitivepass"));
        assert_eq!(masked, "socks5://proxy.example.com:1080");
    }

    #[test]
    fn mask_proxy_value_falls_back_to_a_generic_marker_for_an_unparseable_value() {
        // A bare host list like no_proxy's own typical value never
        // parses as an absolute URL — honest "已设置", not a guess.
        assert_eq!(mask_proxy_value("localhost,127.0.0.1,.internal"), "已设置");
    }

    #[test]
    fn sanitize_scutil_host_strips_a_userinfo_prefix_if_one_somehow_appears() {
        assert_eq!(sanitize_scutil_host("user:pass@127.0.0.1"), "127.0.0.1");
        assert_eq!(sanitize_scutil_host("127.0.0.1"), "127.0.0.1");
    }

    // ---- describe_env_vars ----

    #[test]
    fn describe_env_vars_reports_no_when_nothing_is_set() {
        assert_eq!(describe_env_vars(|_| None), "无");
    }

    #[test]
    fn describe_env_vars_treats_a_present_but_empty_value_as_unset() {
        assert_eq!(describe_env_vars(|_| Some(String::new())), "无");
    }

    #[test]
    fn describe_env_vars_reports_both_case_variants_independently() {
        let desc = describe_env_vars(|name| match name {
            "http_proxy" => Some("http://127.0.0.1:7890".to_string()),
            "HTTP_PROXY" => Some("http://127.0.0.1:9999".to_string()),
            _ => None,
        });
        assert!(desc.contains("http_proxy=http://127.0.0.1:7890"));
        assert!(desc.contains("HTTP_PROXY=http://127.0.0.1:9999"));
    }

    #[test]
    fn describe_env_vars_masks_userinfo_before_it_ever_reaches_the_summary() {
        let desc = describe_env_vars(|name| {
            (name == "https_proxy").then(|| "http://alice:hunter2@proxy.corp.internal:8080".to_string())
        });
        assert!(!desc.contains("alice"));
        assert!(!desc.contains("hunter2"));
        assert_eq!(desc, "https_proxy=http://proxy.corp.internal:8080");
    }

    // ---- render_summary (end to end, pure) ----

    #[test]
    fn render_summary_all_off_matches_the_pinned_shape() {
        let summary = render_summary(&ScutilProxy::default(), "无");
        assert_eq!(
            summary,
            "系统代理: HTTP=未启用 · HTTPS=未启用 · SOCKS=未启用 · PAC=未启用 · 环境变量: 无"
        );
    }

    #[test]
    fn render_summary_proxies_on_matches_the_pinned_shape() {
        let scutil = parse_scutil_proxy(PROXIES_ON);
        let summary = render_summary(&scutil, "无");
        assert_eq!(
            summary,
            "系统代理: HTTP=127.0.0.1:7890 · HTTPS=127.0.0.1:7890 · SOCKS=127.0.0.1:7891 · PAC=未启用 · 环境变量: 无"
        );
    }

    #[test]
    fn render_summary_pac_on_appends_the_manual_proxy_hint() {
        let scutil = parse_scutil_proxy(PAC_ON);
        let summary = render_summary(&scutil, "无");
        assert!(summary.contains("PAC=已启用"));
        assert!(summary.contains("应用无法执行 PAC 脚本"));
        assert!(summary.contains("请在设置中配置手动代理"));
    }

    #[test]
    fn render_summary_pac_off_never_appends_the_manual_proxy_hint() {
        let summary = render_summary(&ScutilProxy::default(), "无");
        assert!(!summary.contains("PAC 脚本"));
    }

    // ---- live dispatch — sanity only, mirrors diskspace.rs's own
    // free_bytes_at "live syscall" test posture: no portable way to pin
    // an exact string (a dev machine's own real proxy state is
    // unknown), so this only asserts the platform-appropriate shape. ----

    #[test]
    fn os_proxy_summary_returns_the_platform_appropriate_shape() {
        let summary = os_proxy_summary();
        if cfg!(target_os = "macos") {
            assert!(summary.starts_with("系统代理"), "got: {summary}");
        } else {
            assert_eq!(summary, "不适用（非 macOS）");
        }
    }
}
