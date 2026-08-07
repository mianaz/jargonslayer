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

// The Rust half of the wire-contract tests: Swift's side of these exact
// shapes is pinned by OsSpeechWireTests.swift (golden payload keys,
// explicit-null vs omitted), but until now nothing asserted the Rust
// serialization it must mirror — a one-sided contract. Golden
// serde_json::json! comparisons, not field spot-checks, so an added/
// renamed/dropped key fails loudly the same way the Swift suite does.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn start_args_serializes_camel_case_with_contextual_json_present() {
        let v = serde_json::to_value(StartArgs {
            locale: "en-US".into(),
            contextual_json: Some("{\"strings\":[\"ARR\"]}".into()),
        })
        .unwrap();
        assert_eq!(
            v,
            json!({"locale": "en-US", "contextualJson": "{\"strings\":[\"ARR\"]}"})
        );
    }

    #[test]
    fn start_args_none_contextual_json_stays_an_explicit_null() {
        // §6 F1 posture (same as capabilities.reason below): no
        // skip_serializing_if anywhere in this file — Swift's Decodable
        // side always sees the key.
        let v = serde_json::to_value(StartArgs {
            locale: "zh-CN".into(),
            contextual_json: None,
        })
        .unwrap();
        assert_eq!(v, json!({"locale": "zh-CN", "contextualJson": null}));
    }

    #[test]
    fn capabilities_reason_none_serializes_as_explicit_null() {
        // The pinned §6 F1 amendment: `reason` is required-nullable. JS
        // reads `caps.reason === null` — an omitted key would change
        // `undefined`-vs-`null` semantics silently.
        let v = serde_json::to_value(OsSpeechCapabilities {
            supported: true,
            reason: None,
            locales: vec!["en-US".into()],
            installed_locales: vec![],
        })
        .unwrap();
        assert_eq!(
            v,
            json!({
                "supported": true,
                "reason": null,
                "locales": ["en-US"],
                "installedLocales": []
            })
        );
    }

    #[test]
    fn capabilities_round_trips_swifts_reply_json() {
        // The Deserialize direction: run_mobile_plugin::<OsSpeechCapabilities>
        // decoding the exact key set OsSpeechWireTests pins on the Swift side.
        let caps: OsSpeechCapabilities = serde_json::from_value(json!({
            "supported": false,
            "reason": "unsupported-os",
            "locales": [],
            "installedLocales": ["en-US"]
        }))
        .unwrap();
        assert_eq!(
            caps,
            OsSpeechCapabilities {
                supported: false,
                reason: Some("unsupported-os".into()),
                locales: vec![],
                installed_locales: vec!["en-US".into()],
            }
        );
    }

    #[test]
    fn probe_result_uses_the_desktop_wire_field_os_supported() {
        // Field-exact against desktop systranslate.rs's own probe shape:
        // `osSupported`, camelCase — the TS caller branches on it.
        let v = serde_json::to_value(SysTranslateProbeResult {
            os_supported: true,
            status: "installed".into(),
        })
        .unwrap();
        assert_eq!(v, json!({"osSupported": true, "status": "installed"}));
    }

    #[test]
    fn translate_item_and_batch_args_deliberately_skip_camel_case() {
        // TranslateItem/SysTranslateBatchArgs carry NO rename_all — id/
        // text/items/source/target are already single words; adding the
        // attribute later must be a conscious wire change, not a tidy-up.
        let v = serde_json::to_value(SysTranslateBatchArgs {
            items: vec![TranslateItem {
                id: "s1".into(),
                text: "hello".into(),
            }],
            source: "en".into(),
            target: "zh".into(),
        })
        .unwrap();
        assert_eq!(
            v,
            json!({
                "items": [{"id": "s1", "text": "hello"}],
                "source": "en",
                "target": "zh"
            })
        );
    }

    #[test]
    fn stop_args_without_a_generation_still_sends_the_key() {
        let v = serde_json::to_value(SysTranslateStopArgs { generation: None }).unwrap();
        assert_eq!(v, json!({"generation": null}));
    }

    #[test]
    fn preinstall_args_shape() {
        let v = serde_json::to_value(PreinstallArgs {
            locale: "en-US".into(),
        })
        .unwrap();
        assert_eq!(v, json!({"locale": "en-US"}));
    }

    #[test]
    fn generation_result_unwraps_swifts_envelope() {
        let g: GenerationResult = serde_json::from_value(json!({"generation": 7})).unwrap();
        assert_eq!(g.generation, 7);
    }

    #[test]
    fn translate_items_result_unwraps_swifts_envelope() {
        let r: TranslateItemsResult = serde_json::from_value(json!({
            "items": [
                {"id": "a", "text": "甲"},
                {"id": "b", "text": "乙"}
            ]
        }))
        .unwrap();
        assert_eq!(
            r.items,
            vec![
                TranslateItem {
                    id: "a".into(),
                    text: "甲".into()
                },
                TranslateItem {
                    id: "b".into(),
                    text: "乙".into()
                },
            ]
        );
    }
}
