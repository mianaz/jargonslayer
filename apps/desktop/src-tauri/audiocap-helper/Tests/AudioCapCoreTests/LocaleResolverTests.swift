import XCTest
@testable import AudioCapCore

// S11 (§Q4) — LocaleResolver's pure fallback-candidate logic (no seam,
// no async needed) plus `resolve(bcp47:)` driven through a fake
// `LocaleEquivalenceProviding` conformance — never touches
// Speech.framework/macOS 26 availability at all, matching this file's
// own header comment ("directly unit tested with a fake provider").
final class LocaleResolverTests: XCTestCase {
    /// Records every identifier it was queried with (call ORDER
    /// matters for the "stops at first match" test below) — a class
    /// (not a struct) purely so its non-`mutating` protocol witness can
    /// still append to `queriedIdentifiers` freely.
    private final class FakeLocaleProvider: LocaleEquivalenceProviding {
        private let resolutions: [String: Locale]
        private(set) var queriedIdentifiers: [String] = []

        init(resolutions: [String: Locale] = [:]) {
            self.resolutions = resolutions
        }

        func supportedLocale(equivalentTo locale: Locale) async -> Locale? {
            queriedIdentifiers.append(locale.identifier)
            return resolutions[locale.identifier]
        }
    }

    // ---- fallbackCandidates(for:) — pure ----

    func testFallbackCandidatesForASingleSubtagIsJustItself() {
        XCTAssertEqual(LocaleResolver.fallbackCandidates(for: "zh"), ["zh"])
    }

    func testFallbackCandidatesForTwoSubtagsAddsTheBareLanguage() {
        XCTAssertEqual(LocaleResolver.fallbackCandidates(for: "en-US"), ["en-US", "en"])
    }

    func testFallbackCandidatesProgressivelyBroadensFromMostToLeastSpecific() {
        XCTAssertEqual(LocaleResolver.fallbackCandidates(for: "zh-Hans-SG"), ["zh-Hans-SG", "zh-Hans", "zh"])
    }

    func testFallbackCandidatesForAnEmptyStringYieldsJustTheEmptyString() {
        XCTAssertEqual(LocaleResolver.fallbackCandidates(for: ""), [""])
    }

    // ---- resolve(bcp47:) — via the fake seam ----

    func testResolveReturnsResolvedWhenTheExactRequestedTagMatches() async {
        let provider = FakeLocaleProvider(resolutions: ["zh-Hans": Locale(identifier: "zh_CN")])
        let resolver = LocaleResolver(provider: provider)

        let resolution = await resolver.resolve(bcp47: "zh-Hans")
        XCTAssertEqual(resolution, .resolved(requested: "zh-Hans", resolved: Locale(identifier: "zh_CN")))
        XCTAssertEqual(provider.queriedIdentifiers, ["zh-Hans"], "must not query any broader fallback once the exact tag already resolved")
    }

    func testResolveFallsBackToABroaderCandidateWhenTheExactTagFails() async {
        let provider = FakeLocaleProvider(resolutions: ["zh-Hans": Locale(identifier: "zh_CN")])
        let resolver = LocaleResolver(provider: provider)

        let resolution = await resolver.resolve(bcp47: "zh-Hans-SG")
        XCTAssertEqual(resolution, .resolved(requested: "zh-Hans-SG", resolved: Locale(identifier: "zh_CN")), "requested must stay the ORIGINAL tag even though a broader candidate is what actually resolved")
        XCTAssertEqual(provider.queriedIdentifiers, ["zh-Hans-SG", "zh-Hans"])
    }

    func testResolveTriesCandidatesInOrderStoppingAtTheFirstMatch() async {
        let provider = FakeLocaleProvider(resolutions: [
            "zh-Hans": Locale(identifier: "zh_CN"),
            "zh": Locale(identifier: "zh_CN"),
        ])
        let resolver = LocaleResolver(provider: provider)

        _ = await resolver.resolve(bcp47: "zh-Hans-SG")
        XCTAssertEqual(provider.queriedIdentifiers, ["zh-Hans-SG", "zh-Hans"], "must stop at the FIRST candidate that resolves — never query 'zh' once 'zh-Hans' already matched")
    }

    func testResolveReturnsUnsupportedWhenNoCandidateEverResolves() async {
        let provider = FakeLocaleProvider(resolutions: [:])
        let resolver = LocaleResolver(provider: provider)

        let resolution = await resolver.resolve(bcp47: "xx-Yy")
        XCTAssertEqual(resolution, .unsupported(requested: "xx-Yy"))
        // Exactly 2 candidates ("xx-Yy" itself + its bare-language
        // fallback "xx") must have been tried before giving up — not
        // asserting the queried strings verbatim here: `Locale
        // (identifier:)` canonicalizes a second subtag's CASE based on
        // its inferred kind (region vs. script), e.g. "Yy" -> "YY", so
        // the exact string FakeLocaleProvider observes is Foundation's
        // own normalized form, not necessarily byte-identical to the
        // candidate `fallbackCandidates` produced — verified directly by
        // `testFallbackCandidatesProgressivelyBroadensFromMostToLeastSpecific`
        // above instead, which never round-trips through `Locale` at all.
        XCTAssertEqual(provider.queriedIdentifiers.count, 2, "every fallback candidate must have been tried before giving up")
    }

    func testResolutionEqualityIgnoresRequestedForUnsupportedMismatch() {
        XCTAssertNotEqual(LocaleResolver.Resolution.unsupported(requested: "a"), .unsupported(requested: "b"))
        XCTAssertNotEqual(
            LocaleResolver.Resolution.resolved(requested: "a", resolved: Locale(identifier: "en_US")),
            .unsupported(requested: "a")
        )
    }
}
