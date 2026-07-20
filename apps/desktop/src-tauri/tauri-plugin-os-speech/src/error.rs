use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
  #[error(transparent)]
  Io(#[from] std::io::Error),
  #[cfg(mobile)]
  #[error(transparent)]
  PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
  /// desktop.rs's own stub conformance (this plugin is iOS-only in
  /// practice — the app crate never path-deps it outside `cfg(target_os
  /// = "ios")`, see that file's own doc comment) — kept on ALL platforms
  /// (not `#[cfg(desktop)]`) so `Error` itself doesn't need a
  /// platform-conditional variant set, matching this enum's existing
  /// `Io`/`PluginInvoke` split (only `PluginInvoke` is cfg-gated, since
  /// only ITS underlying type is mobile-only).
  #[error("{0}")]
  Unsupported(String),
}

impl Serialize for Error {
  fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
  where
    S: Serializer,
  {
    serializer.serialize_str(self.to_string().as_ref())
  }
}
