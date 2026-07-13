// S9.2 (docs/design-explorations/s9-app-audio-tap-blueprint.md, D5) —
// "rubato resample OUTSIDE any RT context (device-native -> 16 kHz mono
// i16)". Pure DSP — no tauri, no I/O; audiocap_pipeline.rs is the only
// caller, and audiocap.rs's session task only ever touches it through
// that pipeline.
//
// rubato version note: pinned to 0.16.2 (Cargo.toml's own comment has
// the full reasoning — the crate redesigned its API around an
// Adapter/process_into_buffer model starting at 1.0.0 and kept making
// breaking major bumps every 1-2 months after that). 0.16.2's own API
// (verified against its docs.rs page, not assumed) is the classic
// `Vec<Vec<f32>>`-per-channel shape: `FftFixedIn::new(sample_rate_in,
// sample_rate_out, chunk_size_in, sub_chunks, nbr_channels)`, and the
// shared `Resampler` trait's `process`/`process_partial` taking
// `&[V] where V: AsRef<[f32]>` and returning `Vec<Vec<f32>>` (one inner
// Vec per channel — here always exactly one, since downmixing to mono
// happens BEFORE resampling per D5).
use rubato::{FftFixedIn, Resampler as RubatoResampler};

pub const OUTPUT_SAMPLE_RATE: u32 = 16_000;

// FftFixedIn's own internal FFT block sizing self-adjusts to whatever
// (input, output) sample-rate pair it's given, via
// gcd(sample_rate_input, sample_rate_output) (rubato 0.16.2's
// synchro.rs) — 1024 is just a reasonable target input block size
// (~21ms at 48kHz), not a figure that needs tuning per input rate.
const CHUNK_SIZE_IN: usize = 1024;
const SUB_CHUNKS: usize = 1;
const MONO_CHANNELS: usize = 1;

/// Wraps one `FftFixedIn<f32>` configured for `input_sample_rate ->
/// OUTPUT_SAMPLE_RATE`, mono. `FftFixedIn` needs EXACTLY
/// `input_frames_next()` input frames per `process()` call, so this
/// accumulates arbitrary-sized `push` calls into an internal buffer and
/// only calls into rubato once enough has arrived.
pub struct Resampler {
    inner: FftFixedIn<f32>,
    accum: Vec<f32>,
}

impl Resampler {
    pub fn new(input_sample_rate: u32) -> Result<Self, String> {
        let inner = FftFixedIn::<f32>::new(
            input_sample_rate as usize,
            OUTPUT_SAMPLE_RATE as usize,
            CHUNK_SIZE_IN,
            SUB_CHUNKS,
            MONO_CHANNELS,
        )
        .map_err(|e| format!("rubato::FftFixedIn::new({input_sample_rate} -> {OUTPUT_SAMPLE_RATE}) failed: {e}"))?;
        Ok(Self { inner, accum: Vec::new() })
    }

    /// Mono f32 samples in, resampled i16 mono samples out — zero or
    /// more of the resampler's own native-sized output chunks, exactly
    /// as many as the newly-accumulated input permits; any leftover
    /// under one input chunk stays buffered for the next `push`/`flush`
    /// call.
    pub fn push(&mut self, mono: &[f32]) -> Result<Vec<i16>, String> {
        self.accum.extend_from_slice(mono);
        let mut out = Vec::new();
        loop {
            let need = self.inner.input_frames_next();
            if need == 0 || self.accum.len() < need {
                break;
            }
            let block: Vec<f32> = self.accum.drain(..need).collect();
            let produced = self
                .inner
                .process(&[block], None)
                .map_err(|e| format!("rubato process failed: {e}"))?;
            append_as_i16(&mut out, &produced[0]);
        }
        Ok(out)
    }

    /// Silence insertion for a seq-gap (D5: "on seq-gap/drop insert
    /// equivalent silence — never time-compress") — runs the SAME
    /// accumulate-then-resample path as real audio, so a gap's silence
    /// is resampled/timed identically to real samples rather than
    /// special-cased.
    pub fn push_silence(&mut self, frame_count: usize) -> Result<Vec<i16>, String> {
        self.push(&vec![0.0f32; frame_count])
    }

