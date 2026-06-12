/**
 * 기능별(컨티/스타일/각도/스케치/무드) 이미지 생성 디폴트 — localStorage 영속.
 *
 * 설계 의도:
 *   · 텍스트 모델의 `modelPreference.ts` 와 같은 "전역 디폴트" 역할.
 *     Settings → 모델 패널이 이 값을 읽고/쓴다.
 *   · 각 기능 화면이 가진 인-앱 토글(스케치/무드/컨티/각도)은 **override** 로
 *     남는다. 즉 Settings 값은 "그 화면을 처음 열었을 때의 출발값" 이고,
 *     사용자가 화면에서 바꾼 값은 (기존처럼) 프로젝트/세션 단위로 따로 저장된다.
 *   · 모델 id 의 네임스페이스가 기능마다 다르므로(예: 컨티는 "gpt", 스케치는
 *     "gpt-image-2") 모델을 불투명 문자열로 다루고, 기능별 옵션 목록/디폴트를
 *     이 한 곳(IMAGE_GEN_FEATURES)에서 정의한다.
 *
 * GPT 품질("low"|"medium"|"high")은 GPT 계열 모델에만 의미가 있다. NB2(나노바나나)
 * 는 품질 파라미터를 무시하므로, NB2 가 선택되면 Settings UI 에서 품질 드롭다운을
 * 비활성화한다(modelIsGpt 로 판정).
 */

export type ImageGenFeature = "conti" | "style" | "angle" | "sketch" | "mood" | "sheet" | "storyboardSheet" | "variation" | "canvas" | "inpaint" | "cameraVariation";
export type GptQuality = "low" | "medium" | "high";

export const GPT_QUALITIES: GptQuality[] = ["low", "medium", "high"];

export interface ImageGenModelOption {
  id: string;
  /** GPT 계열 여부 — true 면 품질 설정이 적용된다. NB2 는 false. */
  isGpt: boolean;
}

export interface ImageGenFeatureSpec {
  feature: ImageGenFeature;
  /** Settings 행 라벨 i18n 키 */
  labelKey: string;
  /** Settings 행 설명 i18n 키 */
  descKey: string;
  models: ImageGenModelOption[];
  defaultModel: string;
  defaultQuality: GptQuality;
}

