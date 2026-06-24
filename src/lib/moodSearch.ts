/**
 * Mood AI 검색 (Phase C)
 *
 * 사용자가 라이브러리 툴바의 MoodFilterChip 에 자연어 한 문장을 입력하면
 *   "잘 곳 면의 따뜻한 이야기 느낌"
 * 같은 NL 을 OpenAI 로 한 번 호출해 `BriefSignals` 로 확장한다. 그 신호는
 * 기존 `scoreReferences()` 함수 (referenceRecommender.ts) 가 그대로 받아
 * 라이브러리의 모든 자료에 매칭 점수를 매긴다 — embedding 없이 토큰 기반
 * 매칭이라 cold-start / 비용 측면에서 안정적이다.
 *
 * 핵심 결정:
 *   - 모델: gpt-5.5-mini — 입력/출력 모두 짧고 (200~300 tokens) 비용 무시
 *     수준. `response_format: json_object` 로 강제 구조화.
 *   - 캐시: 50개 LRU (key = trim+lower NL). 같은 자연어를 또 적용하면
 *     0 ms 에 동작.
 *   - localStorage 최근 5개 — MoodFilterChip 의 dropdown 에 빠른 재선택.
 *   - AbortController 일관성 — Library 페이지에서 칩이 닫히거나 다음
 *     쿼리를 던질 때 직전 in-flight 가 끊어진다.
 */
import { callOpenAI } from "./openai";
import { OPENAI_PRIMARY } from "./modelCatalog";
import { tokenize, type BriefSignals } from "./referenceRecommender";

/* OPENAI_PRIMARY = 현재 카탈로그의 디폴트 OpenAI 모델(`gpt-5.5`).
   하드코딩하지 않고 카탈로그를 통해 가져와, 모델 카탈로그가 갱신되면
   여기도 자동 반영된다. 과거에는 `gpt-5.5-mini` 라는 카탈로그에 존재
   하지 않는 ID를 박아 두어 백엔드(OpenAI proxy) 가 500을 던지고,
   catch 가 빈 신호로 둔갑시켜 사용자에게는 "신호 없음" 만 보였다 — 그
   재발을 막기 위함이다. */
const MOOD_MODEL = OPENAI_PRIMARY;
/* 한/영 두 벌 토큰 + 카테고리당 2-10 개를 허용해 출력이 더 길어진다.
   gpt-5.5 는 reasoning 토큰이 출력 예산을 먼저 소진해, 600 같은 작은 값이면
   본문 JSON 이 나오기 전에 잘려 "빈 신호" 가 된다(briefMatch 와 동일 증상).
   넉넉히 잡아 reasoning + 본문이 모두 들어가게 한다. */
const MAX_TOKENS = 2500;

/** 최소 매칭 점수의 기본값 + 슬라이더 상한.
 *
 *  2026-05 v2 (scoreReferences cross-bucket dedup + weak-token penalty) 이후로
 *  같은 쿼리의 raw 가중합이 약 40-60% 낮아졌다. 과거 임계 2.0/3.0 그대로
 *  쓰면 사실상 모든 결과가 0건. 임계를 비례 하향(2.0 → 1.2, 3.0 → 2.0)
 *  하면서 슬라이더 상한도 2.0 으로 내려 사용자가 "끝까지 올려도 통과 0건"
 *  상황을 안 만나게 한다. 기존 spec 의 minScore > MOOD_MIN_SCORE_MAX 는
 *  로드 시 clamp 된다(MoodFilterChip). */
export const DEFAULT_MOOD_MIN_SCORE = 1.2;
export const MOOD_MIN_SCORE_MIN = 0.3;
export const MOOD_MIN_SCORE_MAX = 2.0;

/** 신호 풍부도에 따른 minScore 동적 산정 (v2 — dedup/weak-penalty 반영).
 *
 *  - 신호 총 ≤ 3 (단일 명사 쿼리 — "청바지", "헬멧", "축구공") → 0.4
 *    → scene_description 단독 매칭(1.0 가중) 한 건만으로도 통과.
 *  - 신호 총 ≤ 6 (짧은 구 — "도시 야경", "핸드헬드 와이드샷") → 0.7
 *    → 두 신호 중 하나라도 분명히 잡힌 자료만 통과.
 *  - 그 외 풍부한 자연어 쿼리 → DEFAULT_MOOD_MIN_SCORE (1.2)
 *    → "느낌이 맞는 자료만" 정책 유지. dedup 후의 raw 가중합 기준.
 *
 *  의도: AI 검색이 일반 검색창의 substring 매칭보다 *못한* 결과를 돌려
 *  주는 회귀(예: scene_description 에 "청바지" 가 있는데 0건)를 막는다.
 *  사용자가 슬라이더로 더 빡빡하게 조이는 것은 여전히 가능. */