    /// True tail flush — call exactly once, at stop, after the last
    /// real `push`/`push_silence`. Feeds whatever's left in the
    /// accumulator (fewer than one full input chunk — `None` if
    /// nothing at all remains) through ONE `process_partial` call.
    ///
    /// Empirically verified (not assumed) against rubato 0.16.2 that a
    /// SINGLE call is correct and complete, contrary to a first draft
    /// of this function that additionally looped calling
    /// `process_partial(None, ...)` again and again until it returned
    /// an empty buffer: that loop never terminated early because
    /// `process_partial(None, ...)` does NOT signal "fully drained" via
    /// an empty result — it keeps returning another full
    /// (zero-padded/silence) output block on every call, so the loop
    /// just kept manufacturing extra trailing silence for
    /// `MAX_FLUSH_ROUNDS` iterations (caught by this module's own
    /// length-ratio test: a 48kHz/1s fixture came back ~21200 frames
    /// instead of ~16000). The trait's own doc for `process_partial`
    /// ("Use this... for processing the last frames... can also be
    /// called without any input frames... to push any remaining
    /// delayed frames out") describes a single terminal call, not a
    /// drain loop — one call already accounts for both the leftover
    /// partial input AND the resampler's own internal delay.
    pub fn flush(&mut self) -> Result<Vec<i16>, String> {
        let remainder: Vec<f32> = std::mem::take(&mut self.accum);
        let produced = if remainder.is_empty() {
            self.inner.process_partial(None::<&[Vec<f32>]>, None)
        } else {
            self.inner.process_partial(Some(&[remainder][..]), None)
        }
        .map_err(|e| format!("rubato process_partial failed: {e}"))?;

        let mut out = Vec::new();
        append_as_i16(&mut out, &produced[0]);
        Ok(out)
    }
}

fn append_as_i16(out: &mut Vec<i16>, samples: &[f32]) {
    out.extend(samples.iter().copied().map(f32_to_i16));
}

/// Normalized [-1.0, 1.0] float PCM -> i16 PCM, clamped so an
/// out-of-range sample (resampler ringing, an upstream encoding bug)
/// saturates instead of wrapping.
fn f32_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

