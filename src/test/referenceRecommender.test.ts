import { describe, it, expect } from "vitest";
import {
  buildBriefSignalsFromAnalysis,
  buildReferenceTokenInventory,
  extractSceneSignals,
  hasInventoryMatch,
  scoreReferences,
  tokenize,
} from "@/lib/referenceRecommender";
import type { ReferenceItem } from "@/lib/referenceLibrary";

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

describe("referenceRecommender.scoreReferences", () => {
  it("user-tagged matches outscore AI-suggested matches with the same overlap", () => {
    const userTagged = makeRef({
      id: "user",
      title: "Neon Tokyo Street",
      tags: ["neon", "tokyo"],
    });
    const aiTagged = makeRef({
      id: "ai",
      title: "Some name",
      tags: [],
      ai_suggestions: { suggested_tags: ["neon", "tokyo"], mood_labels: [], use_cases: [] },
    });
    const signals = buildBriefSignalsFromAnalysis({
      toneKeywords: ["neon", "tokyo"],
      moodSummary: "",
    });
    const ranked = scoreReferences(signals, [userTagged, aiTagged]);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.item.id).toBe("user");
  });

  it("returns empty when all signal buckets are empty", () => {
    const item = makeRef({ id: "x", tags: ["neon"] });
    const ranked = scoreReferences(
      { mood: [], genre: [], product: [], location: [], lighting: [], camera: [], keywords: [] },
      [item],
    );
    expect(ranked).toEqual([]);
  });

  it("excludes deleted references and items in excludeIds", () => {
    const trashed = makeRef({ id: "trashed", tags: ["neon"], deleted_at: new Date().toISOString() });
    const attached = makeRef({ id: "attached", tags: ["neon"] });
    const fresh = makeRef({ id: "fresh", tags: ["neon"] });
    const signals = buildBriefSignalsFromAnalysis({ toneKeywords: ["neon"] });
    const ranked = scoreReferences(signals, [trashed, attached, fresh], {
      excludeIds: new Set(["attached"]),
    });
    expect(ranked.map((r) => r.item.id)).toEqual(["fresh"]);
  });

  it("emits reason chips with the matching signal category prefix", () => {
    const item = makeRef({ id: "a", tags: ["handheld"] });
    const sceneSignals = extractSceneSignals({ shot: ["handheld"] });
    const ranked = scoreReferences(sceneSignals, [item]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.reasons).toContain("shot:handheld");
  });

  it("link references are excluded from default kind whitelist", () => {
    const link = makeRef({ id: "link", kind: "link", tags: ["neon"] });
    const signals = buildBriefSignalsFromAnalysis({ toneKeywords: ["neon"] });
    expect(scoreReferences(signals, [link])).toEqual([]);
  });

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   *  v2 — Cross-bucket dedup + weak-token penalty + strict gates
   *  (AI Search 정확도 개선 — "총격씬에 참고할만한 레퍼런스" 류 false-positive 차단)
   * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  it("cross-bucket dedup: same token in multiple signal categories scores at most once per reference", () => {
    /* 과거 버그: signal 의 mood + keywords + camera 에 동일 토큰("shootout") 이
       들어가면 자료의 user-tag "shootout" 하나가 1.0 × 3 = 3.0 으로 인플레이션.
       v2 dedup 후엔 (이 자료, "shootout") 쌍이 최대 1번만 점수에 기여 → 1.0.
       weak 토큰이 아닌 strong 토큰이라 weight 그대로. */
    const item = makeRef({ id: "shootout", title: "Action", tags: ["shootout"] });
    const ranked = scoreReferences(
      {
        mood: ["shootout"],
        genre: [],
        product: [],
        location: [],
        lighting: [],
        camera: ["shootout"],
        keywords: ["shootout"],
      },
      [item],
      { minScore: 0.5 },
    );
    expect(ranked).toHaveLength(1);
    /* 1.0 (user-tag weight) ± recencyBonus. recencyBonus 는 last_used_at
       없으면 0 이므로 정확히 1.0. */
    expect(ranked[0]!.score).toBeCloseTo(1.0, 5);
  });

  it("weak generic tokens contribute at reduced weight (×0.3)", () => {
    /* "action" 같은 generic 토큰은 매치돼도 weight × 0.3 패널티. 같은
       overlap 이라도 strong 토큰("shootout") 보다 점수가 훨씬 낮다. */
    const weakItem = makeRef({ id: "weak", tags: ["action"] });
    const strongItem = makeRef({ id: "strong", tags: ["shootout"] });
    const ranked = scoreReferences(
      {
        mood: [],
        genre: [],
        product: [],
        location: [],
        lighting: [],
        camera: [],
        keywords: ["action", "shootout"],
      },
      [weakItem, strongItem],
      { minScore: 0.2 },
    );
    const strong = ranked.find((r) => r.item.id === "strong");
    const weak = ranked.find((r) => r.item.id === "weak");
    expect(strong).toBeDefined();
    expect(weak).toBeDefined();
    /* strong (1.0) > weak (1.0 × 0.3 = 0.3). recencyBonus 는 둘 다 0. */
    expect(strong!.score).toBeGreaterThan(weak!.score);
    expect(weak!.score).toBeCloseTo(0.3, 5);
  });

  it("strict mode: anchor token must match a high-weight ref bucket directly (v3 coupled gate)", () => {
    /* v3 핵심 회귀 가드 — v2 까지는 anchor 매치(어떤 ref bucket 이든) 와
       high-weight 매치(어떤 sig 토큰이든) 가 독립 OR 였다. 그래서:
         · anchor 토큰 "neon" 이 title(weight 0.5) 에 매치 → anchor: YES
         · 비-anchor 토큰 "character" 가 user_tag(weight 1.0) 에 매치 → high-weight: YES
       두 게이트가 다른 토큰으로 채워져서 무관한 자료가 통과되던 백도어.
       v3 결합 게이트는 *같은 토큰* 이 anchor 이면서 high-weight bucket
       매치여야 한다 → 이 자료는 탈락한다. */
    const trap = makeRef({
      id: "decoy",
      title: "neon nights demo reel", // anchor "neon" 이 매치되지만 weight 0.5 (저)
      tags: ["character"], // high-weight 1.0, 그러나 anchor 토큰 아님
    });
    /* 비교군: anchor "neon" 이 user_tag (high-weight) 에 직접 매치 → 통과. */
    const direct = makeRef({ id: "direct", tags: ["neon"] });
    const ranked = scoreReferences(
      {
        mood: [],
        genre: ["character"], // genre 는 anchor 카테고리 아님
        product: [],
        location: [],
        lighting: [],
        camera: [],
        keywords: ["neon"],
      },
      [trap, direct],
      { minScore: 0.3, strict: true },
    );
    expect(ranked.map((r) => r.item.id)).toEqual(["direct"]);
  });

  it("strict mode: lighting category counts as anchor (e.g. 'neon' style queries)", () => {
    /* v3 확장 — "네온" 같은 조명 미학이 곧 사용자 의도인 케이스 커버.
       lighting 카테고리의 토큰이 자료의 high-weight bucket (여기선 user_tag)
       에 직접 매치되면 strict 통과. v2 까지는 lighting 이 anchor 가 아니라
       이런 자료가 다른 약한 매치 없으면 탈락했다. */
    const item = makeRef({ id: "neon-lit", tags: ["neon"] });
    const ranked = scoreReferences(
      {
        mood: [],
        genre: [],
        product: [],
        location: [],
        lighting: ["neon"],
        camera: [],
        keywords: [],
      },
      [item],
      { minScore: 0.3, strict: true },
    );
    expect(ranked.map((r) => r.item.id)).toEqual(["neon-lit"]);
  });

  it("strict mode: product category counts as anchor (brand-specific queries)", () => {
    /* v3 확장 — 사용자가 "포카리스웨트 광고" 처럼 product 이름을 명시한
       경우 product 토큰이 자료의 핵심 메타에 들어 있어야 통과. */
    const item = makeRef({
      id: "pocari-ad",
      ai_suggestions: {
        suggested_tags: ["beverage"],
        mood_labels: ["refreshing"],
        use_cases: ["pocari sweat ad"], // weight 0.9 (high)
      },
    });
    const ranked = scoreReferences(
      {
        mood: [],
        genre: [],
        product: ["pocari", "sweat"],
        location: [],
        lighting: [],
        camera: [],
        keywords: [],
      },
      [item],
      { minScore: 0.3, strict: true },
    );
    expect(ranked.map((r) => r.item.id)).toEqual(["pocari-ad"]);
  });

  it("strict mode: camera/location/genre are NOT anchors on their own", () => {
    /* camera/location/genre 만 매치되는 자료는 사용자 의도가 명확히 잡혔다고
       보기 어려워 strict 통과 불가. anchor 카테고리(mood/keywords/lighting/
       product) 의 매치가 별도로 있어야 한다. */
    const camOnly = makeRef({ id: "cam-only", tags: ["handheld"] });
    const ranked = scoreReferences(
      {
        mood: [],
        genre: [],
        product: [],
        location: [],
        lighting: [],
        camera: ["handheld"],
        keywords: [],
      },
      [camOnly],
      { minScore: 0.3, strict: true },
    );
    expect(ranked).toEqual([]);
  });

  it("strict mode: title-only match fails (high-weight gate)", () => {
    /* anchor 토큰(keywords 의 "shootout") 이 있어도 매치되는 ref bucket 이
       title (0.5) 뿐이면 결합 게이트 탈락 — title 은 high-weight 가 아니다.
       반대로 user-tag (1.0) 에 매치되면 통과. */
    const titleOnly = makeRef({ id: "title-only", title: "shootout demo reel" });
    const tagged = makeRef({ id: "tagged", tags: ["shootout"] });
    const ranked = scoreReferences(
      {
        mood: [],
        genre: [],
        product: [],
        location: [],
        lighting: [],
        camera: [],
        keywords: ["shootout"],
      },
      [titleOnly, tagged],
      { minScore: 0.3, strict: true },
    );
    expect(ranked.map((r) => r.item.id)).toEqual(["tagged"]);
  });

  it("strict mode OFF preserves previous broad matching (still benefits from dedup)", () => {
    /* strict: false 면 결합 게이트 미적용. title 매치만으로도 임계 통과
       가능. (단, dedup + weak penalty 는 여전히 적용.) */
    const titleOnly = makeRef({ id: "title-only", title: "shootout demo reel" });
    const ranked = scoreReferences(
      {
        mood: [],
        genre: [],
        product: [],
        location: [],
        lighting: [],
        camera: [],
        keywords: ["shootout"],
      },
      [titleOnly],
      { minScore: 0.3, strict: false },
    );
    expect(ranked.map((r) => r.item.id)).toEqual(["title-only"]);
  });

  it("weak anchor tokens alone do not satisfy strict mode", () => {
    /* anchor 카테고리(mood/keywords/lighting/product) 안에 weak 토큰
       ("action", "scene") 만 있으면 anchor 후보 집합이 비어버려 탈락.
       strong anchor 가 함께 있어야 통과. */
    const item = makeRef({ id: "weak-anchor", tags: ["action", "scene"] });
    const ranked = scoreReferences(
      {
        mood: ["action"],
        genre: [],
        product: [],
        location: [],
        lighting: [],
        camera: [],
        keywords: ["scene"],
      },
      [item],
      { minScore: 0.1, strict: true },
    );
    expect(ranked).toEqual([]);
  });

  it("reasons prioritize strong tokens over weak tokens", () => {
    /* reason 칩(최대 4 슬롯) 은 사용자에게 보이는 정보라, weak 토큰 ("action")
       보다 strong 토큰("shootout") 이 앞에 와야 노이즈가 적다. */
    const item = makeRef({
      id: "mix",
      tags: ["action", "shootout", "fight", "smoke"],
    });
    const ranked = scoreReferences(
      {
        mood: [],
        genre: [],
        product: [],
        location: [],
        lighting: [],
        camera: [],
        keywords: ["action", "shootout", "fight", "smoke"],
      },
      [item],
      { minScore: 0.1 },
    );
    expect(ranked).toHaveLength(1);
    const reasons = ranked[0]!.reasons;
    /* strong 토큰들이 reason 앞쪽에 와야 한다 (정확한 순서는 Map 입력 순서를
       따라가지만 weak 가 뒤로 가는 것은 보장). */
    const actionIdx = reasons.findIndex((r) => r.endsWith(":action"));
    const shootoutIdx = reasons.findIndex((r) => r.endsWith(":shootout"));
    if (actionIdx !== -1 && shootoutIdx !== -1) {
      expect(shootoutIdx).toBeLessThan(actionIdx);
    }
  });

  it("scene_description with Korean particle suffix matches noun-only query", () => {
    /* 회귀 가드 — scene_description_ko 에 "청바지를 입은 인물..." 처럼
       조사가 붙은 명사가 들어 있을 때, 사용자 쿼리 "청바지" 와 exact-token
       intersect 가 0 으로 떨어지던 버그. tokenize 가 stem 까지 emit 하면서
       매칭에 잡혀야 한다. scene_description 가중치(1.0) 단독 매칭 1 건만
       으로도 scoreReferences default minScore(0.5) 통과. */
    const item = makeRef({
      id: "jeans",
      title: "Street portrait",
      ai_suggestions: {
        suggested_tags: ["portrait"],
        mood_labels: [],
        use_cases: [],
        scene_description_ko: "도시 거리에서 청바지를 입은 젊은 여성이 카페에 앉아 있다.",
      },
    });
    const noise = makeRef({
      id: "noise",
      title: "Mountain",
      ai_suggestions: { suggested_tags: ["landscape"], mood_labels: [], use_cases: [] },
    });
    const signals = buildBriefSignalsFromAnalysis({ toneKeywords: ["청바지"] });
    const ranked = scoreReferences(signals, [item, noise]);
    expect(ranked.map((r) => r.item.id)).toContain("jeans");
    expect(ranked.map((r) => r.item.id)).not.toContain("noise");
  });
});

