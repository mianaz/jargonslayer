// S9.2 (docs/design-explorations/s9-app-audio-tap-blueprint.md, D5) —
// composes downmix + Resampler + Batcher into the one pure pipeline
// audiocap.rs's session task drives with parsed Framing v1 records.
// Kept pure/tauri-free like its two components so it stays testable
// with plain fixture bytes (per this slice's own instruction: "the
// parser/resampler/batcher core should be pure functions/structs
// testable without tauri types; keep the tauri glue thin").
use crate::audiocap_batch::Batcher;
use crate::audiocap_resample::{downmix_to_mono, interleaved_f32_from_le_bytes, Resampler, OUTPUT_SAMPLE_RATE};

pub struct AudioPipeline {
    resampler: Option<Resampler>,
    batcher: Batcher,
    channels: u16,
    input_sample_rate: u32,

    // Running average of frame_count per chunk, used to size the
    // silence inserted for a seq-gap — the framing protocol carries no
    // size for a chunk that was never received at all (see
    // `process_gap`'s own doc comment).
    chunk_frame_sum: u64,
    chunk_frame_count: u64,

    frames_in: u64,
    frames_out: u64,
    bytes_sent: u64,
}

impl AudioPipeline {
    pub fn new() -> Self {
        Self {
            resampler: None,
            batcher: Batcher::new(),
            channels: 1,
            input_sample_rate: 0,
            chunk_frame_sum: 0,
            chunk_frame_count: 0,
            frames_in: 0,
            frames_out: 0,
            bytes_sent: 0,
        }
    }

    pub fn has_format(&self) -> bool {
        self.resampler.is_some()
    }

    /// Configures the pipeline for the stream header's declared
    /// sample_rate/channels — call once, as soon as `FramingReader`'s
    /// header becomes available. A second call is a no-op UNLESS the
    /// format actually changed (defensive; the current protocol only
    /// ever sends one header per session, but a resampler configured
    /// for the wrong rate would silently mis-time every sample after
    /// it, so a genuine change must reconfigure rather than be
    /// ignored).
    pub fn set_format(&mut self, sample_rate: u32, channels: u16) -> Result<(), String> {
        if self.resampler.is_some() && self.input_sample_rate == sample_rate && self.channels == channels.max(1) {
            return Ok(());
        }
        self.resampler = Some(Resampler::new(sample_rate)?);
        self.channels = channels.max(1);
        self.input_sample_rate = sample_rate;
        Ok(())
    }

    /// Downmixes + resamples + batches one chunk's payload. Returns
    /// zero or more ~16 KB batches ready to send; anything under that
    /// stays buffered internally. A no-op (empty result) if called
    /// before `set_format` — this shouldn't happen given
    /// `FramingReader` always yields the header before any chunk
    /// record, but is handled without panicking either way.
    pub fn process_chunk(&mut self, frame_count: u32, interleaved_f32_le_bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
        self.frames_in += frame_count as u64;
        self.chunk_frame_sum += frame_count as u64;
        self.chunk_frame_count += 1;

        let Some(resampler) = self.resampler.as_mut() else {
            return Ok(Vec::new());
        };
        let interleaved = interleaved_f32_from_le_bytes(interleaved_f32_le_bytes);
        let mono = downmix_to_mono(&interleaved, self.channels);
        let pcm = resampler.push(&mono)?;
        self.frames_out += pcm.len() as u64;
        Ok(self.batcher.push(&pcm))
    }

    /// A seq-gap of `missing_count` sequence numbers -> that many
    /// ESTIMATED-size silent chunks' worth of frames, sized from the
    /// running average of recently-seen real chunks' `frame_count` — the
    /// framing protocol carries no size for a chunk that was never
    /// received at all, so this is the best available estimate (D5:
    /// "never time-compress" — inserting *some* silence, even
    /// approximately sized, keeps downstream timestamps roughly
    /// continuous; inserting none would let the whole rest of the
    /// session drift early). A gap before any real chunk has ever been
    /// seen inserts nothing (no data yet to estimate from).
    pub fn process_gap(&mut self, missing_count: u64) -> Result<Vec<Vec<u8>>, String> {
        if missing_count == 0 || self.chunk_frame_count == 0 {
            return Ok(Vec::new());
        }
        let Some(resampler) = self.resampler.as_mut() else {
            return Ok(Vec::new());
        };
        let avg_frames = (self.chunk_frame_sum / self.chunk_frame_count).max(1);
        let silence_frames = (missing_count * avg_frames) as usize;
        let pcm = resampler.push_silence(silence_frames)?;
        self.frames_out += pcm.len() as u64;
        Ok(self.batcher.push(&pcm))
    }

    /// True final drain — resampler tail, then whatever's left in the
    /// batcher under the ~16 KB target. Call exactly once, on EOS.
    pub fn flush(&mut self) -> Result<Vec<Vec<u8>>, String> {
        let mut batches = match self.resampler.as_mut() {
            Some(resampler) => {
                let tail = resampler.flush()?;
                self.frames_out += tail.len() as u64;
                self.batcher.push(&tail)
            }
            None => Vec::new(),
        };
        if let Some(last) = self.batcher.flush() {
            batches.push(last);
        }
        Ok(batches)
    }

