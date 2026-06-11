/**
 * Korean → English tag suggestion (B2)
 *
 * 라이브러리 검색 입력에 한글이 섞이면 즉시 "이 쿼리가 영어로 어떤 태그/무드에
 * 해당할 가능성이 높은가" 를 LLM 으로 추천한다. 추천은 인라인 칩으로 사이드바
 * 검색바 아래에 떴다가 사용자가 클릭하면 해당 영어 토큰이 `tagsFilter` 에
 * 자동으로 들어간다. 칩을 dismiss 하면 그 쿼리는 세션 동안 더 이상 추천하지
 * 않는다 (호출부 책임).
 *
 * 핵심 제약:
 *   - Hallucination 방지: 라이브러리에 실제로 존재하는 tag / mood_label
 *     inventory 를 항상 LLM 에 함께 보내고 "이 inventory 안에서만 골라라"
 *     라고 강하게 지시한다. 추가로 응답 후 inventory 와 교집합만 통과시키는
 *     client-side 필터로 한 번 더 거른다.
 *   - 비용 절감: LRU 캐시(쿼리 + inventory hash 기준) + 400 ms 디바운스(호출부
 *     책임) + inventoryHash 단위로 stale 처리.
 *   - 한글 감지는 단순 정규식 (Hangul syllables + jamo 블록) — Hangul 한
 *     글자만 있어도 즉시 한국어 path 로 빠진다.
 */
import { callOpenAI } from "./openai";
import { OPENAI_PRIMARY } from "./modelCatalog";

/* 카탈로그 디폴트 (현재 `gpt-5.5`). 과거에는 `gpt-5.5-mini` 라는 카탈로그
   에 없는 ID를 박아 두어 백엔드가 500 을 던졌고, 그 결과 한글 검색 시
   자동 태그 추천 칩이 조용히 사라지는 silent failure 가 발생했다.
   `OPENAI_PRIMARY` 를 통해 single source of truth 와 묶어 재발 방지. */
const SUGGEST_MODEL = OPENAI_PRIMARY;
const MAX_TOKENS = 240;

/** Hangul syllables (가 — 힣) 와 Jamo 블록을 빠르게 감지. 한 글자만 있어도
 *  true. 영어/숫자/이모지 와 한글이 섞여 있어도 한국어 쿼리로 본다 (예:
 *  "neon 야경"). */
