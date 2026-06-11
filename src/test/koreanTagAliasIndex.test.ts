import { describe, it, expect } from "vitest";
import {
  EMPTY_KOREAN_TAG_ALIAS_INDEX,
  buildKoreanTagAliasIndex,
} from "@/lib/koreanTagAliasIndex";
import type { ReferenceItem } from "@/lib/referenceLibrary";
import type { TagSeedEntry } from "@/lib/koreanTagSeedDictionary";

function makeRef(over: Partial<ReferenceItem>): ReferenceItem {
  return {
    id: over.id ?? "ref",
    kind: over.kind ?? "image",
    title: over.title ?? "Untitled",
    tags: over.tags ?? [],
    timestamp_notes: [],
    color_palette: [],
    ...over,
  } as ReferenceItem;
}

describe("buildKoreanTagAliasIndex", () => {
  it("returns an empty index for items with no AI suggestions", () => {
    const idx = buildKoreanTagAliasIndex([
      makeRef({ id: "a", tags: ["sunset"] }),
      makeRef({ id: "b", tags: ["야경"] }),
    ]);
    expect(idx.hasData).toBe(false);
    expect(idx.lookupTags("야경")).toEqual([]);
    expect(idx.koAliasesFor("sunset")).toEqual([]);
  });

  it("aggregates parallel EN/KO tag arrays from ai_suggestions", () => {
    const items = [
      makeRef({
        id: "a",
        ai_suggestions: {
          suggested_tags: ["nightscape", "city"],
          suggested_tags_ko: ["야경", "도시"],
          mood_labels: [],
          use_cases: [],
        },
      }),
      makeRef({
        id: "b",
        ai_suggestions: {
          suggested_tags: ["nightscape", "neon"],
          suggested_tags_ko: ["야경", "네온"],
          mood_labels: [],
          use_cases: [],
        },
      }),
    ];
    const idx = buildKoreanTagAliasIndex(items);
    expect(idx.hasData).toBe(true);
    const hits = idx.lookupTags("야경");
    expect(hits.map((h) => h.tag)).toEqual(["nightscape"]);
    expect(hits[0]!.count).toBe(2);
    expect(hits[0]!.aliases).toEqual(["야경"]);
  });

  it("sorts candidates by frequency desc, then alpha asc", () => {
    const items = [
      makeRef({
        id: "a",
        ai_suggestions: {
          suggested_tags: ["alpha", "beta"],
          suggested_tags_ko: ["야경", "야경"],
          mood_labels: [],
          use_cases: [],
        },
      }),
      makeRef({
        id: "b",
        ai_suggestions: {
          suggested_tags: ["beta"],
          suggested_tags_ko: ["야경"],
          mood_labels: [],
          use_cases: [],
        },
      }),
    ];
    const idx = buildKoreanTagAliasIndex(items);
    const hits = idx.lookupTags("야경");
    expect(hits.map((h) => h.tag)).toEqual(["beta", "alpha"]);
    expect(hits[0]!.count).toBe(2);
    expect(hits[1]!.count).toBe(1);
  });

  it("matches forward substring: query as substring of stored alias", () => {
    const items = [
      makeRef({
        id: "a",
        ai_suggestions: {
          suggested_tags: ["nightscape"],
          suggested_tags_ko: ["야경 풍경"],
          mood_labels: [],
          use_cases: [],
        },
      }),
    ];
    const idx = buildKoreanTagAliasIndex(items);
    expect(idx.lookupTags("야경").map((h) => h.tag)).toEqual(["nightscape"]);
  });

  it("matches reverse substring: stored alias inside a longer user query", () => {
    const items = [
      makeRef({
        id: "a",
        ai_suggestions: {
          suggested_tags: ["nightscape"],
          suggested_tags_ko: ["야경"],
          mood_labels: [],
          use_cases: [],
        },
      }),
    ];
    const idx = buildKoreanTagAliasIndex(items);
    expect(idx.lookupTags("밤거리 야경").map((h) => h.tag)).toEqual(["nightscape"]);
  });

  it("returns empty for non-hangul query (English path is handled by callers)", () => {
    const items = [
      makeRef({
        id: "a",
        ai_suggestions: {
          suggested_tags: ["nightscape"],
          suggested_tags_ko: ["야경"],
          mood_labels: [],
          use_cases: [],
        },
      }),
    ];
    const idx = buildKoreanTagAliasIndex(items);
    expect(idx.lookupTags("nightscape")).toEqual([]);
    expect(idx.lookupTags("")).toEqual([]);
  });

  it("aggregates mood_labels separately from suggested_tags", () => {
    const items = [
      makeRef({
        id: "a",
        ai_suggestions: {
          suggested_tags: ["nightscape"],
          suggested_tags_ko: ["야경"],
          mood_labels: ["dreamy"],
          mood_labels_ko: ["몽환적"],
          use_cases: [],
        },
      }),
    ];
    const idx = buildKoreanTagAliasIndex(items);
    expect(idx.lookupTags("몽환")).toEqual([]);
    expect(idx.lookupMoods("몽환").map((h) => h.tag)).toEqual(["dreamy"]);
    expect(idx.lookupMoods("야경")).toEqual([]);
  });

  it("ignores parallel arrays of mismatched lengths beyond the shorter side", () => {
    const items = [
      makeRef({
        id: "a",
        ai_suggestions: {
          suggested_tags: ["nightscape", "neon", "city"],
          suggested_tags_ko: ["야경"],
          mood_labels: [],
          use_cases: [],
        },
      }),
    ];
    const idx = buildKoreanTagAliasIndex(items);
    expect(idx.lookupTags("야경").map((h) => h.tag)).toEqual(["nightscape"]);
    expect(idx.lookupTags("네온")).toEqual([]);
  });

  it("skips pairs where EN slot contains hangul or KO slot contains no hangul", () => {
    const items = [
      makeRef({
        id: "a",
        ai_suggestions: {
          suggested_tags: ["야경", "valid"],
          suggested_tags_ko: ["야경", "유효"],
          mood_labels: [],
          use_cases: [],
        },
      }),
      makeRef({
        id: "b",
        ai_suggestions: {
          suggested_tags: ["nope"],
          suggested_tags_ko: ["english"],
          mood_labels: [],
          use_cases: [],
        },
      }),
    ];
    const idx = buildKoreanTagAliasIndex(items);
    expect(idx.lookupTags("유효").map((h) => h.tag)).toEqual(["valid"]);
    expect(idx.lookupTags("야경")).toEqual([]);
    expect(idx.lookupTags("nope")).toEqual([]);
  });

  it("normalizes case before storage and lookup", () => {
    const items = [
      makeRef({
        id: "a",
        ai_suggestions: {
          suggested_tags: ["NightScape"],
          suggested_tags_ko: ["야경"],
          mood_labels: [],
          use_cases: [],
        },
      }),
    ];
    const idx = buildKoreanTagAliasIndex(items);
    expect(idx.lookupTags("야경").map((h) => h.tag)).toEqual(["nightscape"]);
    expect(idx.koAliasesFor("NIGHTSCAPE")).toEqual(["야경"]);
  });

  it("koAliasesFor returns known KO aliases for a canonical EN tag, freq desc", () => {
    const items = [
      makeRef({
        id: "a",
        ai_suggestions: {
          suggested_tags: ["nightscape", "nightscape"],
          suggested_tags_ko: ["야경", "야간경관"],
          mood_labels: [],
          use_cases: [],
        },
      }),
      makeRef({
        id: "b",
        ai_suggestions: {
          suggested_tags: ["nightscape"],
          suggested_tags_ko: ["야경"],
          mood_labels: [],
          use_cases: [],
        },
      }),
    ];
    const idx = buildKoreanTagAliasIndex(items);
    expect(idx.koAliasesFor("nightscape")).toEqual(["야경", "야간경관"]);
  });
});