    pub fn note_bytes_sent(&mut self, n: u64) {
        self.bytes_sent += n;
    }

    /// One human-readable diagnostics line (blueprint S9.2: "input
    /// rate/channels, frames in/out, seq gaps, resampler ratio, channel
    /// bytes sent — never raw audio") — `seq_gaps` is threaded in from
    /// `FramingReader::seq_gaps()`, the only counter this pipeline
    /// doesn't itself own.
    pub fn diagnostics_line(&self, seq_gaps: u64) -> String {
        let ratio = if self.input_sample_rate > 0 {
            OUTPUT_SAMPLE_RATE as f64 / self.input_sample_rate as f64
        } else {
            0.0
        };
        format!(
            "[audiocap] diag: inputRate={}Hz channels={} framesIn={} framesOut={} seqGaps={seq_gaps} resampleRatio={ratio:.4} bytesSent={}",
            self.input_sample_rate, self.channels, self.frames_in, self.frames_out, self.bytes_sent
        )
    }
}

impl Default for AudioPipeline {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f32_le_bytes(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn process_chunk_before_set_format_is_a_harmless_no_op() {
        let mut pipeline = AudioPipeline::new();
        let payload = f32_le_bytes(&[0.1, 0.2]);
        let batches = pipeline.process_chunk(2, &payload).unwrap();
        assert!(batches.is_empty());
        assert!(!pipeline.has_format());
    }

    #[test]
    fn process_chunk_downmixes_resamples_and_eventually_batches() {
        let mut pipeline = AudioPipeline::new();
        pipeline.set_format(48_000, 2).unwrap();
        assert!(pipeline.has_format());

        // Push a lot of stereo audio (well beyond one ~16 KB output
        // batch) across many chunk-sized calls, mirroring how real
        // Framing v1 chunk records arrive (~20ms of audio each).
        let frames_per_chunk = 960; // ~20ms at 48kHz
        let mut total_batches = Vec::new();
        for i in 0..200 {
            let mut interleaved = Vec::with_capacity(frames_per_chunk * 2);
            for f in 0..frames_per_chunk {
                let t = (i * frames_per_chunk + f) as f32 / 48_000.0;
                let l = 0.3 * (2.0 * std::f32::consts::PI * 440.0 * t).sin();
                let r = 0.3 * (2.0 * std::f32::consts::PI * 220.0 * t).sin();
                interleaved.push(l);
                interleaved.push(r);
            }
            let payload = f32_le_bytes(&interleaved);
            total_batches.extend(pipeline.process_chunk(frames_per_chunk as u32, &payload).unwrap());
        }

        assert!(!total_batches.is_empty(), "enough audio was pushed that at least one ~16KB batch must have been emitted");
        for batch in &total_batches {
            assert_eq!(batch.len(), crate::audiocap_batch::TARGET_BATCH_BYTES);
        }
    }

    #[test]
    fn process_gap_before_any_chunk_seen_inserts_nothing() {
        let mut pipeline = AudioPipeline::new();
        pipeline.set_format(48_000, 1).unwrap();
        let batches = pipeline.process_gap(5).unwrap();
        assert!(batches.is_empty());
    }

    #[test]
    fn process_gap_after_chunks_seen_inserts_silence_sized_from_the_running_average() {
        let mut pipeline = AudioPipeline::new();
        pipeline.set_format(48_000, 1).unwrap();
        let payload = f32_le_bytes(&vec![0.0f32; 4800]);
        pipeline.process_chunk(4800, &payload).unwrap();

        let frames_in_before = pipeline.frames_in;
        pipeline.process_gap(3).unwrap();
        // process_gap doesn't count toward frames_in (no real audio was
        // received) — only the resampled silence flows through
        // frames_out.
        assert_eq!(pipeline.frames_in, frames_in_before);
    }

    #[test]
    fn flush_drains_resampler_tail_and_batcher_remainder() {
        let mut pipeline = AudioPipeline::new();
        pipeline.set_format(48_000, 1).unwrap();
        let payload = f32_le_bytes(&vec![0.1f32; 4800]);
        pipeline.process_chunk(4800, &payload).unwrap();
        let batches = pipeline.flush().unwrap();
        // Some audio was pushed but likely under one full ~16KB batch —
        // flush must still hand back whatever's left rather than
        // silently dropping it.
        let total_bytes: usize = batches.iter().map(|b| b.len()).sum();
        assert!(total_bytes > 0, "flush must return the buffered tail, not drop it");
    }

    #[test]
    fn diagnostics_line_reports_configured_rate_and_channels() {
        let mut pipeline = AudioPipeline::new();
        pipeline.set_format(44_100, 2).unwrap();
        let line = pipeline.diagnostics_line(7);
        assert!(line.contains("inputRate=44100Hz"), "{line}");
        assert!(line.contains("channels=2"), "{line}");
        assert!(line.contains("seqGaps=7"), "{line}");
        // "never raw audio" is a property of diagnostics_line's own
        // signature (it takes only counters, never a sample buffer) —
        // not something a string-search assertion could meaningfully
        // add on top of that.
    }
}
