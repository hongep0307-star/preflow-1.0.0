import type { VideoFormat } from "@/lib/conti";
import type { CharacterRefMode } from "@/components/assets/types";
import { KR, KR_BG } from "@/lib/brand";
import { parseProductionSpec, type ProductionSpec } from "@/lib/productionSpec";

export { KR, KR_BG };
export const KR_BG2 = "rgba(249,66,58,0.14)";
export const KR_BORDER = "rgba(249,66,58,0.28)";
export const KR_BORDER2 = "rgba(249,66,58,0.20)";
export const DIV_LINE = "1px solid var(--color-border-tertiary)";

export const FORMAT_MOOD_SLOT: Record<string, { width: number; aspectRatio: string }> = {
  vertical: { width: 88, aspectRatio: "9/16" },
  horizontal: { width: 176, aspectRatio: "16/9" },
  square: { width: 110, aspectRatio: "1/1" },
};

export const FORMAT_DEFAULT_COLS: Record<string, number> = { vertical: 5, horizontal: 4, square: 5 };

export const ACFG: Record<string, { color: string; bg: string; bd: string }> = {
  character: { color: "#6366f1", bg: "rgba(99,102,241,0.10)", bd: "rgba(99,102,241,0.22)" },
  item: { color: "#d97706", bg: "rgba(245,158,11,0.10)", bd: "rgba(245,158,11,0.22)" },
  background: { color: "#059669", bg: "rgba(16,185,129,0.10)", bd: "rgba(16,185,129,0.22)" },
};
export const ASSET_ICON: Record<string, string> = {
  character:
    "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75",
  item: "M16.5 9.4l-9-5.19M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z",
  background: "M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0zM12 13a3 3 0 100-6 3 3 0 000 6",
};

export type AssetType = "character" | "item" | "background";

export interface ChatImage {
  base64: string;
  mediaType: string;
  preview: string;
  /** (선택) 이 첨부가 라이브러리 레퍼런스에서 왔을 때, 그 레퍼런스의 AI 분석
   *  요약. 영상/GIF 는 정지 썸네일만으론 모션/샷 맥락을 전달 못 하므로 이 텍스트로
   *  보완한다. handleSend 가 LLM 페이로드에만 prepend(보이는 채팅/DB 에는 미저장). */
  caption?: string;
  /** (선택) 원본 자료가 영상/GIF 일 때 — 첨부는 정지 썸네일 1장이지만, 작성칸
   *  미리보기 좌상단에 "VIDEO"/"GIF" 뱃지를 띄워 원본 종류를 알려준다. */
  mediaKind?: "gif" | "video";
  /** (선택) 화면엔 안 보이지만 LLM 에는 함께 보내는 추가 프레임들(영상/GIF 의
   *  sampled_frames). 작성칸 미리보기엔 렌더하지 않고, handleSend 가 LLM image
   *  파트로만 확장한다. 스토리지/DB 에도 저장하지 않는 휘발성 컨텍스트. */
  extraFrames?: Array<{ base64: string; mediaType: string }>;
}

export type FocalPoint = { x: number; y: number; scale?: number };

export interface ChatLog {
  id?: string;
  project_id: string;
  role: "user" | "assistant";
  content: string;
  /** 첨부 이미지의 영속 URL(스토리지). 전송 시 업로드되어 chat_logs.images 에 저장,
   *  로드 후 미리보기를 복원하는 데 쓴다(휘발성 sessionImageMap 의 영속 버전). */
  images?: string[];
  created_at?: string;
}

export interface Scene {
  id: string;
  project_id: string;
  scene_number: number;
  /** 씬(sequence) 그룹 번호 — 같은 장소·시간·비트의 컷들을 묶는 1-based 정수.
   *  scene_number(=컷 번호)와 달리 여러 컷이 같은 값을 공유한다. */
  sequence?: number | null;
  title: string | null;
  description: string | null;
  camera_angle: string | null;
  location: string | null;
  mood: string | null;
  /** 컷의 감정 비트 / 드라마적 의도. 시트 패널 연출 지시로 쓰임. */
  emotional_beat?: string | null;
  duration_sec: number | null;
  tagged_assets: string[];
  conti_image_url: string | null;
  is_highlight?: boolean;
  highlight_kind?: "hook" | "hero" | "product" | "emotion" | "cta" | null;
  highlight_reason?: string | null;
  /** 모션 모드 전용 — 이 컷이 어떻게 들어오고/빠지는지(키네틱 핸드오프).
   *  description(정지 프레임 상태문)과 분리해 이미지 생성 프롬프트엔 넣지 않는다. */
  motion_in?: string | null;
  motion_out?: string | null;
  /** 다음 컷으로의 추천 트랜지션 기법 키(transitionGrammar의 TransitionKey) 또는 짧은 의도. */
  transition_to_next?: string | null;
}

