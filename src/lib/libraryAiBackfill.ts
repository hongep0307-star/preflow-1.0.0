/**
 * Library AI 정리(backfill) — gap 분석 + 사용자 한글 태그 정규화 코어.
 *
 * 두 갈래의 일관성 회복 작업을 한 모듈에 모은다:
 *   1) **AI 평행 페어 결손** — `ai_suggestions.{suggested_tags,mood_labels}_ko`
 *      가 비어 있거나 길이가 짝이 안 맞는 자료. 해법: 기존 분류 큐
 *      (`enqueueClassify`) 로 다시 보내 LLM 이 새 KO 슬롯을 채우게 한다.
 *   2) **사용자 입력 한글 태그** — `item.tags` 안에 그대로 한글 토큰이
 *      섞여 있어 픽커의 EN-canonical 일관성이 깨진 자료. 해법은 두 단계:
 *        L1 (즉시) `seedKoToEn` 으로 LLM 호출 없이 시드 사전 매칭. 미스
 *           시 한글 그대로 둠.
 *        L3 (batch) `translateUserTags`(referenceAi.ts) 로 LLM 일괄 번역.
 *
 *  이 파일은 LLM 호출 없는 *순수* 코어 — gap 분석/시드 매칭/단일 자료
 *  patch 빌드만 한다. LLM 경로는 호출부(`runLibraryBackfill`) 에서 합성.
 *
 * 호출부:
 *   - `LibraryAiCleanupDialog` (Settings) — gap 표시, dry-run 미리보기, 실행.
 *   - `LibraryInspector.onAddTag` — L1 즉시 시드 매칭으로 입력 시점 정규화.
 */

import type { ReferenceItem } from "./referenceLibrary";
import type { ReferenceAiSuggestions } from "./referenceAi";
import { KOREAN_TAG_SEED } from "./koreanTagSeedDictionary";

const HANGUL_REGEX = /[\u3131-\u318E\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/;

/** 한글 음절/자모 1 자라도 들어 있으면 true. */
export function containsHangul(value: string): boolean {
  return HANGUL_REGEX.test(value);
}

/** 한 글자라도 한글이 *아닌* 경우(=ASCII/숫자만) false. EN 토큰 검증용. */
function isPureNonHangul(value: string): boolean {
  return !HANGUL_REGEX.test(value);
}

/** 시드 사전을 ko 토큰 → 첫 EN canonical 로 한 번만 빌드해 캐시. 빌드는
 *  모듈 로드 시점에 수행되고 그 이후는 O(1) lookup. ko 가 여러 EN 변형을
 *  가리키는 시드는 *첫 번째* 변형(가장 흔한 짧은 명사) 을 canonical 로
 *  채택 — `koreanTagSeedDictionary.ts` 의 ordering 컨벤션과 같은 규칙. */
const seedKoToEn: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const entry of KOREAN_TAG_SEED) {
    if (!entry.ko || !entry.en || entry.ko.length === 0 || entry.en.length === 0) continue;
    const canonical = String(entry.en[0] ?? "").trim().toLowerCase();
    if (!canonical || !isPureNonHangul(canonical)) continue;
    for (const ko of entry.ko) {
      const k = String(ko ?? "").trim();
      if (!k || !containsHangul(k)) continue;
      /* 같은 ko 가 두 시드 entry 에 등장하면 *나중에* 등장한 것으로
         덮는다 — koreanTagSeedDictionary.ts 의 라인 순서를 그대로 따라
         family 충돌이 생겨도 같은 KO 입력이 결정적인 EN 으로 매핑. */
      map.set(k, canonical);
    }
  }
  return map;
})();

/** L1 즉시 시드 매칭 — 한 한글 태그를 시드에서 EN canonical 로 lookup.
 *  매칭 없으면 `null`. 호출부는 null 시 한글 태그를 그대로 둔다(다음
 *  batch 에서 LLM 처리). 엄격 동등 매칭(부분 일치 X) — 이 시점에서는
 *  noise 보다 정확도가 우선. */
export function lookupSeedKoTag(koTag: string): { en: string; ko: string } | null {
  const k = koTag.trim();
  if (!k) return null;
  if (!containsHangul(k)) return null;
  const en = seedKoToEn.get(k);
  if (!en) return null;
  return { en, ko: k };
}

