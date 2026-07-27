// S13 (docs/design-explorations/s13-ios-blueprint.md, §2 pinned wire
// contract, Lane B) — the shapes crossing the Rust<->Swift
// `run_mobile_plugin` boundary. Defined ONCE here (not duplicated in the
// app crate's osspeech_ios.rs) and re-exported via lib.rs's `pub use
// models::*`, mirroring the tauri-apps geolocation plugin's own
// models.rs convention this crate was scaffolded from.
//
// Field-exact against macOS's own osspeech.rs (that file's own
// `OsSpeechCapabilities`/`start_os_speech` signature) and the TS types
// (apps/web/src/lib/desktop/osspeechCaps.ts / stt/osSpeech.ts) — see the
// blueprint's §6 F1 amendment: `reason` is required-nullable (no
// `skip_serializing_if`, so `None` still serializes as an explicit
// `null`) and `contextual_json` is always-present-nullable
// (`Option<String>`, never `#[serde(default)]`-omittable on the JS side
// — JS always sends the key, `contextualJson: string | null`).
use serde::{Deserialize, Serialize};

/// `run_mobile_plugin("startTranscribe", StartArgs { .. })` — Swift's
/// `StartArgs: Decodable` (OsSpeechPlugin.swift) decodes the SAME
/// camelCase keys.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    pub locale: String,
    pub contextual_json: Option<String>,
}

/// `run_mobile_plugin("preinstall", PreinstallArgs { .. })`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreinstallArgs {
    pub locale: String,
}

/// Round-trips BOTH directions: `os_speech_capabilities` (the app
/// command, osspeech_ios.rs) returns this to JS (needs `Serialize`), and
/// `run_mobile_plugin::<OsSpeechCapabilities>("capabilities", ())`
/// deserializes Swift's JSON response into it (needs `Deserialize`).
/// `reason`/`Option<String>` with NO `skip_serializing_if` is exactly
/// what makes a `None` serialize as `"reason":null` rather than omit the
/// key — required by the pinned contract (§6 F1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsSpeechCapabilities {
    pub supported: bool,
    pub reason: Option<String>,
    pub locales: Vec<String>,
    pub installed_locales: Vec<String>,
}

// ---- v0.6 iOS translate lane (systranslate_ios.rs's own header comment
// covers the design; these shapes are the Rust<->Swift wire contract for
// it, field-exact against macOS's own desktop child, systranslate.rs) ----

/// `run_mobile_plugin("sysTranslateProbe"/"sysTranslatePrepare", ...)` —
/// both take just the language pair, so share one args shape (unlike
/// osspeech's per-command arg types above, which never overlap).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SysTranslateArgs {
    pub source: String,
    pub target: String,
}

/// `run_mobile_plugin("sysTranslate", ...)` — a batch item both inbound
/// (text to translate) and outbound (translated text), same shape either
/// direction, matching desktop's own `systranslate::TranslateItem`
/// field-for-field (`id`/`text`, no camelCase rename needed — both
/// already single words).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranslateItem {
    pub id: String,
    pub text: String,
}

/// `run_mobile_plugin("sysTranslateProbe", ...)`'s reply shape — field-
/// exact against desktop's own `systranslate::SystemTranslateProbe`
/// (`osSupported`/`status` on the wire); `system_translate_probe`
/// (systranslate_ios.rs) returns this straight to JS, so it needs
/// `Serialize` same as `OsSpeechCapabilities` above.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SysTranslateProbeResult {
    pub os_supported: bool,
    pub status: String,
}

/// `run_mobile_plugin("sysTranslate", ...)`'s request shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SysTranslateBatchArgs {
    pub items: Vec<TranslateItem>,
    pub source: String,
    pub target: String,
}

/// `run_mobile_plugin("sysTranslateStop", ...)`'s request shape —
/// `generation` is `Option` for the same reason desktop's own
/// `system_translate_stop` takes one (systranslate.rs's own doc comment
/// on that param): `None` when the caller never had a `prepare()` call
/// succeed this session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SysTranslateStopArgs {
    pub generation: Option<u64>,
}

/// `run_mobile_plugin("sysTranslatePrepare", ...)`'s reply shape — desktop's
/// own `system_translate_prepare` resolves a bare `Result<u64, String>`
/// (systranslate.rs), but Swift's plugin-invoke reply is always a JSON
/// object, so it wraps the generation in `{"generation": u64}`;
/// `OsSpeech::sys_translate_prepare` (mobile.rs) unwraps this so the app
/// crate's own command stays wire-identical to desktop's.
#[derive(Debug, Clone, Deserialize)]
pub struct GenerationResult {
    pub generation: u64,
}

/// `run_mobile_plugin("sysTranslate", ...)`'s reply shape — same envelope
/// reason as `GenerationResult` above: desktop's own `system_translate`
/// resolves a bare `Vec<TranslateItem>`, Swift wraps it as
/// `{"items": [...]}`; `OsSpeech::sys_translate` unwraps this.
#[derive(Debug, Clone, Deserialize)]
pub struct TranslateItemsResult {
    pub items: Vec<TranslateItem>,
}
