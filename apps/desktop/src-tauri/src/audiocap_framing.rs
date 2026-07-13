// S9.2 (docs/design-explorations/s9-app-audio-tap-blueprint.md, D5) —
// the Rust-side DECODER for Framing v1, jargonslayer-audiocap's stdout
// wire format. The ENCODER (audiocap-helper/Sources/AudioCapCore/
// Framing.swift) is golden-bytes tested on the Swift side; this file's
// own tests below pin the SAME byte layout from the reader's side, plus
// the "records split across arbitrary chunk boundaries" reassembly
// Framing.swift's own comment explicitly hands off to "S9.2's Rust
// sidecar supervisor" (set_raw_out(true) means a stdout CommandEvent
// can split a record anywhere, same hazard LineReassembler in
// audiocap.rs already handles for stderr NDJSON).
//
// Pure byte parsing — no tauri, no I/O, no CoreAudio, no allocation
// beyond growing/draining a couple of Vecs. `FramingReader` is fed
// arbitrary byte slices (exactly the shape a `CommandEvent::Stdout`
// chunk arrives in) via `feed`, and yields every record that becomes
// fully available; any trailing partial record/header stays buffered
// for a later `feed` call.
use std::convert::TryInto;

/// "JSAC" (JargonSlayer Audio Capture) — Framing.swift's own `magic`.
pub const MAGIC: [u8; 4] = *b"JSAC";
pub const VERSION: u16 = 1;
/// The only format this helper ever declares on the wire: interleaved
/// LE f32 (Framing.swift's own `formatInterleavedFloat32`).
pub const FORMAT_INTERLEAVED_F32: u16 = 1;

/// magic(4) + version(2) + format(2) + sampleRate(4) + channels(2) +
/// reserved(2) — Framing.encodeStreamHeader's own byte layout.
const HEADER_LEN: usize = 16;
/// seq(8) + frameCount(4) + byteLen(4) — Framing.encodeChunk/encodeEOS's
/// shared fixed-size prefix; `payload` (byteLen bytes) follows for a
/// chunk record, nothing follows for EOS (byteLen == 0).
const RECORD_PREFIX_LEN: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamHeader {
    pub version: u16,
    pub format: u16,
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Record {
    /// `frame_count > 0`; `payload` is interleaved LE f32 bytes, exactly
    /// `byte_len` (== `payload.len()`) of them.
    Chunk { seq: u64, frame_count: u32, payload: Vec<u8> },
    /// `frame_count == 0 && byte_len == 0` — Framing.encodeEOS's own
    /// shape. `seq` continues the same monotonic sequence as the chunk
    /// records that preceded it (Framing.swift's own doc comment), so
    /// FramingReader's gap tracking treats it identically to a chunk.
    Eos { seq: u64 },
}

/// One record plus how many sequence numbers were expected-but-never-
/// observed immediately before it (0 in the normal case) — co-located
/// so a consumer knows exactly when/how much silence to insert (D5:
/// "never time-compress") without needing a second pass over the
/// stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedItem {
    pub record: Record,
    pub gap_before: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramingError {
    BadMagic,
    UnsupportedVersion(u16),
    UnsupportedFormat(u16),
}

impl std::fmt::Display for FramingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadMagic => write!(f, "bad magic bytes (expected \"JSAC\")"),
            Self::UnsupportedVersion(v) => write!(f, "unsupported framing version {v} (expected {VERSION})"),
            Self::UnsupportedFormat(fmt) => write!(
                f,
                "unsupported sample format {fmt} (expected {FORMAT_INTERLEAVED_F32}, interleaved f32)"
            ),
        }
    }
}

impl std::error::Error for FramingError {}