/** 결손 카테고리 — 한 자료가 어떤 정리 작업을 필요로 하는지 표현. 한
 *  자료가 여러 카테고리에 동시 속할 수 있다(set membership).
 *
 *  `missingScene` 은 referenceAi.ts 에 `scene_description` 필드가 도입되기
 *  전에 분류된 자료를 재분석 큐에 흘려 보내기 위한 카테고리. AI 분류 자체
 *  는 정상이지만 *객관적 장면 묘사* 필드만 비어 있는 자료를 식별해 사용자가
 *  Settings 의 정리 다이얼로그에서 한꺼번에 보충할 수 있게 한다. 같은 자료가
 *  `tagKoMismatch` / `moodKoMismatch` 와 동시에 결손이어도 re-classify 큐
 *  단위로 dedupe 되므로 LLM 호출은 한 번만 발생. */
export type BackfillCategory =
  | "missingAi"
  | "tagKoMismatch"
  | "moodKoMismatch"
  | "missingScene"
  | "userHangulTags";

export interface BackfillItemReport {
  readonly itemId: string;
  readonly title: string;
  readonly categories: ReadonlySet<BackfillCategory>;
  /** "사용자 한글 태그 정규화" 로 처리될 토큰 목록 — L1 시드로 즉시
   *  매핑 가능한 것은 `seedHit=true` 로 표시되어 미리보기에 그대로 결과를
   *  표시 가능. 미스(seedHit=false) 는 dry-run 단계에서는 "LLM 처리 예정"
   *  으로만 표시되고 실제 EN 변환은 batch 실행 시 LLM 응답 후 결정된다. */
  readonly hangulTags: ReadonlyArray<{ ko: string; seedHit: boolean; suggestedEn?: string }>;
}

export interface BackfillReport {
  readonly totalItems: number;
  /** category → 영향받는 자료 수. */
  readonly counts: Readonly<Record<BackfillCategory, number>>;
  /** 자료별 상세 — UI 미리보기에서 그대로 사용. */
  readonly perItem: ReadonlyArray<BackfillItemReport>;
  /** L3 단계에서 LLM 호출이 필요한 한글 태그 총 unique 수 (L1 시드로
   *  즉시 처리 가능한 토큰은 제외). 호출 비용 예상치 표시에 사용. */
  readonly llmHangulTagsToTranslate: number;
  /** AI re-classify 큐에 들어갈 자료 수 (missingAi ∪ tagKoMismatch ∪
   *  moodKoMismatch). 같은 자료가 여러 결손이어도 1건으로 계산. */
  readonly itemsToReClassify: number;
}

/** 평행 배열이 *유효* 한지 — 정의되어 있고 길이가 일치. ko 가 아예
 *  undefined 이거나 길이가 다르면 결손으로 본다. */
function isValidParallel(en: string[] | undefined, ko: string[] | undefined): boolean {
  if (!Array.isArray(en) || en.length === 0) return true; // EN 자체가 비면 결손 아님
  if (!Array.isArray(ko)) return false;
  if (ko.length !== en.length) return false;
  return true;
}

/** scene_description 결손 판정 — AI 분류는 끝났지만 *객관적 장면 묘사*
 *  필드만 비어 있는 경우. EN 또는 KO 어느 한 쪽이라도 비-empty 문자열이면
 *  결손이 아닌 것으로 본다 (한 언어만 채워 둔 자료를 재분석으로 강제로 다시
 *  돌릴 필요 없음 — 검색 haystack 은 양 언어 모두 합산 사용).
 *
 *  AI 자체가 없는(`missingAi`) 자료는 여기서 제외 — 어차피 missingAi 큐가
 *  처리할 때 scene_description 도 함께 채워진다. 카테고리 중복 방지. */
function isMissingScene(ai: Partial<ReferenceAiSuggestions> | null): boolean {
  if (!ai) return false;
  if (!Array.isArray(ai.suggested_tags) && !Array.isArray(ai.mood_labels)) return false;
  if (ai.error) return false;
  const en = typeof ai.scene_description === "string" ? ai.scene_description.trim() : "";
  const ko = typeof ai.scene_description_ko === "string" ? ai.scene_description_ko.trim() : "";
  return en.length === 0 && ko.length === 0;
}

