/**
 * 중앙 LLM 모델 카탈로그.
 *
 * 단일 출처 (single source of truth) 로 모든 텍스트 LLM 후보를 정의하고,
 * UI(Settings, ModelPicker, BriefTab/AgentTab) 와 디스패처(callLLM) 가
 * 여기서 메타데이터를 읽어 동작하도록 한다.
 *
 * GPT-5.5 가 API 출시되면 시드의 `released: true` 한 줄만 토글하고
 * 디폴트를 5.4 → 5.5 로 한 줄 바꾸면 끝나도록 설계했다.
 */

export type Provider = "anthropic" | "openai";

export type ModelId =
  | "claude-opus-4-8"
  | "claude-opus-4-7"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5-20251001"
  | "gpt-5.4"
  | "gpt-5.5"
  | "gpt-5.5-pro";

export interface ModelMeta {
  id: ModelId;
  provider: Provider;
  label: string;
  /** 모델 1회 호출 컨텍스트 한도 (UI 표시 + 슬라이딩 윈도우 결정) */
  contextWindow: number;
  supportsVision: boolean;
  /** 영상 프레임 (캔버스 다운샘플 PNG) 을 멀티모달 입력으로 받을 수 있는가 — GPT-5.x 만 true */
  supportsVideoFrames: boolean;
  maxOutputTokens: number;
  /**
   * 외부 API 호출 가능 여부. provider key 보유 + (released OR flag ON) 의 합산.
   * 호출 시 settings 스냅샷을 기반으로 계산되므로, 키나 플래그가 변경되면 즉시 갱신된다.
   */
  available: boolean;
  /** API 미출시 등으로 disabled 인 경우 UI 에 미리보기 라벨 표기 */
  isPreview?: boolean;
  /** UI 부가 설명 (옵션 라벨 한 줄 메타) */
  description?: string;
  /** 비활성 사유 (UI 에서 disabled 툴팁으로 노출) */
  disabledReason?: string;
}

interface ModelSeed {
  id: ModelId;
  provider: Provider;
  label: string;
  contextWindow: number;
  supportsVision: boolean;
  supportsVideoFrames: boolean;
  maxOutputTokens: number;
  /** API 가 출시되어 있고 키만 있으면 호출 가능한가 (런타임 플래그 무관) */
  released: boolean;
  /** released=false 일 때 settings 의 어떤 boolean 플래그 키가 ON 이면 강제 활성화할지 */
  flagKey?: string;
  isPreview?: boolean;
  description?: string;
}

const MODEL_SEEDS: ModelSeed[] = [
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    label: "Claude Opus 4.8",
    contextWindow: 200_000,
    supportsVision: true,
    supportsVideoFrames: false,
    maxOutputTokens: 8192,
    released: true,
    description: "Anthropic · 200K ctx · vision · most capable",
  },
  {
    id: "claude-opus-4-7",
    provider: "anthropic",
    label: "Claude Opus 4.7",
    contextWindow: 200_000,
    supportsVision: true,
    supportsVideoFrames: false,
    maxOutputTokens: 8192,
    released: true,
    description: "Anthropic · 200K ctx · vision · high-res",
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    label: "Claude Sonnet 4.6",
    contextWindow: 200_000,
    supportsVision: true,
    supportsVideoFrames: false,
    maxOutputTokens: 8192,
    released: true,
    description: "Anthropic · 200K ctx · vision · balanced",
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    contextWindow: 200_000,
    supportsVision: true,
    supportsVideoFrames: false,
    maxOutputTokens: 4096,
    released: true,
    description: "Anthropic · 200K ctx · vision · faster",
  },
  {
    id: "gpt-5.4",
    provider: "openai",
    label: "GPT-5.4",
    contextWindow: 400_000,
    supportsVision: true,
    supportsVideoFrames: true,
    maxOutputTokens: 8192,
    released: true,
    description: "OpenAI · 400K ctx · vision + video frames",
  },
  {
    id: "gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
    contextWindow: 1_000_000,
    supportsVision: true,
    supportsVideoFrames: true,
    maxOutputTokens: 16_384,
    // GA — API 가 출시되어 키만 있으면 바로 호출 가능. 별도 플래그 불필요.
    released: true,
    description: "OpenAI · 1M ctx · vision + video frames",
  },
  {
    id: "gpt-5.5-pro",
    provider: "openai",
    label: "GPT-5.5 Pro",
    contextWindow: 1_000_000,
    supportsVision: true,
    supportsVideoFrames: true,
    maxOutputTokens: 16_384,
    // GA — 키만 있으면 바로 호출 가능. 별도 플래그 불필요.
    released: true,
    description: "OpenAI · 1M ctx · vision + video frames · pro tier",
  },
];