fn parse_header(bytes: &[u8]) -> Result<StreamHeader, FramingError> {
    debug_assert_eq!(bytes.len(), HEADER_LEN);
    if bytes[0..4] != MAGIC {
        return Err(FramingError::BadMagic);
    }
    let version = u16::from_le_bytes(bytes[4..6].try_into().unwrap());
    if version != VERSION {
        return Err(FramingError::UnsupportedVersion(version));
    }
    let format = u16::from_le_bytes(bytes[6..8].try_into().unwrap());
    if format != FORMAT_INTERLEAVED_F32 {
        return Err(FramingError::UnsupportedFormat(format));
    }
    let sample_rate = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    let channels = u16::from_le_bytes(bytes[12..14].try_into().unwrap());
    // bytes[14..16] is `reserved` — intentionally ignored.
    Ok(StreamHeader { version, format, sample_rate, channels })
}

/// Incremental reader: buffers whatever hasn't been consumed yet
/// (`pending`) across calls to `feed`. Once a `FramingError` is
/// returned, the stream is considered unparseable from that point on —
/// callers (audiocap.rs's session task) treat it as fatal for the
/// session rather than calling `feed` again.
pub struct FramingReader {
    pending: Vec<u8>,
    header: Option<StreamHeader>,
    next_seq: Option<u64>,
    seq_gaps: u64,
}

impl FramingReader {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
            header: None,
            next_seq: None,
            seq_gaps: 0,
        }
    }

    /// `None` until the 16-byte stream header has fully arrived.
    pub fn header(&self) -> Option<StreamHeader> {
        self.header
    }

    /// Cumulative count of sequence numbers that were expected but
    /// never observed, across the whole session so far.
    pub fn seq_gaps(&self) -> u64 {
        self.seq_gaps
    }

    /// Appends `chunk` and returns every record that becomes fully
    /// available (oldest first). Any trailing partial header/record
    /// stays buffered for a later call — this is what makes `feed` safe
    /// to call with chunks split at ANY byte boundary, matching
    /// `set_raw_out(true)`'s own contract.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<FeedItem>, FramingError> {
        self.pending.extend_from_slice(chunk);
        let mut items = Vec::new();

        if self.header.is_none() {
            if self.pending.len() < HEADER_LEN {
                return Ok(items);
            }
            let header_bytes: Vec<u8> = self.pending.drain(..HEADER_LEN).collect();
            self.header = Some(parse_header(&header_bytes)?);
        }

        loop {
            if self.pending.len() < RECORD_PREFIX_LEN {
                break;
            }
            let seq = u64::from_le_bytes(self.pending[0..8].try_into().unwrap());
            let frame_count = u32::from_le_bytes(self.pending[8..12].try_into().unwrap());
            let byte_len = u32::from_le_bytes(self.pending[12..16].try_into().unwrap());

            let total_len = RECORD_PREFIX_LEN + byte_len as usize;
            if self.pending.len() < total_len {
                break; // the record's payload hasn't fully arrived yet
            }

            let gap_before = self.note_seq(seq);
            let record = if frame_count == 0 && byte_len == 0 {
                self.pending.drain(..total_len);
                Record::Eos { seq }
            } else {
                let payload = self.pending[RECORD_PREFIX_LEN..total_len].to_vec();
                self.pending.drain(..total_len);
                Record::Chunk { seq, frame_count, payload }
            };
            items.push(FeedItem { record, gap_before });
        }

        Ok(items)
    }

    /// Updates gap tracking for a just-observed `seq` and returns how
    /// many sequence numbers were skipped immediately before it (0 for
    /// the normal case, and always 0 for the very first record ever
    /// seen — there is no baseline to compare against yet).
    fn note_seq(&mut self, seq: u64) -> u64 {
        let gap = match self.next_seq {
            Some(expected) if seq > expected => seq - expected,
            _ => 0,
        };
        self.seq_gaps += gap;
        self.next_seq = Some(seq + 1);
        gap
    }
}

