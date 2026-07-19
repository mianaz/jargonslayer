// This plugin is iOS-only in practice (see mobile.rs's own header
// comment) — the app crate never builds `cfg(desktop)` code that touches
// it. This stub exists purely so `cargo check -p tauri-plugin-os-speech`
// (no `--target`) still type-checks the shared `models`/`error` code on
// a plain host `cargo check`, matching every method `mobile::OsSpeech`
// exposes so the two conformances can't silently drift apart.
use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
) -> crate::Result<OsSpeech<R>> {
  Ok(OsSpeech(app.clone()))
}

/// Access to the os-speech APIs.
pub struct OsSpeech<R: Runtime>(AppHandle<R>);

impl<R: Runtime> OsSpeech<R> {
  fn unsupported<T>(&self) -> crate::Result<T> {
    Err(crate::Error::Unsupported("tauri-plugin-os-speech only supports iOS".to_string()))
  }

  pub fn start_transcribe(&self, _args: StartArgs) -> crate::Result<()> {
    self.unsupported()
  }

  pub fn stop_transcribe(&self) -> crate::Result<()> {
    self.unsupported()
  }

  pub fn pause_transcribe(&self) -> crate::Result<()> {
    self.unsupported()
  }

  pub fn resume_transcribe(&self) -> crate::Result<()> {
    self.unsupported()
  }

  pub fn capabilities(&self) -> crate::Result<OsSpeechCapabilities> {
    self.unsupported()
  }

  pub fn preinstall(&self, _args: PreinstallArgs) -> crate::Result<()> {
    self.unsupported()
  }
}
