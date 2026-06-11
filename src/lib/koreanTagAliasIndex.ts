/**
 * Korean tag alias index — LLM 없이 즉시 동작하는 한글 → 영어 태그 매핑.
 *
 * 라이브러리의 각 자료는 `ai_suggestions.suggested_tags[i]` (EN) 와
 * `suggested_tags_ko[i]` (KO) 를 같은 인덱스로 짝지어 들고 있다
 * (`referenceAi.ts` 의 컨트랙트). 자료 전체를 한 번 순회해 이 쌍들을 모으면
 *   - 한글 입력 → 후보 영어 태그 (count 빈도순)
 *   - 영어 태그 → 알려진 한글 별칭 (UI 힌트용)
 * 두 방향 lookup 을 모두 0ms 에 제공할 수 있다.
 *
 * 호출부:
 *   - LibraryPage: B2 사이드바 한글 추천에서 LLM 호출 전에 로컬 후보를
 *     즉시 칩으로 띄우는 데 사용 (UX 지연 0). LLM 응답이 도착하면 dedupe
 *     merge.
 *   - LibraryToolbar `MultiPicker`: Tags 칩 피커 안에서 사용자가 한글을
 *     타이핑하면 row.label(영어) 들을 alias 후보로 필터.
 *
 * 인덱스는 `useMemo([items])` 로 한 번만 빌드. 비AI 라이브러리에서는
 * `hasData=false` 가 되어 호출부는 LLM 경로로 자연 폴백.
 */

import type { ReferenceItem } from "./referenceLibrary";
import type { ReferenceAiSuggestions } from "./referenceAi";
import type { TagSeedEntry } from "./koreanTagSeedDictionary";

/** lookup 결과의 단일 후보. `aliases` 는 UI 가 "∵ 야경" 같은 보조 표기를
 *  보여줄 때 사용. 빈도(count) 가 가장 높은 KO 별칭 순으로 정렬된다. */
export interface KoreanTagAliasMatch {
  /** Canonical EN tag/mood (lowercase). */
  readonly tag: string;
  /** 라이브러리에서 같은 인덱스로 짝지어 발견된 빈도 합산. */
  readonly count: number;
  /** 매칭에 기여한 KO 별칭 목록(빈도 desc). 최대 3 개로 잘라 UI 표기 단순화. */
  readonly aliases: ReadonlyArray<string>;
}

export interface KoreanTagAliasIndex {
  /** 인덱스에 EN↔KO 쌍이 하나라도 있는지. false 면 호출부는 LLM 경로로
   *  바로 빠진다 (라이브러리에 AI 분류가 전혀 안 됐고 시드 사전도 비어
   *  있을 때). */
  readonly hasData: boolean;
  /** Hangul query → EN 일반 태그 후보. 정렬: count desc, 동률 시 alpha asc. */
  lookupTags(koQuery: string): KoreanTagAliasMatch[];
  /** Hangul query → EN mood label 후보. */
  lookupMoods(koQuery: string): KoreanTagAliasMatch[];
  /** EN 일반 태그 → 알려진 KO 별칭. UI 우측 보조 텍스트로 한 줄 표기. */
  koAliasesFor(enTag: string): string[];
  /** EN mood label → 알려진 KO 별칭. */
  koAliasesForMood(enMood: string): string[];
}