export function pickMinScore(signals: BriefSignals): number {
  const total =
    (signals.primary?.length ?? 0)
    + signals.mood.length
    + signals.genre.length
    + signals.product.length
    + signals.location.length
    + signals.lighting.length
    + signals.camera.length
    + signals.keywords.length;
  if (total <= 3) return 0.4;
  if (total <= 6) return 0.7;
  return DEFAULT_MOOD_MIN_SCORE;
}

/** Strict 모드에서 적용할 최소 카테고리 커버리지(서로 다른 *비-primary* 신호
 *  카테고리 중 몇 개가 매치돼야 하는지). primary 는 카테고리 수에서 제외 —
 *  핵심 토큰 강제는 requirePrimary 게이트가 따로 담당한다.
 *
 *  쿼리가 단일 개념(비-primary 카테고리 ≤1) 이면 그 1개만 충족하면 되고,
 *  여러 축으로 풍부한 쿼리는 ≥2개 카테고리를 동시에 충족해야 통과시켜
 *  "흔한 토큰 한두 개만 우연 매칭된" 자료를 걸러낸다. 실제로 쿼리에 존재하는
 *  카테고리 수를 넘지 않게 clamp 해 결과가 통째로 비는 것을 막는다. */
export function pickMinCoverage(signals: BriefSignals): number {
  const realCategories = [
    signals.mood,
    signals.genre,
    signals.product,
    signals.location,
    signals.lighting,
    signals.camera,
    signals.keywords,
  ].filter((arr) => arr.length > 0).length;
  if (realCategories <= 1) return realCategories; // 0 또는 1
  return 2;
}

/** AI Search 의 활성 필터. `strict` 는 cross-bucket dedup 위에 얹는 두 번째
 *  precision 레이어 (intent-anchor + high-weight ref bucket 게이트) 의 ON/OFF.
 *  기본은 ON — 사용자 호소("정확도 안 맞는다") 의 일차 해결책이라, 새로
 *  적용되는 모든 쿼리는 strict 로 시작한다. UI 의 토글로 즉시 OFF 전환 가능. */
export interface MoodFilterSpec {
  rawQuery: string;
  signals: BriefSignals;
  minScore: number;
  /** strict ON 일 때 추가 게이트 적용 (기본 true). legacy spec 로드 시
   *  부재하면 `?? true` 로 채운다. */
  strict: boolean;
}

/** localStorage 의 v1/v2 recent 엔트리 또는 자체 spec 직렬화에서 strict
 *  필드가 누락된 경우 안전하게 기본값 true 로 채운다. */
export function withStrictDefault<T extends { strict?: boolean }>(
  spec: T,
): T & { strict: boolean } {
  return { ...spec, strict: spec.strict ?? true };
}

/** 슬라이더 값이 새 max 를 넘으면 clamp. UI 슬라이더는 마운트 시 이 함수로
 *  들어온 값으로 시작하고, 기존에 3.0 으로 저장돼 있던 spec 도 자연스럽게
 *  안전 범위로 떨어진다. */