/** Provider 별 settings 키 매핑. 키 보유 여부 검사용. */
const PROVIDER_KEY_MAP: Record<Provider, string> = {
  anthropic: "anthropic_api_key",
  openai: "openai_api_key",
};

/**
 * settings 스냅샷에서 string-only 직렬화된 boolean 플래그 읽기.
 * settings DB 는 모든 값이 string 으로 저장되므로 "true" / "false" 비교.
 */
function readFlag(settings: Record<string, any> | null | undefined, key: string | undefined): boolean {
  if (!key || !settings) return false;
  return settings[key] === "true";
}

/** 시드 한 줄 → 런타임 ModelMeta 로 평탄화. */
export function flattenSeed(seed: ModelSeed, settings: Record<string, any> | null | undefined): ModelMeta {
  const providerKey = PROVIDER_KEY_MAP[seed.provider];
  const hasKey = settings ? Boolean(settings[providerKey]) : true;
  const flagOn = readFlag(settings, seed.flagKey);
  const apiAvailable = seed.released || flagOn;
  const available = hasKey && apiAvailable;
  let disabledReason: string | undefined;
  if (!hasKey) {
    disabledReason = `Add ${seed.provider === "anthropic" ? "Anthropic" : "OpenAI"} API key in Settings`;
  } else if (!apiAvailable) {
    disabledReason = "Activates when API ships (toggle in Settings → Models)";
  }
  return {
    id: seed.id,
    provider: seed.provider,
    label: seed.label,
    contextWindow: seed.contextWindow,
    supportsVision: seed.supportsVision,
    supportsVideoFrames: seed.supportsVideoFrames,
    maxOutputTokens: seed.maxOutputTokens,
    available,
    isPreview: seed.isPreview && !flagOn,
    description: seed.description,
    disabledReason,
  };
}

/** 카탈로그 전체. settings 스냅샷을 받아 각 모델의 available 을 계산. */
export function listModels(settings?: Record<string, any> | null): ModelMeta[] {
  return MODEL_SEEDS.map((s) => flattenSeed(s, settings ?? null));
}

/** id → ModelMeta. 없으면 null (옛날에 저장된 prefs 안전 폴백) */
export function getModelMeta(
  id: ModelId | string,
  settings?: Record<string, any> | null,
): ModelMeta | null {
  const seed = MODEL_SEEDS.find((m) => m.id === id);
  return seed ? flattenSeed(seed, settings ?? null) : null;
}

/** 단계별 디폴트 모델 — Brief 는 영상 프레임 분석(GPT-5.x 전용), Agent 는 1M
 *  컨텍스트로 긴 대화 보존이 유리해 둘 다 GPT-5.5 로 기본 지정. */
export const DEFAULT_MODEL_BY_STAGE: Record<"brief" | "agent", ModelId> = {
  brief: "gpt-5.5",
  agent: "gpt-5.5",
};

/** OpenAI 모델 중 현재 권장 디폴트. 5.5 GA 이후 5.5 로 승격. */
export const OPENAI_PRIMARY: ModelId = "gpt-5.5";

/** 카탈로그에 존재하는 모든 ID 집합 (prefs 검증용) */
export const KNOWN_MODEL_IDS: ReadonlySet<string> = new Set(MODEL_SEEDS.map((s) => s.id));