/** `buildKoreanTagAliasIndex` 옵션. */
export interface BuildKoreanTagAliasIndexOptions {
  /** 라이브러리 페어와 함께 마운트할 시드 사전 (정적 + 사용자). 시드 페어는
   *  count = `seedWeight` 로 등록되어 라이브러리 빈도와 결합 시 일관된
   *  랭킹을 만든다. */
  readonly seedDictionary?: ReadonlyArray<TagSeedEntry>;
  /** 시드 1 페어 당 count 가중치. 기본 1. 라이브러리 빈도가 낮을 때 시드
   *  토큰을 상위로 올리고 싶으면 2~3 으로 키울 수 있다. */
  readonly seedWeight?: number;
  /** lookupTags 결과 dead-end 가드 — 라이브러리 *tag* 인벤토리 셋. EN
   *  토큰이 이 셋에 없으면 후보에서 컷. mood inventory 와 합치지 말 것
   *  (mood 카테고리에서만 존재하는 토큰이 tag 추천으로 leak 되지 않도록). */
  readonly tagInventoryFilter?: ReadonlySet<string>;
  /** lookupMoods 결과 dead-end 가드 — 라이브러리 *mood_labels* 인벤토리
   *  셋. EN 토큰이 이 셋에 없으면 후보에서 컷. 같은 EN 토큰이 tag 로는
   *  존재해도 mood 로는 없는 경우(예: 시드 `family: "mood" / en: "cute"`
   *  가 있는데 라이브러리 mood_labels 에는 "cute" 가 없고 suggested_tags
   *  에만 있는 케이스) 가 *추천 무드 → 클릭 → mood 필터에 잡혔는데 팝오버
   *  엔 라벨 없음* 회귀를 일으켜 카테고리별 분리 가드가 반드시 필요. */
  readonly moodInventoryFilter?: ReadonlySet<string>;
  /** @deprecated tagInventoryFilter / moodInventoryFilter 를 쓰세요.
   *  하위호환 — 둘 중 하나라도 지정되면 그쪽이 우선하고, 둘 다 미지정이면
   *  이 통합 셋이 양 lookup 모두에 fallback 으로 사용된다. */
  readonly inventoryFilter?: ReadonlySet<string>;
  /** 시드 EN 토큰이 inventoryFilter 에 *정확히* 일치하지 않을 때, 단어
   *  경계 기반(`car` → `sports-car`) 으로 인벤토리 내 가족 변형을 찾아
   *  후보로 대체한다. 기본 false. 해당 카테고리 인벤토리가 없으면 무효. */
  readonly expandToInventoryFamily?: boolean;
}

/** 빌더 내부 누적 구조 — `koKey → { enTag → count }`. 작은 라이브러리에서는
 *  몇 백 개 수준이라 Map 으로 충분. */
type KoToEnCounts = Map<string, Map<string, number>>;
type EnToKoCounts = Map<string, Map<string, number>>;

/** 정규화 — trim + lowercase. EN/KO 모두 동일 규칙. KO 는 lowercase 가
 *  no-op 이지만 일관성 + EN 토큰과 같은 키 공간을 쓰지 않도록 분리되어 있어
 *  안전하다. */
function normalize(token: string | null | undefined): string {
  if (!token) return "";
  return token.trim().toLowerCase();
}

/** Hangul syllables + jamo 빠른 감지. `koreanSearchSuggest` 의 동일 정규식과
 *  의도적으로 sync — 한 곳에서 바뀌면 양쪽 다 바뀌어야 한다. */