impl Default for FramingReader {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Header (16kHz mono) + one chunk (seq=0, frameCount=2, 8-byte
    /// payload) + EOS (seq=1) — byte-for-byte the same fixture as the
    /// Swift side's own FramingTests.testFullStreamGoldenBytes, so a
    /// mismatch between the two implementations of the SAME wire format
    /// would show up as a failure on at least one side.
    fn golden_stream_bytes() -> Vec<u8> {
        let mut bytes = vec![
            0x4A, 0x53, 0x41, 0x43, // magic "JSAC"
            0x01, 0x00, // version = 1
            0x01, 0x00, // format = 1 (interleaved f32)
            0x80, 0x3E, 0x00, 0x00, // sampleRate = 16000 (LE u32)
            0x01, 0x00, // channels = 1
            0x00, 0x00, // reserved
        ];
        bytes.extend_from_slice(&[
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // seq = 0
            0x02, 0x00, 0x00, 0x00, // frameCount = 2
            0x08, 0x00, 0x00, 0x00, // byteLen = 8
            0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22, // payload
        ]);
        bytes.extend_from_slice(&[
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // seq = 1
            0x00, 0x00, 0x00, 0x00, // frameCount = 0
            0x00, 0x00, 0x00, 0x00, // byteLen = 0
        ]);
        bytes
    }

    #[test]
    fn golden_header_one_chunk_and_eos_fed_as_a_single_chunk() {
        let mut reader = FramingReader::new();
        let items = reader.feed(&golden_stream_bytes()).expect("parses cleanly");

        assert_eq!(
            reader.header(),
            Some(StreamHeader {
                version: 1,
                format: FORMAT_INTERLEAVED_F32,
                sample_rate: 16_000,
                channels: 1,
            })
        );
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0],
            FeedItem {
                record: Record::Chunk {
                    seq: 0,
                    frame_count: 2,
                    payload: vec![0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22],
                },
                gap_before: 0,
            }
        );
        assert_eq!(items[1], FeedItem { record: Record::Eos { seq: 1 }, gap_before: 0 });
        assert_eq!(reader.seq_gaps(), 0);
    }

    #[test]
    fn records_split_across_arbitrary_chunk_boundaries_reassemble_identically() {
        let whole = golden_stream_bytes();
        // A handful of representative arbitrary split points: mid-magic,
        // mid-header, mid-record-prefix, mid-payload, and exactly on a
        // record boundary.
        for split_after in [1usize, 3, 16, 20, 24, 30, 40] {
            let (first, rest) = whole.split_at(split_after.min(whole.len()));
            let mut reader = FramingReader::new();
            let mut items = reader.feed(first).expect("first half parses");
            items.extend(reader.feed(rest).expect("second half parses"));

            assert_eq!(
                reader.header(),
                Some(StreamHeader {
                    version: 1,
                    format: FORMAT_INTERLEAVED_F32,
                    sample_rate: 16_000,
                    channels: 1,
                }),
                "split_after={split_after}"
            );
            assert_eq!(items.len(), 2, "split_after={split_after}");
            assert_eq!(
                items[0].record,
                Record::Chunk {
                    seq: 0,
                    frame_count: 2,
                    payload: vec![0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22],
                },
                "split_after={split_after}"
            );
            assert_eq!(items[1].record, Record::Eos { seq: 1 }, "split_after={split_after}");
        }
    }

    #[test]
    fn byte_by_byte_feed_reassembles_identically() {
        let whole = golden_stream_bytes();
        let mut reader = FramingReader::new();
        let mut items = Vec::new();
        for b in &whole {
            items.extend(reader.feed(std::slice::from_ref(b)).expect("byte-at-a-time parses"));
        }
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0].record,
            Record::Chunk {
                seq: 0,
                frame_count: 2,
                payload: vec![0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22],
            }
        );
        assert_eq!(items[1].record, Record::Eos { seq: 1 });
    }

    #[test]
    fn eos_record_is_recognized_by_zero_frame_count_and_byte_len() {
        let mut reader = FramingReader::new();
        let mut bytes = vec![
            0x4A, 0x53, 0x41, 0x43, 0x01, 0x00, 0x01, 0x00, 0x40, 0x1F, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
        ];
        bytes.extend_from_slice(&[7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // seq=7, frameCount=0, byteLen=0
        let items = reader.feed(&bytes).unwrap();
        assert_eq!(items, vec![FeedItem { record: Record::Eos { seq: 7 }, gap_before: 0 }]);
    }

    #[test]
    fn seq_gap_is_detected_when_a_sequence_number_is_skipped() {
        let mut reader = FramingReader::new();
        reader.feed(&header_bytes()).unwrap();
        reader.feed(&chunk_bytes(0, &[1, 2])).unwrap();
        let items = reader.feed(&chunk_bytes(2, &[3, 4])).unwrap(); // seq jumps 0 -> 2, skipping 1

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].gap_before, 1);
        assert_eq!(reader.seq_gaps(), 1);
    }

    #[test]
    fn multiple_skipped_sequence_numbers_are_all_counted() {
        let mut reader = FramingReader::new();
        reader.feed(&header_bytes()).unwrap();
        reader.feed(&chunk_bytes(10, &[1, 2])).unwrap();
        let items = reader.feed(&chunk_bytes(15, &[3, 4])).unwrap(); // skips 11,12,13,14

        assert_eq!(items[0].gap_before, 4);
        assert_eq!(reader.seq_gaps(), 4);
    }

    #[test]
    fn no_gap_is_flagged_for_the_first_record_ever_seen_even_if_seq_is_not_zero() {
        let mut reader = FramingReader::new();
        reader.feed(&header_bytes()).unwrap();
        let items = reader.feed(&chunk_bytes(5, &[1, 2])).unwrap();
        assert_eq!(items[0].gap_before, 0);
        assert_eq!(reader.seq_gaps(), 0);
    }

    #[test]
    fn consecutive_sequence_numbers_never_count_as_a_gap() {
        let mut reader = FramingReader::new();
        reader.feed(&header_bytes()).unwrap();
        reader.feed(&chunk_bytes(0, &[1, 2])).unwrap();
        let items = reader.feed(&chunk_bytes(1, &[3, 4])).unwrap();
        assert_eq!(items[0].gap_before, 0);
        assert_eq!(reader.seq_gaps(), 0);
    }

    #[test]
    fn bad_magic_is_rejected() {
        let mut bytes = header_bytes();
        bytes[0] = 0x00;
        let mut reader = FramingReader::new();
        assert_eq!(reader.feed(&bytes), Err(FramingError::BadMagic));
    }

    #[test]
    fn unsupported_version_is_rejected() {
        let mut bytes = header_bytes();
        bytes[4] = 0x02; // version = 2
        let mut reader = FramingReader::new();
        assert_eq!(reader.feed(&bytes), Err(FramingError::UnsupportedVersion(2)));
    }

    #[test]
    fn unsupported_format_is_rejected() {
        let mut bytes = header_bytes();
        bytes[6] = 0x02; // format = 2 (not interleaved f32)
        let mut reader = FramingReader::new();
        assert_eq!(reader.feed(&bytes), Err(FramingError::UnsupportedFormat(2)));
    }

    #[test]
    fn a_header_split_mid_magic_still_parses_once_completed() {
        let bytes = header_bytes();
        let mut reader = FramingReader::new();
        assert!(reader.feed(&bytes[0..2]).unwrap().is_empty());
        assert!(reader.header().is_none());
        assert!(reader.feed(&bytes[2..]).unwrap().is_empty());
        assert!(reader.header().is_some());
    }

    // ---- fixture builders ----

    fn header_bytes() -> Vec<u8> {
        vec![
            0x4A, 0x53, 0x41, 0x43, // magic
            0x01, 0x00, // version
            0x01, 0x00, // format
            0x80, 0xBB, 0x00, 0x00, // sampleRate = 48000
            0x02, 0x00, // channels = 2
            0x00, 0x00, // reserved
        ]
    }

    fn chunk_bytes(seq: u64, payload_i16_pairs: &[u8]) -> Vec<u8> {
        let payload: Vec<u8> = payload_i16_pairs.to_vec();
        let mut bytes = seq.to_le_bytes().to_vec();
        bytes.extend_from_slice(&1u32.to_le_bytes()); // frameCount = 1 (arbitrary, non-zero)
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&payload);
        bytes
    }
}