/** 자료 한 건 분석 — 어떤 카테고리에 속하는지 + hangul 토큰 분해. */
function analyzeItem(item: ReferenceItem): BackfillItemReport {
  const cats = new Set<BackfillCategory>();
  const ai = (item.ai_suggestions ?? null) as Partial<ReferenceAiSuggestions> | null;

  if (!ai || (!Array.isArray(ai.suggested_tags) && !Array.isArray(ai.mood_labels))) {
    cats.add("missingAi");
  } else {
    if (!isValidParallel(ai.suggested_tags, ai.suggested_tags_ko)) cats.add("tagKoMismatch");
    if (!isValidParallel(ai.mood_labels, ai.mood_labels_ko)) cats.add("moodKoMismatch");
    if (isMissingScene(ai)) cats.add("missingScene");
  }

  const hangulTags: Array<{ ko: string; seedHit: boolean; suggestedEn?: string }> = [];
  const seenKo = new Set<string>();
  for (const tag of item.tags ?? []) {
    if (typeof tag !== "string") continue;
    const t = tag.trim();
    if (!t || !containsHangul(t)) continue;
    /* folder:* 는 의도된 한글 폴더 경로 — 정규화 대상이 아님(폴더 라벨은
       사용자 표기 그대로 보존). 다른 prefix 도 같은 컨벤션으로 보호. */
    if (t.includes(":")) continue;
    if (seenKo.has(t)) continue;
    seenKo.add(t);
    const seed = lookupSeedKoTag(t);
    hangulTags.push({
      ko: t,
      seedHit: !!seed,
      suggestedEn: seed?.en,
    });
  }
  if (hangulTags.length > 0) cats.add("userHangulTags");

  return {
    itemId: item.id,
    title: item.title || item.id,
    categories: cats,
    hangulTags,
  };
}

/** 라이브러리 전체를 한 번 순회해 결손 리포트를 만든다. O(N × tags). */
export function analyzeBackfillGaps(items: ReadonlyArray<ReferenceItem>): BackfillReport {
  const counts: Record<BackfillCategory, number> = {
    missingAi: 0,
    tagKoMismatch: 0,
    moodKoMismatch: 0,
    missingScene: 0,
    userHangulTags: 0,
  };
  const perItem: BackfillItemReport[] = [];
  const llmTokens = new Set<string>();
  const reClassifyIds = new Set<string>();

  for (const item of items) {
    const report = analyzeItem(item);
    if (report.categories.size === 0 && report.hangulTags.length === 0) continue;
    perItem.push(report);
    for (const cat of report.categories) {
      counts[cat] += 1;
      /* re-classify 큐 단위에서 dedupe — 한 자료가 missingAi + missingScene
         양쪽에 속해도 LLM 한 번만 호출. */
      if (
        cat === "missingAi" ||
        cat === "tagKoMismatch" ||
        cat === "moodKoMismatch" ||
        cat === "missingScene"
      ) {
        reClassifyIds.add(report.itemId);
      }
    }
    for (const ht of report.hangulTags) {
      if (!ht.seedHit) llmTokens.add(ht.ko);
    }
  }

  return {
    totalItems: items.length,
    counts,
    perItem,
    llmHangulTagsToTranslate: llmTokens.size,
    itemsToReClassify: reClassifyIds.size,
  };
}

/** 자료 patch 빌더 — `item.tags` 의 한글 토큰을 EN canonical 로 치환하고
 *  `ai_suggestions.user_tag_aliases_ko` 에 alias 페어 머지.
 *
 *  입력 `mappings` 는 한글 → EN 매핑(L1 시드 + L3 LLM 번역 결과의 합집합).
 *  매핑에 없는 한글 토큰은 *그대로 보존* — 호출부 결정에 따라 다음 batch
 *  로 미루든 실패 표시하든 자유.
 *
 *  반환 `patch` 가 null 이면 변화 없음(no-op). 호출부는 supabase
 *  `updateReference(id, patch)` 를 그대로 적용하면 된다. */
