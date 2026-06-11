/**
 * Reference recommender — Phase 9.
 *
 * 라이브러리 자료의 메타(tags, notes, ai_suggestions, color_palette) 를 입력
 * 신호와 매칭해 점수를 매긴다. 추천 결과는 "추천 카드 + 짧은 매칭 이유"
 * 형태로 표시되며 (`reasons` 토큰), 사용자가 카드를 클릭하면 호출부가
 * `linkReferenceToProject` 로 실제 연결을 만든다.
 *
 * 의도적으로 LLM 을 부르지 않는다 — 추천은 즉시 떠야 하고 OpenAI 키가 없는
 * 환경에서도 동작해야 한다. AI 가 정해 놓은 메타(`ai_suggestions.suggested_tags`,
 * `mood_labels`, `use_cases`) 가 있으면 가중치를 더 주는 식으로만 합류시킨다.
 */

import type { ReferenceAiSuggestions } from "./referenceAi";
import type { ReferenceItem } from "./referenceLibrary";

/** Brief 분석 결과에서 뽑은 신호. 비어 있는 필드는 그냥 점수에 기여하지 않음. */
export interface BriefSignals {
  /** mood/tone keywords — 분석의 tone_manner.keywords 등에서 합류. */
  mood: string[];
  /** Genre / content type — "tutorial", "ad", "documentary" 같은 키워드. */
  genre: string[];
  /** 제품/주제 이름 후보 — 보통 제품명 1-2 개. */
  product: string[];
  /** 장소/환경 키워드. */
  location: string[];
  /** 조명 키워드 — "golden hour", "neon", "soft", "high-key" 등.
   *  BriefAnalysis.visual_direction.lighting 에서 라우팅한다. */
  lighting: string[];
  /** 카메라/샷 키워드 — "wide", "close-up", "handheld", "drone" 등.
   *  BriefAnalysis.visual_direction.camera 에서 라우팅한다. */
  camera: string[];
  /** 그 외 자유 키워드 — 사용자 입력 텍스트 등 모든 토큰. */
  keywords: string[];
}

/** Conti / Agent 의 한 scene 에서 뽑은 신호. */
export interface SceneSignals {
  /** 카메라 샷 종류 — wide / close / handheld 등. */
  shot: string[];
  /** 동작 / 모션 키워드. */
  motion: string[];
  /** 장면 mood / 감정. */
  mood: string[];
  /** 그 외 키워드 — description, location, props 등. */
  keywords: string[];
}

export interface RecommendedReference {
  item: ReferenceItem;
  score: number;
  /** UI 칩에 띄울 사람-friendly 이유 토큰. 예: ["mood:tense","tag:neon"]. */
  reasons: string[];
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "for", "to", "with", "by",
  "is", "are", "was", "were", "be", "been", "being", "this", "that", "these",
  "those", "it", "its", "as", "at", "from", "into", "onto", "off", "over",
  "under", "but", "if", "than", "then", "so", "such",
]);

/* CJK(한글/한자/가나) 한 글자가 곧 한 단어인 경우가 영상/디자인 도메인에서
   매우 흔하다 — "밤", "낮", "차", "꽃", "비", "눈", "산", "강". 영어/숫자
   1글자 stopwords 방어와는 정책이 달라야 검색에서 누락되지 않는다. */
