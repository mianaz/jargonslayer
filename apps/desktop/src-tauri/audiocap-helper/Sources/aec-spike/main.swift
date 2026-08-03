// TEMPORARY dual-capture Phase 0 spike — delete with the Package.swift
// target when the spike ends. Answers three go/no-go questions before
// any production dual-capture code:
//
//   coexist       — CoreAudio global output tap + AVAudioEngine mic
//                   input running simultaneously in one process.
//                   `--vp on` enables Apple voice processing (AEC) with
//                   other-audio ducking forced to minimum. Emits one
//                   JSON line per second: system-tap peak, mic peak,
//                   mic RMS. Run twice (vp off / vp on) with the same
//                   speaker tone to measure AEC echo reduction and to
//                   prove VP does not duck or kill the output tap.
//   dual-analyzer — two SpeechAnalyzerSession instances concurrently:
//                   session A transcribes the output tap (drive it with
//                   `say`), session B consumes a silence ring. Both
//                   must finish cleanly.
//
// Exit codes: 0 = ran to completion, 1 = setup/session failure.

import AVFoundation
import AudioCapCore
import CoreAudio
import Foundation

// ---- tiny arg parsing (spike-grade) ----
let argv = CommandLine.arguments
let mode = argv.count > 1 ? argv[1] : "coexist"
func flagValue(_ name: String) -> String? {
    guard let i = argv.firstIndex(of: name), i + 1 < argv.count else { return nil }
    return argv[i + 1]
}
let vpOn = (flagValue("--vp") ?? "off") == "on"
let seconds = Double(flagValue("--seconds") ?? "10") ?? 10

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func fail(_ message: String) -> Never {
    emit(["spike": "error", "message": message])
    exit(1)
}

// Single-writer aligned Float cell: RT thread stores, main thread reads.
// Torn 32-bit aligned loads don't happen on arm64; good enough here.
final class PeakCell {
    private let p = UnsafeMutablePointer<Float>.allocate(capacity: 1)
    init() { p.initialize(to: 0) }
    func update(_ v: Float) { if v > p.pointee { p.pointee = v } }
    func take() -> Float { let v = p.pointee; p.pointee = 0; return v }
}

func peakOf(bufferList: UnsafeMutableAudioBufferListPointer) -> Float {
    var peak: Float = 0
    for buffer in bufferList {
        guard let data = buffer.mData else { continue }
        let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
        let floats = data.assumingMemoryBound(to: Float.self)
        for i in 0..<count { peak = max(peak, abs(floats[i])) }
    }
    return peak
}

// ---- system output tap (same call sequence as runTranscribe, no exclusion) ----
struct TapHandle {
    let tapID: AudioObjectID
    let aggregateDeviceID: AudioObjectID
    let ioProcID: AudioDeviceIOProcID
}

@available(macOS 14.2, *)
func startOutputTap(onBuffer: @escaping (UnsafeMutableAudioBufferListPointer) -> Void) throws -> TapHandle {
    let created = try ProcessTapCapture.createProcessTap(excluding: nil, name: "AEC Spike Tap")
    guard TapFormatDescription.isFloat32(created.format) else {
        throw AudioCapError.tapCreateFailed("tap format is not Float32")
    }
    let aggregateDeviceID = try ProcessTapCapture.createAggregateDevice(
        uid: "com.bioinfospace.jargonslayer.aecspike." + UUID().uuidString,
        name: "AEC Spike Aggregate",
        tapUID: created.tapUID
    )
    let ioBlock: AudioDeviceIOBlock = { _, inInputData, _, _, _ in
        let bufferList = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
        onBuffer(bufferList)
    }
    let ioProcID = try ProcessTapCapture.createIOProc(aggregateDeviceID: aggregateDeviceID, block: ioBlock)
    try ProcessTapCapture.start(aggregateDeviceID: aggregateDeviceID, ioProcID: ioProcID)
    return TapHandle(tapID: created.tapID, aggregateDeviceID: aggregateDeviceID, ioProcID: ioProcID)
}

