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
