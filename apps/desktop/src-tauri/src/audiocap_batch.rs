// S9.2 (docs/design-explorations/s9-app-audio-tap-blueprint.md, D5) —
// batches resampled i16 mono PCM samples into ~16 KB little-endian byte
// buffers before they ever reach the Tauri Channel: "batched ~16 KB
// (matches the worklet's granularity), never per-IOProc-callback sends"
// and "Tauri's binary fetch path engages above 1 KB". Pure — no tauri,
// no I/O; audiocap.rs's session task is the only thing that ever calls
// `channel.send` with what this produces.

/// ~16 KB — at 16 kHz mono i16 (2 bytes/frame) this is ≈0.5 s of audio,
/// matching D5's own "batched ~16 KB (≈0.5 s)".
pub const TARGET_BATCH_BYTES: usize = 16 * 1024;

pub struct Batcher {
    pending: Vec<u8>,
}

impl Batcher {
    pub fn new() -> Self {
        Self { pending: Vec::new() }
    }

    /// Appends `samples` (mono i16, native order converted to LE on the
    /// way in) and drains zero or more `TARGET_BATCH_BYTES`-sized
    /// batches, oldest first. Any remainder under the target stays
    /// buffered for a later `push`/`flush` call.
    pub fn push(&mut self, samples: &[i16]) -> Vec<Vec<u8>> {
        self.pending.reserve(samples.len() * 2);
        for &sample in samples {
            self.pending.extend_from_slice(&sample.to_le_bytes());
        }

        let mut batches = Vec::new();
        while self.pending.len() >= TARGET_BATCH_BYTES {
            let batch: Vec<u8> = self.pending.drain(..TARGET_BATCH_BYTES).collect();
            batches.push(batch);
        }
        batches
    }

    /// The final, possibly-under-target batch (if any) — call exactly
    /// once, at stop, after the last `push`. Idempotent: a second call
    /// with nothing pushed in between returns `None`.
    pub fn flush(&mut self) -> Option<Vec<u8>> {
        if self.pending.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.pending))
        }
    }
}

impl Default for Batcher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audiocap_resample::OUTPUT_SAMPLE_RATE;

    /// Sanity cross-check that TARGET_BATCH_BYTES is in fact ≈0.5 s at
    /// the pipeline's fixed 16 kHz mono i16 output rate.
    const BYTES_PER_FRAME: usize = 2;

    #[test]
    fn target_batch_bytes_is_approximately_half_a_second_at_16khz_mono_i16() {
        let frames_per_batch = TARGET_BATCH_BYTES / BYTES_PER_FRAME;
        let seconds = frames_per_batch as f64 / OUTPUT_SAMPLE_RATE as f64;
        // 16 * 1024 bytes / 2 bytes-per-frame / 16000 Hz = 0.512s exactly
        // — "≈0.5s" (D5's own words), not a tighter guarantee.
        assert!((seconds - 0.5).abs() < 0.02, "expected ~0.5s, got {seconds}");
    }

    #[test]
    fn push_below_target_emits_no_batch() {
        let mut batcher = Batcher::new();
        let batches = batcher.push(&[1, 2, 3, 4]); // 8 bytes, far under 16 KB
        assert!(batches.is_empty());
    }

    #[test]
    fn push_at_exactly_the_target_emits_one_batch_with_no_remainder() {
        let mut batcher = Batcher::new();
        let samples = vec![0i16; TARGET_BATCH_BYTES / 2]; // exactly TARGET_BATCH_BYTES bytes
        let batches = batcher.push(&samples);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), TARGET_BATCH_BYTES);
        assert_eq!(batcher.flush(), None, "nothing should remain buffered");
    }

    #[test]
    fn push_past_the_target_emits_a_batch_and_keeps_the_remainder() {
        let mut batcher = Batcher::new();
        let extra_samples = 100;
        let samples = vec![7i16; TARGET_BATCH_BYTES / 2 + extra_samples];
        let batches = batcher.push(&samples);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), TARGET_BATCH_BYTES);
        let remainder = batcher.flush().expect("remainder should be buffered");
        assert_eq!(remainder.len(), extra_samples * 2);
    }

    #[test]
    fn many_small_pushes_cross_the_boundary_at_exactly_the_right_byte() {
        let mut batcher = Batcher::new();
        let mut total_bytes_pushed = 0usize;
        let mut emitted: Vec<Vec<u8>> = Vec::new();
        // 50 bytes (25 i16 samples) per push — deliberately not a
        // divisor of TARGET_BATCH_BYTES, to exercise a boundary that
        // doesn't land on a push call's own edge.
        let chunk: Vec<i16> = vec![42; 25];
        for _ in 0..1000 {
            let batches = batcher.push(&chunk);
            total_bytes_pushed += chunk.len() * 2;
            emitted.extend(batches);
            if !emitted.is_empty() {
                break;
            }
        }
        assert_eq!(emitted.len(), 1, "expected exactly one batch to have been emitted by the time we stopped");
        assert_eq!(emitted[0].len(), TARGET_BATCH_BYTES);
        assert!(
            total_bytes_pushed >= TARGET_BATCH_BYTES,
            "must not emit a batch before enough bytes were actually pushed"
        );
    }

    #[test]
    fn multiple_batches_can_be_emitted_from_a_single_push() {
        let mut batcher = Batcher::new();
        let samples = vec![1i16; (TARGET_BATCH_BYTES / 2) * 3]; // 3 full batches, in one push call
        let batches = batcher.push(&samples);
        assert_eq!(batches.len(), 3);
        for batch in &batches {
            assert_eq!(batch.len(), TARGET_BATCH_BYTES);
        }
        assert_eq!(batcher.flush(), None);
    }

    #[test]
    fn flush_on_an_empty_batcher_returns_none() {
        let mut batcher = Batcher::new();
        assert_eq!(batcher.flush(), None);
    }

    #[test]
    fn flush_returns_the_remainder_exactly_once() {
        let mut batcher = Batcher::new();
        batcher.push(&[1, 2, 3]);
        assert!(batcher.flush().is_some());
        assert_eq!(batcher.flush(), None);
    }

    #[test]
    fn samples_round_trip_as_little_endian_bytes() {
        let mut batcher = Batcher::new();
        batcher.push(&[0x0102i16, -1i16]);
        let bytes = batcher.flush().unwrap();
        assert_eq!(bytes, vec![0x02, 0x01, 0xFF, 0xFF]);
    }
}