export type BriefField = string[] | { summary: string; detail?: string; memo_link?: string | null };

// ─────────────────────────────────────────────────────────────
// Brief Analysis v2 — content-type branched schema
// (영상 전문가 관점의 실무 필드. 모든 필드 optional — 기존 브리프와 하위호환)
// ─────────────────────────────────────────────────────────────

export type ContentType = "product_launch" | "event" | "update" | "community" | "brand_film";

export type HookType =
  | "gameplay_first"
  | "fail_solve"
  | "power_fantasy"
  | "unboxing_reveal"
  | "before_after"
  | "mystery_tease"
  | "testimonial"
  | "pattern_interrupt";

export type VideoAspect = "9:16" | "16:9" | "1:1" | "4:5";
export type VideoDuration = "6s" | "15s" | "30s" | "45s" | "60s";
export type EditRhythm = "fast" | "medium" | "slow";
export type RevealTiming = "0-3s" | "3-5s" | "5-10s";
export type LogoPlacement = "first_frame" | "last_frame" | "persistent_corner";

export interface ProductInfo {
  what: string;
  key_benefit: string;
  urgency: {
    type: "time_limited" | "quantity_limited" | "exclusive" | "none";
    description: string;
  };
  cta_destination: string;
  cta_action: string;
}

export interface HeroVisual {
  must_show: string[];
  first_frame: string;
  brand_reveal_timing: "0-3s" | "3-5s";
  product_reveal_timing: RevealTiming;
  logo_placement: LogoPlacement;
}

export interface KeyVisualCriteria {
  definition: string;
  selection_rules: string[];
  visual_priorities: string[];
  avoid_patterns: string[];
  evidence: string[];
}

export interface HookStrategy {
  primary: HookType;
  alternatives: HookType[];
  first_3s_description: string;
  pattern_interrupt: boolean;
}

export interface Pacing {
  format: VideoAspect;
  duration: VideoDuration;
  /** Story-level sequence count: larger narrative blocks such as Hook / Body / CTA. */
  sequence_count?: {
    min: number;
    max: number;
    recommended: number;
  };
  /** Storyboard card count: one Shot/cut per image-generation card. */
  shot_count?: {
    min: number;
    max: number;
    recommended: number;
  };
  /** Legacy field name. Prefer shot_count for new analyses. */
  scene_count: {
    min: number;
    max: number;
    recommended: number;
  };
  edit_rhythm: EditRhythm;
  silent_viewable: boolean;
  captions_required: boolean;
}

export interface Constraints {
  brand_guidelines: string[];
  avoid: string[];
  platform_policies: string[];
}

export interface AudienceInsight {
  pain_point?: string;
  motivation?: string;
}

export interface ABCDScore {
  score: number;
  notes: string;
}
export interface ABCDCompliance {
  attract: ABCDScore;
  brand: ABCDScore;
  connect: ABCDScore;
  direct: ABCDScore;
  total?: number;
  /** 컷 간 연속성(장소 흐름·에셋 캐리오버·카메라 변주) 보조 점수.
   *  ABCD total 에는 합산하지 않는 독립 신호. 씬 2개 미만이면 undefined. */
  continuity?: ABCDScore;
}

export interface NarrativeAnalysis {
  controlling_idea: string;
  story_structure: "hero_journey" | "before_after" | "vignette" | "demonstration";
  protagonist: {
    identity: string;
    desire: string;
    transformation: string;
  };
  emotional_beats: Array<{
    timestamp: string;
    emotion: string;
    intensity: number;
  }>;
}

export interface Analysis {
  goal: BriefField;
  target: BriefField;
  usp: BriefField;
  tone_manner: BriefField;
  creative_gap?: { synergy?: string[]; gap?: string[]; recommendation?: string };
  idea_note?: string;
  image_analysis?: string;
  reference_mood?: string;
  /** GPT-5.x 가 영상 레퍼런스를 분석했을 때 채워지는 인사이트 배열. */
  reference_video_insights?: Array<{
    source: "youtube" | "upload";
    title?: string;
    hook_pattern?: string;
    pacing_per_scene?: Array<{ t: string; beat: string }>;
    visual_motifs?: string[];
    audio_cues?: string[];
    transferable_techniques?: string[];
    do_not_copy?: string[];
  }>;
  visual_direction?:
    | {
        camera?: string;
        lighting?: string;
        color_grade?: string;
        editing?: string;
      }
    | string;
  scene_flow?:
    | {
        structure?: string;
        hook?: { duration?: string; description?: string };
        body?: { duration?: string; description?: string };
        cta?: { duration?: string; description?: string };
      }
    | string;

  // ── v2 fields (all optional; classifier-driven) ──
  content_type?: ContentType;
  classification_confidence?: number;
  classification_reasoning?: string;
  secondary_type?: ContentType;

