import { callOpenAI, type OpenAIChatResponse } from "./openai";
import { updateReference, type ReferenceItem } from "./referenceLibrary";
import {
  MAX_DURATION_SEC,
  MAX_VIDEO_BYTES,
  sampleFramesWithSceneAwareness,
  suggestedFrameCount,
  type ExtractedFrame,
  type VideoMeta,
} from "./videoFrames";
import { bilingualDirective, type AiOutputLanguage } from "./aiOutputLanguage";
import { decodeAnimatedAllFrames } from "./gifFrames";

/**
 * AI 분류 결과. 모든 필드는 영어 canonical + 한국어 parallel(`_ko`) 두 벌이
 * 함께 저장된다. canonical 은 시스템 식별/검색/추천의 단일 토큰 공간
 * (`item.tags` 머지 기본값)이고, `_ko` 는 인스펙터 디스플레이/한국어 양방향
 * 검색을 위한 alias. 두 배열은 같은 index 가 같은 개념을 가리키도록 LLM
 * 프롬프트가 강제한다(suggested_tags[0] ↔ suggested_tags_ko[0]).
 *
 * 자유 텍스트 필드(visual_style, motion_notes, …)도 `_ko` 변종을 갖는다 —
 * 인스펙터의 Display 토글로 KO↔EN 을 즉시 전환할 수 있게 두 버전 모두
 * 미리 저장해 LLM 재호출을 피한다.
 */
export interface ReferenceAiSuggestions {
  suggested_tags: string[];
  suggested_tags_ko?: string[];
  /** 사용자가 직접 입력한 *한글* 태그를 EN canonical 로 정규화하면서 만든
   *  alias 매핑. 라이브러리 일관성 유지(픽커 row.id 는 항상 lowercase EN)
   *  를 위한 보존 메타데이터다.
   *
   *  생성 경로 두 가지:
   *    1. L1(즉시) — 시드 사전(`koreanTagSeedDictionary`)에 ko 가 정확
   *       히 매핑되는 경우, LibraryInspector 의 onAddTag 핸들러에서
   *       즉시 번역해 등록. LLM 호출 0.
   *    2. L3(batch) — Settings → "라이브러리 AI 정리" 에서 시드 미스
   *       한글 태그를 LLM(`translateUserTags`)으로 한 번에 번역해 등록.
   *
   *  이 필드는 `koreanTagAliasIndex` 빌드시 추가 ingestion 되어 픽커의
   *  KO alias hint 데이터 소스 중 하나가 된다. 사용자가 본 태그를 다시
   *  지우면 (item.tags 에서 EN canonical 제거) 기록이 남아 있어도 무해
   *  — 인덱스 빌드시 inventoryFilter 로 걸러지면 자연 비활성. */
  user_tag_aliases_ko?: Array<{ en: string; ko: string }>;
  mood_labels: string[];
  mood_labels_ko?: string[];
  use_cases: string[];
  use_cases_ko?: string[];
  /** 객관적 장면 묘사. visual_style 이 *해석*("정제된 전기차 + 황혼 톤") 인
   *  반면 scene_description 은 *관찰*("들판에 EV4 한 대, 그 앞에 헬멧을 쓴
   *  사람이 팔짱을 끼고 서 있고, 배경에 폐공장과 산이 있다") 만 담는다.
   *  사용자가 검색창에 "헬멧" / "공장" / "EV4" 같은 구체적 명사를 쳤을 때
   *  AI 가 분석한 자료에서 직접 잡히도록 하는 게 목적. 검색 haystack +
   *  recommender 의 scene 버킷 양쪽에서 토큰 소스로 쓰인다. */
  scene_description?: string;
  scene_description_ko?: string;
  visual_style?: string;
  visual_style_ko?: string;
  content_type?: string;
  content_type_ko?: string;
  shot_type?: string;
  shot_type_ko?: string;
  color_notes?: string;
  color_notes_ko?: string;
  motion_notes?: string;
  motion_notes_ko?: string;
  avoid_notes?: string;
  avoid_notes_ko?: string;
  brief_fit?: string;
  brief_fit_ko?: string;
  asset_candidate?: string;
  asset_candidate_ko?: string;
  agent_use?: string;
  agent_use_ko?: string;
  conti_use?: string;
  conti_use_ko?: string;
  promote_to_asset_reason?: string;
  promote_to_asset_reason_ko?: string;
  classification_input?: "visual" | "text";
  /* video 자료의 분류에 실제로 사용된 sampled frame 썸네일.
     인스펙터의 "Selected frames" 미리보기를 분석 *완료 후에도* 유지하기 위해
     base64 다운스케일(가로 128px JPEG q=0.6) 본을 함께 영구 저장한다.
     non-video 자료에서는 undefined. */
  sampled_frames?: Array<{
    t: number;
    mediaType: string;
    base64: string;
  }>;
  error?: unknown;
}

const EMPTY_SUGGESTIONS: ReferenceAiSuggestions = {
  suggested_tags: [],
  mood_labels: [],
  use_cases: [],
};

/* ---- 모델 / 토큰 상수 ----
   image / video 모두 gpt-5.5. 향후 native video 입력 API 가 열리면 여기서만
   모델 / 모드 를 바꿔 끼울 수 있도록 한 곳에 모음.

   `max_completion_tokens` 는 GPT-5.x reasoning 모델의 특성상 *reasoning + visible*
   토큰을 모두 포함하는 합산 한도다. 초기에는 1200 으로 잡았으나, 비디오 분류
   는 8~12 장의 프레임 + 양언어(en/ko) JSON 출력이라 reasoning 에 토큰이 다
   소모되어 보이는 응답이 0 글자로 잘리는 사례("Empty AI response") 가 다수
   보고됐다. 4096 으로 상향해 reasoning 여유와 본문 출력을 모두 보장한다.

   비디오 프레임 수는 더 이상 고정 상수가 아니라 길이 기반 동적 결정
   (videoFrames.ts 의 `suggestedFrameCount`) + scene-aware 선택. */
const CLASSIFY_MODEL = "gpt-5.5";
const MAX_TOKENS = 4096;

export type ClassifyStage = "idle" | "sampling" | "analyzing" | "ready" | "failed";

/**
 * Inspector 의 진행 시각화에 쓰는 세부 정보.
 * - `stage` 는 ClassifyStage 와 별개로 progress 의 동시 상태를 알려준다.
 * - `targetFrameCount` 는 최종 채택될 프레임 수 (선택 후 확정값과 일치).
 * - `candidatesDone`/`candidatesTotal` 는 oversample 단계의 진행률 (예: 12/28).
 *   짧은 클립(uniform fast path) 이면 total = targetFrameCount 와 같다.
 * - `scoringActive` 는 oversample 종료 직후 scene scoring/선택 짧은 구간 동안 true.
 * - `frames` 는 *최종 선택된* 프레임만 (썸네일 미리보기에 사용).
 *   oversample 도중에는 채워지지 않는다 — 28→16 으로 줄어드는 시각적 점프
 *   를 피하기 위함.
 * - `durationSec` 는 메타 단계에서 알려진 클립 길이 (없으면 undefined).
 */
export interface ClassifyProgress {
  stage: ClassifyStage;
  targetFrameCount?: number;
  candidatesDone?: number;
  candidatesTotal?: number;
  scoringActive?: boolean;
  frames?: ExtractedFrame[];
  durationSec?: number;
}

export interface ClassifyOptions {
  /** UI 가 sampling/analyzing 단계 토글하기 위한 옵셔널 콜백.
     idle 은 호출 시작 전, ready/failed 는 호출 종료 시 호출자가
     직접 토글해도 무방하지만 일관성을 위해 여기서도 호출한다. */
  onStage?: (stage: ClassifyStage) => void;
  /** Inspector 가 세부 진행률(프레임 추출 개수, 선택 결과 등) 을 보여줄 때
     쓰는 콜백. onStage 와 동시에 호출되며, 옵셔널. */
  onProgress?: (progress: ClassifyProgress) => void;
  /** 자료 전환 / 재분류 요청 시 in-flight sampling 을 즉시 끊기 위한 신호. */
  signal?: AbortSignal;
  /** 분석 결과(자유 문장 + tags) 의 출력 언어. 미지정 시 "en" — 호출자가
     UI 언어 / Settings 의 AI Output Language 모드를 합쳐 결정한 결과를
     넘긴다. 모듈 내부에서 store 를 직접 읽지 않는 것은 분류 큐(외부
     스레드/워커 변종) 에서도 같은 함수를 그대로 쓰기 위함. */
  language?: AiOutputLanguage;
}

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/* OpenAI Vision API 가 안전하게 처리할 수 있는 짧은 변(px) 의 보수적 하한.
   .exe / .msi 등에서 추출한 16/32/48 px 아이콘이나 손상된 마이크로 썸네일은
   API 가 "Invalid image." 로 거절한다. 이 임계값보다 작으면 시각 모드를
   포기하고 텍스트 메타로만 분류한다 — 사용자 입장에서는 "AI 분석 실패" 보다
   "이 자료는 시각 정보 없이 메타 기반으로 분류됨" 이 훨씬 나은 결과다.
   64 px 은 OpenAI 의 "low detail" 모드 처리 단위(64px×64px 토큰화) 와도
   부합해, 그 이하는 사실상 1-token 이하라 의미 있는 분석이 불가능하다. */