describe("buildKoreanTagAliasIndex with seed dictionary", () => {
  const carSeed: TagSeedEntry = {
    family: "transport",
    ko: ["자동차", "차", "차량"],
    en: ["car", "vehicle", "automobile"],
  };
  const skySeed: TagSeedEntry = {
    family: "nature",
    ko: ["하늘"],
    en: ["sky"],
  };
  const dreamyMoodSeed: TagSeedEntry = {
    family: "mood",
    ko: ["몽환적"],
    en: ["dreamy"],
  };

  it("returns seed-only candidates when library has no AI suggestions", () => {
    const idx = buildKoreanTagAliasIndex([], { seedDictionary: [carSeed] });
    expect(idx.hasData).toBe(true);
    const hits = idx.lookupTags("자동차").map((h) => h.tag);
    expect(hits).toContain("car");
    expect(hits).toContain("vehicle");
    expect(hits).toContain("automobile");
  });

  it("any KO synonym in the seed entry resolves to all EN variants", () => {
    const idx = buildKoreanTagAliasIndex([], { seedDictionary: [carSeed] });
    const carHits = idx.lookupTags("자동차").map((h) => h.tag).sort();
    const vehicleHits = idx.lookupTags("차량").map((h) => h.tag).sort();
    expect(vehicleHits).toEqual(carHits);
  });

  it("merges library frequency with seed entries for the same EN token", () => {
    const items = [
      makeRef({
        id: "a",
        ai_suggestions: {
          suggested_tags: ["car"],
          suggested_tags_ko: ["자동차"],
          mood_labels: [],
          use_cases: [],
        },
      }),
    ];
    const idx = buildKoreanTagAliasIndex(items, { seedDictionary: [carSeed] });
    const hits = idx.lookupTags("자동차");
    const car = hits.find((h) => h.tag === "car");
    expect(car?.count).toBeGreaterThan(1);
  });

  it("routes seed entries with family='mood' into mood bucket only", () => {
    const idx = buildKoreanTagAliasIndex([], { seedDictionary: [dreamyMoodSeed] });
    expect(idx.lookupTags("몽환적")).toEqual([]);
    expect(idx.lookupMoods("몽환적").map((h) => h.tag)).toEqual(["dreamy"]);
  });

  it("inventoryFilter: drops EN candidates not present in the library inventory", () => {
    const idx = buildKoreanTagAliasIndex([], {
      seedDictionary: [carSeed],
      inventoryFilter: new Set(["vehicle"]),
    });
    expect(idx.lookupTags("자동차").map((h) => h.tag)).toEqual(["vehicle"]);
  });

  it("inventoryFilter empty → all seed candidates pass (no dead-end guard)", () => {
    const idx = buildKoreanTagAliasIndex([], {
      seedDictionary: [skySeed],
      inventoryFilter: new Set<string>(),
    });
    expect(idx.lookupTags("하늘").map((h) => h.tag)).toContain("sky");
  });

  it("inventoryFilter blocks all seed EN → returns empty without family expansion", () => {
    const idx = buildKoreanTagAliasIndex([], {
      seedDictionary: [carSeed],
      inventoryFilter: new Set(["airplane"]),
    });
    expect(idx.lookupTags("자동차")).toEqual([]);
  });

  it("expandToInventoryFamily: substitutes seed EN with library family variant ('car' → 'sports-car')", () => {
    const idx = buildKoreanTagAliasIndex([], {
      seedDictionary: [carSeed],
      inventoryFilter: new Set(["sports-car", "racing-car"]),
      expandToInventoryFamily: true,
    });
    const hits = idx.lookupTags("자동차").map((h) => h.tag).sort();
    expect(hits).toEqual(["racing-car", "sports-car"]);
  });

  it("family expansion respects word boundaries — 'car' does NOT match 'carpet'", () => {
    const idx = buildKoreanTagAliasIndex([], {
      seedDictionary: [carSeed],
      inventoryFilter: new Set(["carpet", "carbon"]),
      expandToInventoryFamily: true,
    });
    expect(idx.lookupTags("자동차")).toEqual([]);
  });

  it("family expansion still prefers exact inventory match over substring family", () => {
    const idx = buildKoreanTagAliasIndex([], {
      seedDictionary: [carSeed],
      inventoryFilter: new Set(["car", "sports-car"]),
      expandToInventoryFamily: true,
    });
    const hits = idx.lookupTags("자동차").map((h) => h.tag);
    expect(hits).toContain("car");
    /* sports-car 는 'car' 시드의 가족이지만 exact match 가 있으면 가족
       확장은 건너뛴다 (per-seed early return). */
    expect(hits).not.toContain("sports-car");
  });

  it("seedWeight scales how strongly seed entries boost a candidate count", () => {
    const idx = buildKoreanTagAliasIndex([], {
      seedDictionary: [carSeed],
      seedWeight: 3,
    });
    const hits = idx.lookupTags("자동차");
    const car = hits.find((h) => h.tag === "car");
    expect(car?.count).toBeGreaterThanOrEqual(3);
  });

  it("filters out non-hangul ko entries and hangul en entries from seed", () => {
    const malformed: TagSeedEntry = {
      ko: ["car", "자동차"],
      en: ["자동차", "car"],
    };
    const idx = buildKoreanTagAliasIndex([], { seedDictionary: [malformed] });
    const hits = idx.lookupTags("자동차").map((h) => h.tag);
    expect(hits).toEqual(["car"]);
  });
});