// ---- coexist mode ----
@available(macOS 26.0, *)
func runCoexist() {
    let sysPeak = PeakCell()
    let micPeak = PeakCell()
    let rmsLock = NSLock()
    var sumSquares = 0.0
    var sampleCount = 0.0

    let tap: TapHandle
    do {
        tap = try startOutputTap { bufferList in
            sysPeak.update(peakOf(bufferList: bufferList))
        }
    } catch {
        fail("output tap setup failed: \(error)")
    }

    let engine = AVAudioEngine()
    let input = engine.inputNode
    if vpOn {
        do {
            try input.setVoiceProcessingEnabled(true)
        } catch {
            fail("setVoiceProcessingEnabled(true) threw: \(error)")
        }
        input.voiceProcessingOtherAudioDuckingConfiguration =
            AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
    }
    let format = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 4800, format: format) { buffer, _ in
        guard let channelData = buffer.floatChannelData else { return }
        var localPeak: Float = 0
        var localSum = 0.0
        let frames = Int(buffer.frameLength)
        for ch in 0..<Int(buffer.format.channelCount) {
            let samples = channelData[ch]
            for i in 0..<frames {
                let v = samples[i]
                localPeak = max(localPeak, abs(v))
                localSum += Double(v * v)
            }
        }
        micPeak.update(localPeak)
        rmsLock.lock()
        sumSquares += localSum
        sampleCount += Double(frames) * Double(buffer.format.channelCount)
        rmsLock.unlock()
    }
    do {
        try engine.start()
    } catch {
        fail("AVAudioEngine.start failed (mic permission?): \(error)")
    }

    emit([
        "spike": "coexist-start", "vp": vpOn,
        "mic_format_rate": format.sampleRate, "mic_channels": Int(format.channelCount),
    ])

    var totalSum = 0.0
    var totalCount = 0.0
    for t in 1...Int(seconds.rounded()) {
        Thread.sleep(forTimeInterval: 1.0)
        rmsLock.lock()
        let windowSum = sumSquares
        let windowCount = sampleCount
        sumSquares = 0
        sampleCount = 0
        rmsLock.unlock()
        totalSum += windowSum
        totalCount += windowCount
        let rms = windowCount > 0 ? (windowSum / windowCount).squareRoot() : 0
        emit([
            "t": t,
            "sys_peak": Double(sysPeak.take()),
            "mic_peak": Double(micPeak.take()),
            "mic_rms": rms,
        ])
    }

    engine.stop()
    input.removeTap(onBus: 0)
    ProcessTapCapture.stopDevice(aggregateDeviceID: tap.aggregateDeviceID, ioProcID: tap.ioProcID)
    ProcessTapCapture.teardown(tapID: tap.tapID, aggregateDeviceID: tap.aggregateDeviceID, ioProcID: tap.ioProcID)
    let overallRMS = totalCount > 0 ? (totalSum / totalCount).squareRoot() : 0
    emit(["spike": "coexist-done", "vp": vpOn, "overall_mic_rms": overallRMS])
    exit(0)
}

// ---- dual-analyzer mode ----
/// Pushes 100 ms mono-Float32 silence buffers so the second analyzer
/// session has a live (but silent) audio source.
final class SilencePusher {
    private let ring: SPSCByteRing
    private var running = false
    private var thread: Thread?
    init(ring: SPSCByteRing) { self.ring = ring }
    func start() {
        running = true
        let t = Thread { [self] in
            let frames: UInt32 = 4800
            let byteCount = Int(frames) * MemoryLayout<Float>.size
            let data = UnsafeMutableRawPointer.allocate(byteCount: byteCount, alignment: MemoryLayout<Float>.alignment)
            memset(data, 0, byteCount)
            var abl = AudioBufferList(
                mNumberBuffers: 1,
                mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(byteCount), mData: data)
            )
            while running {
                withUnsafeMutablePointer(to: &abl) { pointer in
                    _ = ring.tryPush(frameCount: frames, buffers: UnsafeMutableAudioBufferListPointer(pointer))
                }
                Thread.sleep(forTimeInterval: 0.1)
            }
            data.deallocate()
        }
        t.start()
        thread = t
    }
    func stop() { running = false }
}