/** 기능별 옵션/디폴트 단일 출처. 현재 각 컴포넌트에 흩어진 디폴트값과 일치. */
export const IMAGE_GEN_FEATURES: ImageGenFeatureSpec[] = [
  {
    feature: "conti",
    labelKey: "settings.imgGen.conti",
    descKey: "settings.imgGen.contiDesc",
    models: [
      { id: "gpt", isGpt: true },
      { id: "nano-banana-2", isGpt: false },
    ],
    defaultModel: "gpt",
    defaultQuality: "high",
  },
  {
    feature: "style",
    labelKey: "settings.imgGen.style",
    descKey: "settings.imgGen.styleDesc",
    models: [
      { id: "gpt", isGpt: true },
      { id: "nano-banana-2", isGpt: false },
    ],
    defaultModel: "gpt",
    defaultQuality: "high",
  },
  {
    // 콘티 "시트 모드" 의 멀티패널 시트 생성. 파이프라인이 모델 고정
    // (GPT Image 2 → NB2 리파인)이라 모델은 단일 옵션으로 노출하고, 조절 가능한
    // 것은 GPT 생성 품질뿐이다. 셀 디테일/컷 일관성에 직결되므로 기본 high.
    feature: "storyboardSheet",
    labelKey: "settings.imgGen.storyboardSheet",
    descKey: "settings.imgGen.storyboardSheetDesc",
    models: [{ id: "gpt-image-2", isGpt: true }],
    defaultModel: "gpt-image-2",
    defaultQuality: "high",
  },
  {
    feature: "angle",
    labelKey: "settings.imgGen.angle",
    descKey: "settings.imgGen.angleDesc",
    models: [
      { id: "gpt-image-1.5", isGpt: true },
      { id: "gpt-image-2", isGpt: true },
    ],
    defaultModel: "gpt-image-1.5",
    defaultQuality: "high",
  },
  {
    // 인페인트 — "auto" 는 ContiStudio 에서 마스크 유무로 분기한다(마스크 있으면
    // gpt-image-1.5 native mask + input_fidelity, 없으면 NB2 instruction 편집).
    // auto 를 isGpt:true 로 둬서 품질 드롭다운이 살아 있게 한다(GPT 로 풀릴 때 적용,
    // NB2 로 풀리면 무시).
    feature: "inpaint",
    labelKey: "settings.imgGen.inpaint",
    descKey: "settings.imgGen.inpaintDesc",
    models: [
      { id: "auto", isGpt: true },
      { id: "gpt-image-1.5", isGpt: true },
      { id: "gpt-image-2", isGpt: true },
      { id: "nano-banana-2", isGpt: false },
    ],
    defaultModel: "auto",
    defaultQuality: "high",
  },
  {
    // 카메라 베리에이션 — 스토리보드 시트와 동일하게 파이프라인이 모델 고정이다
    // (GPT Image 2 로 9분할 그리드 생성 → Nano Banana 2 리파인). 따라서 모델은
    // 단일 옵션으로 노출하고 조절 가능한 것은 GPT 생성 품질뿐이다.
    feature: "cameraVariation",
    labelKey: "settings.imgGen.cameraVariation",
    descKey: "settings.imgGen.cameraVariationDesc",
    models: [{ id: "gpt-image-2", isGpt: true }],
    defaultModel: "gpt-image-2",
    defaultQuality: "high",
  },
  {
    feature: "sketch",
    labelKey: "settings.imgGen.sketch",
    descKey: "settings.imgGen.sketchDesc",
    models: [
      { id: "gpt-image-2", isGpt: true },
      { id: "gpt-image-1.5", isGpt: true },
      { id: "nano-banana-2", isGpt: false },
    ],
    defaultModel: "gpt-image-2",
    defaultQuality: "high",
  },
  {
    // 무드 패널은 현재 gpt-image-1.5 계열만 활성(gpt-image-2 / NB2 는 비활성).
    // Settings 도 실제 선택 가능한 두 옵션만 노출한다.
    feature: "mood",
    labelKey: "settings.imgGen.mood",
    descKey: "settings.imgGen.moodDesc",
    models: [
      { id: "gpt-image-1.5-ref", isGpt: true },
      { id: "gpt-image-1.5-text", isGpt: true },
    ],
    defaultModel: "gpt-image-1.5-ref",
    defaultQuality: "high",
  },
  {
    // 캐릭터 시트/보드 — 둘 다 같은 inpaint 파이프라인(원본 사진 → 16:9 레퍼런스)
    // 을 공유하므로 모델 선택도 하나로 묶는다. NB2 가 기본(다중 패널 얼굴 그리드의
    // 2K 렌더에 튜닝됨). GPT 계열은 ChangeAngle 과 동일한 inpaint GPT-edits 경로로
    // 라우팅된다(품질 파라미터 적용).
    feature: "sheet",
    labelKey: "settings.imgGen.sheet",
    descKey: "settings.imgGen.sheetDesc",
    models: [
      { id: "nano-banana-2", isGpt: false },
      { id: "gpt-image-1.5", isGpt: true },
      { id: "gpt-image-2", isGpt: true },
    ],
    defaultModel: "nano-banana-2",
    defaultQuality: "high",
  },
  {
    // Reference Library AI 베리에이션 — 원본 레퍼런스에서 구도/스타일 변형을
    // 뽑아 새 레퍼런스로 저장. 구도 베리에이션을 여러 장 빠르게 뽑는 UX 라
    // NB2(빠르고 저렴)를 기본으로. GPT Image 2 는 품질 파라미터 적용.
    feature: "variation",
    labelKey: "settings.imgGen.variation",
    descKey: "settings.imgGen.variationDesc",
    models: [
      { id: "nano-banana-2", isGpt: false },
      { id: "gpt-image-2", isGpt: true },
    ],
    defaultModel: "nano-banana-2",
    defaultQuality: "high",
  },
  {
    // 캔버스 AI 생성 노드 — 연결된 이미지(레퍼런스) + 프롬프트 카드를 입력으로
    // 새 이미지를 생성해 라이브러리에 적재한다. 노드 그래프에서 빠르게 여러 변형을
    // 뽑는 UX 라 variation 과 동일하게 NB2 를 기본으로 둔다. GPT Image 2 는 품질
    // 파라미터가 적용된다. (영상 출력은 Vertex API 부재로 보류 — 스키마만 유지.)
    feature: "canvas",
    labelKey: "settings.imgGen.canvas",
    descKey: "settings.imgGen.canvasDesc",
    models: [
      { id: "nano-banana-2", isGpt: false },
      { id: "gpt-image-2", isGpt: true },
    ],
    defaultModel: "nano-banana-2",
    defaultQuality: "high",
  },
];