describe("buildKoreanTagAliasIndex per-category inventory filters", () => {
  /* 회귀 가드 — 과거: 단일 `inventoryFilter = new Set([...tags, ...moodLabels])`
     를 양 lookup 모두에 적용해서, mood 시드(`family: "mood" / en: "cute"`) 가
     "cute" 가 tag 인벤토리에 존재한다는 이유로 추천 무드 칩에 통과 →
     사용자가 그 무드 칩을 클릭 → moodsFilter.include 에 "cute" 가 들어가지만
     mood 칩 피커에는 라벨이 없어 사라진 것처럼 보이는 회귀가 있었다. 이제는
     tag/moodInventoryFilter 를 카테고리별로 분리 전달해 차단된다. */

  const cuteMoodSeed: TagSeedEntry = {
    family: "mood",
    ko: ["귀여운", "큐트한"],
    en: ["cute"],
  };
  const dreamyMoodSeed: TagSeedEntry = {
    family: "mood",
    ko: ["몽환적"],
    en: ["dreamy"],
  };
  const skyTagSeed: TagSeedEntry = {
    family: "nature",
    ko: ["하늘"],
    en: ["sky"],
  };

  it("moodInventoryFilter blocks mood seed EN that only exists in tag inventory", () => {
    /* 라이브러리 상황: "cute" 는 suggested_tags 에는 있지만 mood_labels 에는
       없다 — 추천 무드 칩으로 "cute" 가 나오면 클릭 후 dead-end. */
    const idx = buildKoreanTagAliasIndex([], {
      seedDictionary: [cuteMoodSeed],
      tagInventoryFilter: new Set(["cute", "sky"]),
      moodInventoryFilter: new Set(["dreamy"]),
    });
    expect(idx.lookupMoods("귀여운")).toEqual([]);
    /* mood family 시드는 tag 버킷에 들어가지 않으므로 tag lookup 도 비어야
       정상 — 카테고리 분리 라우팅이 깨지지 않았는지 동시 확인. */
    expect(idx.lookupTags("귀여운")).toEqual([]);
  });

  it("tagInventoryFilter blocks tag seed EN that only exists in mood inventory", () => {
    /* 대칭 가드 — tag 시드의 EN 이 mood_labels 에만 있고 suggested_tags 에는
       없으면 tag 추천 칩에서도 컷되어야 한다. */
    const idx = buildKoreanTagAliasIndex([], {
      seedDictionary: [skyTagSeed],
      tagInventoryFilter: new Set(["forest"]),
      moodInventoryFilter: new Set(["sky"]),
    });
    expect(idx.lookupTags("하늘")).toEqual([]);
    expect(idx.lookupMoods("하늘")).toEqual([]);
  });

  it("each category passes its own seed through when its own inventory contains the EN", () => {
    const idx = buildKoreanTagAliasIndex([], {
      seedDictionary: [cuteMoodSeed, skyTagSeed],
      tagInventoryFilter: new Set(["sky"]),
      moodInventoryFilter: new Set(["cute"]),
    });
    expect(idx.lookupTags("하늘").map((h) => h.tag)).toEqual(["sky"]);
    expect(idx.lookupMoods("귀여운").map((h) => h.tag)).toEqual(["cute"]);
  });

  it("falls back to legacy single inventoryFilter when category filters are omitted", () => {
    /* 하위호환 — 기존 호출부(legacy `inventoryFilter` 한 셋) 가 깨지지 않도록.
       두 카테고리 모두 같은 통합 셋으로 가드되어야 한다. */
    const idx = buildKoreanTagAliasIndex([], {
      seedDictionary: [cuteMoodSeed, skyTagSeed],
      inventoryFilter: new Set(["cute", "sky"]),
    });
    expect(idx.lookupTags("하늘").map((h) => h.tag)).toEqual(["sky"]);
    expect(idx.lookupMoods("귀여운").map((h) => h.tag)).toEqual(["cute"]);
  });

  it("category filter takes precedence over legacy inventoryFilter when both are provided", () => {
    /* 마이그레이션 전환점 보호 — 호출부가 점진적으로 분리 필터를 도입할 때
       legacy 셋이 더 관대해도 카테고리 셋이 더 좁으면 좁은 쪽이 이긴다. */
    const idx = buildKoreanTagAliasIndex([], {
      seedDictionary: [cuteMoodSeed],
      inventoryFilter: new Set(["cute", "sky"]),
      moodInventoryFilter: new Set(["dreamy"]),
    });
    expect(idx.lookupMoods("귀여운")).toEqual([]);
  });

  it("expandToInventoryFamily uses each category's own inventory for family lookup", () => {
    /* mood 시드 "dreamy" 가 정확 일치는 없고, mood 인벤토리에 가족 변형
       "dreamy-haze" 가 있으면 mood lookup 만 그것으로 대체되고, tag 인벤토리
       의 "dreamy-tag-only" 같은 잡음에는 mood 쪽이 끌려가지 않아야 한다. */
    const idx = buildKoreanTagAliasIndex([], {
      seedDictionary: [dreamyMoodSeed],
      tagInventoryFilter: new Set(["dreamy-tag-only"]),
      moodInventoryFilter: new Set(["dreamy-haze"]),
      expandToInventoryFamily: true,
    });
    expect(idx.lookupMoods("몽환적").map((h) => h.tag)).toEqual(["dreamy-haze"]);
    expect(idx.lookupTags("몽환적")).toEqual([]);
  });
});

describe("EMPTY_KOREAN_TAG_ALIAS_INDEX", () => {
  it("is safe to call without items", () => {
    expect(EMPTY_KOREAN_TAG_ALIAS_INDEX.hasData).toBe(false);
    expect(EMPTY_KOREAN_TAG_ALIAS_INDEX.lookupTags("야경")).toEqual([]);
    expect(EMPTY_KOREAN_TAG_ALIAS_INDEX.lookupMoods("야경")).toEqual([]);
    expect(EMPTY_KOREAN_TAG_ALIAS_INDEX.koAliasesFor("nightscape")).toEqual([]);
    expect(EMPTY_KOREAN_TAG_ALIAS_INDEX.koAliasesForMood("dreamy")).toEqual([]);
  });
});