describe("referenceRecommender.tokenize", () => {
  it("preserves both the original token and the particle-stripped stem", () => {
    /* 조사 휴리스틱은 *원본 + stem* 양쪽 emit. 사용자 쿼리가 조사 포함
       이든 미포함이든 모두 매칭되도록. */
    const tokens = tokenize("청바지를");
    expect(tokens).toContain("청바지를");
    expect(tokens).toContain("청바지");
  });

  it("strips long-form particles (e.g. 에서) when stem stays meaningful", () => {
    const tokens = tokenize("거리에서");
    expect(tokens).toContain("거리에서");
    expect(tokens).toContain("거리");
  });

  it("does not over-strip short tokens like 수도 (1-char particle false positive)", () => {
    /* "수도" 가 "도" 조사 후보지만, 1글자 조사는 stem 이 ≥ 2글자 필요
       하므로 떼어내지 않는다. "수" 가 추가되면 false-positive 매칭이
       생기므로 가드. (게다가 "도/만" 같은 위험 조사는 화이트리스트
       에서도 제외돼 있다.) */
    const tokens = tokenize("수도");
    expect(tokens).toEqual(["수도"]);
  });

  it("tokenizes Korean sentence into noun + stem pairs", () => {
    const tokens = tokenize("도시 거리에서 청바지를 입은 인물");
    expect(tokens).toContain("도시");
    expect(tokens).toContain("거리");
    expect(tokens).toContain("청바지");
    /* 원본도 같이 살아 있어야 한다 — substring 같은 다른 매칭 의미가
       깨지지 않게. */
    expect(tokens).toContain("거리에서");
    expect(tokens).toContain("청바지를");
  });

  it("leaves English tokens untouched (no false particle matches on ASCII)", () => {
    const tokens = tokenize("denim jeans wearing");
    expect(tokens.sort()).toEqual(["denim", "jeans", "wearing"]);
  });
});

