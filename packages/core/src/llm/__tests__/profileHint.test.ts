import { describe, expect, it } from "vitest";
import type { Settings } from "../../types";
import {
  PROFILE_FIELD_MAX_CHARS,
  PROFILE_HINT_MAX_CHARS,
  renderProfileHint,
} from "../profileHint";

type Profile = NonNullable<Settings["profile"]>;

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return { enabled: true, ...overrides };
}

describe("renderProfileHint — enabled gate", () => {
  it("returns undefined when profile is undefined", () => {
    expect(renderProfileHint(undefined)).toBeUndefined();
  });

  it("returns undefined when enabled: false, even with every field populated", () => {
    expect(
      renderProfileHint({
        enabled: false,
        industry: "互联网",
        role: "产品经理",
        englishLevel: "intermediate",
        familiarDomains: "云计算",
        weakDomains: "法务",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when enabled: true but every field is empty/absent", () => {
    expect(renderProfileHint(makeProfile())).toBeUndefined();
  });

  it("returns undefined when fields are present but blank/whitespace-only", () => {
    expect(
      renderProfileHint(makeProfile({ industry: "   ", role: "" })),
    ).toBeUndefined();
  });
});

describe("renderProfileHint — field rendering", () => {
  it("renders industry, role, englishLevel, familiarDomains, weakDomains, joined by '；'", () => {
    const hint = renderProfileHint(
      makeProfile({
        industry: "互联网",
        role: "产品经理",
        englishLevel: "intermediate",
        familiarDomains: "云计算",
        weakDomains: "法务",
      }),
    );
    expect(hint).toBe("行业：互联网；角色：产品经理；英语水平：中级；熟悉领域：云计算；薄弱领域：法务");
  });

  it("renders each englishLevel to its zh label", () => {
    expect(renderProfileHint(makeProfile({ englishLevel: "basic" }))).toBe("英语水平：初级");
    expect(renderProfileHint(makeProfile({ englishLevel: "intermediate" }))).toBe("英语水平：中级");
    expect(renderProfileHint(makeProfile({ englishLevel: "advanced" }))).toBe("英语水平：高级");
  });

  it("omits fields that are absent — partial profile renders only the present fields", () => {
    expect(renderProfileHint(makeProfile({ industry: "金融" }))).toBe("行业：金融");
    expect(renderProfileHint(makeProfile({ role: "工程师", weakDomains: "合规" }))).toBe(
      "角色：工程师；薄弱领域：合规",
    );
  });

  it("trims surrounding whitespace on free-text fields", () => {
    expect(renderProfileHint(makeProfile({ industry: "  金融  " }))).toBe("行业：金融");
  });
});

describe("renderProfileHint — truncation caps (design Q5)", () => {
  it("truncates a free-text field longer than PROFILE_FIELD_MAX_CHARS to exactly that length", () => {
    const long = "字".repeat(PROFILE_FIELD_MAX_CHARS + 20);
    const hint = renderProfileHint(makeProfile({ industry: long }));
    expect(hint).toBe(`行业：${"字".repeat(PROFILE_FIELD_MAX_CHARS)}`);
  });

  it("a field at exactly PROFILE_FIELD_MAX_CHARS is not truncated", () => {
    const exact = "字".repeat(PROFILE_FIELD_MAX_CHARS);
    const hint = renderProfileHint(makeProfile({ industry: exact }));
    expect(hint).toBe(`行业：${exact}`);
  });

  it("the assembled hint never exceeds PROFILE_HINT_MAX_CHARS even with every field maxed out", () => {
    const long = "字".repeat(PROFILE_FIELD_MAX_CHARS);
    const hint = renderProfileHint(
      makeProfile({
        industry: long,
        role: long,
        englishLevel: "advanced",
        familiarDomains: long,
        weakDomains: long,
      }),
    );
    expect(hint).toBeDefined();
    expect(hint!.length).toBeLessThanOrEqual(PROFILE_HINT_MAX_CHARS);
  });
});