@available(macOS 26.0, *)
func runDualAnalyzer() async {
    // Session A: real output tap (drive with `say` from the harness).
    let created: (tapID: AudioObjectID, tapUID: String, format: AudioStreamBasicDescription)
    do {
        created = try ProcessTapCapture.createProcessTap(excluding: nil, name: "AEC Spike Dual Tap")
    } catch {
        fail("tap create failed: \(error)")
    }
    let isNonInterleaved = TapFormatDescription.isNonInterleaved(created.format)
    let channels = UInt16(TapFormatDescription.channelCount(created.format))
    let sampleRate = UInt32(created.format.mSampleRate)
    let aggregateDeviceID: AudioObjectID
    do {
        aggregateDeviceID = try ProcessTapCapture.createAggregateDevice(
            uid: "com.bioinfospace.jargonslayer.aecspike.dual." + UUID().uuidString,
            name: "AEC Spike Dual Aggregate",
            tapUID: created.tapUID
        )
    } catch {
        fail("aggregate create failed: \(error)")
    }
    let ringA = SPSCByteRing(capacity: 4 << 20)
    let ioBlock: AudioDeviceIOBlock = { _, inInputData, _, _, _ in
        let bufferList = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
        var frameCount: UInt32 = 0
        if let first = bufferList.first, first.mDataByteSize > 0 {
            let bytesPerChannelFrame = isNonInterleaved ? 4 : Int(channels) * 4
            frameCount = bytesPerChannelFrame > 0 ? UInt32(Int(first.mDataByteSize) / bytesPerChannelFrame) : 0
        }
        _ = ringA.tryPush(frameCount: frameCount, buffers: bufferList)
    }
    let ioProcID: AudioDeviceIOProcID
    do {
        ioProcID = try ProcessTapCapture.createIOProc(aggregateDeviceID: aggregateDeviceID, block: ioBlock)
    } catch {
        fail("ioproc create failed: \(error)")
    }

    // Session B: silence ring.
    let ringB = SPSCByteRing(capacity: 1 << 20)
    let pusher = SilencePusher(ring: ringB)

    let shutdown = ShutdownSignal()
    emit(["spike": "dual-analyzer-start", "seconds": seconds])

    async let outcomeA = SpeechAnalyzerSession().run(
        locale: "en-US", contextualJSON: nil, durationSeconds: seconds,
        ring: ringA, channels: channels, isNonInterleaved: isNonInterleaved, sampleRate: sampleRate,
        shutdown: shutdown, isPaused: { false },
        startTap: { try ProcessTapCapture.start(aggregateDeviceID: aggregateDeviceID, ioProcID: ioProcID) },
        stopTap: { ProcessTapCapture.stopDevice(aggregateDeviceID: aggregateDeviceID, ioProcID: ioProcID) }
    )
    async let outcomeB = SpeechAnalyzerSession().run(
        locale: "en-US", contextualJSON: nil, durationSeconds: seconds,
        ring: ringB, channels: 1, isNonInterleaved: false, sampleRate: 48000,
        shutdown: shutdown, isPaused: { false },
        startTap: { pusher.start() },
        stopTap: { pusher.stop() }
    )
    let (a, b) = await (outcomeA, outcomeB)
    ProcessTapCapture.teardown(tapID: created.tapID, aggregateDeviceID: aggregateDeviceID, ioProcID: ioProcID)
    emit([
        "spike": "dual-analyzer-done",
        "tap_session": a == .success ? "success" : "failure",
        "silence_session": b == .success ? "success" : "failure",
    ])
    exit(a == .success && b == .success ? 0 : 1)
}

// ---- entry ----
if #available(macOS 26.0, *) {
    switch mode {
    case "coexist":
        runCoexist()
    case "dual-analyzer":
        let semaphore = DispatchSemaphore(value: 0)
        Task {
            await runDualAnalyzer()
            semaphore.signal()
        }
        semaphore.wait()
    default:
        fail("unknown mode \(mode) — use coexist | dual-analyzer")
    }
} else {
    fail("spike requires macOS 26 (SpeechAnalyzer)")
}
