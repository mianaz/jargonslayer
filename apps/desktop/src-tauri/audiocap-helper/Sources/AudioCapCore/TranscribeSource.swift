// Dual-capture mic producer — the CLI's own `--source` value for
// `--transcribe` (mic|system|dual). `RawRepresentable(String)` makes
// `TranscribeSource(rawValue:)` itself the small pure parse function
// this slice's own test list asks for (mirrors LocaleResolver.swift's
// own "pure, no seam/async needed — directly testable" posture one file
// over, just via the compiler-synthesized initializer rather than a
// hand-rolled one): it already returns `nil` for anything outside this
// closed set, exactly the "validation error for unknown values"
// main.swift's own `parseArguments` needs, with no bespoke parsing code
// to maintain. The DEFAULT ("system", when `--source` is absent) is
// main.swift's own call, not this type's — a bare String-backed enum
// has no way to express "and here's what missing means" on its own.
public enum TranscribeSource: String {
    case system
    case mic
    case dual
}