export function clampMinScore(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MOOD_MIN_SCORE;
  return Math.max(MOOD_MIN_SCORE_MIN, Math.min(MOOD_MIN_SCORE_MAX, value));
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * LRU cache + in-flight dedup
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const LRU_LIMIT = 50;
const cache = new Map<string, BriefSignals>();
const inflight = new Map<string, Promise<BriefSignals>>();

function makeKey(query: string): string {
  return query.trim().toLowerCase();
}

function cacheGet(key: string): BriefSignals | undefined {
  const v = cache.get(key);
  if (!v) return undefined;
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function cacheSet(key: string, value: BriefSignals): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > LRU_LIMIT) {
    const first = cache.keys().next().value as string | undefined;
    if (!first) break;
    cache.delete(first);
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Recent queries (사용자가 최근에 "적용한" mood NL — 칩 dropdown 용)
 *
 * 저장 모양 변천:
 *   v1: string[]                                  (raw NL 만 저장)
 *   v2: { rawQuery, signals, savedAt }[]          ← 현재
 *
 * v2 로 가는 이유: 최근 검색 항목을 클릭했을 때 LLM 을 다시 부르는
 * 대신 저장된 signals 를 그대로 spec 에 복원해 즉시 결과가 뜨도록.
 * (사용자 입장에서 '최근'은 메모리, 매번 재분석은 의미가 없음.)
 * 구버전 string[] 도 그대로 읽히도록 migration 분기를 둔다 — string
 * 항목은 signals 가 비어 있으니 클릭 시 자연스럽게 LLM 재호출로
 * 폴백된다.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const RECENT_KEY = "preflow.moodSearch.recent";
const RECENT_LIMIT = 5;

export interface RecentMoodEntry {
  rawQuery: string;
  signals: BriefSignals;
  /** 마지막으로 적용된 시각(ms). 0 = 마이그레이션된 legacy 항목. */
  savedAt: number;
}

/** 임의의 unknown 입력을 안전하게 `BriefSignals` 모양으로 정규화.
 *  필드가 누락됐거나 형식이 어긋나도 빈 배열로 떨어뜨려 호출부가
 *  totalSignals() === 0 분기를 그대로 탈 수 있게 한다. */
function coerceSignals(value: unknown): BriefSignals {
  const v = (value ?? {}) as Record<string, unknown>;
  const pick = (k: string): string[] => {
    const arr = v[k];
    if (!Array.isArray(arr)) return [];
    return arr.filter((t): t is string => typeof t === "string");
  };
  return {
    primary: pick("primary"),
    mood: pick("mood"),
    genre: pick("genre"),
    product: pick("product"),
    location: pick("location"),
    lighting: pick("lighting"),
    camera: pick("camera"),
    keywords: pick("keywords"),
  };
}

export function getRecentMoodEntries(): RecentMoodEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: RecentMoodEntry[] = [];
    for (const item of parsed) {
      if (typeof item === "string") {
        /* legacy v1 항목 — signals 비어 있어 클릭 시 LLM 으로 폴백. */
        if (item.trim()) {
          out.push({ rawQuery: item.trim(), signals: emptySignals(), savedAt: 0 });
        }
        continue;
      }
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const rawQuery = typeof rec.rawQuery === "string" ? rec.rawQuery.trim() : "";
        if (!rawQuery) continue;
        out.push({
          rawQuery,
          signals: coerceSignals(rec.signals),
          savedAt: typeof rec.savedAt === "number" ? rec.savedAt : 0,
        });
      }
      if (out.length >= RECENT_LIMIT) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** 가장 최근 적용한 항목을 dropdown 맨 위로 끌어올리며 저장. 같은
 *  rawQuery 가 이미 있으면 새 signals 로 덮어쓴다. */
export function rememberMoodEntry(spec: {
  rawQuery: string;
  signals: BriefSignals;
}): void {
  const trimmed = spec.rawQuery.trim();
  if (!trimmed) return;
  try {
    const current = getRecentMoodEntries().filter((e) => e.rawQuery !== trimmed);
    const next: RecentMoodEntry[] = [
      { rawQuery: trimmed, signals: spec.signals, savedAt: Date.now() },
      ...current,
    ].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private 모드 등 — 무시. UX 에 critical 하지 않음. */
  }
}

/** 단일 항목 제거 — 드롭다운 row 옆의 X 버튼에서 호출. */
export function removeMoodEntry(rawQuery: string): void {
  const trimmed = rawQuery.trim();
  if (!trimmed) return;
  try {
    const current = getRecentMoodEntries().filter((e) => e.rawQuery !== trimmed);
    if (current.length === 0) {
      localStorage.removeItem(RECENT_KEY);
    } else {
      localStorage.setItem(RECENT_KEY, JSON.stringify(current));
    }
  } catch {
    /* noop */
  }
}

export function clearRecentMoodQueries(): void {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    /* noop */
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * LLM 응답 정규화
 *
 * LLM 이 어떤 모양으로 반환하든 BriefSignals (모든 키가 string[]) 로
 * 줄인다. 키 누락 / 타입 부정합 / 빈 배열도 안전하게 통과 — 매칭은
 * scoreReferences() 가 알아서 비어 있는 카테고리를 0 점으로 본다.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function normTokens(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    /* referenceRecommender.tokenize 를 그대로 호출해 자료 측 좌표계와
       100% 일치시킨다. 이로써:
         · `golden-hour` → ["golden", "hour"] 로 양쪽 모두 쪼개져 매칭됨
         · 공백 / 콤마 / 슬래시 등 모든 구분자도 동일 규칙으로 처리
         · 1글자 / stopwords 도 동일하게 제거. */
    for (const tok of tokenize(v)) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

function emptySignals(): BriefSignals {
  return {
    primary: [],
    mood: [],
    genre: [],
    product: [],
    location: [],
    lighting: [],
    camera: [],
    keywords: [],
  };
}

/** 자연어 → BriefSignals. 캐시 hit 이면 즉시 반환, 아니면 LLM 호출.
 *  호출부(LibraryPage) 는 결과를 들고 `scoreReferences()` 로 매칭. */
export async function expandMoodQuery(
  nl: string,
  opts: { signal?: AbortSignal } = {},
): Promise<MoodFilterSpec> {
  const trimmed = nl.trim();
  if (!trimmed) {
    /* 빈 쿼리는 어차피 scoreReferences 가 empty signals 로 0건을 돌려
       주므로 minScore 값 자체는 무의미. 일관성을 위해 dynamic 으로 계산. */
    const empty = emptySignals();
    return { rawQuery: "", signals: empty, minScore: pickMinScore(empty), strict: true };
  }
  const key = makeKey(trimmed);
  const cached = cacheGet(key);
  if (cached) {
    return { rawQuery: trimmed, signals: cached, minScore: pickMinScore(cached), strict: true };
  }
  const pending = inflight.get(key);
  if (pending) {
    const sig = await pending;
    return { rawQuery: trimmed, signals: sig, minScore: pickMinScore(sig), strict: true };
  }

  const promise = (async (): Promise<BriefSignals> => {
    const prompt = [
      "Convert a natural-language search query into structured visual reference signals.",
      "Goal: pick reference clips/images that *feel* like the description.",
      "Always think in short keywords (1-3 words each).",
      "",
      "IMPORTANT — bilingual output:",
      "Emit BOTH natural English tokens AND natural Korean tokens in every non-empty category.",
      "The matching system indexes references in both languages, so providing both maximizes recall.",
      "Korean tokens should be how a native speaker would naturally describe the concept",
      "(예: 따뜻한, 도시 야경, 네온, 와이드샷, 핸드헬드, 클로즈업, 광고, 뮤직비디오, 다큐멘터리).",
      "Do not transliterate — use real Korean words.",
      "",
      "Fill the following JSON shape — use empty arrays when a category does not apply:",
      "{",
      '  "primary": string[],',
      '  "mood": string[],',
      '  "genre": string[],',
      '  "product": string[],',
      '  "location": string[],',
      '  "lighting": string[],',
      '  "camera": string[],',
      '  "keywords": string[]',
      "}",
      "",
      "Rules:",
      "- `primary`: THE CORE SUBJECT of the query — the 1-3 essential concepts a matching reference MUST contain. Be strict: only the literal subject(s), not inferred attributes. Emit BOTH languages (e.g. query \"네온사인\" → [\"neon\",\"sign\",\"signage\",\"네온\",\"네온사인\",\"간판\"]; query \"비 오는 도시 밤거리\" → [\"rain\",\"city\",\"night\",\"비\",\"도시\",\"밤\"]). Do NOT put incidental/inferred attributes here.",
      "- `mood`: emotion / atmosphere words (warm, tense, dreamy, melancholic / 따뜻한, 긴장감, 몽환적, 쓸쓸한).",
      "- `genre`: content kind (ad, music-video, documentary, tutorial, vlog / 광고, 뮤직비디오, 다큐멘터리, 튜토리얼, 브이로그).",
      "- `product`: product or subject names if the query names them (otherwise empty). Keep brand names as-is in original script.",
      "- `location`: place / environment (urban night, beach, forest, cafe interior / 도시 야경, 바다, 숲, 카페 내부).",
      "- `lighting`: lighting keywords (neon, golden hour, low key, soft, backlit / 네온, 황금빛, 로우키, 부드러운 빛, 역광).",
      "- `camera`: shot/lens/motion (wide, close-up, handheld, drone, slow motion / 와이드, 클로즈업, 핸드헬드, 드론, 슬로우모션).",
      "- `keywords`: any other useful free tokens that don't fit the buckets above (한/영 모두 환영).",
      "- For Korean queries, infer reasonable English equivalents AND keep the original Korean tokens.",
      "- For English queries, generate natural Korean equivalents AND keep the original English tokens.",
      "- Use spaces, not hyphens, for multi-word phrases (\"golden hour\" not \"golden-hour\").",
      "- Lowercase all English tokens. Korean tokens as-is.",
      "- Never invent product or brand names that the query does not mention.",
      "- Be precise, not exhaustive: only fill categories the query actually implies. Do NOT pad with loosely-related tokens (e.g. for \"네온사인\" do not add generic camera/location guesses unless the query mentions them).",
      "- 2-5 tokens per non-empty category (counting both languages together). `primary`: 1-3 concepts max.",
      "",
      `Query: ${trimmed}`,
      "",
      "Return ONLY valid JSON (no commentary).",
    ].join("\n");

    if (opts.signal?.aborted) throw new Error("AbortError");
    /* gpt-5.x 계열은 `temperature` 커스텀을 거부하고 디폴트(=1)만 허용.
       과거 0.1 을 보내다가 백엔드에서 400 "does not support 0.1" 으로
       튕겼다. 결정성은 (a) response_format=json_object 강제, (b) 충분히
       구체적인 프롬프트 + 한/영 예시 토큰, (c) LRU 캐시로 충분히 확보된다. */
    const response = await callOpenAI({
      model: MOOD_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: MAX_TOKENS,
      response_format: { type: "json_object" },
    });
    if (opts.signal?.aborted) throw new Error("AbortError");

    const raw = response.choices?.[0]?.message?.content ?? "";
    const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    let parsed: Record<string, unknown> = {};
    let parseError: unknown = null;
    try {
      parsed = JSON.parse(cleaned) as Record<string, unknown>;
    } catch (e) {
      parseError = e;
      parsed = {};
    }
    const signals: BriefSignals = {
      primary: normTokens(parsed.primary),
      mood: normTokens(parsed.mood),
      genre: normTokens(parsed.genre),
      product: normTokens(parsed.product),
      location: normTokens(parsed.location),
      lighting: normTokens(parsed.lighting),
      camera: normTokens(parsed.camera),
      keywords: normTokens(parsed.keywords),
    };
    /* 진단 로그 — gpt-5.5 가 json_object 모드에서 어떤 응답을 돌려주는지
       콘솔에 한 번 노출한다. warn 으로 띄워야 Vite 의 client-relay 가
       터미널까지 흘려준다 (log/debug 는 일부 환경에서 누락). 한 번 안정
       화되면 일반 console.log 로 낮춰도 됨. */
    const totalTokens = Object.values(signals).reduce((a, b) => a + b.length, 0);
    console.warn("[moodSearch][diag] LLM response", {
      query: trimmed,
      finish: response.choices?.[0]?.finish_reason,
      usage: response.usage,
      rawLength: raw.length,
      rawPreview: raw.slice(0, 400),
      parseError: parseError ? String(parseError) : null,
      parsedKeys: Object.keys(parsed),
      signalTotal: totalTokens,
      signals,
    });
    /* 빈 신호는 캐시하지 않는다. 재시도 시 같은 쿼리가 다시 LLM 으로
       향해야 진단(또는 모델 컨디션 변경)이 의미를 가진다. catch 경로와
       동일한 정책. */
    if (totalTokens > 0) {
      cacheSet(key, signals);
    }
    return signals;
  })();

  inflight.set(key, promise);
  try {
    const signals = await promise;
    return { rawQuery: trimmed, signals, minScore: pickMinScore(signals), strict: true };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    /* 실패 시 빈 신호로 둔갑시키지 않고 그대로 던진다. 호출부
       (MoodFilterChip) 가 이미 err.message 를 사용자 친화적으로
       UI 에 노출하도록 되어 있어, "추출된 신호 없음" 같은 모호한
       메시지 대신 "model X does not exist" 같은 실제 원인이 보인다.
       콘솔에도 한 줄 남겨 두어 사용자가 dev tools 로 추적하기 쉽게. */
    console.error("[moodSearch] expandMoodQuery failed:", err);
    throw err;
  } finally {
    inflight.delete(key);
  }
}

/** 테스트 / 디버그 용 — LRU 와 in-flight Promise 를 비운다. */
export function _clearMoodSearchCache(): void {
  cache.clear();
  inflight.clear();
}