  product_info?: ProductInfo;
  hero_visual?: HeroVisual;
  key_visual_criteria?: KeyVisualCriteria;
  hook_strategy?: HookStrategy;
  pacing?: Pacing;
  constraints?: Constraints;
  audience_insight?: AudienceInsight;
  abcd_compliance?: ABCDCompliance;

  // brand_film 전용
  narrative?: NarrativeAnalysis;
}

export interface Asset {
  tag_name: string;
  photo_url: string | null;
  ai_description: string | null;
  asset_type?: AssetType;
  role_description?: string | null;
  outfit_description?: string | null;
  space_description?: string | null;
  /** 캐릭터/아이템 레퍼런스 모드(원본/시트/보드) — 멘션 프리뷰가 선택된 모드의
   *  이미지를 보여주기 위해 함께 로드한다(pickCharacterRefUrl). */
  character_ref_mode?: CharacterRefMode | null;
  character_sheet_url?: string | null;
  character_board_url?: string | null;
  use_character_sheet?: boolean | number | null;
}

export interface MoodImage {
  id: string;
  url: string | null;
  liked: boolean;
  sceneRef: number | null;
  comment: string;
  createdAt: string;
}

export type ParsedScene = {
  scene_number: number;
  /** 씬(sequence) 그룹 번호 — 같은 씬에 속한 컷들이 공유하는 1-based 정수. */
  sequence?: number;
  title?: string;
  description?: string;
  camera_angle?: string;
  location?: string;
  mood?: string;
  /** 컷의 감정 비트 / 드라마적 의도(예: 위압, 충격, 해방). 시트 패널 연출 지시로 쓰임. */
  emotional_beat?: string;
  duration_sec?: number;
  tagged_assets?: string[];
  is_highlight?: boolean;
  highlight_kind?: "hook" | "hero" | "product" | "emotion" | "cta" | null;
  highlight_reason?: string | null;
  /** 모션 모드 전용 키네틱 필드 (정지 프레임 description 과 분리). */
  motion_in?: string;
  motion_out?: string;
  transition_to_next?: string;
};

/** 연출 방향 모드 — 진입 시 선제안되고, 시놉시스/컷 기획 전체를 바꾼다. */
export type DirectionMode = "narrative" | "motion" | "hybrid";

/** 진입 시 방향 선제안 카드(Phase 0.5) 데이터. */
export type ParsedDirection = {
  options?: Array<{ mode: DirectionMode; title?: string; reason?: string }>;
  recommended?: DirectionMode;
  /** 사용자 자유 채팅 의도를 받아 에이전트가 확정한 모드(있으면 그 즉시 모드 세팅). */
  confirmed?: DirectionMode;
};

export type StorylineOption = { id: string; title: string; synopsis: string; mood?: string; reference_anchor?: string };

/** GPT-5.x 가 Phase 2 에서 각 Shot/Cut에 대해 제시하는 대안 변형. */
export type ParsedSceneAlt = {
  scene_number: number;
  variant: string;
  title?: string;
  description?: string;
  rationale?: string;
};

/** 씬들 출력 후 자체 채점 결과. */
export type ParsedSceneAudit = {
  abcd: { A?: number; B?: number; C?: number; D?: number };
  issues?: string[];
  suggested_fixes?: string[];
};

/** 레퍼런스 영상 분해 (Phase 0). storylines 보다 먼저 나온다. */
export type ParsedReferenceDecomposition = {
  hook?: string;
  scenes?: Array<{ t?: string; beat?: string; visual?: string; audio?: string }>;
  motifs?: string[];
  do_not_copy?: string[];
};

export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "scene"; data: ParsedScene | null }
  | { type: "strategy"; content: string }
  | { type: "storylines"; options: StorylineOption[] }
  | { type: "scene_alt"; data: ParsedSceneAlt | null }
  | { type: "scene_audit"; data: ParsedSceneAudit | null }
  | { type: "reference_decomposition"; data: ParsedReferenceDecomposition | null }
  | { type: "spec"; data: ProductionSpec | null }
  | { type: "direction"; data: ParsedDirection | null };

export type RightPanel = "scenes" | "mood";

// ── Utility functions ──