const MIN_VISION_INPUT_DIM_PX = 64;

/* OpenAI Vision API 가 직접 처리하지 않는(또는 빈번히 거부하는) MIME 타입.
   - svg+xml : 래스터화 안 됨
   - x-icon / vnd.microsoft.icon : 보통 다중 사이즈 ICO 로 디코드 자체가
     브라우저별로 일관되지 않음
   - tiff : 미지원
   해당 타입은 사전 단계에서 시각 모드를 포기시켜 "Invalid image." 라운드
   트립 자체를 발생시키지 않는다. */
const UNSUPPORTED_VISION_MIME_PREFIXES = [
  "image/svg",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/tiff",
];

/** 임의의 URL → OpenAI Vision 호환 data URL.
 *
 *  단순 fetch + FileReader 가 아니라 한 번 더 디코드/리사이즈하는 이유:
 *    1) `Invalid image.` 거절 사례를 사전에 차단. 짧은 변이 64px 미만인
 *       자료(.exe 추출 아이콘, 깨진 micro 썸네일 등) 는 API 라운드 트립
 *       전에 null 로 떨어뜨려 호출부가 텍스트 모드로 자연 폴백.
 *    2) SVG/ICO/TIFF 같은 미지원 포맷도 동일하게 사전 컷.
 *    3) 통과한 이미지는 모두 PNG 로 정규화 — 호환 mime 가 일관되어 API
 *       처리 비용 / 거부 위험 모두 감소.
 *  실패 시 null 을 돌려 텍스트 모드로 자연 폴백. */
async function urlToDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const blobType = blob.type.toLowerCase();
    // AVIF/HEIC 등은 로컬 스토리지가 Content-Type 을 못 채워 application/octet-
    // stream 으로 내려오는 경우가 있다. blob.type 만 믿고 컷하면 디코드 가능한
    // 이미지를 시각 분석에서 누락(텍스트 모드 폴백)하므로, 비-image MIME 이라도
    // URL 확장자가 알려진 래스터 이미지면 통과시켜 아래 <img> 디코드가 실제
    // 게이트 역할을 하게 한다. (디코드 실패 시 자연스럽게 null 반환.)
    const RASTER_IMAGE_EXT = /\.(avif|png|jpe?g|webp|gif|bmp|heic|heif)(\?|#|$)/i;
    const looksLikeImageUrl = RASTER_IMAGE_EXT.test(url);
    if (!blobType.startsWith("image/") && !looksLikeImageUrl) return null;
    if (UNSUPPORTED_VISION_MIME_PREFIXES.some((p) => blobType.startsWith(p))) {
      return null;
    }
    /* DOM 미가용 환경(WebWorker 단독 등) 에서는 디코드를 못 하니 가능한
       범위에서 raw data URL 만 돌려준다 — 기존 동작 호환. 실제 LibraryPage
       경로는 항상 document 가 있다. */
    if (typeof document === "undefined") {
      return await blobToDataUrl(blob);
    }
    const objectUrl = URL.createObjectURL(blob);
    let img: HTMLImageElement | null = null;
    try {
      img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("image decode failed"));
        el.src = objectUrl;
      });
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    /* 짧은 변 < 64px 면 시각 분석 가치가 사실상 0 — 텍스트 모드로 자연 폴백
       시키기 위해 null 을 돌린다. 호출부가 dataUrl == null 을 감지하면
       자동으로 "No thumbnail/poster" 안내문을 프롬프트에 끼워 텍스트 모드로
       분류한다. */
    if (Math.min(w, h) < MIN_VISION_INPUT_DIM_PX) return null;

    /* OpenAI Vision 의 "high detail" 모드 권장 상한이 ~2048px 이라, 비용
       절감 + 호환성 강화를 위해 짧은 변을 1024 까지 다운스케일(필요 시).
       업스케일은 하지 않는다(없는 정보 만들지 않기). */
    const MAX_DIM = 1024;
    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return await blobToDataUrl(blob);
    ctx.drawImage(img, 0, 0, outW, outH);
    /* PNG 로 정규화 — mime 호환성 최대화. JPEG 가 살짝 더 작지만 알파/팔레트
       자료(스티커, 투명 PNG)에서 시각 정보 손실 가능. */
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.readAsDataURL(blob);
  });
}

/* 분류에 사용된 sampled frame 을 작은 thumbnail 로 다운스케일.
   목적: 분석 *완료 후에도* 인스펙터의 "Selected frames" 미리보기를 유지해야
   하므로 ai_suggestions 에 함께 저장하는데, 원본은 768px PNG 라 자료 1건당
   1MB 가 넘는다(JSON column 부담). 가로 128px JPEG q=0.6 으로 줄이면 프레임
   당 1~3KB 수준이라 8장이어도 20KB 안팎으로 떨어진다.
   - mediaType 은 항상 image/jpeg.
   - 캔버스/이미지 디코드 실패 시 원본을 그대로 리턴해 분석 자체가 실패하지
     않도록 best-effort. */
async function downsampleFrameForStorage(
  frame: ExtractedFrame,
  maxWidth = 128,
): Promise<ExtractedFrame> {
  if (typeof document === "undefined") return frame;
  try {
    const dataUrl = `data:${frame.mediaType};base64,${frame.base64}`;
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image decode failed"));
      el.src = dataUrl;
    });
    const scale = Math.min(1, maxWidth / Math.max(img.width, 1));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return frame;
    ctx.drawImage(img, 0, 0, w, h);
    const url = canvas.toDataURL("image/jpeg", 0.6);
    const comma = url.indexOf(",");
    if (comma < 0) return frame;
    return {
      t: frame.t,
      mediaType: "image/jpeg",
      base64: url.slice(comma + 1),
    };
  } catch {
    return frame;
  }
}

/* `_ko` 배열은 canonical 과 길이가 다르면 통째로 버린다(parallel 가정이
   깨지면 인덱스 매칭 자체가 무효). 자유 텍스트 `_ko` 는 길이 가드가 없으니
   존재 시 그대로 보존. */
function pickParallel(canonical: string[], maybeLoc: unknown): string[] | undefined {
  if (!Array.isArray(maybeLoc)) return undefined;
  if (maybeLoc.length !== canonical.length) return undefined;
  return maybeLoc.map((x) => (typeof x === "string" ? x : ""));
}

function pickText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function safeJson(text: string): ReferenceAiSuggestions {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(cleaned) as Partial<ReferenceAiSuggestions> & Record<string, unknown>;
  const suggested_tags = Array.isArray(parsed.suggested_tags) ? parsed.suggested_tags.slice(0, 12) : [];
  const mood_labels = Array.isArray(parsed.mood_labels) ? parsed.mood_labels.slice(0, 8) : [];
  const use_cases = Array.isArray(parsed.use_cases) ? parsed.use_cases.slice(0, 8) : [];
  return {
    ...EMPTY_SUGGESTIONS,
    suggested_tags,
    suggested_tags_ko: pickParallel(suggested_tags, parsed.suggested_tags_ko),
    mood_labels,
    mood_labels_ko: pickParallel(mood_labels, parsed.mood_labels_ko),
    use_cases,
    use_cases_ko: pickParallel(use_cases, parsed.use_cases_ko),
    scene_description: pickText(parsed.scene_description),
    scene_description_ko: pickText(parsed.scene_description_ko),
    visual_style: pickText(parsed.visual_style),
    visual_style_ko: pickText(parsed.visual_style_ko),
    content_type: pickText(parsed.content_type),
    content_type_ko: pickText(parsed.content_type_ko),
    shot_type: pickText(parsed.shot_type),
    shot_type_ko: pickText(parsed.shot_type_ko),
    color_notes: pickText(parsed.color_notes),
    color_notes_ko: pickText(parsed.color_notes_ko),
    motion_notes: pickText(parsed.motion_notes),
    motion_notes_ko: pickText(parsed.motion_notes_ko),
    avoid_notes: pickText(parsed.avoid_notes),
    avoid_notes_ko: pickText(parsed.avoid_notes_ko),
    brief_fit: pickText(parsed.brief_fit),
    brief_fit_ko: pickText(parsed.brief_fit_ko),
    asset_candidate: pickText(parsed.asset_candidate),
    asset_candidate_ko: pickText(parsed.asset_candidate_ko),
    agent_use: pickText(parsed.agent_use),
    agent_use_ko: pickText(parsed.agent_use_ko),
    conti_use: pickText(parsed.conti_use),
    conti_use_ko: pickText(parsed.conti_use_ko),
    promote_to_asset_reason: pickText(parsed.promote_to_asset_reason),
    promote_to_asset_reason_ko: pickText(parsed.promote_to_asset_reason_ko),
  };
}

