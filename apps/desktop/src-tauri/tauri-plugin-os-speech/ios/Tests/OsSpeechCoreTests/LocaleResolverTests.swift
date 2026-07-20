import XCTest

@testable import OsSpeechCore

final class LocaleResolverTests: XCTestCase {
  private struct FakeProvider: LocaleEquivalenceProviding {
    /// requested-candidate identifier -> resolved identifier.
    let supported: [String: String]
    func supportedLocale(equivalentTo locale: Locale) async -> Locale? {
      guard let resolved = supported[locale.identifier] else { return nil }
      return Locale(identifier: resolved)
    }
  }

  func testResolvesExactMatch() async {
    let resolver = LocaleResolver(provider: FakeProvider(supported: ["zh-Hans": "zh_CN"]))
    let result = await resolver.resolve(bcp47: "zh-Hans")
    XCTAssertEqual(result, .resolved(requested: "zh-Hans", resolved: Locale(identifier: "zh_CN")))
  }

  func testFallsBackToBroaderCandidateWhenExactTagUnsupported() async {
    // "zh-Hans-SG" itself isn't in the fake provider's supported map,
    // but its script-level parent "zh-Hans" is.
    let resolver = LocaleResolver(provider: FakeProvider(supported: ["zh-Hans": "zh_CN"]))
    let result = await resolver.resolve(bcp47: "zh-Hans-SG")
    XCTAssertEqual(result, .resolved(requested: "zh-Hans-SG", resolved: Locale(identifier: "zh_CN")))
  }

  func testUnsupportedWhenNoCandidateResolves() async {
    let resolver = LocaleResolver(provider: FakeProvider(supported: [:]))
    let result = await resolver.resolve(bcp47: "zh-Yue")
    XCTAssertEqual(result, .unsupported(requested: "zh-Yue"))
  }

  func testFallbackCandidatesProgressivelyDropTrailingSubtags() {
    XCTAssertEqual(LocaleResolver.fallbackCandidates(for: "zh-Hans-SG"), ["zh-Hans-SG", "zh-Hans", "zh"])
    XCTAssertEqual(LocaleResolver.fallbackCandidates(for: "en-US"), ["en-US", "en"])
    XCTAssertEqual(LocaleResolver.fallbackCandidates(for: "zh"), ["zh"])
  }

  func testFallbackCandidatesNeverEmptyEvenForMalformedInput() {
    XCTAssertEqual(LocaleResolver.fallbackCandidates(for: ""), [""])
  }
}