/** 모델 id → 사람이 읽는 라벨(브랜드명). i18n 불필요한 고유명사. */
export const IMAGE_GEN_MODEL_LABELS: Record<string, string> = {
  "auto": "Auto (mask-based)",
  "gpt": "GPT Image 2",
  "gpt-image-2": "GPT Image 2",
  "gpt-image-1.5": "GPT Image 1.5",
  "gpt-image-1.5-ref": "GPT Image 1.5 (with refs)",
  "gpt-image-1.5-text": "GPT Image 1.5 (text only)",
  "nano-banana-2": "Nano Banana 2",
};

const SPEC_BY_FEATURE: Record<ImageGenFeature, ImageGenFeatureSpec> =
  Object.fromEntries(IMAGE_GEN_FEATURES.map((s) => [s.feature, s])) as Record<
    ImageGenFeature,
    ImageGenFeatureSpec
  >;

export function getFeatureSpec(feature: ImageGenFeature): ImageGenFeatureSpec {
  return SPEC_BY_FEATURE[feature];
}

const modelKey = (feature: ImageGenFeature) => `ff_imggen_model_${feature}`;
const qualityKey = (feature: ImageGenFeature) => `ff_imggen_quality_${feature}`;

function readLS(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLS(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore quota / sandboxed write failure */
  }
}

/** 해당 모델 id 가 기능의 GPT 계열인지. 미지의 id 면 false(=품질 무관). */
export function modelIsGpt(feature: ImageGenFeature, modelId: string): boolean {
  return !!SPEC_BY_FEATURE[feature].models.find((m) => m.id === modelId)?.isGpt;
}

/**
 * 기능의 디폴트 모델 id. 저장값이 없거나 옵션에 없으면 spec 디폴트로 폴백.
 */
export function getImageModelDefault(feature: ImageGenFeature): string {
  const spec = SPEC_BY_FEATURE[feature];
  const raw = readLS(modelKey(feature));
  if (raw && spec.models.some((m) => m.id === raw)) return raw;
  return spec.defaultModel;
}

export function setImageModelDefault(feature: ImageGenFeature, modelId: string): void {
  writeLS(modelKey(feature), modelId);
}

/**
 * 기능의 디폴트 GPT 품질. 저장값이 없거나 유효하지 않으면 spec 디폴트로 폴백.
 */
export function getGptQualityDefault(feature: ImageGenFeature): GptQuality {
  const raw = readLS(qualityKey(feature));
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  return SPEC_BY_FEATURE[feature].defaultQuality;
}

export function setGptQualityDefault(feature: ImageGenFeature, quality: GptQuality): void {
  writeLS(qualityKey(feature), quality);
}