/* 항상 영어 canonical + 한국어 parallel 두 벌을 함께 요구한다. canonical
   배열과 `_ko` 배열은 같은 길이 + 같은 인덱스 = 같은 개념이어야 하며,
   `_ko` 자유 텍스트는 canonical 의 자연스러운 한국어 번역(직역이 아니라
   촬영/편집 도메인 톤). 영어 단어를 음차한 토큰(예 "시네마틱") 보다는
   네이티브 표현을 우선. */
const JSON_SCHEMA_TEXT = `{
  "suggested_tags": string[],          /* 8-10 concise English tags (subject, environment, style, technique, use case). lowercase; hyphenated for multi-word (e.g. "neon-noir"). DO NOT include mood/emotion words. */
  "suggested_tags_ko": string[],       /* SAME LENGTH as suggested_tags, SAME ORDER. Natural Korean phrases (no transliteration of English; e.g. canonical "neon-noir" → "네온 누아르" not "네온 노이르"). */
  "mood_labels": string[],             /* 2-4 English mood/emotion-only labels (e.g. "tense", "melancholic"). lowercase. */
  "mood_labels_ko": string[],          /* SAME LENGTH as mood_labels, SAME ORDER. Natural Korean adjectives. */
  "use_cases": string[],               /* 3-6 short English use-case phrases. */
  "use_cases_ko": string[],            /* SAME LENGTH as use_cases, SAME ORDER. */
  "scene_description": string,         /* OBSERVATION-ONLY literal description of what is visible in the frame. 2-4 sentences. Enumerate concrete subjects (with attire/pose), spatial layout (foreground/midground/background), key props/architecture/landscape elements, named brands/products if clearly identifiable. NO mood words, NO style adjectives, NO interpretation. This field exists so users can search by plain factual terms ("helmet", "kia", "field", "abandoned factory"). GOOD: "A person in a black helmet stands in front of a Kia EV4 with arms folded. The vehicle sits on a grassy field. The background shows an abandoned factory with broken windows, distant mountains, and a translucent energy barrier across the sky." BAD (belongs in visual_style): "A dramatic post-apocalyptic scene evoking tension and resilience." */
  "scene_description_ko": string,      /* Same observational description in natural Korean. Same factual content as scene_description, native Korean phrasing. */
  "visual_style": string,              /* English short paragraph. Style/tone/technique INTERPRETATION (cinematic look, palette intent, era reference). Distinct from scene_description which is observation-only. */
  "visual_style_ko": string,           /* Korean version of the same paragraph. Same intent, native Korean tone. */
  "content_type": string,
  "content_type_ko": string,
  "shot_type": string,
  "shot_type_ko": string,
  "color_notes": string,
  "color_notes_ko": string,
  "motion_notes": string,
  "motion_notes_ko": string,
  "avoid_notes": string,
  "avoid_notes_ko": string,
  "brief_fit": string,
  "brief_fit_ko": string,
  "asset_candidate": string,
  "asset_candidate_ko": string,
  "agent_use": string,
  "agent_use_ko": string,
  "conti_use": string,
  "conti_use_ko": string,
  "promote_to_asset_reason": string,
  "promote_to_asset_reason_ko": string
}`;

/* GPT 응답이 비어있을 때 finish_reason 을 토대로 좀 더 정확한 에러를 만든다.
   - "length" : reasoning + visible 합산 토큰이 max_completion_tokens 한도를
     넘었다 → 토큰 부족. MAX_TOKENS 상향 또는 더 가벼운 모델로 폴백 안내.
   - "content_filter" : 안전 필터에 차단됨 → 자료 자체나 프롬프트가 문제.
   - "stop"/undefined : 보통은 정상 종료지만 응답만 빈 케이스. 모델 가용성
     /일시적 오류로 가정. 같은 자료로 한 번 더 시도해 보라고 안내.
   문자열 컨벤션: 영문(canonical) 메시지를 throw 하고, friendlyClassifyError
   에서 한국어/영어 친화 메시지로 매핑한다. */
function emptyResponseError(response: OpenAIChatResponse): Error {
  const finish = response.choices?.[0]?.finish_reason;
  if (finish === "length") {
    return new Error(
      "AI response truncated by token limit — the model used its budget on reasoning and returned no visible output.",
    );
  }
  if (finish === "content_filter") {
    return new Error("AI response blocked by content filter.");
  }
  return new Error("Empty AI response");
}

/* 사용자 친화적 에러 매핑 — 영상 검증/디코딩 실패는 stack 보다는 한 줄
   설명으로 보여주는 게 낫다. UI 에서도 `friendlyClassifyError()` 를 통해
   동일 메시지를 재사용할 수 있도록 export. */
export function friendlyClassifyError(err: unknown): string {
  /* AbortError 는 사용자가 자료를 바꾸거나 재분류 버튼을 다시 눌렀을 때 in-flight
     sampling 을 끊은 결과 — 에러 토스트로 보여줄 가치가 없으므로 빈 문자열을
     리턴해 호출자가 표시 스킵을 결정하게 한다. */
  if (err instanceof Error && err.name === "AbortError") return "";
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (!raw) return "AI classification failed.";
  if (raw.includes("200MB")) return `Video too large. Limit: 200MB (current file exceeds it).`;
  if (raw.includes("5분") || raw.includes("5 minutes")) return `Video too long. Limit: 5 minutes.`;
  if (raw.includes("디코딩") || raw.toLowerCase().includes("decod")) return "Could not decode video. The file may be corrupted or in an unsupported format.";
  if (raw.includes("메타데이터") || raw.toLowerCase().includes("metadata")) return "Could not read video metadata. The file may be unreachable or corrupted.";
  if (raw.includes("seek")) return "Frame extraction failed (seek error). Try a different video file.";
  if (raw.includes("canvas") || raw.toLowerCase().includes("tainted")) return "Cross-origin video detected — frame extraction blocked by the browser. Re-import the video locally.";
  if (raw.toLowerCase().includes("unsupported value") || raw.toLowerCase().includes("unsupported parameter")) {
    return "The selected AI model does not accept one of the parameters used. Please contact the developer.";
  }
  if (raw.includes("AI response truncated")) {
    return "AI response was truncated by the token limit before any text was emitted. Try again — the limit has been raised; if it still fails on the same video, the clip is too long/complex for this model.";
  }
  if (raw.includes("content filter")) {
    return "The reference (or its frames) was blocked by the AI content safety filter. Try a different reference.";
  }
  if (raw === "Empty AI response") {
    return "AI returned an empty response. Often a transient model issue — try Re-analyze once more.";
  }
  /* OpenAI Vision 의 image 거부 — 보통 (a) 너무 작은 추출 아이콘(.exe/.msi),
     (b) SVG/ICO 미지원, (c) 손상된 썸네일 데이터. classifyVisualOrTextReference
     가 텍스트 폴백을 자동으로 한 번 더 시도하므로 이 메시지가 사용자에게
     도달하면 폴백 마저 실패한 드문 케이스. 친화 문구로 다음 행동을 제시. */
  if (looksLikeInvalidImageError(err)) {
    return "AI rejected the thumbnail (too small, unsupported format, or corrupted). The system also tried to classify from metadata only and that did not succeed — try setting a custom thumbnail and re-analyze.";
  }
  return raw;
}

/**
 * 자료 1개를 분류한다. kind 가 video 면 frame sampling → 멀티 프레임 비전,
 * 그 외(image/webp/gif/youtube/link)는 단일 image_url 또는 text-only 분류.
 *
 * 진행 단계는 onStage 로 보고:
 *   idle → sampling (video 만, frame 추출 중) → analyzing (LLM 호출) → ready / failed
 *
 * 실패 시 ai_suggestions.error 와 classification_status="failed" 가 DB 에 저장되고,
 * 호출자에게 그대로 throw 해 toast 를 띄울 수 있게 한다.
 */