export function containsHangul(value: string | null | undefined): boolean {
  if (!value) return false;
  return /[\u3131-\u318E\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/.test(value);
}

/** 라이브러리 인벤토리 — 호출부(LibraryPage) 가 useMemo 로 한 번 계산해
 *  주입한다. 두 카테고리가 분리돼 있어 mood vs 일반 태그를 prompt 안에서
 *  명확히 가이드할 수 있다. */
export interface SuggestionInventory {
  /** suggested_tags + 사용자 태그 — folder:/source: 접두는 호출부가 제거해
   *  순수 키워드 토큰만 넘긴다. */
  tags: ReadonlyArray<string>;
  /** mood_labels 만 — Mood 칩과의 협업을 위해 별도. */
  moodLabels: ReadonlyArray<string>;
}

export interface KoreanSuggestSpec {
  rawQuery: string;
  /** 3-5 영어 태그 (inventory 와 교집합 통과). 최소 0 까지 허용. */
  suggestedTags: string[];
  /** 0-3 mood 영어 후보. */
  suggestedMoods: string[];
  /** LLM 호출 자체가 실패했을 때만 채워진다 — UI 가 noisy fallback 없이
   *  조용히 칩을 숨길 수 있게. */
  error?: string;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * LRU cache + in-flight dedup
 *
 * 키 = `${query}\u0000${inventoryHash}` — inventory 변할 때 자연 stale.
 * 최대 64 개 까지만 유지(라이브러리 한 세션에서 보통 1-10 개 정도의
 * 한글 쿼리가 반복된다). 추가로 in-flight Promise 를 같은 키로 잡아
 * 두어 짧은 시간에 연속 호출이 일어나도 한 번만 네트워크를 탄다.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const LRU_LIMIT = 64;
const cache = new Map<string, KoreanSuggestSpec>();
const inflight = new Map<string, Promise<KoreanSuggestSpec>>();

function makeKey(query: string, inventoryHash: string): string {
  return `${query}\u0000${inventoryHash}`;
}

function cacheGet(key: string): KoreanSuggestSpec | undefined {
  const v = cache.get(key);
  if (!v) return undefined;
  /* LRU touch — get 시점에 같은 키를 다시 set 해 가장 최근에 쓰인 것
     으로 끌어올린다. Map 의 insertion-order semantics 를 활용. */
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function cacheSet(key: string, value: KoreanSuggestSpec): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > LRU_LIMIT) {
    const first = cache.keys().next().value as string | undefined;
    if (!first) break;
    cache.delete(first);
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 호출부가 inventory 전체를 매번 통째로 넘기지 않도록 가벼운 hash
 * 헬퍼를 export — 라이브러리 페이지가 useMemo 로 한 번 계산해 두면
 * 자료가 추가/삭제 될 때마다 자동으로 stale 처리된다.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/** 결정적 32-bit FNV-1a — 빠르고 매우 짧다. 충돌은 cache key 동등성이
 *  완전히 보장돼야 할 만큼 critical 하진 않다 (캐시 stale 정도). */
export function hashInventory(inventory: SuggestionInventory): string {
  let h = 0x811c9dc5;
  const fold = (token: string) => {
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    h ^= 0x2c;
    h = (h * 0x01000193) >>> 0;
  };
  for (const tag of inventory.tags) fold(tag);
  h ^= 0xff;
  for (const m of inventory.moodLabels) fold(m);
  h ^= inventory.tags.length;
  h ^= inventory.moodLabels.length << 8;
  return h.toString(16);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Recent queries (사용자가 최근에 클릭/적용한 한글 쿼리 3개)
 *
 * localStorage 영속 — 새 세션에도 살아남는다. 검색 입력이 비어 있을
 * 때 사이드바에서 "최근 검색" 칩으로 보여주거나, 같은 쿼리를 또
 * 쳤을 때 추천 ranking 의 보조 신호로 쓰일 수 있게.
 * 현재는 read/write helper 만 제공하고 UI 결합은 호출부 책임.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const RECENT_QUERIES_KEY = "preflow.library.koreanRecentQueries";
const RECENT_QUERIES_LIMIT = 3;

export function getRecentKoreanQueries(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_QUERIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string").slice(0, RECENT_QUERIES_LIMIT);
  } catch {
    return [];
  }
}

export function rememberKoreanQuery(query: string): void {
  const trimmed = query.trim();
  if (!trimmed) return;
  if (!containsHangul(trimmed)) return;
  try {
    const current = getRecentKoreanQueries();
    const next = [trimmed, ...current.filter((v) => v !== trimmed)].slice(0, RECENT_QUERIES_LIMIT);
    localStorage.setItem(RECENT_QUERIES_KEY, JSON.stringify(next));
  } catch {
    /* private 모드 등으로 set 실패 — 무시. UX 에 critical 하지 않음. */
  }
}

/** Hangul 쿼리 → 라이브러리 inventory 안의 영어 태그/무드 후보.
 *
 *  ─ Hallucination 가드 ─────────────────────────────────────────
 *  inventory 가 비어 있으면 즉시 빈 결과를 돌려준다 — LLM 이 자기 멋대로
 *  단어를 만들어 사용자가 클릭해도 매칭되는 자료가 없는 상황을 막는다.
 *  inventory 가 있어도, 응답 후 inventory 와 교집합만 통과시킨다. */
export async function suggestEnglishTagsForKorean(
  nl: string,
  inventory: SuggestionInventory,
  opts: { inventoryHash?: string; signal?: AbortSignal } = {},
): Promise<KoreanSuggestSpec> {
  const trimmed = nl.trim();
  const emptyResult = (extra?: Partial<KoreanSuggestSpec>): KoreanSuggestSpec => ({
    rawQuery: trimmed,
    suggestedTags: [],
    suggestedMoods: [],
    ...extra,
  });

  if (!trimmed) return emptyResult();
  if (!containsHangul(trimmed)) return emptyResult();
  if (inventory.tags.length === 0 && inventory.moodLabels.length === 0) return emptyResult();

  const hash = opts.inventoryHash ?? hashInventory(inventory);
  const key = makeKey(trimmed, hash);
  const cached = cacheGet(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async (): Promise<KoreanSuggestSpec> => {
    /* LLM 입력 토큰을 줄이기 위해 inventory 가 너무 크면 카테고리별로
       sample 한다 (호출부가 frequency-desc 로 정렬해 넘겨주면 이상적
       이지만, 알파벳 순이어도 의미 있는 후보가 들어온다). */
    const tagSlice = inventory.tags.length > 200 ? inventory.tags.slice(0, 200) : [...inventory.tags];
    const moodSlice =
      inventory.moodLabels.length > 80 ? inventory.moodLabels.slice(0, 80) : [...inventory.moodLabels];

    const prompt = [
      "You translate a Korean search query into the most relevant English tags",
      "and mood labels for a video pre-production reference library.",
      "",
      "CRITICAL RULES:",
      "- Only return tokens that appear in the INVENTORY lists below — never invent new words.",
      "- For `tags`: return at most 5 entries, ordered by relevance.",
      "- For `moods`: return at most 3 entries from the MOOD INVENTORY only.",
      "- Lowercase only. Preserve hyphens/spaces exactly as they appear in the inventory.",
      "- If nothing matches, return empty arrays.",
      "",
      `Korean query: ${trimmed}`,
      "",
      "TAG INVENTORY:",
      tagSlice.join(", ") || "(none)",
      "",
      "MOOD INVENTORY:",
      moodSlice.join(", ") || "(none)",
      "",
      `Return ONLY valid JSON: {"tags": string[], "moods": string[]}`,
    ].join("\n");

    try {
      if (opts.signal?.aborted) throw new Error("AbortError");
      /* gpt-5.x 계열은 temperature 커스텀 거부, 디폴트(=1)만 허용. 결정성은
         response_format=json_object + inventory 강제 교집합 필터로 충분
         확보된다(어차피 inventory 밖 토큰은 client-side 에서 컷). */
      const response = await callOpenAI({
        model: SUGGEST_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: MAX_TOKENS,
        response_format: { type: "json_object" },
      });
      if (opts.signal?.aborted) throw new Error("AbortError");

      const raw = response.choices?.[0]?.message?.content ?? "";
      const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
      let parsed: { tags?: unknown; moods?: unknown } = {};
      try {
        parsed = JSON.parse(cleaned) as { tags?: unknown; moods?: unknown };
      } catch {
        parsed = {};
      }
      const sanitize = (
        bucket: unknown,
        allowed: ReadonlySet<string>,
        max: number,
      ): string[] => {
        const out: string[] = [];
        if (!Array.isArray(bucket)) return out;
        const seen = new Set<string>();
        for (const v of bucket) {
          if (typeof v !== "string") continue;
          const norm = v.trim().toLowerCase();
          if (!norm) continue;
          /* 두 번째 hallucination 가드 — inventory 와 교집합만 통과. */
          if (!allowed.has(norm)) continue;
          if (seen.has(norm)) continue;
          seen.add(norm);
          out.push(norm);
          if (out.length >= max) break;
        }
        return out;
      };

      const tagSet = new Set(inventory.tags.map((t) => t.toLowerCase()));
      const moodSet = new Set(inventory.moodLabels.map((t) => t.toLowerCase()));

      const result: KoreanSuggestSpec = {
        rawQuery: trimmed,
        suggestedTags: sanitize(parsed.tags, tagSet, 5),
        suggestedMoods: sanitize(parsed.moods, moodSet, 3),
      };
      cacheSet(key, result);
      return result;
    } catch (err) {
      /* Abort 는 캐시하지 않고 throw — 호출부가 in-flight 컨트롤을 다시
         걸도록. 그 외 에러는 빈 결과 + error 로 캐시해 짧은 시간 안의
         반복 호출이 같은 실패를 또 일으키지 않게 한다.
         silent UI(사이드바 칩) 이라 setError 가 표면화되지 않으므로
         devtools 추적용으로 콘솔에 한 줄 남긴다 — 모델 미등록 같은 환경
         문제가 자동제안 침묵으로만 보이는 사고를 막기 위함. */
      if (err instanceof Error && err.name === "AbortError") throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.error("[koreanSearchSuggest] suggest failed:", err);
      const result: KoreanSuggestSpec = {
        rawQuery: trimmed,
        suggestedTags: [],
        suggestedMoods: [],
        error: message,
      };
      cacheSet(key, result);
      return result;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/** 테스트 / 디버그 용 — LRU 와 in-flight Promise 를 한 번에 비운다.
 *  운영 코드에서 호출할 일은 없다. */
export function _clearKoreanSuggestCache(): void {
  cache.clear();
  inflight.clear();
}