describe("referenceRecommender.buildReferenceTokenInventory", () => {
  it("aggregates all matchable tokens from items and excludes deleted ones", () => {
    const a = makeRef({ id: "a", title: "Neon Tokyo", tags: ["neon", "tokyo"] });
    const b = makeRef({ id: "b", title: "Dark Alley", tags: ["dark"] });
    const trashed = makeRef({
      id: "trashed",
      title: "Removed",
      tags: ["secret"],
      deleted_at: new Date().toISOString(),
    });
    const inv = buildReferenceTokenInventory([a, b, trashed]);
    expect(inv.has("neon")).toBe(true);
    expect(inv.has("tokyo")).toBe(true);
    expect(inv.has("dark")).toBe(true);
    expect(inv.has("alley")).toBe(true);
    expect(inv.has("secret")).toBe(false);
  });

  it("returns an empty set for empty input — defensive default for MoodFilterChip prop", () => {
    expect(buildReferenceTokenInventory([]).size).toBe(0);
  });
});

describe("referenceRecommender.hasInventoryMatch", () => {
  it("matches when any tokenized form of the raw signal exists in inventory", () => {
    const a = makeRef({ id: "a", title: "Low Angle Street", tags: ["neon"] });
    const inv = buildReferenceTokenInventory([a]);
    expect(hasInventoryMatch("low-angle", inv)).toBe(true);
    expect(hasInventoryMatch("neon", inv)).toBe(true);
    expect(hasInventoryMatch("stylish", inv)).toBe(false);
  });

  it("matches Korean signal tokens through shared tokenize normalization", () => {
    const a = makeRef({ id: "a", title: "도시 야경", tags: [] });
    const inv = buildReferenceTokenInventory([a]);
    /* tokenize 가 동일 좌표계에서 동작하므로 "도시" 가 인벤토리에 들어 있으면
       raw "도시" 토큰도 match — 칩 단에서 hide 회귀를 막는다. */
    expect(hasInventoryMatch("도시", inv)).toBe(true);
    expect(hasInventoryMatch("바다", inv)).toBe(false);
  });
});