export async function classifyReference(
  item: ReferenceItem,
  opts: ClassifyOptions = {},
): Promise<ReferenceItem> {
  const onStage = opts.onStage ?? (() => {});
  const onProgress = opts.onProgress ?? (() => {});
  const signal = opts.signal;
  const language: AiOutputLanguage = opts.language ?? "en";
  await updateReference(item.id, { classification_status: "pending" });

  if (item.kind === "video" && item.file_url) {
    return classifyVideoReference(item, onStage, onProgress, signal, language);
  }
  /* GIF / animated WebP / APNG (kind === "gif") 는 ImageDecoder 로 프레임을
     뽑아 video 와 같은 multi-image 흐름으로 분석한다. 디코드 실패 / 미지원
     환경 / 정적 단일 프레임이면 classifyGifReference 내부에서 visual path 로
     안전 폴백. */
  if (item.kind === "gif" && item.file_url) {
    return classifyGifReference(item, onStage, onProgress, signal, language);
  }
  return classifyVisualOrTextReference(item, onStage, onProgress, language);
}

/* OpenAI 에서 "image 가 처리 불가" 라는 의미로 흘러오는 메시지를 식별.
   GPT-4o / 4.1 / 5.x 계열은 보통 "Invalid image." 또는 "Could not process
   image." 비슷한 문구를 던진다. 표준 키워드를 모두 잡아 텍스트 폴백으로
   유도. */
function looksLikeInvalidImageError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return (
    lower.includes("invalid image")
    || lower.includes("could not process image")
    || lower.includes("unsupported image")
    || lower.includes("image is not")
    || lower.includes("image_url is invalid")
  );
}

async function classifyVisualOrTextReference(
  item: ReferenceItem,
  onStage: (stage: ClassifyStage) => void,
  onProgress: (progress: ClassifyProgress) => void,
  language: AiOutputLanguage,
): Promise<ReferenceItem> {
  const imageUrl = item.thumbnail_url
    || (item.kind === "image" || item.kind === "webp" || item.kind === "gif" ? item.file_url : null);
  const dataUrl = imageUrl ? await urlToDataUrl(imageUrl) : null;

  /* 시각 / 텍스트 모드 양쪽 prompt 를 한 번에 조립해 두고, 첫 시도가 OpenAI
     의 image 거부 (`Invalid image.` 등) 에 떨어졌을 때 두 번째 시도 (텍스트
     only) 를 같은 함수 안에서 그대로 진행한다. urlToDataUrl 의 사전 검증을
     통과한 자료라도 OpenAI 측 정책/일시 이슈로 드물게 거절될 수 있어 그
     마지막 안전망 역할. */
  const buildContent = (withImage: boolean): OpenAIContentPart[] => {
    const text = [
      `Title: ${item.title}`,
      `Kind: ${item.kind}`,
      item.source_url ? `Source URL: ${item.source_url}` : "",
      item.notes ? `User notes: ${item.notes}` : "",
      item.tags.length > 0 ? `Existing tags: ${item.tags.join(", ")}` : "",
      withImage ? "" : "No thumbnail/poster image was available. Classify from metadata only and avoid claiming visual details you cannot see.",
    ].filter(Boolean).join("\n");
    const parts: OpenAIContentPart[] = [
      {
        type: "text",
        text: `Classify this visual reference for a video pre-production library.\n\n${text}\n\nReturn ONLY valid JSON with this shape:\n${JSON_SCHEMA_TEXT}\n\nGenerate 8 to 10 suggested_tags. Cover diverse axes (subject, environment, style, technique, use case) so the user has enough variety to keep some and discard others. Reserve mood/emotion words for mood_labels, not suggested_tags.\n\nFor "scene_description", be a neutral observer: enumerate the concrete things visible in the frame (people with attire/pose, vehicles, architecture, landscape, props, named brands if identifiable) and their spatial layout (foreground/midground/background). Use plain factual nouns. Do NOT include mood, style, or aesthetic words there — those belong in visual_style/mood_labels. This field is the searchable description that lets users find this reference by literal keywords.\n\n${bilingualDirective(language)}`,
      },
    ];
    if (withImage && dataUrl) parts.push({ type: "image_url", image_url: { url: dataUrl } });
    return parts;
  };

  onStage("analyzing");
  onProgress({ stage: "analyzing" });

  const callOnce = async (withImage: boolean) => {
    const response = await callOpenAI({
      model: CLASSIFY_MODEL,
      messages: [{ role: "user", content: buildContent(withImage) }],
      max_completion_tokens: MAX_TOKENS,
      response_format: { type: "json_object" },
    });
    const raw = response.choices?.[0]?.message?.content;
    if (!raw) throw emptyResponseError(response);
    return safeJson(raw);
  };

  let suggestions: ReferenceAiSuggestions | null = null;
  let inputMode: "visual" | "text" = dataUrl ? "visual" : "text";
  try {
    if (dataUrl) {
      try {
        suggestions = await callOnce(true);
      } catch (err) {
        /* OpenAI 가 image 자체를 거절한 경우(예: 사전 검증을 통과한 자료라도
           서버측 정책/일시 이슈) 에는 image 빼고 텍스트 메타로 한 번 더
           시도. 다른 모든 에러(토큰 한도, 안전 필터, 네트워크 등) 는 그대로
           전파해 기존 분기를 유지한다. */
        if (looksLikeInvalidImageError(err)) {
          suggestions = await callOnce(false);
          inputMode = "text";
        } else {
          throw err;
        }
      }
    } else {
      suggestions = await callOnce(false);
    }
    onStage("ready");
    onProgress({ stage: "ready" });
    return updateReference(item.id, {
      ai_suggestions: {
        ...suggestions,
        classification_input: inputMode,
      } as unknown as Record<string, unknown>,
      classification_status: "ready",
      classified_at: new Date().toISOString(),
    });
  } catch (err) {
    onStage("failed");
    onProgress({ stage: "failed" });
    await updateReference(item.id, {
      ai_suggestions: {
        error: err instanceof Error ? err.message : String(err),
      },
      classification_status: "failed",
    });
    throw err;
  }
}