const HANGUL_REGEX = /[\u3131-\u318E\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/;
function containsHangulLocal(value: string): boolean {
  return HANGUL_REGEX.test(value);
}

function bump(map: Map<string, Map<string, number>>, outer: string, inner: string): void {
  let inner_ = map.get(outer);
  if (!inner_) {
    inner_ = new Map<string, number>();
    map.set(outer, inner_);
  }
  inner_.set(inner, (inner_.get(inner) ?? 0) + 1);
}

/** 평행 EN/KO 배열을 짝지어 누적. 길이가 다르면 짧은 쪽 길이까지만 매칭
 *  (LLM 가 한쪽을 짧게 반환하는 edge case 보호 — 인덱스 일치가 무너지지
 *  않도록 i 가 두 배열 모두에 존재할 때만 페어 처리). */
function ingestParallel(
  enList: ReadonlyArray<string> | undefined,
  koList: ReadonlyArray<string> | undefined,
  koToEn: KoToEnCounts,
  enToKo: EnToKoCounts,
): void {
  if (!enList || !koList) return;
  const len = Math.min(enList.length, koList.length);
  for (let i = 0; i < len; i++) {
    const en = normalize(enList[i]);
    const ko = normalize(koList[i]);
    if (!en || !ko) continue;
    /* EN 자체가 한글이거나 KO 자체가 영어만 있는 비정상 페어는 스킵 —
       데이터 정합성이 깨진 경우(LLM 출력 형식 위반) 검색을 오염시키지
       않도록. */
    if (containsHangulLocal(en)) continue;
    if (!containsHangulLocal(ko)) continue;
    bump(koToEn, ko, en);
    bump(enToKo, en, ko);
  }
}

/** 시드 사전 한 항목을 ko × en 카티시안 곱으로 등록한다. 같은 항목 안의
 *  모든 ko 동의어가 모든 en 변형을 동등한 후보로 가리키게 만들어, 사용자가
 *  어떤 한국어 동의어를 쳐도 EN 후보 묶음 전체에 접근할 수 있게 한다. */
function ingestSeedEntry(
  entry: TagSeedEntry,
  weight: number,
  koToEn: KoToEnCounts,
  enToKo: EnToKoCounts,
): void {
  const koTokens = entry.ko.map(normalize).filter(Boolean).filter(containsHangulLocal);
  const enTokens = entry.en.map(normalize).filter(Boolean).filter((s) => !containsHangulLocal(s));
  if (koTokens.length === 0 || enTokens.length === 0) return;
  for (const ko of koTokens) {
    for (const en of enTokens) {
      for (let w = 0; w < weight; w++) {
        bump(koToEn, ko, en);
        bump(enToKo, en, ko);
      }
    }
  }
}

/** 인벤토리 가족 매칭 — 단어 경계(`-` / `_` / 공백 / `/`) 기반 토큰 비교.
 *  `car` ↔ `sports-car` 는 매치, `car` ↔ `carpet` 은 미매치 (carpet 은
 *  `carpet` 한 토큰이라 `car` 와 다름). 양방향 보조 — seedEn 이 인벤토리
 *  토큰의 sub-token 이거나, 인벤토리 토큰이 seedEn 의 sub-token 인 경우
 *  모두 통과. 너무 짧은 토큰(<3) 에 의한 noise 를 막기 위한 길이 가드 포함. */
const WORD_BOUNDARY = /[\s\-_/,]+/;
function tokenize(s: string): string[] {
  return s.split(WORD_BOUNDARY).filter(Boolean);
}
function expandToFamily(seedEn: string, inventory: ReadonlySet<string>): string[] {
  if (inventory.has(seedEn)) return [seedEn];
  const out = new Set<string>();
  const seedTokens = tokenize(seedEn);
  for (const inv of inventory) {
    const invTokens = tokenize(inv);
    /* `sports-car` 가 `car` 시드의 가족: invTokens 안에 seedEn 토큰이
       그대로 등장. */
    if (seedTokens.length === 1 && invTokens.includes(seedEn)) {
      out.add(inv);
      continue;
    }
    /* 시드 EN 이 멀티 토큰(`close-up`) 이고 인벤토리 한 토큰이 그 일부
       인 경우 — 너무 광범위해 noise 가능. 토큰 길이 3 이상으로 가드. */
    if (
      invTokens.length === 1 &&
      seedTokens.includes(inv) &&
      inv.length >= 3
    ) {
      out.add(inv);
    }
  }
  return Array.from(out);
}

/** Map<inner, count> 을 빈도 desc / alpha asc 로 정렬한 키 배열로. */
function sortedKeys(counts: Map<string, number>): string[] {
  return Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .map(([k]) => k);
}

/** lookup 의 매칭 규칙 — 3 단계.
 *   1) `koKey.includes(query)` : "야경" 입력 → "야경 풍경" 별칭 매칭.
 *   2) `query.includes(koKey)` : "밤거리 야경" 입력 → "야경" 별칭 매칭.
 *   3) 활용형 변형 fallback — 둘 다 길이 3 이상 + 첫 2 글자 일치 시 매칭.
 *      "에너지"(쿼리) ↔ "에너제틱"(koKey) 처럼 어근에서 갈라진 단어가
 *      서로 substring 이 아닌 케이스를 잡는다. 한글에서 첫 2 음절은
 *      어근/의미를 강하게 결정해 false positive 가 낮다 — "차분"/"차가",
 *      "긴장"/"긴급", "행복"/"행운" 모두 첫 2 글자가 다르다.
 *  query / koKey 가 2 글자 미만이면 (1)/(2) 만 허용해 "도" 라는 noise
 *  쿼리가 "도시" 같은 짧은 키를 잘못 매칭하는 것을 막는다. (3) 은 길이
 *  3 미만에서 비활성 — 짧은 prefix 가 곧 단어 전체가 되어 noise 폭증. */
function matches(koKey: string, query: string): boolean {
  if (!koKey || !query) return false;
  if (koKey.includes(query)) return true;
  if (koKey.length >= 2 && query.length >= 2 && query.includes(koKey)) return true;
  if (
    koKey.length >= 3 &&
    query.length >= 3 &&
    koKey.charAt(0) === query.charAt(0) &&
    koKey.charAt(1) === query.charAt(1)
  ) {
    return true;
  }
  return false;
}

interface LookupBuckets {
  readonly koToEn: KoToEnCounts;
  readonly enToKo: EnToKoCounts;
}

interface LookupConfig {
  readonly inventoryFilter?: ReadonlySet<string>;
  readonly expandToInventoryFamily?: boolean;
  readonly limit?: number;
}

function lookup(
  query: string,
  buckets: LookupBuckets,
  config: LookupConfig = {},
): KoreanTagAliasMatch[] {
  const q = normalize(query);
  if (!q) return [];
  /* 영어/숫자만 들어오면 의미가 없다 — alias 인덱스는 한글 쿼리 전용. */
  if (!containsHangulLocal(q)) return [];

  /* en → { count: 합산 빈도, aliases: { koKey → 합산 빈도 } }. 가족 확장
     단계에서 같은 인벤토리 토큰이 여러 시드로부터 도달할 수 있으므로 합산
     필수. */
  const agg = new Map<string, { count: number; aliases: Map<string, number> }>();
  const inv = config.inventoryFilter;
  const expand = config.expandToInventoryFamily === true && !!inv && inv.size > 0;

  const ingest = (rawEn: string, koKey: string, weight: number) => {
    const targets: string[] = (() => {
      if (!inv || inv.size === 0) return [rawEn];
      if (inv.has(rawEn)) return [rawEn];
      if (expand) {
        const fam = expandToFamily(rawEn, inv);
        return fam;
      }
      return [];
    })();
    for (const target of targets) {
      let row = agg.get(target);
      if (!row) {
        row = { count: 0, aliases: new Map<string, number>() };
        agg.set(target, row);
      }
      row.count += weight;
      row.aliases.set(koKey, (row.aliases.get(koKey) ?? 0) + weight);
    }
  };

  for (const [koKey, enMap] of buckets.koToEn) {
    if (!matches(koKey, q)) continue;
    for (const [en, c] of enMap) {
      ingest(en, koKey, c);
    }
  }

  const result: KoreanTagAliasMatch[] = Array.from(agg.entries()).map(([tag, row]) => ({
    tag,
    count: row.count,
    aliases: sortedKeys(row.aliases).slice(0, 3),
  }));

  result.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
  });

  const limit = config.limit ?? 12;
  return result.slice(0, limit);
}