export const genMoodId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const toMoodImages = (raw: (string | MoodImage)[]): MoodImage[] => {
  // 1) 문자열 → MoodImage 정규화
  const normalized: MoodImage[] = raw.map((item) =>
    typeof item === "string"
      ? { id: genMoodId(), url: item, liked: false, sceneRef: null, comment: "", createdAt: new Date().toISOString() }
      : item,
  );
  // 2) URL 기반 dedup.
  //    과거 generateMoodImages 가 DB 에 raw URL 배열을 append 하면서
  //    persistMoodGenResultToDB 가 skel ID 객체를 prepend 하여 같은 URL 이
  //    중복 기록된 브리프들이 존재. 로드 시점에 첫 항목만 유지해 자동 치유.
  const seen = new Set<string>();
  const out: MoodImage[] = [];
  for (const img of normalized) {
    const key = img.url ?? `__null__${img.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(img);
  }
  return out;
};

export const briefFieldToString = (f: BriefField | undefined | null): string => {
  if (!f) return "";
  if (Array.isArray(f)) return f.join(", ");
  return f.summary ?? "";
};

export const cleanJsonString = (raw: string) =>
  raw
    .trim()
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");

export const formatTime = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
};

export const fileToBase64 = (file: File): Promise<ChatImage> =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      resolve({ base64: dataUrl.split(",")[1], mediaType: file.type, preview: dataUrl });
    };
    reader.readAsDataURL(file);
  });

/** 비전 API(Claude/OpenAI)가 받아들이는 이미지 MIME. 그 외(AVIF/octet-stream
 *  등)는 그대로 보내면 "Invalid MIME type" 으로 전송이 실패한다. */
const VISION_SAFE_CHAT_MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** 채팅 첨부 이미지를 비전 API 호환 포맷으로 정규화. 지원 MIME 이면 그대로,
 *  아니면 <img>+canvas 로 webp 재인코딩(다운스케일 포함). 디코드 실패 시 원본
 *  best-effort 반환. handleSend 가 LLM 전송 직전에 모든 첨부에 적용한다. */
export async function toVisionSafeChatImage(img: ChatImage): Promise<ChatImage> {
  const mt = (img.mediaType || "").toLowerCase();
  if (VISION_SAFE_CHAT_MEDIA.has(mt) || typeof document === "undefined") return img;
  try {
    const src = img.preview && img.preview.startsWith("data:")
      ? img.preview
      : `data:${img.mediaType || "image/png"};base64,${img.base64}`;
    const el = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("image decode failed"));
      i.src = src;
    });
    const w0 = el.naturalWidth || el.width;
    const h0 = el.naturalHeight || el.height;
    if (!w0 || !h0) return img;
    const maxEdge = 1280;
    const scale = Math.min(1, maxEdge / Math.max(w0, h0));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w0 * scale));
    canvas.height = Math.max(1, Math.round(h0 * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return img;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/webp", 0.85);
    const base64 = dataUrl.split(",")[1];
    if (!base64) return img;
    return { ...img, base64, mediaType: "image/webp", preview: dataUrl };
  } catch {
    return img;
  }
}

/* ━━━━━ 라이브러리 → 아이데이션 채팅 첨부 핸드오프 ━━━━━
 * 라이브러리에서 'Agent에 추가' 한 레퍼런스 이미지를 프로젝트의 아이데이션(Agent)
 * 탭 채팅 작성칸으로 옮기기 위한 1회성 큐. 브리프의 ff_brief_draft 핸드오프와
 * 같은 패턴(LS + 커스텀 이벤트). AgentTab 이 mount 시 drain 후 비운다. */
export const AGENT_CHAT_ATTACH_CHANGED_EVENT = "preflow:agent-chat-attach-changed";
const agentChatAttachKey = (projectId: string) => `ff_agent_chat_attach_${projectId}`;
/** 채팅 작성칸 최대 첨부 수(AgentTab.addImages 와 동일). */
export const CHAT_IMAGE_MAX = 4;

export const readAgentChatImages = (projectId: string): ChatImage[] => {
  try {
    const raw = localStorage.getItem(agentChatAttachKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatImage[]) : [];
  } catch {
    return [];
  }
};

export const clearAgentChatImages = (projectId: string): void => {
  try {
    localStorage.removeItem(agentChatAttachKey(projectId));
  } catch {
    /* ignore */
  }
};

export const appendAgentChatImages = (projectId: string, images: ChatImage[]): void => {
  if (!images.length) return;
  try {
    const next = [...readAgentChatImages(projectId), ...images].slice(0, CHAT_IMAGE_MAX);
    localStorage.setItem(agentChatAttachKey(projectId), JSON.stringify(next));
    window.dispatchEvent(
      new CustomEvent(AGENT_CHAT_ATTACH_CHANGED_EVENT, { detail: { projectId } }),
    );
  } catch {
    /* ignore (quota 등) */
  }
};

export const loadFocalMap = (projectId: string): Record<string, FocalPoint> => {
  try {
    const r = localStorage.getItem(`ff_focal_${projectId}`);
    return r ? JSON.parse(r) : {};
  } catch {
    return {};
  }
};

export const getFocalStyle = (asset: Asset, focalMap: Record<string, FocalPoint>): Record<string, string> | null => {
  if (!asset.photo_url) return null;
  const key = asset.tag_name.startsWith("@") ? asset.tag_name.slice(1) : asset.tag_name;
  const focal = focalMap[key] ?? focalMap[`@${key}`];
  if (!focal) return null;
  const scale = focal.scale ?? 1.4;
  return {
    backgroundImage: `url(${asset.photo_url})`,
    backgroundSize: `${scale * 100}%`,
    backgroundPosition: `${focal.x * 100}% ${focal.y * 100}%`,
    backgroundRepeat: "no-repeat",
  };
};



export const buildAssetMap = (assets: Asset[]) =>
  Object.fromEntries(
    assets.flatMap((a) => {
      const n = a.tag_name.startsWith("@") ? a.tag_name.slice(1) : a.tag_name;
      return [
        [n, a],
        [`@${n}`, a],
      ];
    }),
  ) as Record<string, Asset>;

/**
 * Resolve an `@tag` mention to the registered asset.
 *
 *  1. **Exact match** wins outright (case-sensitive, matches stored tag_name).
 *  2. **Prefix-match fallback** is intentionally narrow: it only fires when
 *     the overflow tail is **non-ASCII** (e.g. Korean particles `가/를/이/는`).
 *     This preserves the original UX of `@YD가` resolving to `@YD`, while
 *     refusing to swallow longer registered tags such as `@BG_medium`,
 *     `@BG2`, or `@BGwide` — those must hit step 1 with their full name.
 *
 *  Why the original prefix matcher was broken:
 *  the user could create `@BG_medium` from a background framing variation,
 *  type `@BG_medium` in a scene's location field, but if the renderer's
 *  `assets` list was momentarily stale (no `BG_medium` yet), the matcher
 *  would silently downgrade to `@BG`. That wrong tag would then be
 *  written into `scene.tagged_assets` and persist forever, so the conti
 *  pipeline never even saw `BG_medium` at generation time.
 */
export const resolveAsset = (raw: string, assets: Asset[]): { asset: Asset; name: string } | null => {
  const clean = raw.startsWith("@") ? raw.slice(1) : raw;
  // Step 1 — exact match (case-sensitive, preferred).
  for (const a of assets) {
    const n = a.tag_name.startsWith("@") ? a.tag_name.slice(1) : a.tag_name;
    if (n === clean) return { asset: a, name: n };
  }
  // Step 2 — case-insensitive exact match. Users routinely retype tags
  // with different casing (`@BG_Medium` vs the registered `@BG_medium`).
  // Without this the prefix fallback below would either reject (ASCII
  // tail) or silently match the shorter `BG`, which is what the user
  // saw as "BG_Medium 호출했는데 BG가 불러와짐".
  const cleanLc = clean.toLowerCase();
  for (const a of assets) {
    const n = a.tag_name.startsWith("@") ? a.tag_name.slice(1) : a.tag_name;
    if (n.toLowerCase() === cleanLc) return { asset: a, name: n };
  }
  // Step 3 — narrow prefix fallback, only for trailing non-ASCII (Korean
  // particles etc.). Sort longest-first so that nested registrations like
  // `YD` and `YDhyung` compete deterministically (longest-prefix wins).
  const sorted = [...assets].sort((a, b) => b.tag_name.length - a.tag_name.length);
  for (const a of sorted) {
    const n = a.tag_name.startsWith("@") ? a.tag_name.slice(1) : a.tag_name;
    if (!clean.startsWith(n) || clean.length === n.length) continue;
    const tail = clean.slice(n.length);
    // Reject ASCII alnum / underscore tails — those almost always mean
    // a different (longer) tag the user actually intended (`BG_medium`
    // vs `BG`, `YDhyung` vs `YD`). Allow Hangul or other non-ASCII.
    if (/^[A-Za-z0-9_]/.test(tail)) continue;
    return { asset: a, name: n };
  }
  return null;
};

function remapStorylineIds(options: any[], usedIds: Set<string>): { options: any[]; idMap: Record<string, string> } {
  if (!usedIds.size) return { options, idMap: {} };
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const allUsed = new Set([...usedIds]);
  const idMap: Record<string, string> = {};

  const remapped = options.map((o: any) => {
    const oldId = String(o.id).toUpperCase();
    if (allUsed.has(oldId)) {
      let newId = oldId;
      for (let i = 0; i < LETTERS.length; i++) {
        if (!allUsed.has(LETTERS[i])) { newId = LETTERS[i]; break; }
      }
      allUsed.add(newId);
      idMap[oldId] = newId;
      return { ...o, id: newId };
    }
    allUsed.add(oldId);
    return o;
  });
  return { options: remapped, idMap };
}

function applyIdMapToText(text: string, idMap: Record<string, string>): string {
  if (!Object.keys(idMap).length) return text;
  let result = text;
  for (const [from, to] of Object.entries(idMap)) {
    if (from !== to) result = result.replace(new RegExp(`(?<![a-zA-Z])${from}안`, "g"), `${to}안`);
  }
  return result;
}

export function parseMessageSegments(text: string, usedIds?: Set<string>): MessageSegment[] {
  const segments: MessageSegment[] = [];
  // ★ scene_alt 와 scene 의 매칭 우선순위 — `scene_alt` 가 더 길어 alternation 앞에 둔다.
  // ★ reference_decomposition 도 추가.
  const regex = /```(reference_decomposition|scene_audit|scene_alt|scene|strategy|storylines|direction|spec)\s*([\s\S]*?)```/g;
  let lastIndex = 0,
    match: RegExpExecArray | null;
  let idMap: Record<string, string> = {};

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) segments.push({ type: "text", content: applyIdMapToText(before, idMap) });
    }
    const bt = match[1] as
      | "scene"
      | "strategy"
      | "storylines"
      | "scene_alt"
      | "scene_audit"
      | "reference_decomposition"
      | "spec"
      | "direction";
    const bc = match[2].trim();
    if (bt === "spec") {
      segments.push({ type: "spec", data: parseProductionSpec(cleanJsonString(bc)) });
    } else if (bt === "direction") {
      try {
        segments.push({ type: "direction", data: JSON.parse(cleanJsonString(bc)) });
      } catch {
        segments.push({ type: "direction", data: null });
      }
    } else if (bt === "scene") {
      try {
        segments.push({ type: "scene", data: JSON.parse(cleanJsonString(bc)) });
      } catch {
        segments.push({ type: "scene", data: null });
      }
    } else if (bt === "storylines") {
      try {
        let parsed = JSON.parse(cleanJsonString(bc));
        if (usedIds && usedIds.size > 0 && Array.isArray(parsed)) {
          const result = remapStorylineIds(parsed, usedIds);
          parsed = result.options;
          idMap = { ...idMap, ...result.idMap };
        }
        segments.push({ type: "storylines", options: parsed });
      } catch {
        segments.push({ type: "text", content: bc });
      }
    } else if (bt === "scene_alt") {
      try {
        segments.push({ type: "scene_alt", data: JSON.parse(cleanJsonString(bc)) });
      } catch {
        segments.push({ type: "scene_alt", data: null });
      }
    } else if (bt === "scene_audit") {
      try {
        segments.push({ type: "scene_audit", data: JSON.parse(cleanJsonString(bc)) });
      } catch {
        segments.push({ type: "scene_audit", data: null });
      }
    } else if (bt === "reference_decomposition") {
      try {
        segments.push({ type: "reference_decomposition", data: JSON.parse(cleanJsonString(bc)) });
      } catch {
        segments.push({ type: "reference_decomposition", data: null });
      }
    } else {
      segments.push({ type: "strategy", content: bc });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const rem = text.slice(lastIndex).trim();
    if (rem) segments.push({ type: "text", content: applyIdMapToText(rem, idMap) });
  }
  return segments;
}

/**
 * Rewrites a raw assistant message so its storylines-block IDs and body "X안" mentions
 * match what the user actually sees after cumulative remapping.
 *
 * - `usedIds` is mutated: every ID that ends up visible (after possible remap) is added.
 * - Returns the rewritten raw text (with storylines blocks re-serialized using new IDs).
 *
 * Use this when building chat history sent to the LLM so its self-consistent reasoning
 * lines up with the IDs displayed in the UI (e.g. avoids "you proposed A,B,C only" when
 * the user is looking at D,E,F cards).
 */
export function remapMessageForHistory(text: string, usedIds: Set<string>): string {
  const regex = /```(scene|strategy|storylines)\s*([\s\S]*?)```/g;
  let result = "";
  let lastIndex = 0;
  let idMap: Record<string, string> = {};
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result += applyIdMapToText(text.slice(lastIndex, match.index), idMap);
    }
    const bt = match[1] as "scene" | "strategy" | "storylines";
    const bc = match[2].trim();
    if (bt === "storylines") {
      try {
        let parsed = JSON.parse(cleanJsonString(bc));
        if (Array.isArray(parsed)) {
          if (usedIds.size > 0) {
            const r = remapStorylineIds(parsed, usedIds);
            parsed = r.options;
            idMap = { ...idMap, ...r.idMap };
          }
          for (const opt of parsed) usedIds.add(String(opt.id).toUpperCase());
          result += "```storylines\n" + JSON.stringify(parsed) + "\n```";
        } else {
          result += match[0];
        }
      } catch {
        result += match[0];
      }
    } else {
      result += match[0];
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    result += applyIdMapToText(text.slice(lastIndex), idMap);
  }
  return result;
}

/**
 * 컷 카드 제목 전용 — `@태그` 의 선행 `@` 만 제거해 이름만 남긴다.
 * 제목 필드는 태그 뱃지 렌더가 없어 `@bag` 처럼 raw @ 가 그대로 노출되기 때문.
 * (description/location 등 뱃지로 렌더되는 필드에는 적용하지 않는다.)
 * 토큰 시작(문자열 머리 또는 공백 뒤)의 `@` 만 떼어 이메일 등 중간 `@` 는 보존하고,
 * 한글 조사("@bag이" → "bag이")는 자연스럽게 그대로 남긴다.
 */
const stripTitleMentionAt = (title: unknown): unknown =>
  typeof title === "string" ? title.replace(/(^|\s)@([\p{L}\p{N}_]+)/gu, "$1$2") : title;

export function extractScenesFromText(text: string): ParsedScene[] {
  const result: ParsedScene[] = [];
  // ★ `scene_alt` 와 충돌 방지: 정확히 ```scene\n 또는 ```scene\s 로 시작하되,
  //   ` `scene_` 같은 prefix 매칭은 [\s] 매칭으로 막는다.
  for (const m of [...text.matchAll(/```scene(?![a-z_])\s*([\s\S]*?)```/g)]) {
    try {
      const s = JSON.parse(cleanJsonString(m[1]));
      if (s.scene_number && typeof s.scene_number === "number") {
        // 제목에서만 @ 제거 (태그를 끌어다 써도 제목엔 @ 가 노출되지 않게).
        if (s.title != null) s.title = stripTitleMentionAt(s.title);
        result.push(s);
      }
    } catch {}
  }
  return result;
}

/**
 * Extract the single production-spec fence from an assistant message. The agent
 * emits at most one ```spec block per Phase-2 turn; if several appear (e.g. a
 * re-issued spec on cut restructuring) the LAST valid one wins. Returns null when
 * no usable spec parses, so callers leave any existing draft untouched.
 */
export function extractSpecFromText(text: string): ProductionSpec | null {
  let latest: ProductionSpec | null = null;
  for (const m of [...text.matchAll(/```spec(?![a-z_])\s*([\s\S]*?)```/g)]) {
    const parsed = parseProductionSpec(cleanJsonString(m[1]));
    if (parsed) latest = parsed;
  }
  return latest;
}

// ── Pending scenes persistence ──

export const _pendingScenesByProject = new Map<string, ParsedScene[]>();

/* ─────────────────────────────────────────────────────────────
 *  Mood Generation In-Flight 스토어 (배치 리스트)
 *
 *   — AgentTab/MoodIdeationPanel 이 언마운트(탭 이동)된 동안에도
 *     in-flight 콜백이 안전하게 상태를 갱신할 수 있도록 모듈 레벨에 보관.
 *
 *   — 한 프로젝트에서 여러 배치를 동시에 실행할 수 있도록
 *     `Map<pid, MoodGenState[]>` 로 들고 있고, 각 배치는 `batchId` 로 식별.
 *     이전에는 `Map<pid, MoodGenState>` 단일 슬롯이라 두 번째 generate 호출이
 *     첫 배치의 skeletonIds/arrivedUrls 를 덮어쓰는 한계가 있었음.
 *
 *   — DB persist (skeletonIds 1:1 매핑) 는 배치 단위로 호출되어야 함.
 * ───────────────────────────────────────────────────────────── */
export type MoodGenState = {
  /** 배치 식별자 — 한 프로젝트 안에서 unique. */
  batchId: string;
  count: number;
  skeletonIds: string[];
  arrivedUrls: string[];
  promise: Promise<void> | null;
};

/** Map<projectId, MoodGenState[]> — 배열 순서는 시작 시각(오래된→최신). */
export const _moodGeneratingByProject = new Map<string, MoodGenState[]>();
const _moodGenListeners = new Map<string, Set<() => void>>();

const notify = (pid: string) => _moodGenListeners.get(pid)?.forEach((fn) => fn());

/** 현재 진행중인 모든 배치를 시작 순서대로 반환 (없으면 빈 배열). */
export function getMoodGenBatches(pid: string): MoodGenState[] {
  return _moodGeneratingByProject.get(pid) ?? [];
}

/** in-flight 배치가 1개라도 있는지. UI 카운터/스피너 토글용. */
export function isAnyMoodGenInFlight(pid: string): boolean {
  return (_moodGeneratingByProject.get(pid)?.length ?? 0) > 0;
}

/** 배치 한 개를 추가. batchId 는 호출자가 미리 발급해서 넘긴다 (clean-up 시 같은 ID 사용). */
export function addMoodGenBatch(pid: string, state: MoodGenState) {
  const arr = _moodGeneratingByProject.get(pid) ?? [];
  arr.push(state);
  _moodGeneratingByProject.set(pid, arr);
  notify(pid);
}

/** 특정 배치만 부분 갱신. batchId 가 매칭 안 되면 no-op. */
export function patchMoodGenBatch(pid: string, batchId: string, patch: Partial<MoodGenState>) {
  const arr = _moodGeneratingByProject.get(pid);
  if (!arr) return;
  const idx = arr.findIndex((b) => b.batchId === batchId);
  if (idx < 0) return;
  arr[idx] = { ...arr[idx], ...patch };
  notify(pid);
}

/** 특정 배치를 제거. 배열이 비면 Map 엔트리도 지운다. */
export function removeMoodGenBatch(pid: string, batchId: string) {
  const arr = _moodGeneratingByProject.get(pid);
  if (!arr) return;
  const next = arr.filter((b) => b.batchId !== batchId);
  if (next.length === 0) _moodGeneratingByProject.delete(pid);
  else _moodGeneratingByProject.set(pid, next);
  notify(pid);
}

/** 변경 구독. 배치 추가/패치/제거 모두 동일 콜백을 깨운다. */
export function subscribeMoodGen(pid: string, fn: () => void) {
  if (!_moodGenListeners.has(pid)) _moodGenListeners.set(pid, new Set());
  _moodGenListeners.get(pid)!.add(fn);
  return () => {
    _moodGenListeners.get(pid)?.delete(fn);
  };
}

/** 배치 리스트에서 skeleton ID → 도착 URL 룩업. UI sync 에서 쓰는 헬퍼.
 *  찾지 못하면 null. */
export function lookupArrivedUrlForSkeleton(pid: string, skelId: string): string | null {
  const arr = _moodGeneratingByProject.get(pid);
  if (!arr) return null;
  for (const b of arr) {
    const i = b.skeletonIds.indexOf(skelId);
    if (i >= 0) return b.arrivedUrls[i] ?? null;
  }
  return null;
}

/** 진행중인 모든 배치의 skeleton ID 합집합. fetchBrief 등에서 placeholder 보존용. */
export function collectAllInFlightSkeletonIds(pid: string): Set<string> {
  const out = new Set<string>();
  for (const b of getMoodGenBatches(pid)) for (const id of b.skeletonIds) out.add(id);
  return out;
}

/* ─────────────────────────────────────────────────────────────
 *  Chat (Agent) In-Flight 스토어
 *   — AgentTab 이 언마운트 돼도 진행 중인 LLM 호출의 상태를 보관해
 *     탭 복귀 시 로딩 인디케이터 복원 및 완료 후 chat_logs 재조회를 트리거.
 * ───────────────────────────────────────────────────────────── */
export type ChatGenState = {
  /** 진행 중 여부 */
  inFlight: boolean;
  /** 시작 시각 */
  startedAt: number;
  /** 완료 후 draft 로 넘길 씬 — mount 복귀 시 반영 */
  pendingExtractedScenes?: ParsedScene[];
  /** pendingExtractedScenes 가 있을 때, 기존 확정 씬이 있으면 replace confirm 을 띄워야 함을 표시 */
  pendingExtractedNeedsReplaceConfirm?: boolean;
  /** pending draft 에 병합하지 않고 새 추출 목록으로 교체해야 함을 표시 */
  pendingExtractedReplaceDrafts?: boolean;
};

export const _chatGenByProject = new Map<string, ChatGenState>();
const _chatGenListeners = new Map<string, Set<() => void>>();

export function getChatGen(pid: string): ChatGenState | undefined {
  return _chatGenByProject.get(pid);
}
export function setChatGen(pid: string, next: ChatGenState | null) {
  if (next === null) _chatGenByProject.delete(pid);
  else _chatGenByProject.set(pid, next);
  _chatGenListeners.get(pid)?.forEach((fn) => fn());
}
export function patchChatGen(pid: string, patch: Partial<ChatGenState>) {
  const cur = _chatGenByProject.get(pid);
  if (!cur) return;
  _chatGenByProject.set(pid, { ...cur, ...patch });
  _chatGenListeners.get(pid)?.forEach((fn) => fn());
}
export function subscribeChatGen(pid: string, fn: () => void) {
  if (!_chatGenListeners.has(pid)) _chatGenListeners.set(pid, new Set());
  _chatGenListeners.get(pid)!.add(fn);
  return () => {
    _chatGenListeners.get(pid)?.delete(fn);
  };
}

export const LS_PENDING = (pid: string) => `ff_pending_scenes_${pid}`;

export const loadPendingFromLS = (pid: string): ParsedScene[] => {
  try {
    const r = localStorage.getItem(LS_PENDING(pid));
    return r ? JSON.parse(r) : [];
  } catch {
    return [];
  }
};

export const savePendingToLS = (pid: string, scenes: ParsedScene[]) => {
  try {
    if (scenes.length === 0) localStorage.removeItem(LS_PENDING(pid));
    else localStorage.setItem(LS_PENDING(pid), JSON.stringify(scenes));
  } catch {}
};