async function classifyVideoReference(
  item: ReferenceItem,
  onStage: (stage: ClassifyStage) => void,
  onProgress: (progress: ClassifyProgress) => void,
  signal: AbortSignal | undefined,
  language: AiOutputLanguage,
): Promise<ReferenceItem> {
  const videoUrl = item.file_url;
  if (!videoUrl) {
    /* 방어 — 호출자가 file_url 가드를 해 두었지만 안전. */
    return classifyVisualOrTextReference(item, onStage, onProgress, language);
  }

  /* 1) 사이즈 사전 검증은 이 단계에서 강제 못 함(remote URL 의 Content-Length
     을 fetch 해야 하는데 비용이 큼). sampleFramesWithSceneAwareness 가 메타
     단계에서 길이 제한(5분) 은 자체 검증하니 그 결과만 catch.
     200MB 강제는 import 시점에서 이미 적용되었으므로 여기서는 길이만 검증. */
  onStage("sampling");
  /* targetFrameCount 는 메타 도착 전엔 알 수 없으므로 placeholder 만 전달. */
  onProgress({ stage: "sampling" });
  let frames: ExtractedFrame[];
  let meta: VideoMeta;
  let usedSceneAware = false;
  try {
    const result = await sampleFramesWithSceneAwareness(videoUrl, {
      signal,
      onMeta: (m) => {
        const target = suggestedFrameCount(m.durationSec);
        onProgress({
          stage: "sampling",
          targetFrameCount: target,
          durationSec: m.durationSec,
          candidatesDone: 0,
          candidatesTotal: 0,
        });
      },
      onCandidateProgress: (done, total) => {
        onProgress({
          stage: "sampling",
          candidatesDone: done,
          candidatesTotal: total,
        });
      },
      onScoring: () => {
        onProgress({ stage: "sampling", scoringActive: true });
      },
      onSelected: (selected, sceneAware) => {
        usedSceneAware = sceneAware;
        onProgress({
          stage: "sampling",
          scoringActive: false,
          frames: selected,
          targetFrameCount: selected.length,
        });
      },
    });
    frames = result.frames;
    meta = result.meta;
  } catch (err) {
    onStage("failed");
    onProgress({ stage: "failed" });
    await updateReference(item.id, {
      ai_suggestions: {
        error: err instanceof Error ? err.message : String(err),
      },
      classification_status: "failed",
    });
    throw err;
  }

  if (frames.length === 0) {
    onStage("failed");
    onProgress({ stage: "failed" });
    const message = "No frames could be sampled from the video.";
    await updateReference(item.id, {
      ai_suggestions: { error: message },
      classification_status: "failed",
    });
    throw new Error(message);
  }

  /* 2) width/height/duration_sec 백필 — 영상 메타가 처음 들어왔을 때 비어
     있을 수 있음. 새 메타가 있고 기존 값이 비어 있을 때만 채움. */
  const metaPatch: Record<string, unknown> = {};
  if (!item.width && meta.widthPx) metaPatch.width = meta.widthPx;
  if (!item.height && meta.heightPx) metaPatch.height = meta.heightPx;
  if (!item.duration_sec && meta.durationSec) metaPatch.duration_sec = meta.durationSec;

  onStage("analyzing");
  onProgress({
    stage: "analyzing",
    targetFrameCount: frames.length,
    frames,
    durationSec: meta.durationSec,
  });
  const timestampList = frames.map((f) => f.t.toFixed(2)).join("s, ");
  /* scene-aware 채택 여부에 따라 프롬프트 문장을 살짝 다르게 — fast path
     (uniform) 일 때 "scene-aware" 라고 거짓 라벨링하지 않기 위함. */
  const samplingDescription = usedSceneAware
    ? "scene-aware sampling — frames concentrate around shot changes and high-motion moments while still anchoring the timeline at regular intervals"
    : "evenly spaced across the clip";
  const text = [
    `Title: ${item.title}`,
    `Kind: video`,
    `Duration: ${meta.durationSec.toFixed(1)}s`,
    `Resolution: ${meta.widthPx} x ${meta.heightPx}`,
    `Frame count: ${frames.length} (${samplingDescription})`,
    `Frames sampled at: ${timestampList}s`,
    item.source_url ? `Source URL: ${item.source_url}` : "",
    item.notes ? `User notes: ${item.notes}` : "",
    item.tags.length > 0 ? `Existing tags: ${item.tags.join(", ")}` : "",
    "These frames are sequential samples from the same video. Infer motion (camera movement, subject movement, scene transitions) from the differences between consecutive frames. Treat the clip as a moving image, not a set of unrelated stills.",
  ].filter(Boolean).join("\n");

  const content: OpenAIContentPart[] = [
    {
      type: "text",
      text: `Classify this VIDEO reference for a video pre-production library.\n\n${text}\n\nReturn ONLY valid JSON with this shape:\n${JSON_SCHEMA_TEXT}\n\nGenerate 8 to 10 suggested_tags. Cover diverse axes (subject, environment, style, technique, motion, use case) so the user has enough variety to keep some and discard others. Reserve mood/emotion words for mood_labels, not suggested_tags.\n\nFor video, fill "motion_notes" carefully (describe what moves and how) and infer "shot_type" (close-up / medium / wide / aerial / handheld / static / dolly / etc.) from framing changes across frames.\n\nFor "scene_description", be a neutral observer across the sampled frames: enumerate the concrete subjects (people with attire/pose, vehicles, architecture, landscape, props, named brands if identifiable) and their spatial layout (foreground/midground/background). Use plain factual nouns. Do NOT include mood, style, or aesthetic words there — those belong in visual_style/mood_labels. If the scene changes meaningfully across frames, summarize the dominant scene first and note key changes briefly. This field is the searchable description that lets users find this reference by literal keywords.\n\n${bilingualDirective(language)}`,
    },
    ...frames.map<OpenAIContentPart>((f) => ({
      type: "image_url",
      image_url: { url: `data:${f.mediaType};base64,${f.base64}` },
    })),
  ];

  try {
    const response = await callOpenAI({
      model: CLASSIFY_MODEL,
      messages: [{ role: "user", content }],
      max_completion_tokens: MAX_TOKENS,
      response_format: { type: "json_object" },
    });
    const raw = response.choices?.[0]?.message?.content;
    if (!raw) throw emptyResponseError(response);
    const suggestions = safeJson(raw);
    onStage("ready");
    onProgress({ stage: "ready", frames, targetFrameCount: frames.length });
    /* 분석에 쓴 프레임을 작은 thumbnail 로 영구 저장 — 인스펙터의 "Selected
       frames" 미리보기를 분석 후/세션 전환 후에도 보여주기 위함. 본 호출
       시점에는 이미 LLM 응답이 도착했으므로 UX 상 중요한 경로는 끝났다.
       Promise.all 이 실패해도 분류 자체는 성공으로 마감되도록 catch 로
       감싼다. */
    let storedFrames: ReferenceAiSuggestions["sampled_frames"] | undefined;
    try {
      const compact = await Promise.all(
        frames.map((f) => downsampleFrameForStorage(f, 128)),
      );
      storedFrames = compact.map(({ t, mediaType, base64 }) => ({ t, mediaType, base64 }));
    } catch {
      storedFrames = undefined;
    }
    return updateReference(item.id, {
      ...metaPatch,
      ai_suggestions: {
        ...suggestions,
        classification_input: "visual",
        sampled_frames: storedFrames,
      } as unknown as Record<string, unknown>,
      classification_status: "ready",
      classified_at: new Date().toISOString(),
    });
  } catch (err) {
    onStage("failed");
    onProgress({ stage: "failed", frames, targetFrameCount: frames.length });
    /* meta 백필은 분석 실패와 무관하므로 따로 저장 — 다음 시도부터 메타가
       이미 있어 재샘플링이 약간 더 정확해짐. */
    if (Object.keys(metaPatch).length > 0) {
      try {
        await updateReference(item.id, metaPatch);
      } catch {
        /* 메타 백필 실패는 무시 — 핵심 에러 정보는 다음 update 가 저장. */
      }
    }
    await updateReference(item.id, {
      ai_suggestions: {
        error: err instanceof Error ? err.message : String(err),
      },
      classification_status: "failed",
    });
    throw err;
  }
}

/* total 개 중 N 개를 균등 인덱스로 선택. (N >= total 이면 0..total-1 그대로)
   첫 프레임(0)과 마지막 프레임(total-1) 을 반드시 포함해 루프의 시작/끝
   상태가 LLM 컨텍스트에 들어가도록 한다 — 짧은 GIF 에서 가장 중요한
   anchor 들. */
function selectUniformIndexes(total: number, n: number): number[] {
  if (total <= 0) return [];
  if (n >= total) return Array.from({ length: total }, (_, i) => i);
  if (n <= 1) return [Math.floor(total / 2)];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (total - 1)) / (n - 1));
    if (out.length === 0 || idx !== out[out.length - 1]) out.push(idx);
  }
  return out;
}

/* VideoFrame → base64 PNG. ExtractedFrame 의 mediaType 규약(image/png) 과
   맞추어 video sampling 경로의 다운스트림(분석 컨텐트 / sampled_frames
   저장) 과 동일하게 다룰 수 있게 한다. maxWidth 로 768px 로 캡 — 비전 API
   비용/대역폭 절감. */
async function videoFrameToBase64Png(vf: VideoFrame, maxWidth: number): Promise<string> {
  if (typeof document === "undefined") throw new Error("DOM required to encode VideoFrame");
  const srcW = vf.displayWidth;
  const srcH = vf.displayHeight;
  const scale = Math.min(1, maxWidth / Math.max(srcW, 1));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(vf as unknown as CanvasImageSource, 0, 0, w, h);
  const url = canvas.toDataURL("image/png");
  const comma = url.indexOf(",");
  if (comma < 0) throw new Error("toDataURL failed");
  return url.slice(comma + 1);
}

/**
 * GIF / animated WebP / APNG 분류 경로.
 *
 * 흐름:
 *   1) ImageDecoder 로 모든 프레임 디코드(상한 250 frames). 미지원 환경/
 *      디코드 실패는 정적 visual path 로 폴백.
 *   2) frameCount === 1 (정적 GIF) 면 visual path 로 폴백 — 단일 프레임이라
 *      multi-image 컨텍스트가 의미 없음.
 *   3) 총 프레임 수에서 suggestedFrameCount(totalDurationSec) 만큼 균등
 *      인덱스 추출 → 각 VideoFrame 을 768px PNG base64 로 인코드 →
 *      ExtractedFrame 으로 변환. 인덱스 기반 균등 분포는 GIF 의 프레임당
 *      표시 시간이 대체로 균일하다는 휴리스틱에 의존(현실 GIF/스티커는
 *      거의 항상 그렇다).
 *   4) video 와 같은 multi-image 프롬프트(motion_notes / shot_type 강조)
 *      를 호출. sampled_frames 까지 저장해 인스펙터에서 분석 후에도 미리
 *      보기를 유지.
 *
 * 비용은 video 와 동일한 곡선 (≤10s → 6 frames, ≤60s → 14 frames …). 짧고
 * 루프가 있는 자료이므로 6~10 frame 범위에서 끝나는 게 보통.
 */