export interface UserTagPatch {
  tags: string[];
  ai_suggestions: Record<string, unknown>;
}

/** 단일 alias 페어를 기존 `ai_suggestions` 객체에 dedupe 머지해 새 객체를
 *  반환한다. L1 즉시 시드 매칭(LibraryInspector onAddTag) 에서 매번 인라인
 *  으로 dedupe 코드를 짜지 않도록 추출 — `buildUserTagAliasPatch` 와 같은
 *  머지 의미를 단일 페어 버전으로. */
export function mergeUserTagAliasIntoAi(
  prevAi: Record<string, unknown> | null | undefined,
  newAlias: { en: string; ko: string },
): Record<string, unknown> {
  const base = (prevAi ?? {}) as Record<string, unknown>;
  const prev = Array.isArray(base.user_tag_aliases_ko)
    ? (base.user_tag_aliases_ko as Array<{ en?: unknown; ko?: unknown }>)
    : [];
  const dedup = new Map<string, { en: string; ko: string }>();
  for (const a of prev) {
    const en = typeof a?.en === "string" ? a.en.trim().toLowerCase() : "";
    const ko = typeof a?.ko === "string" ? a.ko.trim() : "";
    if (!en || !ko) continue;
    dedup.set(`${en}\u0001${ko}`, { en, ko });
  }
  const en = newAlias.en.trim().toLowerCase();
  const ko = newAlias.ko.trim();
  if (en && ko && isPureNonHangul(en) && containsHangul(ko)) {
    dedup.set(`${en}\u0001${ko}`, { en, ko });
  }
  return { ...base, user_tag_aliases_ko: Array.from(dedup.values()) };
}

export function buildUserTagAliasPatch(
  item: ReferenceItem,
  mappings: ReadonlyMap<string, string>,
): UserTagPatch | null {
  if (!item.tags || item.tags.length === 0) return null;
  if (mappings.size === 0) return null;

  const nextTags: string[] = [];
  const newAliases: Array<{ en: string; ko: string }> = [];
  const seenInTags = new Set<string>();
  let mutated = false;

  for (const tag of item.tags) {
    if (typeof tag !== "string") continue;
    const t = tag.trim();
    if (!t) continue;
    if (containsHangul(t) && !t.includes(":")) {
      const en = mappings.get(t);
      if (en && isPureNonHangul(en)) {
        mutated = true;
        const enLower = en.toLowerCase();
        if (!seenInTags.has(enLower)) {
          seenInTags.add(enLower);
          nextTags.push(enLower);
        }
        newAliases.push({ en: enLower, ko: t });
        continue;
      }
    }
    /* 변환 안 된 일반 태그(EN 또는 시드 미매핑 한글) 는 그대로. dedupe
       는 lowercase 기준 — `Sunset` 와 `sunset` 이 동시에 있어도 한 번만. */
    const key = t.toLowerCase();
    if (seenInTags.has(key)) continue;
    seenInTags.add(key);
    nextTags.push(t);
  }

  if (!mutated) return null;

  /* 기존 ai_suggestions 와 user_tag_aliases_ko 를 보존하며 dedupe 머지.
     같은 (en, ko) 페어가 두 번 등록되지 않도록 set 키 (en\u0001ko) 로
     중복 차단. */
  const prevAi = (item.ai_suggestions ?? {}) as Record<string, unknown>;
  const prevAliases = Array.isArray(prevAi.user_tag_aliases_ko)
    ? (prevAi.user_tag_aliases_ko as Array<{ en?: unknown; ko?: unknown }>)
    : [];
  const dedup = new Map<string, { en: string; ko: string }>();
  for (const a of prevAliases) {
    const en = typeof a?.en === "string" ? a.en.trim().toLowerCase() : "";
    const ko = typeof a?.ko === "string" ? a.ko.trim() : "";
    if (!en || !ko) continue;
    dedup.set(`${en}\u0001${ko}`, { en, ko });
  }
  for (const a of newAliases) {
    dedup.set(`${a.en}\u0001${a.ko}`, a);
  }

  return {
    tags: nextTags,
    ai_suggestions: {
      ...prevAi,
      user_tag_aliases_ko: Array.from(dedup.values()),
    },
  };
}