const CJK_REGEX = /[\u3131-\uD7A3\u3041-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;
function hasCjk(token: string): boolean {
  return CJK_REGEX.test(token);
}

/* 한국어 조사(을/를/이/가/은/는 등) 가 명사에 붙으면 토큰화 후에도
   "청바지를", "거리에서" 같은 형태로 그대로 남아 사용자 쿼리 토큰 "청바지" /
   "거리" 와 *exact-token* intersect 가 0 으로 떨어진다. AI 검색
   (moodSearch + scoreReferences) 이 자료의 scene_description_ko 안 명사를
   못 잡는 회귀(예: "장면 묘사에 청바지가 있는데 청바지로 검색해도 안 잡힘")
   의 1차 원인.

   완전한 형태소 분석기(mecab-ko/kuromoji) 대신 *원본 + stem 양쪽 emit*
   하는 보수적 휴리스틱으로 처리:
     - 2글자 이상 조사(에서/으로/이라/라고/이라고/부터/까지/보다/처럼/
       마저/조차/만큼/한테/에게/이랑) → 명사 어말이 우연히 이 길이로
       일치할 가능성이 극히 낮아 stem 안전.
     - 1글자 조사(을/를/이/가/은/는/의/에/로/와/과/랑) → stem 이 ≥ 2글자
       일 때만 떼어낸다. "수도" → "수" 같은 1글자 stem 폐기 ("수도" 가
       명사로 살아 있는 케이스 보호).
     - 위험도 큰 단음절 조사(도/만/뿐) 는 명사 어말 충돌 가능성이 너무
       커서 의도적으로 제외 (수도/자만/뿐 등).

   원본 토큰도 항상 같이 emit 하므로, 휴리스틱이 잘못 떼어 낸 케이스에도
   원본 매칭은 보존되어 false-negative 가 새로 생기지 않는다. 부수적으로
   stem 이 추가될 뿐이라 false-positive 위험은 "1 토큰 가짜 매칭" 정도
   (scoreReferences 의 다른 버킷이 거의 항상 뒷받침해야 결과로 떨어진다).

   사용자 쿼리 측에서도 같은 tokenize 를 통과하므로, "청바지를" 로 검색해도
   stem 인 "청바지" 가 함께 emit 되어 자료 측 "청바지" 와 양방향으로 매칭
   된다. */
const KOREAN_PARTICLES_LONG = [
  "이라고", "에서", "으로", "이라", "라고",
  "부터", "까지", "보다", "처럼", "마저",
  "조차", "만큼", "한테", "에게", "이랑",
];
const KOREAN_PARTICLES_SHORT = [
  "을", "를", "이", "가", "은", "는",
  "의", "에", "로", "와", "과", "랑",
];

function stripKoreanParticle(token: string): string | null {
  if (!hasCjk(token)) return null;
  for (const p of KOREAN_PARTICLES_LONG) {
    if (token.length > p.length && token.endsWith(p)) {
      const stem = token.slice(0, -p.length);
      if (hasCjk(stem) && stem.length >= 1) return stem;
    }
  }
  /* 1글자 조사 — token 길이가 3 이상이고 stem 이 2글자 이상일 때만 떼어
     낸다. "차를"(2) → "차"(1) 같은 단음절 stem 은 폐기해 도메인 명사를
     보호하면서, "청바지를"(4) → "청바지"(3) 같은 일반 케이스는 통과. */
  for (const p of KOREAN_PARTICLES_SHORT) {
    if (token.length >= 3 && token.endsWith(p)) {
      const stem = token.slice(0, -p.length);
      if (hasCjk(stem) && stem.length >= 2) return stem;
    }
  }
  return null;
}

/** 자유 텍스트 → 소문자 토큰 배열. 한글은 그대로 보존, 영어/숫자만 normalize.
 *
 *  외부(moodSearch.ts)에서도 같은 토크나이저로 LLM 출력 토큰을 정규화해야
 *  하이픈 복합어(`urban-night`)가 양쪽에서 동일하게 ["urban", "night"] 로
 *  쪼개진다 → 매칭 좌표계 일치. export 로 단일 진실원을 공유한다.
 *
 *  길이 가드는 비CJK(영어/숫자) 토큰에만 length >= 2 를 적용한다 — 한글
 *  "차", "밤", "꽃" 같은 1음절 단어가 stopwords 방어를 핑계로 사라지면
 *  Mood/Tag 검색에서 통째로 누락된다. CJK 가 섞인 토큰은 length 1 이어도
 *  유의미하다.
 *
 *  한국어 조사가 붙은 토큰은 stripKoreanParticle 로 stem 을 추출해 *원본과
 *  함께* 두 토큰 모두 emit 한다 — 정책 자세한 설명은 stripKoreanParticle
 *  주석 참고. */
export function tokenize(input: string | null | undefined): string[] {
  if (!input || typeof input !== "string") return [];
  const raw = input
    .toLowerCase()
    .split(/[\s,.;:!?()[\]{}"'`/\\|·•—–-]+/u)
    .map((token) => token.trim())
    .filter((token) => {
      if (!token) return false;
      if (STOPWORDS.has(token)) return false;
      if (hasCjk(token)) return true;
      return token.length >= 2;
    });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of raw) {
    if (!seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
    const stem = stripKoreanParticle(tok);
    if (stem && !seen.has(stem)) {
      seen.add(stem);
      out.push(stem);
    }
  }
  return out;
}

function normalizeArray(values: Array<string | null | undefined> | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.flatMap((v) => tokenize(v)))];
}

/** 두 토큰 set 의 교집합. tokenize 가 이미 trim/lower 했다고 가정. */
function intersect(a: string[], b: string[]): string[] {
  if (a.length === 0 || b.length === 0) return [];
  const set = new Set(a);
  const out = new Set<string>();
  for (const t of b) if (set.has(t)) out.add(t);
  return [...out];
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 신호 추출
 *
 * Brief / Scene 양쪽에서 자주 쓰는 필드들을 받아 정규화. 호출부는 자기
 * 도메인의 어떤 데이터든 string / string[] 로 줄여 넘기면 된다 — 추천기는
 * 데이터 모양을 모른 채 토큰만 본다.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface ExtractBriefSignalsInput {
  /** tone_manner.keywords / mood — 정확히 알면 여기에. */
  mood?: Array<string | null | undefined>;
  /** content_type / hook_strategy.kind / production_notes.shooting_style 등. */
  genre?: Array<string | null | undefined>;
  /** product_info.brand / product_name / target_audience.primary 등. */
  product?: Array<string | null | undefined>;
  /** location 키워드. */
  location?: Array<string | null | undefined>;
  /** 조명 키워드 — visual_direction.lighting 등. */
  lighting?: Array<string | null | undefined>;
  /** 카메라/샷 키워드 — visual_direction.camera 등. */
  camera?: Array<string | null | undefined>;
  /** Free-form 텍스트 (raw_text, analysis.goal.summary, idea_note 등). */
  text?: Array<string | null | undefined>;
}

export function extractBriefSignals(input: ExtractBriefSignalsInput): BriefSignals {
  return {
    mood: normalizeArray(input.mood),
    genre: normalizeArray(input.genre),
    product: normalizeArray(input.product),
    location: normalizeArray(input.location),
    lighting: normalizeArray(input.lighting),
    camera: normalizeArray(input.camera),
    keywords: normalizeArray(input.text),
  };
}

export interface ExtractSceneSignalsInput {
  shot?: Array<string | null | undefined>;
  motion?: Array<string | null | undefined>;
  mood?: Array<string | null | undefined>;
  text?: Array<string | null | undefined>;
}

export function extractSceneSignals(input: ExtractSceneSignalsInput): SceneSignals {
  return {
    shot: normalizeArray(input.shot),
    motion: normalizeArray(input.motion),
    mood: normalizeArray(input.mood),
    keywords: normalizeArray(input.text),
  };
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 스코어링
 *
 * 가중치는 "사용자가 직접 단 태그 > AI 가 제안한 태그 > free-text" 순으로
 * 점차 작아진다. 가중치 합이 어디서든 명확히 0-100 사이에 들어오게 만들지는
 * 않는다 — 절대값이 아니라 정렬용 상대값이다.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const WEIGHTS = {
  userTag: 1.0,
  aiTag: 0.6,
  /** mood_labels 는 referenceAi.ts 의 컨트랙트상 자료당 2-4 토큰으로 의도적
   *  으로 작게 유지된다(emotion-only). suggested_tags(8-10) 와 매칭 확률
   *  자체가 다르기 때문에, 가중치만 0.6 → 0.7 차이로는 mood 검색이 일관되게
   *  과소평가된다. 0.7 → 1.0 으로 끌어올려 mood 토큰 1 개 매칭이
   *  suggested_tag 토큰 1 개보다 약간 더 무겁게 잡히도록 조정 — Mood AI(NL)
   *  검색에서 단일 mood 라벨 매칭(예: 자료의 "tense" 가 사용자 NL "긴장된"
   *  쿼리의 mood 신호와 만남) 가 DEFAULT_MOOD_MIN_SCORE 컷오프(2.0) 안에
   *  들어올 가능성이 의미 있는 수준으로 올라간다.
   *  acceptReferenceAiSuggestions 가 mood_labels 를 머지하지 않는 정책
   *  (referenceAi.ts 854) 과 함께, mood 는 "AI 가 잡아낸 감정 신호" 의 1차
   *  소스라는 의미가 매칭 가중에서도 일관되게 표현된다. */
  aiMoodLabel: 1.0,
  aiUseCase: 0.9,
  /** 이미 분류 비용을 들인 AI 메타들 — 매칭에 합류만 시킴, 사실상 무료.
   *  사용자 태그/AI 태그보다는 약하게, 그러나 noisy 한 title/notes 보다는
   *  강하게 가중치를 둔다. */
  aiVisualStyle: 0.5,
  aiMotionNotes: 0.4,
  aiShotType: 0.4,
  aiColorNotes: 0.4,
  aiBriefFit: 0.5,
  aiContentType: 0.6,
  /** scene_description 은 referenceAi.ts 의 prompt 가 명시적으로 "the
   *  searchable description that lets users find this reference by literal
   *  keywords" 로 설계한 1차 키워드 인덱스다. 모델은 화면에 보이는 구체
   *  명사(사람의 옷차림/포즈, 사물, 장소, 식별 가능한 브랜드 등)만 객관적
   *  으로 나열하라고 강제되므로, visual_style 같은 해석형 텍스트보다 명사
   *  매칭 정밀도가 훨씬 높다.
   *
   *  과거 0.5 였을 때는 단일 명사 쿼리("청바지", "헬멧" 등) 가 scene 한
   *  곳에서만 매칭되면 점수 0.5 → mood 검색 컷오프(2.0) 에 막혀 결과가
   *  0 건으로 떨어졌다. 사용자 태그(1.0) 와 동일 가중까지 끌어올려, scene
   *  단독 매칭 1 건만으로도 동적 minScore(moodSearch.pickMinScore) 의 하한
   *  컷(0.5) 을 자연스럽게 통과하도록 한다.
   *
   *  사용자 태그(1.0) 과 동률이 된다는 점이 어색해 보일 수 있으나, AI
   *  설계상 scene 은 "사용자가 일일이 태그를 안 달아도 동일한 검색 경험을
   *  주기 위한 자동 인덱스" 라 같은 신뢰도로 합류시키는 것이 의도와 맞다.
   *  태그가 직접 일치하면 scene + user-tag 두 버킷에서 동시에 점수가 들어
   *  와 자연스럽게 사용자 태그 자료가 위로 올라가는 정렬은 유지된다. */
  aiSceneDescription: 1.0,
  notes: 0.4,
  title: 0.5,
  /** last_used_at 가 최근 30일 이내면 약한 보너스 — 사용자가 최근에 손댄
   *  자료가 검색 의도와 가까울 가능성이 높다. */
  recencyBonus: 0.2,
  /** Brief 의 mood / Scene 의 mood / shot 같은 "전용" 신호와 매칭됐을 때만
   *  이유 토큰에 카테고리 prefix 를 붙여 사람이 읽기 쉽게 한다. 추가 가중치는
   *  주지 않음 — 이중 카운트 방지. */
} as const;

/* ───────────────────────────────────────────────────────────────
 * 약한/일반 토큰 — 매칭 weight 패널티
 *
 * LLM 이 `BriefSignals` 를 풍부하게 뽑을 때 거의 항상 함께 따라오는 generic
 * 한 단어들. 그 자체로는 어떤 자료에든 들어맞을 만큼 의미가 흐려서, 다른
 * 카테고리에 풍부한 토큰이 있어도 이 토큰들이 한두 개 우연 매칭되면 가중합
 * 임계를 가볍게 통과시키는 노이즈 원천이 된다 — "총격씬" 쿼리가 단순히 비-액션
 * 영상 클립을 끌어들이는 원인 중 하나가 이 부류 토큰들이었다.
 *
 * 정책: 매칭 자체는 살려서 *랭킹 정렬 신호* 로는 활용하되, 가중치를 0.3 배로
 * 강하게 깎는다. 풍부한 쿼리에서는 weak 토큰만으로 임계 통과가 어려워지고
 * (다른 strong 토큰이 함께 매칭돼야 통과), 단일 명사 쿼리는 영향 없음.
 *
 * 리스트는 의도적으로 보수적으로 시작 — 운영하며 false-positive 가 잦은
 * 토큰만 점진 확장. 도메인 명사("총격", "shootout", "neon", "warm") 는
 * 절대 추가하지 않는다. */
const WEAK_SIGNAL_TOKENS: ReadonlySet<string> = new Set([
  // 영어 — 영상/디자인 도메인 전반에서 "어떤 자료에든 적용 가능"한 단어들
  "action", "scene", "shot", "motion", "look", "feel",
  "mood", "vibe", "style", "film", "video", "image",
  "reference", "thing", "stuff", "general", "generic",
  // 한국어 — 동일 의미군. 단음절은 가급적 피하고 도메인 명사 충돌 위험이
  // 낮은 것만.
  "씬", "장면", "샷", "영상", "이미지", "참고", "레퍼런스",
  "느낌", "분위기", "인기", "셋업", "감각",
]);

const WEAK_TOKEN_PENALTY = 0.3;

/** 이 토큰이 매치됐을 때 점수 weight 에 적용할 multiplier.
 *  weak set 안에 있으면 0.3, 그 외엔 1.0. */
function tokenStrengthMultiplier(token: string): number {
  return WEAK_SIGNAL_TOKENS.has(token) ? WEAK_TOKEN_PENALTY : 1.0;
}

/* ───────────────────────────────────────────────────────────────
 * Strict 모드 게이트 (v3 — anchor × high-weight 결합)
 *
 * Strict ON 일 때 점수 합산과 별개로 단일 게이트를 추가로 통과해야 결과에
 * 포함된다 — 가중합이 우연히 임계점을 넘어버린 false-positive 를 차단.
 *
 *   · Anchor-on-high-weight: 사용자 의도 카테고리(mood / keywords /
 *     lighting / product) 의 WEAK 가 아닌 토큰이 *직접* high-weight ref
 *     bucket (가중치 ≥ HIGH_WEIGHT_THRESHOLD) 과 매치해야 한다.
 *
 * v2 까지는 "anchor 매치 ≥1" 과 "high-weight ref bucket 매치 ≥1" 을
 * 독립 OR 로 검증해, 다른 약한 토큰이 우연히 anchor 를 채우고 *전혀
 * 무관한 다른 토큰* 이 high-weight 를 채우는 백도어가 있었다. "네온
 * 스타일" 쿼리에 뽀로로/PUBG 같은 무관 자료가 통과되던 회귀의 1차
 * 원인. v3 에선 두 조건을 토큰 단위로 묶어, "쿼리의 핵심 의도 토큰이
 * 자료의 구조화 메타에 실제로 들어 있어야" 통과하게 만든다.
 *
 * Anchor 카테고리에 lighting / product 도 포함한다 — "네온"(조명) /
 * "황금시간"(조명) / 특정 브랜드명(product) 처럼 *해당 카테고리 자체가
 * 사용자 의도* 인 경우가 흔하다. 반면 camera / location / genre 는
 * 보조 정보 성격이라 anchor 에서 제외 (사용자가 "와이드샷" 만 쳤다고
 * 해서 모든 와이드샷 자료를 strict 로 통과시키지 않는다).
 *
 * High-weight ref bucket (가중치 ≥ 0.9):
 *   user_tag (1.0), aiMoodLabel (1.0), aiUseCase (0.9),
 *   aiSceneDescription (1.0)
 * 즉 사용자가 직접 단 태그, AI 가 구조화한 mood/use-case 라벨, 그리고
 * AI 가 객관 명사로 작성한 scene 묘사. title/notes/visual_style 같은
 * verbose / 해석성 텍스트는 high-weight 아님 → anchor 게이트 통과에
 * 단독 기여 불가.
 * ─────────────────────────────────────────────────────────────── */
const HIGH_WEIGHT_THRESHOLD = 0.9;

/* Anchor 로 인정되는 signal 카테고리(=`flattenSignal` 의 reasonPrefix).
 * "keyword" 는 BriefSignals 의 keywords (SceneSignals 도 같은 prefix 공유).
 * camera / location / genre 는 의도적 제외 — 보조 정보. */
const ANCHOR_CATEGORIES: ReadonlySet<string> = new Set([
  "mood",
  "keyword",
  "lighting",
  "product",
]);

function recencyBonus(lastUsedAt: string | null | undefined): number {
  if (!lastUsedAt) return 0;
  const t = new Date(lastUsedAt).getTime();
  if (!Number.isFinite(t)) return 0;
  const ageDays = (Date.now() - t) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 0;
  if (ageDays > 30) return 0;
  return WEIGHTS.recencyBonus * (1 - ageDays / 30);
}

interface MatchableTokens {
  /** key → token bucket. 같은 토큰이 여러 카테고리에 등장하면 각각의 가중치를 다 받는다. */
  buckets: Array<{ tokens: string[]; weight: number; reasonPrefix: string }>;
}

function tokensFromReference(item: ReferenceItem): MatchableTokens {
  const ai = (item.ai_suggestions ?? null) as Partial<ReferenceAiSuggestions> | null;
  const userTags = (item.tags ?? []).filter((tag) => !tag.startsWith("source:"));
  const folderTags = userTags.filter((tag) => tag.startsWith("folder:")).map((tag) => tag.replace(/^folder:/, ""));
  const plainUserTags = userTags.filter((tag) => !tag.startsWith("folder:"));

  /* AI 분석은 모든 카테고리에 대해 canonical(영어) + `_ko` 두 벌을 평행
     저장한다(referenceAi.ts). 매칭은 언어를 가리지 않고 토큰 교집합만 보므로
     같은 버킷에 양 언어 토큰을 합쳐 넣어 두면 한글 쿼리(또는 한글 자료 메타)
     도 동일한 점수 경로를 탄다. canonical 만 보던 기존 동작에서는 KO 인덱스가
     사실상 dead-weight 였는데, 그 정보를 매칭에 정상적으로 합류시킨다. */
  const aiSuggestedTags = [...(ai?.suggested_tags ?? []), ...(ai?.suggested_tags_ko ?? [])];
  const aiMoodLabels = [...(ai?.mood_labels ?? []), ...(ai?.mood_labels_ko ?? [])];
  const aiUseCases = [...(ai?.use_cases ?? []), ...(ai?.use_cases_ko ?? [])];

  return {
    buckets: [
      { tokens: normalizeArray(plainUserTags), weight: WEIGHTS.userTag, reasonPrefix: "tag" },
      { tokens: normalizeArray(folderTags), weight: WEIGHTS.userTag, reasonPrefix: "folder" },
      { tokens: normalizeArray(aiSuggestedTags), weight: WEIGHTS.aiTag, reasonPrefix: "ai-tag" },
      { tokens: normalizeArray(aiMoodLabels), weight: WEIGHTS.aiMoodLabel, reasonPrefix: "mood" },
      { tokens: normalizeArray(aiUseCases), weight: WEIGHTS.aiUseCase, reasonPrefix: "use" },
      /* AI 가 채워 둔 free-text 메타들 — tokenize 해서 매칭에 합류시킨다.
         이미 분류 비용이 발생했으니 추가 LLM 호출 없이 점수만 더 들어온다.
         `_ko` 자유 텍스트도 함께 토큰화해 한글 신호와 매칭 가능. */
      { tokens: [...tokenize(ai?.scene_description), ...tokenize(ai?.scene_description_ko)], weight: WEIGHTS.aiSceneDescription, reasonPrefix: "scene" },
      { tokens: [...tokenize(ai?.visual_style), ...tokenize(ai?.visual_style_ko)], weight: WEIGHTS.aiVisualStyle, reasonPrefix: "style" },
      { tokens: [...tokenize(ai?.motion_notes), ...tokenize(ai?.motion_notes_ko)], weight: WEIGHTS.aiMotionNotes, reasonPrefix: "motion" },
      { tokens: [...tokenize(ai?.shot_type), ...tokenize(ai?.shot_type_ko)], weight: WEIGHTS.aiShotType, reasonPrefix: "shot" },
      { tokens: [...tokenize(ai?.color_notes), ...tokenize(ai?.color_notes_ko)], weight: WEIGHTS.aiColorNotes, reasonPrefix: "color" },
      { tokens: [...tokenize(ai?.brief_fit), ...tokenize(ai?.brief_fit_ko)], weight: WEIGHTS.aiBriefFit, reasonPrefix: "brief" },
      { tokens: [...tokenize(ai?.content_type), ...tokenize(ai?.content_type_ko)], weight: WEIGHTS.aiContentType, reasonPrefix: "type" },
      { tokens: tokenize(item.title), weight: WEIGHTS.title, reasonPrefix: "title" },
      { tokens: tokenize(item.notes), weight: WEIGHTS.notes, reasonPrefix: "note" },
    ],
  };
}

function flattenSignal(signals: BriefSignals | SceneSignals): Array<{ tokens: string[]; reasonPrefix: string }> {
  if ("genre" in signals) {
    // BriefSignals
    return [
      { tokens: signals.mood, reasonPrefix: "mood" },
      { tokens: signals.genre, reasonPrefix: "genre" },
      { tokens: signals.product, reasonPrefix: "product" },
      { tokens: signals.location, reasonPrefix: "location" },
      { tokens: signals.lighting, reasonPrefix: "lighting" },
      { tokens: signals.camera, reasonPrefix: "camera" },
      { tokens: signals.keywords, reasonPrefix: "keyword" },
    ];
  }
  // SceneSignals
  return [
    { tokens: signals.shot, reasonPrefix: "shot" },
    { tokens: signals.motion, reasonPrefix: "motion" },
    { tokens: signals.mood, reasonPrefix: "mood" },
    { tokens: signals.keywords, reasonPrefix: "keyword" },
  ];
}

export interface ScoreReferencesOptions {
  /** 추천에 포함할 자료 종류. 기본값: image / gif / video / youtube (link 제외). */
  allowedKinds?: ReadonlySet<ReferenceItem["kind"]>;
  /** 이미 어떤 target 에 붙어 있어 다시 추천할 필요 없는 reference id 들. */
  excludeIds?: ReadonlySet<string>;
  /** 점수 cutoff — 너무 낮은 매칭은 제외. 기본 0.5 (대략 user-tag 1 개 또는 mood 매칭 1 개 이상). */
  minScore?: number;
  /** 결과 상한. 기본 12. */
  limit?: number;
  /** Strict 매칭 모드. ON 일 때 두 게이트(intent anchor / high-weight ref) 통과
   *  필요. 기본 false — 기존 추천 호출부(RecommendedReferences, ReferencePickerDrawer
   *  등)의 동작을 보존. AI Search(LibraryPage) 만 명시적으로 true 로 전달. */
  strict?: boolean;
}

const DEFAULT_KINDS: ReadonlySet<ReferenceItem["kind"]> = new Set(["image", "gif", "video", "youtube"]);

/** Brief / Scene 신호로 라이브러리 자료를 스코어링한 뒤 정렬해 반환.
 *
 *  스코어링 모델 (v3 — 2026-05 개선):
 *
 *  1. **Cross-bucket token dedup** — 한 자료(reference) 안에서 같은 토큰이
 *     여러 신호 카테고리(mood/keywords/camera/…) 에 동시 등장해도 *한 번만*
 *     점수에 기여한다. 매치된 ref-bucket 중 가장 높은 weight 를 채택.
 *     과거: signal 의 mood + keywords + camera 에 "action" 이 모두 들어가고
 *     자료 user-tag 에 "action" 이 있으면 1.0 × 3 = 3.0 → 임계 자동 통과.
 *     현재: 1.0 × 1 = 1.0 — bilingual / 다중 카테고리 emission 으로 인한
 *     점수 인플레이션을 차단.
 *
 *  2. **Weak-token weight penalty** — `WEAK_SIGNAL_TOKENS` 에 해당하는
 *     토큰("action", "scene", "씬", "참고" 등)이 매치되면 그 매치의
 *     기여도가 ×0.3 으로 깎인다. 랭킹용으로는 살아 있지만 단독으론 임계
 *     통과 어려움. 풍부한 쿼리는 strong 토큰이 함께 매치돼야 통과되는
 *     자연스러운 동작.
 *
 *  3. **Strict 모드 (optional)** — `options.strict === true` 일 때 점수와
 *     별개로 단일 결합 게이트를 추가로 통과해야 결과 포함.
 *     · Anchor-on-high-weight: ANCHOR_CATEGORIES (mood / keywords /
 *       lighting / product) 의 *비-weak* 토큰이 *직접* high-weight ref
 *       bucket (가중치 ≥ HIGH_WEIGHT_THRESHOLD) 과 매치 필요.
 *     v2 의 독립 OR 게이트(anchor 따로 / high-weight 따로) 가 만들던
 *     "다른 약한 매치가 anchor 를 메우고 무관 토큰이 high-weight 를 메워
 *     자료가 통과되던" 백도어를 토큰 단위 결합으로 차단.
 *     AI Search(LibraryPage) 가 기본 ON 으로 호출.
 */
export function scoreReferences(
  signals: BriefSignals | SceneSignals,
  candidates: ReferenceItem[],
  options: ScoreReferencesOptions = {},
): RecommendedReference[] {
  const allowed = options.allowedKinds ?? DEFAULT_KINDS;
  const exclude = options.excludeIds ?? new Set<string>();
  const minScore = options.minScore ?? 0.5;
  const limit = options.limit ?? 12;
  const strict = options.strict === true;
  const flatSignals = flattenSignal(signals);

  // 신호가 아예 비어있으면 더 계산할 필요가 없음 — 빈 배열 반환.
  // (호출부가 fallback 으로 "최근 사용" 정렬을 띄우면 됨.)
  if (flatSignals.every((bucket) => bucket.tokens.length === 0)) return [];

  /* Strict anchor 게이트용으로 ANCHOR_CATEGORIES (mood ∪ keywords ∪ lighting
     ∪ product) 의 비-weak 토큰 집합을 미리 계산. SceneSignals 는 mood +
     keywords 두 키만 있고 둘 다 anchor 후보라 동일 코드가 자연스럽게 동작.
     camera / location / genre 는 의도적으로 anchor 에서 제외 — 보조 정보
     성격이라, 사용자가 "와이드샷" 만 쳤다고 모든 와이드샷 자료를 strict 로
     통과시키지 않는다. */
  const anchorTokens = strict
    ? new Set(
        flatSignals
          .filter((b) => ANCHOR_CATEGORIES.has(b.reasonPrefix))
          .flatMap((b) => b.tokens)
          .filter((tok) => !WEAK_SIGNAL_TOKENS.has(tok)),
      )
    : null;

  const scored: RecommendedReference[] = [];
  for (const item of candidates) {
    if (item.deleted_at) continue;
    if (!allowed.has(item.kind)) continue;
    if (exclude.has(item.id)) continue;

    const refTokens = tokensFromReference(item);

    /* (token → 채택 weight) — 각 signal-token 에 대해 ref bucket 들을 훑어
       매치된 것 중 가장 높은 weight 를 기록. 한 토큰당 최대 1번 기여. */
    const tokenBestWeight = new Map<string, number>();
    /* (token → reasonPrefix) — UI 의 reason 칩에 표시할 카테고리 prefix.
       같은 토큰이 여러 sigBucket 에 들어 있어도 첫 발견된 prefix 만 채택
       (안정적 reason 출력). */
    const tokenReasonPrefix = new Map<string, string>();
    /* v3 결합 게이트 — anchor 토큰이 *직접* high-weight ref bucket 과 매치
       된 적이 있는지. anchor 게이트와 high-weight 게이트를 토큰 단위로
       묶어 v2 의 백도어("anchor 는 약한 토큰 / high-weight 는 무관 토큰" 조합)
       을 차단. strict OFF 면 의미 없음. */
    let hasAnchorHighWeightHit = false;

    for (const sigBucket of flatSignals) {
      if (sigBucket.tokens.length === 0) continue;
      for (const refBucket of refTokens.buckets) {
        if (refBucket.tokens.length === 0) continue;
        const overlap = intersect(refBucket.tokens, sigBucket.tokens);
        if (overlap.length === 0) continue;
        for (const token of overlap) {
          const prev = tokenBestWeight.get(token) ?? 0;
          if (refBucket.weight > prev) {
            tokenBestWeight.set(token, refBucket.weight);
          }
          if (!tokenReasonPrefix.has(token)) {
            tokenReasonPrefix.set(token, sigBucket.reasonPrefix);
          }
          if (
            strict
            && anchorTokens?.has(token)
            && refBucket.weight >= HIGH_WEIGHT_THRESHOLD
          ) {
            hasAnchorHighWeightHit = true;
          }
        }
      }
    }

    if (tokenBestWeight.size === 0) continue;

    /* 가중합 — 각 토큰당 (채택 weight × strength multiplier).
       Weak 토큰은 0.3 배로 깎여 임계 통과 기여도가 작아진다. */
    let score = 0;
    for (const [token, weight] of tokenBestWeight) {
      score += weight * tokenStrengthMultiplier(token);
    }

    if (score < minScore) continue;
    /* Strict 결합 게이트 — anchor 토큰이 high-weight ref bucket 과 직접
       매치된 흔적이 없으면 탈락. 점수가 임계를 넘어도 의도-매치 증거가
       구조화 메타에 없으면 false-positive 로 본다. */
    if (strict && !hasAnchorHighWeightHit) continue;

    score += recencyBonus(item.last_used_at);

    /* Reason 칩 — strong 토큰 우선 노출. weak 토큰은 사용자에게 노이즈로
       보이므로 reason 슬롯(최대 4) 에서 후순위. */
    const reasonsAll = [...tokenBestWeight.keys()].map((token) => ({
      token,
      prefix: tokenReasonPrefix.get(token) ?? "keyword",
      weak: WEAK_SIGNAL_TOKENS.has(token),
    }));
    reasonsAll.sort((a, b) => Number(a.weak) - Number(b.weak));
    const reasons = reasonsAll.slice(0, 4).map((r) => `${r.prefix}:${r.token}`);

    scored.push({ item, score, reasons });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** LLM 이 emit 한 raw signal 토큰 한 개가 자료 인벤토리와 *실제로* 매치
 *  가능한지 판정.
 *
 *  raw 토큰("low-angle", "로우 앵글", "neon style") 을 scoreReferences 와
 *  동일한 tokenize 로 normalize 한 뒤, 결과 중 하나라도 인벤토리 Set 에
 *  존재하면 match. tokenize 좌표계가 인벤토리/스코어/이 체크 셋이 모두
 *  동일하기 때문에 "칩에선 매치되지만 실제 결과엔 없음" 같은 불일치가
 *  원천적으로 발생하지 않는다. */
export function hasInventoryMatch(
  rawSignalToken: string,
  inventory: ReadonlySet<string>,
): boolean {
  const toks = tokenize(rawSignalToken);
  for (const tok of toks) {
    if (inventory.has(tok)) return true;
  }
  return false;
}

/** 라이브러리 자료 전체의 매칭 가능 토큰을 하나의 Set 으로 합쳐 반환.
 *
 *  AI Search 의 *신호 칩 노출* 시점에 "이 LLM 토큰이 라이브러리 안 자료
 *  어느 곳에라도 실제 매치 가능한가" 를 O(1) 로 판정하기 위한 인벤토리다.
 *  LLM 은 자료 인벤토리를 모른 채 쿼리에서 자유롭게 토큰을 emit 하기
 *  때문에, "stylish" 처럼 *추정은 합리적이지만 라이브러리엔 한 자료도
 *  매치 안 되는 0건 토큰* 이 그대로 칩으로 노출돼 사용자가 노이즈로
 *  인지하는 회귀가 있었다. UI 단에서 이 Set 으로 필터해 0건 칩만 숨기면
 *  점수 계산에는 영향 없이 표시 잡음만 제거된다.
 *
 *  scoreReferences 와 동일한 tokensFromReference 를 통해 토큰을 모으므로
 *  매칭 좌표계가 100% 일치 — "칩으로 보이는데 결과엔 없는" 불일치가
 *  원천적으로 발생하지 않는다. items.length × bucket 수만큼 한 번 돌고
 *  Set 에 합치는 O(N) 연산이라 호출부에서 useMemo 한 번이면 충분. */
export function buildReferenceTokenInventory(
  items: ReadonlyArray<ReferenceItem>,
): Set<string> {
  const inv = new Set<string>();
  for (const item of items) {
    if (item.deleted_at) continue;
    const refTokens = tokensFromReference(item);
    for (const bucket of refTokens.buckets) {
      for (const tok of bucket.tokens) inv.add(tok);
    }
  }
  return inv;
}

/** Brief 분석 결과에서 호출부가 흔히 가진 필드들을 한 번에 취하는 편의 함수.
 *  파라미터는 모두 unknown 으로 받고 안에서 안전하게 풀어낸다 — DeepAnalysis
 *  타입 import 없이도 BriefTab/Agent 어디서든 호출할 수 있도록.
 *
 *  lighting/camera 는 BriefAnalysis.tone_manner.visual_direction 구조에서
 *  분리해 들어오는 새 차원 — recommender 가 자료의 motion_notes / shot_type /
 *  color_notes 와 직접 매칭할 수 있어 추천 품질이 올라간다. */
export function buildBriefSignalsFromAnalysis(input: {
  rawText?: string | null;
  ideaNote?: string | null;
  toneKeywords?: ReadonlyArray<string | null | undefined>;
  moodSummary?: string | null;
  genre?: string | null;
  productName?: string | null;
  productBrand?: string | null;
  location?: string | null;
  lighting?: string | null;
  camera?: string | null;
}): BriefSignals {
  return extractBriefSignals({
    mood: [...(input.toneKeywords ?? []), input.moodSummary ?? null],
    genre: [input.genre ?? null],
    product: [input.productName ?? null, input.productBrand ?? null],
    location: [input.location ?? null],
    lighting: [input.lighting ?? null],
    camera: [input.camera ?? null],
    text: [input.rawText ?? null, input.ideaNote ?? null],
  });
}