async function classifyGifReference(
  item: ReferenceItem,
  onStage: (stage: ClassifyStage) => void,
  onProgress: (progress: ClassifyProgress) => void,
  signal: AbortSignal | undefined,
  language: AiOutputLanguage,
): Promise<ReferenceItem> {
  const fileUrl = item.file_url;
  if (!fileUrl) {
    return classifyVisualOrTextReference(item, onStage, onProgress, language);
  }

  onStage("sampling");
  onProgress({ stage: "sampling" });

  /* (1) 디코드. 실패 시 visual path 로 안전 폴백 — classification_status 가
     pending 상태이므로 그쪽이 ready 로 마감해 줄 것이다. */
  let decoded: Awaited<ReturnType<typeof decodeAnimatedAllFrames>>;
  try {
    decoded = await decodeAnimatedAllFrames(fileUrl, item.mime_type, {
      signal,
      onFrameDecoded: (done, total) => {
        onProgress({
          stage: "sampling",
          candidatesDone: done,
          candidatesTotal: total,
        });
      },
    });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      throw err;
    }
    /* ImageDecoder 미지원 / 손상된 파일 등 → 정적 한 컷 분석으로 폴백.
       사용자 입장에서 "AI 분류 실패" 보다는 "정지 한 컷으로라도 분석" 이
       유용하다. */
    return classifyVisualOrTextReference(item, onStage, onProgress, language);
  }

  /* (2) 정적 단일 프레임 GIF — multi-image 의미 없음. visual path 로. */
  if (decoded.frames.length <= 1) {
    for (const f of decoded.frames) { try { f.close(); } catch { /* noop */ } }
    return classifyVisualOrTextReference(item, onStage, onProgress, language);
  }

  /* (3) 인덱스 균등 샘플링 + base64 인코드. close 누락 방지를 위해 try/finally
     로 모든 디코드 프레임을 한 번에 정리한다. */
  const totalDurationSec = Math.max(0.001, decoded.totalDurationMs / 1000);
  const target = suggestedFrameCount(totalDurationSec);
  const selectedIdxs = selectUniformIndexes(decoded.frames.length, target);

  onProgress({
    stage: "sampling",
    durationSec: totalDurationSec,
    targetFrameCount: selectedIdxs.length,
    candidatesDone: 0,
    candidatesTotal: selectedIdxs.length,
  });

  /* 프레임별 누적 시간(ms) — 선택된 프레임의 t 값(초) 계산용. */
  const cumulativeMs: number[] = [];
  let acc = 0;
  for (const d of decoded.durationsMs) {
    cumulativeMs.push(acc);
    acc += d;
  }

  let extracted: ExtractedFrame[];
  try {
    extracted = [];
    for (let i = 0; i < selectedIdxs.length; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const idx = selectedIdxs[i];
      const vf = decoded.frames[idx];
      const base64 = await videoFrameToBase64Png(vf, 768);
      const tSec = cumulativeMs[idx] / 1000;
      extracted.push({ t: tSec, mediaType: "image/png", base64 });
      onProgress({
        stage: "sampling",
        targetFrameCount: selectedIdxs.length,
        candidatesDone: i + 1,
        candidatesTotal: selectedIdxs.length,
      });
    }
  } finally {
    for (const f of decoded.frames) { try { f.close(); } catch { /* noop */ } }
  }

  /* (4) meta 백필. width/height/duration 이 비어 있던 자료는 분석을 계기로
     채워 둠 — 다음 카드 렌더부터 색팔레트/스펙 라벨이 정확해짐. */
  const metaPatch: Record<string, unknown> = {};
  if (!item.width && decoded.widthPx) metaPatch.width = decoded.widthPx;
  if (!item.height && decoded.heightPx) metaPatch.height = decoded.heightPx;
  if (!item.duration_sec && totalDurationSec > 0) metaPatch.duration_sec = totalDurationSec;

  onStage("analyzing");
  onProgress({
    stage: "analyzing",
    targetFrameCount: extracted.length,
    frames: extracted,
    durationSec: totalDurationSec,
  });

  const timestampList = extracted.map((f) => f.t.toFixed(2)).join("s, ");
  const truncatedNote = decoded.truncated
    ? ` (Note: source has ${decoded.totalFrameCount} frames; only the first ${decoded.frames.length} were considered due to size cap.)`
    : "";
  const text = [
    `Title: ${item.title}`,
    `Kind: animated raster (${item.kind})`,
    item.source_url ? `Source URL: ${item.source_url}` : "",
    item.notes ? `User notes: ${item.notes}` : "",
    item.tags.length > 0 ? `Existing tags: ${item.tags.join(", ")}` : "",
    `Frames sampled uniformly across the loop at: ${timestampList}s (loop ${totalDurationSec.toFixed(2)}s total, ${extracted.length} of ${decoded.frames.length} frames analyzed).${truncatedNote}`,
  ].filter(Boolean).join("\n");

  const content: OpenAIContentPart[] = [
    {
      type: "text",
      text: `Classify this animated image (GIF / animated WebP / APNG) reference for a video pre-production library.\n\n${text}\n\nReturn ONLY valid JSON with this shape:\n${JSON_SCHEMA_TEXT}\n\nGenerate 8 to 10 suggested_tags. Cover diverse axes (subject, environment, style, technique, motion, use case) so the user has enough variety to keep some and discard others. Reserve mood/emotion words for mood_labels, not suggested_tags.\n\nThis is a short looping animation. Fill "motion_notes" carefully (describe what moves, where, and the rhythm/cadence of the loop) and infer "shot_type" (close-up / medium / wide / static / handheld / etc.) from framing across frames.\n\nFor "scene_description", be a neutral observer across the loop: enumerate the concrete subjects (characters/figures with appearance, objects, environment, props, identifiable brands) and their spatial layout (foreground/midground/background). Use plain factual nouns. Do NOT include mood, style, or aesthetic words there — those belong in visual_style/mood_labels. This field is the searchable description that lets users find this reference by literal keywords.\n\n${bilingualDirective(language)}`,
    },
    ...extracted.map<OpenAIContentPart>((f) => ({
      type: "image_url",
      image_url: { url: `data:${f.mediaType};base64,${f.base64}` },
    })),
  ];

  try {
    const response = await callOpenAI({
      model: CLASSIFY_MODEL,
      messages: [{ role: "user", content }],
      max_completion_tokens: MAX_TOKENS,
      response_format: { type: "json_object" },
    });
    const raw = response.choices?.[0]?.message?.content;
    if (!raw) throw emptyResponseError(response);
    const suggestions = safeJson(raw);
    onStage("ready");
    onProgress({ stage: "ready", frames: extracted, targetFrameCount: extracted.length });
    /* video 와 동일하게 인스펙터의 "Selected frames" 미리보기를 위해 128px
       다운스케일 PNG 를 저장. 실패는 분류 성공과 무관(best-effort). */
    let storedFrames: ReferenceAiSuggestions["sampled_frames"] | undefined;
    try {
      const compact = await Promise.all(
        extracted.map((f) => downsampleFrameForStorage(f, 128)),
      );
      storedFrames = compact.map(({ t, mediaType, base64 }) => ({ t, mediaType, base64 }));
    } catch {
      storedFrames = undefined;
    }
    return updateReference(item.id, {
      ...metaPatch,
      ai_suggestions: {
        ...suggestions,
        classification_input: "visual",
        sampled_frames: storedFrames,
      } as unknown as Record<string, unknown>,
      classification_status: "ready",
      classified_at: new Date().toISOString(),
    });
  } catch (err) {
    onStage("failed");
    onProgress({ stage: "failed", frames: extracted, targetFrameCount: extracted.length });
    if (Object.keys(metaPatch).length > 0) {
      try { await updateReference(item.id, metaPatch); } catch { /* noop */ }
    }
    await updateReference(item.id, {
      ai_suggestions: {
        error: err instanceof Error ? err.message : String(err),
      },
      classification_status: "failed",
    });
    throw err;
  }
}

/* AI accept 는 "tags only" — Notes 는 사용자 전용 공간이라 AI 결과로 덮어쓰지
   않는다. visual_style / motion_notes / brief_fit / conti_use 같은 구조화된
   인사이트는 ai_suggestions 안에 그대로 남고 AI 탭의 Suggestions 블록에서
   read-only 로 노출된다.

   mood_labels 는 의도적으로 머지 대상에서 제외 — Inspector 의 독립 Mood
   섹션과 Mood AI 필터의 1차 신호원으로만 사용한다. 일반 tag 와 섞이면
   "playful" 같은 감정 토큰이 일반 검색/추천에 노이즈로 들어가기 때문.

   `tagLanguage` 옵션은 머지할 언어를 결정한다. 미지정 시 영어 canonical 을
   머지(기존 동작 유지). KO 머지일 땐 `suggested_tags_ko` 가 있으면 그것을,
   없으면 canonical 로 fallback. ai_suggestions 자체에는 양 언어 모두 그대로
   남기 때문에 양방향 검색 haystack 은 변함없이 작동. */
