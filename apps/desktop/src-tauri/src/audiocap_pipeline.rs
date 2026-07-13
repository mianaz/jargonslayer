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

    // F4 (soft pause, adversarial-review fix round) — see `pause`/
    // `resume`'s own doc comments.
    paused: bool,
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
            paused: false,
        }
    }

    pub fn has_format(&self) -> bool {
        self.resampler.is_some()
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// F4 (soft pause — PINNED CONTRACT: the JS worker wires
    /// engine.pause() to the `pause_app_audio` command, which sets the
    /// generation-scoped flag `spawn_session_task` reads and forwards
    /// here): flushes whatever the batcher was still accumulating under
    /// the ~16KB target — pre-pause audio that had already been
    /// resampled but not yet reached one full batch — so it's still
    /// delivered instead of sitting buffered indefinitely (D5's own
    /// "batched ~16KB" latency would otherwise silently absorb it).
    /// Every `process_chunk`/`process_gap` call from this point on is a
    /// no-op until `resume()` (deliberately does NOT touch the
    /// resampler — its own leftover accum is real, already-received
    /// pre-pause audio, not paused audio, and stays intact for the
    /// eventual session-end `flush()` to drain normally). Idempotent: a
    /// second call while already paused just flushes again, harmlessly
    /// empty since the batcher has nothing new to give.
    pub fn pause(&mut self) -> Vec<Vec<u8>> {
        self.paused = true;
        self.batcher.flush().into_iter().collect()
    }

    /// F4: un-pauses AND rebuilds the resampler from scratch at the SAME
    /// input_sample_rate — deliberately NOT just continuing to feed the
    /// existing instance. While paused, `process_chunk` never touches
    /// the resampler at all (frames are dropped before reaching it), so
    /// its internal accumulator/FFT delay-line state is left exactly
    /// where it was at the moment `pause()` was called — potentially
    /// seconds "behind" real time once audio resumes. Feeding new,
    /// post-resume audio into that stale instance would resample it as
    /// if no time had passed, an audible discontinuity/click at the
    /// pause boundary. A fresh `Resampler` starts clean, which is
    /// correct here: unlike a seq-gap (`process_gap`, D5's "never
    /// time-compress" contract for DROPPED wire data), a soft pause is a
    /// deliberate UI action with no obligation to represent the paused
    /// interval as silence in the output stream at all. A no-op for the
    /// resampler specifically if `set_format` was never even called yet
    /// (pausing before the stream header ever arrived) — kept harmless
    /// rather than panicking.
    pub fn resume(&mut self) -> Result<(), String> {
        self.paused = false;
        if self.resampler.is_some() {
            self.resampler = Some(Resampler::new(self.input_sample_rate)?);
        }
        Ok(())
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
        // F4: dropped at the pipeline's own input, before anything else
        // (including the frames_in counter) — see `pause`'s own doc
        // comment. The single source of truth for "is paused audio ever
        // let through," independent of whatever gating the caller
        // (audiocap.rs's session task) also applies.
        if self.paused {
            return Ok(Vec::new());
        }
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
        // F4: same pause gate as process_chunk — a gap detected while
        // paused must not manufacture silence for it either (that
        // silence would just be more paused-interval audio the user
        // asked to stop receiving).
        if self.paused || missing_count == 0 || self.chunk_frame_count == 0 {
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
    /// doesn't itself own. `paused` (F4) rides along here so a log
    /// reader can tell "no audio flowing because of a soft pause" apart
    /// from every other reason framesOut might have stalled.
    pub fn diagnostics_line(&self, seq_gaps: u64) -> String {
        let ratio = if self.input_sample_rate > 0 {
            OUTPUT_SAMPLE_RATE as f64 / self.input_sample_rate as f64
        } else {
            0.0
        };
        format!(
            "[audiocap] diag: inputRate={}Hz channels={} framesIn={} framesOut={} seqGaps={seq_gaps} resampleRatio={ratio:.4} bytesSent={} paused={}",
            self.input_sample_rate,
            self.channels,
            self.frames_in,
            self.frames_out,
            self.bytes_sent,
            self.is_paused()
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

    // ---- F4: soft pause/resume (adversarial-review fix round) ----

    #[test]
    fn pause_flushes_whatever_the_batcher_was_still_accumulating() {
        let mut pipeline = AudioPipeline::new();
        pipeline.set_format(48_000, 1).unwrap();
        // 100ms of resampled audio — well under one ~16KB/512ms batch,
        // so it's sitting unflushed in the batcher's own pending buffer
        // at the moment pause() is called.
        let payload = f32_le_bytes(&vec![0.2f32; 4800]);
        let pre_pause_batches = pipeline.process_chunk(4800, &payload).unwrap();
        assert!(pre_pause_batches.is_empty(), "100ms of audio must stay well under one ~16KB batch on its own");

        let flushed = pipeline.pause();
        assert!(!flushed.is_empty(), "pause() must flush the batcher's own pending partial batch immediately");
        assert!(pipeline.is_paused());
    }

    #[test]
    fn pause_is_idempotent_a_second_call_flushes_nothing_new() {
        let mut pipeline = AudioPipeline::new();
        pipeline.set_format(48_000, 1).unwrap();
        pipeline.process_chunk(4800, &f32_le_bytes(&vec![0.2f32; 4800])).unwrap();
        assert!(!pipeline.pause().is_empty());
        assert!(pipeline.pause().is_empty(), "a second pause() call has nothing left to flush");
    }

    #[test]
    fn pause_before_any_format_or_audio_is_a_harmless_no_op() {
        let mut pipeline = AudioPipeline::new();
        assert!(pipeline.pause().is_empty());
        assert!(pipeline.is_paused());
    }

    #[test]
    fn frames_pushed_while_paused_never_reach_the_batcher() {
        let mut pipeline = AudioPipeline::new();
        pipeline.set_format(48_000, 1).unwrap();
        pipeline.pause();

        // Push a lot of audio while paused — enough that, unpaused, it
        // would easily cross one or more ~16KB batch boundaries.
        let payload = f32_le_bytes(&vec![0.3f32; 48_000]); // 1s @ 48kHz
        for _ in 0..5 {
            let batches = pipeline.process_chunk(48_000, &payload).unwrap();
            assert!(batches.is_empty(), "no audio must be forwarded while paused, no matter how much is pushed");
        }

        // Prove it wasn't just delayed in the batcher (as opposed to
        // dropped outright at the pipeline's own input, per pause's own
        // doc comment) — a further pause() call (still paused, a
        // harmless no-op state-wise) must have nothing left to flush.
        // Deliberately does NOT call resume()+flush() here: a resampler
        // that has never received a single sample yet still emits a
        // non-empty delay-tail block from process_partial(None, ...)
        // (see Resampler::flush's own doc comment) — an unrelated
        // property of `flush()` this test must not conflate with "was
        // the paused audio actually dropped".
        assert!(pipeline.pause().is_empty(), "paused audio must be dropped outright, never buffered for later delivery");
    }

    #[test]
    fn process_gap_during_pause_inserts_no_silence_either() {
        let mut pipeline = AudioPipeline::new();
        pipeline.set_format(48_000, 1).unwrap();
        pipeline.process_chunk(4800, &f32_le_bytes(&vec![0.0f32; 4800])).unwrap();
        pipeline.pause();
        assert!(pipeline.process_gap(5).unwrap().is_empty());
    }

    #[test]
    fn resume_without_a_prior_pause_is_a_harmless_no_op() {
        let mut pipeline = AudioPipeline::new();
        pipeline.set_format(48_000, 1).unwrap();
        assert!(pipeline.resume().is_ok());
        assert!(!pipeline.is_paused());
    }

    #[test]
    fn resume_clears_the_paused_flag_and_processing_continues() {
        let mut pipeline = AudioPipeline::new();
        pipeline.set_format(48_000, 1).unwrap();
        pipeline.pause();
        pipeline.resume().unwrap();
        assert!(!pipeline.is_paused());

        let mut total_batches = Vec::new();
        let frames_per_chunk = 960;
        for i in 0..200 {
            let mut samples = Vec::with_capacity(frames_per_chunk);
            for f in 0..frames_per_chunk {
                let t = (i * frames_per_chunk + f) as f32 / 48_000.0;
                samples.push(0.3 * (2.0 * std::f32::consts::PI * 440.0 * t).sin());
            }
            total_batches.extend(pipeline.process_chunk(frames_per_chunk as u32, &f32_le_bytes(&samples)).unwrap());
        }
        assert!(!total_batches.is_empty(), "audio pushed after resume must reach the batcher normally");
    }

    #[test]
    fn resume_resets_the_resampler_so_output_matches_a_fresh_pipeline_not_a_stale_one() {
        // `CHUNK_SIZE_IN` (rubato's actual per-call input need for
        // 48kHz -> 16kHz, empirically confirmed — see that constant's
        // own doc comment) lets this test force an EXACT block-boundary
        // crossing instead of guessing: process_chunk's own returned
        // batches alone can't tell buggy from fixed here (a couple of
        // resampled samples are nowhere near the ~16KB batch target
        // either way) — flush() below, which drains the resampler tail
        // AND the batcher's remainder regardless of that target, is
        // what actually surfaces the difference.
        use crate::audiocap_resample::CHUNK_SIZE_IN;

        // Pipeline A: prime with just under one full resampler input
        // block — guaranteed to sit entirely in the resampler's own
        // accumulator, producing no output yet — then pause and resume.
        let mut paused_then_resumed = AudioPipeline::new();
        paused_then_resumed.set_format(48_000, 1).unwrap();
        let prime = sine_samples(48_000, 440.0, CHUNK_SIZE_IN - 1);
        let prime_batches = paused_then_resumed.process_chunk((CHUNK_SIZE_IN - 1) as u32, &f32_le_bytes(&prime)).unwrap();
        assert!(prime_batches.is_empty(), "priming audio must stay under one full resampler input block, producing no output yet");
        paused_then_resumed.pause();
        paused_then_resumed.resume().unwrap();

        // Pipeline B: brand new — never saw `prime` at all.
        let mut fresh = AudioPipeline::new();
        fresh.set_format(48_000, 1).unwrap();

        // A tiny probe, nowhere near a full input block on its own —
        // BUT pre-fix, `paused_then_resumed`'s stale leftover accum
        // (CHUNK_SIZE_IN - 1 samples) plus this probe crosses one whole
        // block, producing a REAL resampled block `fresh` never
        // produces: exactly the discontinuity artifact F4's fix
        // prevents.
        let probe = sine_samples(48_000, 220.0, 2);
        let mut paused_then_resumed_out = paused_then_resumed.process_chunk(2, &f32_le_bytes(&probe)).unwrap();
        let mut fresh_out = fresh.process_chunk(2, &f32_le_bytes(&probe)).unwrap();
        paused_then_resumed_out.extend(paused_then_resumed.flush().unwrap());
        fresh_out.extend(fresh.flush().unwrap());

        assert_eq!(
            paused_then_resumed_out, fresh_out,
            "resume() must reset the resampler — stale pre-pause state must never leak into post-resume output"
        );
    }

    fn sine_samples(sample_rate: u32, freq_hz: f32, count: usize) -> Vec<f32> {
        (0..count)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * freq_hz * i as f32 / sample_rate as f32).sin())
            .collect()
    }

    #[test]
    fn diagnostics_line_reports_configured_rate_and_channels() {
        let mut pipeline = AudioPipeline::new();
        pipeline.set_format(44_100, 2).unwrap();
        let line = pipeline.diagnostics_line(7);
        assert!(line.contains("inputRate=44100Hz"), "{line}");
        assert!(line.contains("channels=2"), "{line}");
        assert!(line.contains("seqGaps=7"), "{line}");
        assert!(line.contains("paused=false"), "{line}");
        // "never raw audio" is a property of diagnostics_line's own
        // signature (it takes only counters, never a sample buffer) —
        // not something a string-search assertion could meaningfully
        // add on top of that.
    }

    #[test]
    fn diagnostics_line_reflects_the_current_paused_state() {
        let mut pipeline = AudioPipeline::new();
        pipeline.set_format(44_100, 2).unwrap();
        pipeline.pause();
        assert!(pipeline.diagnostics_line(0).contains("paused=true"));
        pipeline.resume().unwrap();
        assert!(pipeline.diagnostics_line(0).contains("paused=false"));
    }
}