/** items 전체와(옵션) 시드 사전을 한 번 순회해 한국어 별칭 인덱스를 만든다.
 *  O(items × tags + seed entries) 시간. React 호출부는
 *  `useMemo(() => buildKoreanTagAliasIndex(items, opts), [items, ...])`
 *  로 한 번만 빌드한다.
 *
 *  시드 사전은 라이브러리 페어와 *같은 키 공간* 에 마운트된다 — lookup
 *  결과에 둘 다 후보로 나타나고, 같은 EN 토큰은 자동으로 빈도 합산된다.
 *  inventoryFilter 가 있으면 lookup 단계에서 라이브러리에 실제 존재하지
 *  않는 EN 후보가 제거되어 dead-end 클릭을 막는다.
 */
export function buildKoreanTagAliasIndex(
  items: ReadonlyArray<ReferenceItem>,
  options: BuildKoreanTagAliasIndexOptions = {},
): KoreanTagAliasIndex {
  const tagKoToEn: KoToEnCounts = new Map();
  const tagEnToKo: EnToKoCounts = new Map();
  const moodKoToEn: KoToEnCounts = new Map();
  const moodEnToKo: EnToKoCounts = new Map();

  for (const item of items) {
    const ai = item.ai_suggestions as Partial<ReferenceAiSuggestions> | null | undefined;
    if (!ai) continue;
    ingestParallel(ai.suggested_tags, ai.suggested_tags_ko, tagKoToEn, tagEnToKo);
    ingestParallel(ai.mood_labels, ai.mood_labels_ko, moodKoToEn, moodEnToKo);
    /* 사용자가 직접 입력한 한글 태그를 EN 으로 정규화하면서 보존한
       alias map (referenceAi.ts ReferenceAiSuggestions.user_tag_aliases_ko).
       라이브러리 평행 페어와 동일 키 공간에 합산되어 픽커 hint 가
       AI 분류와 사용자 수동 입력을 구분 없이 통합 표기한다. */
    const userAliases = ai.user_tag_aliases_ko;
    if (Array.isArray(userAliases)) {
      for (const pair of userAliases) {
        if (!pair || typeof pair !== "object") continue;
        const en = normalize(pair.en);
        const ko = normalize(pair.ko);
        if (!en || !ko) continue;
        if (containsHangulLocal(en)) continue;
        if (!containsHangulLocal(ko)) continue;
        bump(tagKoToEn, ko, en);
        bump(tagEnToKo, en, ko);
      }
    }
  }

  const seedWeight = Math.max(1, options.seedWeight ?? 1);
  if (options.seedDictionary && options.seedDictionary.length > 0) {
    /* 시드 항목은 family 가 "mood" 면 mood 버킷, 그 외엔 tag 버킷으로
       라우팅한다 (mood/tag 칩 분리 컨트랙트 유지). family 미지정은 tag 로
       기본. UI 호출부는 lookupTags / lookupMoods 를 별도로 호출하므로 이
       라우팅이 정확해야 같은 토큰이 양 칩에 중복 등장하지 않는다. */
    for (const entry of options.seedDictionary) {
      const target = entry.family === "mood" ? "mood" : "tag";
      if (target === "mood") {
        ingestSeedEntry(entry, seedWeight, moodKoToEn, moodEnToKo);
      } else {
        ingestSeedEntry(entry, seedWeight, tagKoToEn, tagEnToKo);
      }
    }
  }

  const hasData = tagKoToEn.size > 0 || moodKoToEn.size > 0;

  const tagBuckets: LookupBuckets = { koToEn: tagKoToEn, enToKo: tagEnToKo };
  const moodBuckets: LookupBuckets = { koToEn: moodKoToEn, enToKo: moodEnToKo };

  /* 카테고리별 인벤토리 필터 — 신규 API(tag/moodInventoryFilter) 가 우선,
     없으면 legacy 통합 inventoryFilter 로 자연 폴백. legacy 만 지정된
     레거시 호출부는 기존 동작(합집합 가드) 그대로 유지된다. */
  const tagFilter = options.tagInventoryFilter ?? options.inventoryFilter;
  const moodFilter = options.moodInventoryFilter ?? options.inventoryFilter;

  const tagLookupConfig: LookupConfig = {
    inventoryFilter: tagFilter,
    expandToInventoryFamily: options.expandToInventoryFamily,
  };
  const moodLookupConfig: LookupConfig = {
    inventoryFilter: moodFilter,
    expandToInventoryFamily: options.expandToInventoryFamily,
  };

  /** EN 토큰에 알려진 KO 별칭이 정확 키로 없을 때 단어 경계 기반으로
   *  sub-token 별 KO 별칭을 합산해 반환한다 — `coral-accent` 의 정확 키
   *  매칭이 없을 때 시드의 `coral` 별칭("코랄")을 borrow.
   *
   *  noise 가드:
   *    · 단일 토큰("competitive") 은 fallback 으로 더 쪼갤 게 없어 [].
   *    · 토큰 길이 3 미만(`of`, `to`) 은 generic stopword 성격이라 스킵.
   *    · sub-token 별 빈도를 합산하므로 같은 KO 가 여러 sub-token 에서
   *      동시에 나오면 자연스럽게 상위로 정렬된다.
   */
  function familyAliasesFor(enToKo: EnToKoCounts, enTag: string): string[] {
    const norm = normalize(enTag);
    const exact = enToKo.get(norm);
    if (exact) return sortedKeys(exact);
    const tokens = norm.split(WORD_BOUNDARY).filter((t) => t.length >= 3);
    if (tokens.length <= 1) return [];
    const merged = new Map<string, number>();
    for (const tk of tokens) {
      const sub = enToKo.get(tk);
      if (!sub) continue;
      for (const [ko, c] of sub) {
        merged.set(ko, (merged.get(ko) ?? 0) + c);
      }
    }
    return merged.size > 0 ? sortedKeys(merged) : [];
  }

  return {
    hasData,
    lookupTags(koQuery: string) {
      return lookup(koQuery, tagBuckets, tagLookupConfig);
    },
    lookupMoods(koQuery: string) {
      return lookup(koQuery, moodBuckets, { ...moodLookupConfig, limit: 6 });
    },
    koAliasesFor(enTag: string) {
      return familyAliasesFor(tagEnToKo, enTag);
    },
    koAliasesForMood(enMood: string) {
      return familyAliasesFor(moodEnToKo, enMood);
    },
  };
}

/** 빈 인덱스 — 컴포넌트가 prop default 로 안전하게 쓸 수 있게. */
export const EMPTY_KOREAN_TAG_ALIAS_INDEX: KoreanTagAliasIndex = {
  hasData: false,
  lookupTags: () => [],
  lookupMoods: () => [],
  koAliasesFor: () => [],
  koAliasesForMood: () => [],
};