/// Averages `channels` interleaved f32 samples per frame down to one
/// mono f32 sample per frame — D5: "Downmix channels by averaging
/// BEFORE resampling." `channels <= 1` is a passthrough (already mono,
/// or a malformed/zero header value treated as mono rather than
/// dividing by zero).
pub fn downmix_to_mono(interleaved: &[f32], channels: u16) -> Vec<f32> {
    let channels = channels.max(1) as usize;
    if channels == 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Decodes a Framing v1 chunk payload (interleaved LE f32, per
/// Framing.swift's own fixed wire format) into f32 samples.
pub fn interleaved_f32_from_le_bytes(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    // ---- downmix_to_mono ----

    #[test]
    fn downmix_averages_two_channels_with_known_values() {
        // L = [1.0, 1.0, 1.0], R = [-1.0, -1.0, -1.0], interleaved.
        let interleaved = [1.0, -1.0, 1.0, -1.0, 1.0, -1.0];
        let mono = downmix_to_mono(&interleaved, 2);
        assert_eq!(mono, vec![0.0, 0.0, 0.0]);
    }

    #[test]
    fn downmix_of_different_l_r_values_averages_correctly_per_frame() {
        // L and R carry genuinely different (non-symmetric) sines'
        // sample values — this is the "L/R different sines" shape the
        // slice spec calls out, pinned here with exact expected values
        // rather than a tolerance-based comparison.
        let l = [0.2f32, 0.4, 0.6, 0.8];
        let r = [0.8f32, 0.0, -0.2, 1.0];
        let mut interleaved = Vec::with_capacity(8);
        for i in 0..4 {
            interleaved.push(l[i]);
            interleaved.push(r[i]);
        }
        let mono = downmix_to_mono(&interleaved, 2);
        let expected: Vec<f32> = (0..4).map(|i| (l[i] + r[i]) / 2.0).collect();
        assert_eq!(mono, expected);
    }

    #[test]
    fn downmix_of_mono_is_a_passthrough() {
        let samples = [0.1f32, -0.2, 0.3];
        assert_eq!(downmix_to_mono(&samples, 1), samples.to_vec());
    }

    #[test]
    fn downmix_of_three_channels_averages_all_three() {
        // frame: ch0=3.0, ch1=6.0, ch2=9.0 -> mean 6.0
        let interleaved = [3.0f32, 6.0, 9.0];
        assert_eq!(downmix_to_mono(&interleaved, 3), vec![6.0]);
    }

    // ---- interleaved_f32_from_le_bytes ----

    #[test]
    fn decodes_interleaved_le_f32_bytes() {
        let bytes = 1.5f32.to_le_bytes().iter().chain((-2.5f32).to_le_bytes().iter()).copied().collect::<Vec<u8>>();
        assert_eq!(interleaved_f32_from_le_bytes(&bytes), vec![1.5, -2.5]);
    }

    // ---- Resampler: 48 kHz -> 16 kHz sine fixture ----

    fn sine_mono(sample_rate: u32, freq_hz: f32, amplitude: f32, seconds: f32) -> Vec<f32> {
        let n = (sample_rate as f32 * seconds) as usize;
        (0..n)
            .map(|i| amplitude * (2.0 * PI * freq_hz * i as f32 / sample_rate as f32).sin())
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|&s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    fn rms_i16(samples: &[i16]) -> f32 {
        let floats: Vec<f32> = samples.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
        rms(&floats)
    }

    #[test]
    fn resample_48k_to_16k_preserves_length_ratio_within_tolerance() {
        let input = sine_mono(48_000, 440.0, 0.7, 1.0); // 1 second, 48000 frames
        let mut resampler = Resampler::new(48_000).unwrap();

        let mut output = Vec::new();
        for block in input.chunks(4800) {
            output.extend(resampler.push(block).unwrap());
        }
        output.extend(resampler.flush().unwrap());

        let expected_len = input.len() * OUTPUT_SAMPLE_RATE as usize / 48_000;
        let tolerance = (expected_len as f64 * 0.05).max(200.0) as usize;
        assert!(
            output.len().abs_diff(expected_len) <= tolerance,
            "expected ~{expected_len} frames (±{tolerance}), got {}",
            output.len()
        );
    }

    #[test]
    fn resample_48k_to_16k_preserves_rms_within_tolerance() {
        let input = sine_mono(48_000, 440.0, 0.7, 1.0);
        let input_rms = rms(&input);

        let mut resampler = Resampler::new(48_000).unwrap();
        let mut output = Vec::new();
        for block in input.chunks(4800) {
            output.extend(resampler.push(block).unwrap());
        }
        output.extend(resampler.flush().unwrap());

        let output_rms = rms_i16(&output);
        let relative_error = (output_rms - input_rms).abs() / input_rms;
        assert!(
            relative_error < 0.15,
            "input RMS {input_rms}, output RMS {output_rms}, relative error {relative_error}"
        );
    }

    #[test]
    fn silence_resamples_to_silence() {
        let mut resampler = Resampler::new(48_000).unwrap();
        let mut output = resampler.push_silence(4800).unwrap();
        output.extend(resampler.flush().unwrap());
        assert!(output.iter().all(|&s| s == 0), "silence in must resample to silence out");
    }

    #[test]
    fn a_sample_rate_that_already_matches_the_output_rate_is_a_near_identity() {
        let input = sine_mono(16_000, 440.0, 0.5, 0.5);
        let mut resampler = Resampler::new(16_000).unwrap();
        let mut output = Vec::new();
        for block in input.chunks(1600) {
            output.extend(resampler.push(block).unwrap());
        }
        output.extend(resampler.flush().unwrap());
        assert!(output.len().abs_diff(input.len()) <= (input.len() / 10).max(50));
    }
}