export async function acceptReferenceAiSuggestions(
  item: ReferenceItem,
  options: { tagLanguage?: AiOutputLanguage } = {},
): Promise<ReferenceItem> {
  const suggestions = item.ai_suggestions as Partial<ReferenceAiSuggestions> | null | undefined;
  if (!suggestions) return item;
  const lang: AiOutputLanguage = options.tagLanguage ?? "en";
  const canonical = Array.isArray(suggestions.suggested_tags) ? suggestions.suggested_tags : [];
  const localized = Array.isArray(suggestions.suggested_tags_ko) ? suggestions.suggested_tags_ko : [];
  /* parallel 보장: localized 길이가 canonical 과 다르면 안전하게 canonical
     로만 머지 (safeJson 이 그렇게 만든다는 보장이 있지만 한 번 더 가드). */
  const source =
    lang === "ko" && localized.length === canonical.length && localized.length > 0
      ? localized
      : canonical;
  const nextTags = [...item.tags, ...source];
  return updateReference(item.id, {
    tags: [...new Set(nextTags.map((tag) => tag.trim()).filter(Boolean))],
  });
}

/* video import 시점 검증을 별도 모듈에서 호출할 수 있게 재노출. */
export { MAX_DURATION_SEC, MAX_VIDEO_BYTES };

/** ──────────────────────────────────────────────────────────────────
 *  translateUserTags — 사용자가 직접 입력한 한글 태그 묶음을 EN canonical
 *  로 일괄 번역. Library 정리 batch (Settings → "라이브러리 AI 정리") 의
 *  L3 단계에서 시드 사전(`koreanTagSeedDictionary`) 으로 즉시 매칭(L1)
 *  되지 않은 한글 토큰들을 자동으로 chunk 분할해 LLM 호출한다.
 *
 *  설계 선택:
 *    · *영상 사전제작 도메인* 어휘 친화적 변환 — "야경" → `nightscape`
 *      같이 short-hyphen-canonical EN. 일반 번역기("night view") 보다
 *      라이브러리 태그 인덱스 일관성이 더 중요.
 *    · **자동 chunk 분할** (`CHUNK_SIZE`=30) — 한 호출에 너무 많이 보내면
 *      response 가 잘리거나 응답 누락이 늘어 일부 토큰이 silent 하게
 *      변환에서 빠지는 사고가 발생한다(이전 보고된 증상). 30 단위로
 *      나눠 보내면 max_completion_tokens 안에서 안정적으로 응답 완료.
 *    · **공백→하이픈 정규화** — 모델이 가끔 `vehicle interior` 처럼 공백
 *      포함 응답을 보낸다. 정확히 거부하지 않고 `vehicle-interior` 로
 *      자동 정규화해 매핑 누락을 줄인다. 검증 정규식도 *조립 전* 입력만
 *      살피도록 완화 (영문/숫자/하이픈/언더스코어/슬래시/점/공백 OK).
 *    · **temperature 미지정** — gpt-5.x family 는 temperature=0 을 거부할
 *      수 있다. classify path 와 동일하게 temperature 옵션을 빼서 모델
 *      기본값에 맡긴다.
 *
 *  반환 형태:
 *    `{ ko, en }[]` — 호출자 전체 입력 순서 그대로.  매핑 실패 토큰은 `en=null`.
 *    호출부는 null 토큰을 dry-run preview 에서 "(LLM)" 로 표시하거나
 *    한글 보존 정책 적용.
 */
const TRANSLATE_CHUNK_SIZE = 30;

export async function translateUserTags(
  hangulTags: ReadonlyArray<string>,
  options: { signal?: AbortSignal } = {},
): Promise<Array<{ ko: string; en: string | null }>> {
  void options.signal; // callOpenAI 가 abort signal 를 직접 받지 않음 — fetch 단의 정책에 위임
  const cleaned = hangulTags
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean);
  if (cleaned.length === 0) return [];

  /* chunk 단위로 LLM 호출 후 결과 병합. 한 chunk 가 throw 해도 그 chunk
     의 토큰만 null 로 남기고 나머지는 진행 — 사용자에게 부분 성공이
     훨씬 가치 있다. */
  const merged = new Map<string, string | null>();
  for (let i = 0; i < cleaned.length; i += TRANSLATE_CHUNK_SIZE) {
    const chunk = cleaned.slice(i, i + TRANSLATE_CHUNK_SIZE);
    try {
      const partial = await translateChunk(chunk);
      for (const row of partial) {
        if (!merged.has(row.ko)) merged.set(row.ko, row.en);
      }
    } catch {
      /* 이 chunk 의 토큰들은 null 로 — 호출부가 stats 표시 가능 */
      for (const ko of chunk) {
        if (!merged.has(ko)) merged.set(ko, null);
      }
    }
  }

  return cleaned.map((ko) => ({ ko, en: merged.has(ko) ? merged.get(ko) ?? null : null }));
}

async function translateChunk(
  chunk: ReadonlyArray<string>,
): Promise<Array<{ ko: string; en: string | null }>> {
  const prompt = [
    "You normalize Korean tags from a video pre-production reference library into",
    "canonical English tags. Output rules:",
    "  - lowercase ASCII only",
    "  - hyphen-separated for compounds (e.g. nightscape, close-up, sports-car,",
    "    vehicle-interior, battle-royale)",
    "  - prefer short common English nouns/adjectives over literal phrase translation",
    "    e.g. '야경' → 'nightscape' (NOT 'night-view'), '쓸쓸함' → 'melancholy',",
    "         '차량 실내' → 'vehicle-interior', '배틀그라운드' → 'battle-royale-game'",
    "  - proper nouns (game/brand titles) → translate to a generic kebab-case category",
    "    e.g. '배틀그라운드' → 'battle-royale-game', '에버랜드' → 'theme-park'",
    "  - if truly untranslatable (gibberish, abbreviations, single particles),",
    "    return null for that entry. NEVER invent meaningless tags.",
    "  - YOU MUST return an entry for EVERY input token in the same order.",
    "",
    'Return STRICT JSON: {"results": [{"ko": "<original>", "en": "<kebab-case-en>" | null}, ...]}.',
    "",
    `Input (${chunk.length} tags):`,
    JSON.stringify(chunk),
  ].join("\n");

  const response = await callOpenAI({
    model: CLASSIFY_MODEL,
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 2048,
    response_format: { type: "json_object" },
  });
  const raw = response.choices?.[0]?.message?.content;
  if (!raw) throw emptyResponseError(response);

  const cleanedRaw = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  type Row = { ko?: unknown; en?: unknown };
  let parsed: { results?: Row[] } = {};
  try {
    parsed = JSON.parse(cleanedRaw) as { results?: Row[] };
  } catch {
    return chunk.map((ko) => ({ ko, en: null }));
  }
  const rows = Array.isArray(parsed.results) ? parsed.results : [];

  /* 모델이 입력 순서를 어겼을 수 있어 ko 키로 다시 매핑. 한 ko 토큰이
     두 번 나오면 *첫* en 채택. 응답 누락 토큰은 null. */
  const byKo = new Map<string, string | null>();
  for (const row of rows) {
    const ko = typeof row.ko === "string" ? row.ko.trim() : "";
    if (!ko || byKo.has(ko)) continue;
    byKo.set(ko, normalizeEnTag(row.en));
  }

  return chunk.map((ko) => ({
    ko,
    en: byKo.has(ko) ? byKo.get(ko) ?? null : null,
  }));
}

/**
 * expandEnTagsToKorean — EN canonical 태그/무드를 한국어 *검색 별칭* 으로 확장.
 *
 * `suggested_tags_ko` 가 자연 번역(직역, 예: halftone→망점) 만 채우는 한계를
 * 보완해, 한국 사용자가 *실제로 검색창에 치는* 음역(하프톤) + 자연 번역 +
 * 동의어를 함께 생성한다. 결과는 `koreanTagAliasOverrides` 에 저장되어 검색
 * 별칭 인덱스에 augment 된다 (기존 별칭 대체 X).
 *
 * 반환: `{ [enTag]: koSynonyms[] }`. 모델이 응답한 EN 키만 포함되며, 의미 있는
 * 한국어 검색어가 없으면 빈 배열로 응답될 수 있다(그래도 키는 포함 → 호출부의
 * auto dedupe 가 "확장 시도 완료" 로 마킹). chunk 호출이 실패/타임아웃하면 그
 * chunk 의 토큰은 결과에서 빠져 다음 기회에 재시도된다.
 *
 * 대량(수백 태그) 처리를 위한 4가지 보강:
 *   1) onChunk — chunk 가 끝날 때마다 호출되어 *증분 저장* 을 가능케 한다.
 *      (이전엔 전부 끝나야 한 번에 반환 → 중간 중단 시 전부 손실)
 *   2) onProgress — 진행률(완료 chunk 수 / 전체) 콜백.
 *   3) signal — AbortSignal. abort 되면 진행 중 chunk 만 마무리(=그 결과는
 *      보존)하고 이후 chunk 는 스케줄하지 않는다.
 *   4) concurrency + chunkTimeoutMs — chunk 를 동시성 제한 풀로 병렬 처리하고,
 *      개별 chunk 는 타임아웃을 둬 무한 대기를 막는다.
 */
const EXPAND_CHUNK_SIZE = 24;
const EXPAND_CONCURRENCY = 4;
const EXPAND_CHUNK_TIMEOUT_MS = 45_000;

export interface ExpandKoreanProgress {
  /** 완료(성공/실패 무관)된 chunk 수. */
  doneChunks: number;
  /** 전체 chunk 수. */
  totalChunks: number;
  /** 지금까지 한국어 별칭이 생성된 태그 누적 수. */
  expandedTags: number;
}

export interface ExpandKoreanOptions {
  /** 취소 신호. abort 시 진행 중 chunk 까지만 보존하고 멈춘다. */
  signal?: AbortSignal;
  /** 동시 실행 chunk 수(기본 4). rate-limit 여유를 위해 보수적으로 둔다. */
  concurrency?: number;
  /** chunk 1개의 최대 대기(ms). 초과 시 그 chunk 만 실패 처리(기본 45s). */
  chunkTimeoutMs?: number;
  /** chunk 성공 시마다 그 chunk 의 부분 결과로 호출(증분 저장용). */
  onChunk?: (partial: Record<string, string[]>) => void;
  /** 진행률 갱신 콜백. */
  onProgress?: (progress: ExpandKoreanProgress) => void;
}

/** Promise 에 타임아웃을 건다 — 초과 시 reject. 원 요청 자체는 취소되지 않지만
 *  (callOpenAI 는 abort 미지원) 호출부는 다음 chunk 로 진행할 수 있다. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`expandKoreanChunk timeout after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function expandEnTagsToKorean(
  enTags: ReadonlyArray<string>,
  options: ExpandKoreanOptions = {},
): Promise<Record<string, string[]>> {
  const {
    signal,
    concurrency = EXPAND_CONCURRENCY,
    chunkTimeoutMs = EXPAND_CHUNK_TIMEOUT_MS,
    onChunk,
    onProgress,
  } = options;

  const cleaned = Array.from(
    new Set(
      enTags
        .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
        .filter(Boolean),
    ),
  );
  if (cleaned.length === 0) return {};

  const chunks: string[][] = [];
  for (let i = 0; i < cleaned.length; i += EXPAND_CHUNK_SIZE) {
    chunks.push(cleaned.slice(i, i + EXPAND_CHUNK_SIZE));
  }
  const totalChunks = chunks.length;

  const merged: Record<string, string[]> = {};
  let doneChunks = 0;
  let expandedTags = 0;
  let nextIndex = 0;

  const emit = () => onProgress?.({ doneChunks, totalChunks, expandedTags });
  emit(); // 시작 시 0/total 한 번.

  // 동시성 제한 워커 풀. 각 워커는 nextIndex 를 원자적으로(JS 단일스레드) 집어
  // 다음 chunk 를 처리한다. abort 되면 *새 chunk 를 더 집지 않고* 종료하되,
  // 이미 처리 중이던 chunk 의 결과는 onChunk 로 저장돼 보존된다.
  const worker = async (): Promise<void> => {
    while (!signal?.aborted) {
      const idx = nextIndex++;
      if (idx >= chunks.length) return;
      const chunk = chunks[idx];
      try {
        const partial = await withTimeout(expandKoreanChunk(chunk), chunkTimeoutMs);
        for (const [en, ko] of Object.entries(partial)) {
          merged[en] = ko;
        }
        expandedTags += Object.keys(partial).length;
        onChunk?.(partial);
      } catch {
        /* 이 chunk 의 토큰은 결과에서 제외 — 부분 성공 우선, 다음에 재시도. */
      } finally {
        doneChunks++;
        emit();
      }
    }
  };

  const poolSize = Math.max(1, Math.min(concurrency, chunks.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return merged;
}

async function expandKoreanChunk(
  chunk: ReadonlyArray<string>,
): Promise<Record<string, string[]>> {
  const prompt = [
    "You generate Korean SEARCH synonyms for English tags from a video",
    "pre-production reference library. For each English tag, return the Korean",
    "words a Korean user would actually TYPE to find it.",
    "Rules:",
    "  - Include BOTH the common transliteration (음역) AND the natural Korean",
    "    translation when both are in real use. e.g.",
    "      'halftone'   → ['하프톤','망점']",
    "      'gradient'   → ['그라디언트','그래디언트','그러데이션']",
    "      'bokeh'      → ['보케','아웃포커스']",
    "      'silhouette' → ['실루엣']",
    "      'cyberpunk'  → ['사이버펑크']",
    "  - 1 to 4 Korean synonyms per tag, most common first.",
    "  - Hangul only. No English, no latin romanization, no punctuation.",
    "  - If a tag has no meaningful Korean search term, return an empty array.",
    "  - Return an entry for EVERY input tag, using the SAME en string as key.",
    "",
    'Return STRICT JSON: {"results":[{"en":"<tag>","ko":["..."]}, ...]}.',
    "",
    `Input (${chunk.length} tags):`,
    JSON.stringify(chunk),
  ].join("\n");

  const response = await callOpenAI({
    model: CLASSIFY_MODEL,
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 2048,
    response_format: { type: "json_object" },
  });
  const raw = response.choices?.[0]?.message?.content;
  if (!raw) throw emptyResponseError(response);

  const cleanedRaw = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  type Row = { en?: unknown; ko?: unknown };
  let parsed: { results?: Row[] } = {};
  try {
    parsed = JSON.parse(cleanedRaw) as { results?: Row[] };
  } catch {
    return {};
  }
  const rows = Array.isArray(parsed.results) ? parsed.results : [];
  const HANGUL = /[\u3131-\u318E\uAC00-\uD7A3]/;
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    const en = typeof row.en === "string" ? row.en.trim().toLowerCase() : "";
    if (!en) continue;
    const koList = Array.isArray(row.ko)
      ? row.ko
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && HANGUL.test(s))
      : [];
    out[en] = Array.from(new Set(koList)).slice(0, 4);
  }
  return out;
}

/** LLM 응답 EN 토큰을 라이브러리 canonical 형식(`lowercase-kebab`)으로
 *  정규화. 모델이 공백/대문자/특수문자를 섞어 보내도 의미만 살아 있으면
 *  매핑에 살린다 — silent 실패율을 줄이는 것이 목표.
 *
 *  - 입력이 string 이 아니거나 길이 0 → null
 *  - 한글 포함 → null (모델이 번역 못 했다는 시그널)
 *  - 양 끝 trim, 외곽 quote/대괄호 제거, 내부 whitespace → 단일 hyphen
 *  - 알파벳/숫자/하이픈/언더스코어/슬래시/점만 살리고 나머지 제거
 *  - 시작/끝의 하이픈/구두점 정리
 *  - 정리 후 빈 문자열이나 첫 글자가 알파벳 아니면 null
 */
function normalizeEnTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let t = raw.trim();
  if (!t) return null;
  if (/[\u3131-\u318E\uAC00-\uD7A3]/.test(t)) return null;
  /* 외곽 quote / 대괄호 / 따옴표 제거 — 모델이 가끔 `"vehicle"` 처럼
     리터럴을 그대로 echo. */
  t = t.replace(/^["'`\[\(\{]+|["'`\]\)\}]+$/g, "");
  t = t.toLowerCase();
  /* 공백류 → 단일 하이픈 (canonical: hyphen-separated). */
  t = t.replace(/\s+/g, "-");
  /* canonical 허용 문자 외(특수문자, ko stripping fail 등) 제거. */
  t = t.replace(/[^a-z0-9\-_/.]+/g, "");
  /* 연속 하이픈 압축 + 외곽 정리. */
  t = t.replace(/-{2,}/g, "-").replace(/^[-._/]+|[-._/]+$/g, "");
  if (!t) return null;
  if (!/^[a-z0-9]/.test(t)) return null;
  return t;
}
