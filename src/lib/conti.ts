import { supabase } from "./supabase";
import { deleteStoredFile } from "./storageUtils";
import type { HeroVisual, HookStrategy, ProductInfo, Constraints, KeyVisualCriteria } from "@/components/agent/agentTypes";
import { buildHookMoodAddendum } from "./hookLibrary";
import { pickCharacterRefUrl, effectiveRefMode } from "./characterSheetStore";
import { getImageModelDefault, getGptQualityDefault, type GptQuality } from "./imageGenPreference";

/* ━━━━━ 타입 ━━━━━ */
type AssetType = "character" | "item" | "background";

/**
 * Background framings are now independent sibling assets
 * (e.g. `@BG_wide`, `@BG_close`) rather than alternate views
 * stored on a parent asset. The conti pipeline therefore no
 * longer needs `photo_variations` here — each tag the user
 * @-mentions resolves directly to its own `photo_url`.
 */
interface Asset {
  tag_name: string;
  photo_url: string | null;
  ai_description: string | null;
  outfit_description: string | null;
  signature_items: string | null;
  space_description: string | null;
  asset_type: AssetType;
  /** Character-only multi-angle reference sheet generated from
   *  `photo_url` by NB2. When present, conti generation prefers it
   *  over the single portrait so the model has a turnaround anchor
   *  for face/hair/outfit consistency. Falls back to `photo_url`
   *  when null/undefined — existing projects without sheets render
   *  identically to before. */
  character_sheet_url?: string | null;
  /** Character-only AAA design-bible board, preserved independently of
   *  the sheet. Used when `character_ref_mode === "board"`. */
  character_board_url?: string | null;
  /** Which reference feeds conti: original / sheet / board. null/undefined
   *  → legacy: derived from `use_character_sheet`. */
  character_ref_mode?: "original" | "sheet" | "board" | null;
  /** Tri-state user toggle. `false` = ignore sheet, force photo_url
   *  fallback (UI off-switch in AssetDetailModal). null/undefined/true
   *  keep the sheet-preferred default. */
  use_character_sheet?: boolean | null;
}

interface SceneForConti {
  id: string;
  scene_number: number;
  title: string | null;
  description: string | null;
  camera_angle: string | null;
  location: string | null;
  mood: string | null;
  duration_sec?: number | null;
  tagged_assets: string[];
  is_transition?: boolean;
  is_final?: boolean;
  is_highlight?: boolean;
  highlight_kind?: "hook" | "hero" | "product" | "emotion" | "cta" | null;
  highlight_reason?: string | null;
}

export type VideoFormat = "vertical" | "horizontal" | "square";

type BriefField = string[] | { summary: string; detail?: string; memo_link?: string | null };

export interface BriefAnalysis {
  goal: BriefField;
  target: BriefField;
  usp: BriefField;
  tone_manner: BriefField;
  visual_direction?: string | { camera?: string; lighting?: string; color_grade?: string; editing?: string };

  // ── v2 fields (optional; injected into per-scene image prompt) ──
  hero_visual?: HeroVisual;
  key_visual_criteria?: KeyVisualCriteria;
  hook_strategy?: HookStrategy;
  product_info?: ProductInfo;
  constraints?: Constraints;
}

export type ContiModel = "gpt" | "nano-banana-2";

export type GeneratingStage = "queued" | "translating" | "building" | "generating" | "uploading";

/**
 * 한 사이클 (Generate All 한 번 또는 단일 Generate) 동안 같은 프로젝트의
 * `assets` 행을 여러 워커가 공유하기 위한 스냅샷.
 *
 * - `rows`     : `fetchTaggedAssets` 가 태그-필터링에 쓰는 풀 컬럼 행 집합
 * - `projectAssetTags` : `filterMustShowForScene` 의 must_show 자산명 매칭에
 *                       쓰는 lowercase 태그 리스트 (`@` 접두 제거).
 *
 * Supabase 의 같은 SELECT 결과에서 둘 다 파생되므로 한 번만 가져오면 4 워커
 * × N 씬 만큼 중복 round-trip 을 제거할 수 있다. 캐시 미전달 시 기존 경로
 * (호출마다 SELECT) 가 그대로 동작해 단일 씬 호출 호환을 유지한다.
 */
export interface ProjectAssetsCache {
  rows: Asset[];
  projectAssetTags: string[];
}

export interface ContiGenerateOptions {
  scene: SceneForConti;
  allScenes: SceneForConti[];
  projectId: string;
  videoFormat: VideoFormat;
  briefAnalysis?: BriefAnalysis | null;
  styleAnchor?: string;
  styleImageUrl?: string;
  model?: ContiModel;
  onStageChange?: (stage: GeneratingStage) => void;
  /**
   * Generate All 같은 다중-씬 사이클에서 한 번 만들어 모든 씬에 같은
   * 스냅샷을 공유시키기 위한 캐시. 단일 씬 경로에서는 omit (=fallback).
   */
  projectAssetsCache?: ProjectAssetsCache;
  /**
   * Phase 2.0: stable id used by the main-process in-flight dedup
   * (`electron/api-handlers.ts` `inflightOpenaiImageJobs`). When provided,
   * the openai-image call carries `__jobId` and a renderer that refreshes
   * mid-flight will re-attach to the same promise instead of firing a
   * second call. Caller is responsible for persisting this id to
   * localStorage BEFORE awaiting `generateConti`. Single-scene Generate /
   * Regenerate uses the `PendingContiSingleJob.id`; Generate All uses
   * `${generateJob.id}:${scene.id}` so per-scene dedup works inside the
   * batch. Omit on call sites where dedup isn't desired.
   */
  jobId?: string;
}

export interface StyleTransferOptions {
  // conti_image_crop 을 포함한 full Scene 객체를 허용 — 프리뷰 비율로 사전-크롭할 때 사용.
  scene: SceneForConti & { conti_image_url: string; conti_image_crop?: unknown };
  projectId: string;
  styleImageUrl: string;
  stylePrompt?: string;
  videoFormat: VideoFormat;
  /** Which generator to drive. Style Apply has its own Settings default
   *  (decoupled from the conti top-bar toggle). When omitted, falls back to
   *  the "style" feature default. NB2 = legacy NB2→GPT fallback chain. */
  model?: ContiModel;
  /** GPT quality (low|medium|high). Applies only when the chosen model is
   *  GPT. When omitted, resolved from the "style" feature Settings default. */
  quality?: GptQuality;
  onStageChange?: (stage: GeneratingStage) => void;
}

/* ━━━━━ 유틸 ━━━━━ */
const fieldToString = (field: BriefField | undefined | null): string => {
  if (!field) return "";
  if (Array.isArray(field)) return field.join(", ");
  return field.summary ?? "";
};

const fieldToArray = (field: BriefField | undefined | null): string[] => {
  if (!field) return [];
  if (Array.isArray(field)) return field;
  const parts: string[] = [];
  if (field.summary) parts.push(field.summary);
  if (field.detail) parts.push(field.detail);
  return parts;
};

export const sanitizeImagePrompt = (text: string, opts?: { weaponSafe?: boolean }): string => {
  // weaponSafe(게임/무기 캠페인): 무기 "명사"는 의미를 보존하는 게임-에셋 표현으로
  // 치환해 광고의 핵심(무기 외형)이 사라지지 않게 한다. 대체어는 스크럽 토큰
  // (무기/총기/weapon/gun)을 포함하지 않아 재-sanitize 시에도 중첩되지 않는다.
  // 폭력 "동사"(전투/폭발/kill 등)는 weaponSafe 여부와 무관하게 항상 "action"으로
  // 남겨 실사 폭력 가드를 유지한다.
  const weaponNoun = opts?.weaponSafe ? "stylized in-game firearm prop" : "action";
  return text
    .replace(/에스파|aespa|카리나|윈터|지젤|닝닝/gi, "K-pop artist")
    .replace(/블랙핑크|BTS|방탄소년단|뉴진스|아이브|르세라핌|엑소|빅뱅|세븐틴|스트레이키즈/gi, "K-pop group")
    .replace(/PUBG|배틀그라운드|PlayerUnknown/gi, "mobile game")
    .replace(/포트나이트|리그오브레전드|오버워치|발로란트|마인크래프트/gi, "popular game")
    .replace(/크래프톤|라이엇|블리자드|넥슨|넷마블/gi, "game company")
    // 폭력 동사 — 항상 중립화
    .replace(/배틀|전투|총격|격투|폭발|전쟁|킬|사살|공격|저격|폭탄/gi, "action")
    .replace(/battle|combat|gunfire|explosion|warfare|kill|attack|bomb/gi, "action")
    // 무기 명사 — weaponSafe면 의미 보존, 아니면 중립화
    .replace(/무기|총기/gi, weaponNoun)
    .replace(/weapon|gun/gi, weaponNoun)
    .replace(/삼성|갤럭시|애플|아이폰|나이키|아디다스|현대|기아|LG전자|SK텔레콤/gi, "brand")
    .replace(/\s{2,}/g, " ")
    .trim();
};

/** 게임/무기 컨셉 캠페인 자동 감지.
 *  태그 에셋 설명 또는 브리프 텍스트에 게임/무기 신호가 있으면 true.
 *  true면 sanitize/footer가 무기 표현을 게임-에셋 친화적으로 보존한다.
 *  (실사 폭력 가드는 유지되므로 false positive 의 부작용은 최소.) */
const GAME_WEAPON_RE =
  /게임|슈터|배틀그라운드|배그|소총|권총|저격|무기|총기|FPS|PUBG|weapon|gun|rifle|firearm|pistol|sniper|shooter/i;
export const isGameWeaponContext = (
  briefAnalysis: BriefAnalysis | null | undefined,
  assets: Asset[] | undefined,
): boolean => {
  if (
    assets?.some((a) =>
      GAME_WEAPON_RE.test(`${a.tag_name ?? ""} ${a.ai_description ?? ""} ${a.space_description ?? ""}`),
    )
  ) {
    return true;
  }
  if (briefAnalysis) {
    try {
      const briefText = JSON.stringify([
        briefAnalysis.goal,
        briefAnalysis.target,
        briefAnalysis.usp,
        briefAnalysis.tone_manner,
        briefAnalysis.visual_direction,
        briefAnalysis.product_info,
        briefAnalysis.key_visual_criteria,
        briefAnalysis.hero_visual,
      ]);
      if (GAME_WEAPON_RE.test(briefText)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
};

export const IMAGE_SIZE_MAP: Record<VideoFormat, string> = {
  vertical: "1024x1536",
  horizontal: "1536x1024",
  square: "1024x1024",
};

/* ━━━━━ 프리뷰 컨테이너 비율 (씬카드와 동일) ━━━━━
 * SortableContiCard.tsx 의 FORMAT_RATIO 와 1:1 일치해야 한다.
 * NB2 가 출력할 비율(9:16, 16:9, 1:1)과도 정확히 일치한다.
 */
export const FORMAT_RATIO: Record<VideoFormat, number> = {
  horizontal: 16 / 9,
  vertical: 9 / 16,
  square: 1,
};

/* ━━━━━ pre-crop 캔버스 출력 크기 ━━━━━
 * FORMAT_RATIO 와 정확히 동일한 비율의 픽셀 사이즈.
 * NB2 / GPT 의 size 인자(IMAGE_SIZE_MAP)와는 무관하다 — 어차피 NB2 는
 * source 이미지의 픽셀 크기는 무시하고 aspectRatio 인자만 본다.
 */
const FORMAT_OUTPUT_SIZE: Record<VideoFormat, { w: number; h: number }> = {
  horizontal: { w: 1536, h: 864 }, // 16:9
  vertical: { w: 864, h: 1536 }, // 9:16
  square: { w: 1024, h: 1024 }, // 1:1
};

const FORMAT_PROMPT_NOTE: Record<VideoFormat, string> = {
  vertical: "VERTICAL 9:16 portrait frame. Mobile fullscreen.",
  horizontal: "HORIZONTAL 16:9 landscape. Wide cinematic frame.",
  square: "SQUARE 1:1. Centered balanced composition.",
};

const DEFAULT_STYLE_ANCHOR = `VISUAL STYLE (apply consistently):
- High-end Korean commercial advertisement
- Cinematic lighting — soft, directional, no harsh flash
- Sony A7IV aesthetic, 35mm lens, f/2.0
- Teal-orange color grade
- Photorealistic, 8K quality
- No text, subtitles, or watermarks in image
- Safe for all audiences`;

const SHOT_ROTATION: Record<number, string> = {
  1: "EXTREME WIDE ESTABLISHING SHOT — full environment visible, character tiny in frame, massive sense of scale",
  2: "MEDIUM SHOT — waist-up, character off-center (rule of thirds), environment context visible",
  3: "CLOSE-UP — chest to head, face fills 60% of frame, shallow depth of field blurs background",
  4: "LOW ANGLE SHOT — camera placed below subject looking up, hero perspective, dramatic sky visible",
  5: "OVER-THE-SHOULDER or POV SHOT — camera behind/beside character, scene viewed from their perspective",
  6: "EXTREME CLOSE-UP — face only or single detail (hands, eyes, object), maximum emotion",
  7: "BIRD'S EYE / HIGH ANGLE — camera looks straight down or steep angle from above",
  8: "DUTCH ANGLE (tilted frame) — camera rotated 15-30 degrees, tension and unease",
};

const resolveShotType = (sceneNumber: number, totalScenes: number, cameraAngle: string | null): string => {
  if (cameraAngle && cameraAngle.trim().length > 3) {
    return `SHOT TYPE (MANDATORY): ${cameraAngle.trim()}
    — Strictly compose this frame as described. Do NOT default to a standard front-facing portrait.`;
  }
  if (sceneNumber === 1) {
    return `SHOT TYPE (MANDATORY): EXTREME WIDE ESTABLISHING SHOT
    — Show full environment, character small in frame. Set the world.`;
  }
  if (sceneNumber === totalScenes) {
    return `SHOT TYPE (MANDATORY): MEDIUM CLOSE-UP facing camera
    — Final emotional beat. Character centered, direct eye contact with viewer.`;
  }
  const idx = ((sceneNumber - 2) % (Object.keys(SHOT_ROTATION).length - 2)) + 2;
  return `SHOT TYPE (MANDATORY): ${SHOT_ROTATION[idx] ?? SHOT_ROTATION[2]}
  — This is scene ${sceneNumber} of ${totalScenes}. Vary the composition from adjacent scenes.`;
};

/* ━━━━━ 씬 빈약도 판정 ━━━━━ */
const isSparseScene = (scene: SceneForConti): boolean => {
  const filledFields = [scene.description, scene.camera_angle, scene.mood, scene.location].filter(
    (v) => v && v.trim().length > 2,
  ).length;
  return filledFields <= 1;
};

const describeFinalCut = (label: string, scene: SceneForConti): string => {
  const parts = [
    `${label} S${scene.scene_number}`,
    scene.title ? `"${scene.title}"` : null,
    scene.camera_angle ? `camera: ${sanitizeImagePrompt(scene.camera_angle)}` : null,
    scene.mood ? `mood: ${sanitizeImagePrompt(scene.mood)}` : null,
  ].filter(Boolean);
  return `- ${parts.join(" | ")}`;
};

const buildCompletedCutDiversityNote = (
  allScenes: SceneForConti[],
  sceneIndex: number,
): string => {
  if (sceneIndex < 0) return "";

  const findFinal = (dir: -1 | 1) => {
    for (let i = sceneIndex + dir; i >= 0 && i < allScenes.length; i += dir) {
      const candidate = allScenes[i];
      if (candidate.is_transition) continue;
      if (candidate.is_final) return candidate;
      // Only adjacent completed cuts matter; stop at the first editable real scene.
      if (!candidate.is_transition) return null;
    }
    return null;
  };

  const prevFinal = findFinal(-1);
  const nextFinal = findFinal(1);
  const refs = [
    prevFinal ? describeFinalCut("Previous completed cut", prevFinal) : null,
    nextFinal ? describeFinalCut("Next completed cut", nextFinal) : null,
  ].filter(Boolean);

  if (!refs.length) return "";
  return `\n═══ COMPOSITION CONTINUITY NOTE (SOFT) ═══
Completed neighboring cuts are treated as camera-fixed reference points:
${refs.join("\n")}
→ Keep story continuity, but avoid repeating the same shot size, camera angle, movement, and subject placement.
→ Prefer a complementary composition that creates visual rhythm between these locked cuts.
═══════════════════════════════════════════`;
};

/**
 * highlight_kind 별 구체적 시각 레시피.
 *
 * 모델이 "hero" 같은 단어 하나로 hero shot 의 시각 언어(low-angle, rim light,
 * 영웅적 실루엣) 를 알아서 풀어내길 기대하는 건 너무 낙관적이다. 각 kind 가
 * 실제 영상문법으로 무엇인지 직접 가르쳐 주기 위해 이 사전을 쓴다.
 *
 * 의도: highlight 컷이 "옆 컷이랑 어떻게든 다른 평범한 변주" 가 아니라 정말
 * 이 씬을 대표할 수 있는 iconic 한 한 컷이 되게끔 모델에 강한 시각 anchor 를 박는다.
 */
type HighlightKind = NonNullable<SceneForConti["highlight_kind"]>;

const HIGHLIGHT_KIND_RECIPE: Record<HighlightKind, string> = {
  hook: `Punchy attention-grabbing first-frame energy: bold foreground element, anticipatory tension or implied motion, high-contrast lighting that reads in under one second on a thumb-scrolling feed. Negative space biased to one side so a viewer's eye locks immediately.`,
  hero: `Hero shot conventions: low-angle camera looking up at the subject, dramatic backlight or hard rim light separating subject from background, slightly wider lens for grandeur, subject placed on a strong vertical line of thirds. Aim for poster-frame iconography.`,
  product: `Glamour / beauty shot treatment: three-point or specular hero lighting, shallow depth of field with the product (or hero object) crisply in focus, immaculate negative space, reflective highlights and material rendering on the product surface. Absolutely no clutter.`,
  emotion: `Intimate close-up or extreme close-up: 85mm-equivalent compression, very shallow depth of field (f/1.4 feel), soft directional key light shaping the face, expression-first composition with eyes on the upper third. Background falls away as creamy bokeh.`,
  cta: `Forward-leaning energy directed at the viewer: subject moving toward camera or a strong directional cue (gaze, gesture, or light trail) pointing to where the action begins. Bright, unambiguous focal point with breathing room around the action target so a CTA overlay can land cleanly later.`,
};

const buildHighlightBlock = (
  scene: SceneForConti,
  weaponSafe = false,
): string => {
  if (!scene.is_highlight) return "";
  const sani = (t: string) => sanitizeImagePrompt(t, { weaponSafe });
  const kind = scene.highlight_kind ? `\nHighlight type: ${scene.highlight_kind}` : "";
  const reason = scene.highlight_reason ? `\nReason: ${sani(scene.highlight_reason)}` : "";
  const recipe = scene.highlight_kind
    ? `\nVisual recipe for "${scene.highlight_kind}" highlight:\n${HIGHLIGHT_KIND_RECIPE[scene.highlight_kind]}`
    : "";
  // 다중 인물 컷이 "정면으로 나란히 선 평면적 라인업" 으로 도망가는 걸 막는다.
  // 브리프 내용이 아닌 순수 공간 결정(주피사체 1명·시선/액션 라인·깊이 plane)만
  // 못 박고, 인원수 판정은 모델이 컷 구성을 보고 스스로 하게 둔다(1~2인이면 무시).
  const multiSubjectRule = `
If 3 or more people appear in the frame, you decide and commit to a clear staging:
- Pick ONE primary subject; all others are subordinate (smaller in frame, lower contrast, or pushed to mid/background).
- Direct every secondary subject's gaze, body, weapon, or gesture (line of action) toward the primary subject or the dramatic target — never a flat row of people facing the camera side-by-side.
- Stage people across distinct depth planes (foreground / midground / background) using overlap and scale difference; do not place them on one parallel line.
- Choose a camera height and lens that fuse the group into one readable silhouette, not a lineup.
If only 1–2 people appear, ignore this rule and follow the recipe above.`;
  return `\n═══ KEY VISUAL / HIGHLIGHT EMPHASIS (HIGH PRIORITY) ═══${kind}${reason}${recipe}
This scene IS the key visual of the spot — the one frame that would survive as a poster, thumbnail, or ad still.
Treat this directive with the same priority as the SHOT TYPE rule above; resolve conflicts by serving the iconic key-visual reading first, then the rotation rule.
- Build clear subject hierarchy: one unmistakable focal point, supporting elements clearly subordinate.
- Use strong silhouette or lighting separation between subject and background; intentional foreground / midground / background depth.
- Emotionally or commercially memorable — striking but still faithful to the scene's action and cast.
- Do NOT default to a safe centered close-up unless the recipe above explicitly calls for it; choose the composition that best serves this specific beat.
${multiSubjectRule}
═══════════════════════════════════════════`;
};

/* ━━━━━ 프리뷰 비율로 source 이미지 자르기 ━━━━━
 * 씬카드의 AdjustImageModal.captureAsImage 와 동일한 cover-render 알고리즘.
 * conti_image_crop 의 x/y/scale/rotate/ia 를 그대로 적용해, 사용자가 보고 있는
 * 프리뷰의 visible region 만 잘라서 PNG Blob 으로 반환한다.
 *
 * 결과 이미지 비율 = FORMAT_RATIO[videoFormat] = NB2 출력 비율 → 스타일 변환 후
 * 결과 이미지가 프리뷰 컨테이너에 정확히 들어맞아 더 이상 찌그러짐이 없다.
 */
type PreflightCrop = {
  x?: number;
  y?: number;
  scale?: number;
  rotate?: number;
  ia?: number;
};

const loadHTMLImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });

/** SortableContiCard.tsx 의 getCropForFmt 와 동일 로직.
 *  CropMap({horizontal, vertical, square}) 또는 단일 CropState 모두 지원. */
const getCropForFmtFromStored = (stored: unknown, fmt: VideoFormat): PreflightCrop | null => {
  if (!stored || typeof stored !== "object") return null;
  const obj = stored as Record<string, any>;
  if ("horizontal" in obj || "vertical" in obj || "square" in obj) {
    const c = obj[fmt];
    if (c && c._v === 2) return c as PreflightCrop;
    return null;
  }
  const s = obj as any;
  if (s._v === 2 && (!s.fmt || s.fmt === fmt)) return s as PreflightCrop;
  return null;
};

const cropImageForFormat = async (
  imageUrl: string,
  storedCrop: PreflightCrop | null,
  videoFormat: VideoFormat,
): Promise<Blob> => {
  const img = await loadHTMLImage(imageUrl);
  const { w: cW, h: cH } = FORMAT_OUTPUT_SIZE[videoFormat];

  const canvas = document.createElement("canvas");
  canvas.width = cW;
  canvas.height = cH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cW, cH);

  // crop 인자 — 없으면 정중앙 cover (x=0, y=0, scale=0.8 → 렌더 scale 1.0)
  const x = storedCrop?.x ?? 0;
  const y = storedCrop?.y ?? 0;
  const baseScale = typeof storedCrop?.scale === "number" ? storedCrop.scale : 0.8;
  const s = Math.max(0.1, baseScale) + 0.2;
  const rad = ((storedCrop?.rotate ?? 0) * Math.PI) / 180;

  // 항상 현재 이미지의 실제 자연 비율 사용 — 저장된 ia 값이 stale 인 경우(이전 NB2 변환 등)도 안전.
  const ia = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : (storedCrop?.ia ?? cW / cH);

  // 컨테이너에 cover-fit 시 이미지의 렌더 픽셀 크기.
  const cAspect = cW / cH;
  let covW: number, covH: number;
  if (ia >= cAspect) {
    covH = cH;
    covW = cH * ia;
  } else {
    covW = cW;
    covH = cW / ia;
  }

  ctx.save();
  ctx.translate(cW / 2 + (x / 100) * cW, cH / 2 + (y / 100) * cH);
  ctx.scale(s, s);
  ctx.rotate(rad);
  ctx.drawImage(img, -covW / 2, -covH / 2, covW, covH);
  ctx.restore();

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/png",
    );
  });
};

const uploadPreflightSource = async (
  blob: Blob,
  projectId: string,
  sceneNumber: number,
  label: string = "styletx-src",
): Promise<string> => {
  const path = `${projectId}/scene_${sceneNumber}_${label}_${Date.now()}.png`;
  const { error } = await supabase.storage.from("contis").upload(path, blob, {
    contentType: "image/png",
    upsert: true,
  });
  if (error) throw new Error(`Pre-crop upload failed: ${error.message}`);
  return supabase.storage.from("contis").getPublicUrl(path).data.publicUrl;
};

/* ━━━━━ 외부에서 재사용하는 preflight 래퍼 ━━━━━
 * 씬 이미지를 프리뷰(= FORMAT_RATIO) 비율로 잘라 blob + publicUrl 로 돌려준다.
 * style transfer, inpaint 등 "프리뷰에 보이는 영역만 원본으로 쓰고 싶은" 모든
 * 파이프라인에서 동일하게 쓸 수 있다.
 */
export const preflightCropToFormat = async (
  imageUrl: string,
  storedCrop: unknown,
  videoFormat: VideoFormat,
  projectId: string,
  sceneNumber: number,
  label: string = "preflight-src",
): Promise<{ blob: Blob; publicUrl: string }> => {
  const crop = getCropForFmtFromStored(storedCrop, videoFormat);
  const blob = await cropImageForFormat(imageUrl, crop, videoFormat);
  const publicUrl = await uploadPreflightSource(blob, projectId, sceneNumber, label);
  return { blob, publicUrl };
};

/* ━━━━━ 한→영 번역 — @태그 보호 ━━━━━ */
const translateSceneToEnglish = async (scene: SceneForConti): Promise<SceneForConti> => {
  const koreanCharCount = (scene.description ?? "").match(/[ㄱ-힣]/g)?.length ?? 0;
  if (koreanCharCount < 30) return scene;
  try {
    const tagMap: Record<string, string> = {};
    let tagIdx = 0;
    const protectTags = (text: string) =>
      text.replace(/@([\w가-힣-]+)/g, (match) => {
        const key = `__TAG${tagIdx++}__`;
        tagMap[key] = match;
        return key;
      });
    const restoreTags = (text: string) => Object.entries(tagMap).reduce((t, [k, v]) => t.replace(k, v), text);

    const protected_desc = protectTags(scene.description ?? "");
    const protected_loc = protectTags(scene.location ?? "");

    const { data, error } = await supabase.functions.invoke("claude-proxy", {
      body: {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: `You are a translator for video production storyboards.
Translate the given Korean scene descriptions into concise, vivid English suitable for AI image generation.
Use cinematographic language. Be specific about visuals.
Preserve ALL placeholders like __TAG0__, __TAG1__ exactly as-is — do NOT translate them.
Return ONLY a raw JSON object with the same keys. No explanation, no markdown, no code fences.`,
        messages: [
          {
            role: "user",
            content: `Translate to English:\n${JSON.stringify(
              {
                title: scene.title ?? "",
                description: protected_desc,
                camera_angle: scene.camera_angle ?? "",
                location: protected_loc,
                mood: scene.mood ?? "",
              },
              null,
              2,
            )}`,
          },
        ],
      },
    });
    if (error || !data) return scene;
    const text = data.content?.[0]?.text ?? "";
    const clean = text.replace(/```json|```/g, "").trim();
    const translated = JSON.parse(clean);
    return {
      ...scene,
      title: translated.title || scene.title,
      description: restoreTags(translated.description || scene.description || ""),
      camera_angle: translated.camera_angle || scene.camera_angle,
      location: restoreTags(translated.location || scene.location || ""),
      mood: translated.mood || scene.mood,
    };
  } catch (err) {
    // Phase 1.6: 사용자에겐 보이지 않지만 (씬 원본을 그대로 반환해 generate 가
    // 계속 진행됨), "왜 이 씬만 영문 번역이 누락됐지?" 류의 추적이 들어왔을 때
    // 유일한 단서. 동작 / 분기 / 반환값은 동일.
    console.warn("[generateConti] translateSceneToEnglish failed", {
      sceneNumber: scene.scene_number,
      err,
    });
    return scene;
  }
};

/* ━━━━━ 씬 설명 → 시각적 연출 해석 ━━━━━ */
const enrichSceneDescription = async (
  scene: SceneForConti,
  briefAnalysis?: BriefAnalysis | null,
  weaponSafe = false,
): Promise<{ enrichedContext: string }> => {
  const sparse = isSparseScene(scene);
  // 설명이 충분히 구체적인(비스파스) 컷은 자동 보정을 생략한다. 비스파스 컷에서
  // enrichment 가 "배경을 보케로 녹여라" 같은 임의 연출을 추가해 장소가 묻히거나
  // 컷 본연의 내용이 흐려지던 문제를 차단한다. 키비주얼 방향은 buildHighlightBlock
  // 이 별도로 주입하므로 하이라이트 컷도 손실 없다.
  if (!sparse) return { enrichedContext: "" };
  const hasMinContent =
    (scene.description?.trim().length ?? 0) >= 10 ||
    (scene.mood?.trim().length ?? 0) > 2 ||
    (scene.location?.trim().length ?? 0) > 2;

  if (!hasMinContent && !briefAnalysis) return { enrichedContext: "" };

  // highlight 인 경우 cinematographer 에게도 그 사실과 kind 별 시각 레시피를
  // 흘려준다. 이 단계가 "VISUAL DIRECTION" 으로 들어가 가장 창의적인 채널이라,
  // 여기서부터 hero/emotion/product 방향을 잡아주면 후속 prompt assembly 와
  // 같은 방향으로 정렬돼 highlight 컷의 분산이 줄어든다.
  const highlightHint =
    scene.is_highlight && scene.highlight_kind
      ? `\n\nThis scene is a KEY VISUAL HIGHLIGHT (kind: ${scene.highlight_kind}). Bias the composition toward an iconic, poster-grade frame for this kind:
${HIGHLIGHT_KIND_RECIPE[scene.highlight_kind]}${
          scene.highlight_reason ? `\nIntent: ${sanitizeImagePrompt(scene.highlight_reason, { weaponSafe })}` : ""
        }`
      : scene.is_highlight
        ? `\n\nThis scene is a KEY VISUAL HIGHLIGHT. Bias the composition toward an iconic, poster-grade frame: clear subject hierarchy, strong silhouette or lighting separation, intentional fg/mg/bg depth.${
            scene.highlight_reason ? `\nIntent: ${sanitizeImagePrompt(scene.highlight_reason, { weaponSafe })}` : ""
          }`
        : "";

  try {
    const userContent =
      sparse && briefAnalysis
        ? `This scene has minimal description. Use the campaign context to infer the visual direction.

Campaign goal: ${fieldToString(briefAnalysis.goal)}
Target audience: ${fieldToString(briefAnalysis.target)}
Key message: ${fieldToString(briefAnalysis.usp)}
Visual tone: ${fieldToString(briefAnalysis.tone_manner)}

Scene (partial): "${scene.description ?? ""}"
Location: "${scene.location ?? ""}"
Mood: "${scene.mood ?? ""}"${highlightHint}

Based on the campaign context above, translate into visual composition directives:`
        : `Scene: "${scene.description}"\nLocation: "${scene.location ?? ""}"\nMood: "${scene.mood ?? ""}"${highlightHint}\n\nTranslate into visual composition directives:`;

    const { data, error } = await supabase.functions.invoke("claude-proxy", {
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 200,
        system: `You are a cinematographer translating scene descriptions into precise visual composition directives for AI image generation.

Given a scene description, mood, and location, output a SHORT visual interpretation (3-5 sentences max) that covers:
1. FRAMING: How should the subject be positioned in frame? (rule of thirds, centered, foreground/background ratio, negative space)
2. LIGHTING: What does this mood translate to visually? (key light direction, color temperature, contrast, shadow quality)
3. ATMOSPHERE: Environmental details that reinforce the emotional tone (depth of field, background clarity, particles, weather)

If the user marks the scene as a KEY VISUAL HIGHLIGHT, your directives MUST reflect that hero/iconic framing — favor poster-grade compositions over safe averages, and let the highlight kind's recipe guide framing/lighting choices.

Do NOT describe what characters look like or their outfits.
Do NOT restate the original scene description.
Do NOT introduce new characters, props, objects, brand names, text, or signage that are not already present in the given scene description — stick strictly to atmospheric and compositional directives.
Keep the tagged location recognizable: do NOT dissolve, melt, or fully blur the background into abstract energy or pure bokeh unless the scene explicitly asks for it — the setting should still read as the same physical place.
Output ONLY the visual directives as a short paragraph. No labels, no bullet points, no explanation.`,
        messages: [
          {
            role: "user",
            content: userContent,
          },
        ],
      },
    });
    if (error || !data) return { enrichedContext: "" };
    const enriched = data.content?.[0]?.text?.trim() ?? "";
    return { enrichedContext: enriched };
  } catch (err) {
    // Phase 1.6: 빈 문자열 폴백은 그대로 (generate 가 계속 진행). 사용자
    // 보이는 변화 없음. 향후 "어떤 씬이 enrichedContext 없이 생성됐지?" 추적
    // 시 유일한 단서.
    console.warn("[generateConti] enrichSceneDescription failed", {
      sceneNumber: scene.scene_number,
      err,
    });
    return { enrichedContext: "" };
  }
};

/* ━━━━━ 에셋 섹션 빌더 ━━━━━ */
const buildAssetSections = (assets: Asset[], hasImageUrls: boolean, weaponSafe = false): string => {
  const sani = (t: string) => sanitizeImagePrompt(t, { weaponSafe });
  const characters = assets.filter((a) => (a.asset_type ?? "character") === "character");
  const items = assets.filter((a) => a.asset_type === "item");
  const backgrounds = assets.filter((a) => a.asset_type === "background");
  const sections: string[] = [];

  if (characters.length > 0) {
    const lines = characters.map((a) => {
      // When a character-sheet has been generated, the reference URL
      // pushed by buildAssetImageUrls is the multi-panel sheet — NOT
      // the original portrait. The model must be told to read identity
      // off the sheet without copying the sheet's neutral-bg multi-
      // panel COMPOSITION into the actual scene frame, otherwise we
      // get a 6-cell turnaround in the storyboard. This guard mirrors
      // the ChangeAngle Phase 1.x lesson on negating renderable
      // meta-visual constructs.
      // The sheet is only "active" when the user hasn't explicitly
      // toggled it off — keep this in sync with `buildAssetImageUrls`
      // so prompt text and image refs agree on whether the sheet is
      // present. `isCharacterSheetActive` handles the SQLite tri-state
      // (NULL / 0 / 1 mixed with renderer booleans).
      // "generated" = conti is feeding the sheet OR board (multi-panel
      // reference) rather than the plain portrait. Both need the same
      // "don't reproduce the panel layout" guard.
      const usingGenerated = effectiveRefMode(a) !== "original" && !!pickCharacterRefUrl(a);
      const refLine =
        a.photo_url && hasImageUrls
          ? usingGenerated
            ? " [REFERENCE SHEET PROVIDED] Use it ONLY to preserve facial identity, hairstyle, outfit, and body proportions across angles. The sheet shows multiple panels on a neutral background — do NOT reproduce the multi-panel layout, neutral background, panel borders, or any caption/label from the sheet. Pose, expression, gaze, head tilt, and body orientation MUST follow THIS scene's ACTION."
            : " [REFERENCE IMAGE PROVIDED] Preserve ONLY the facial identity — face shape, skin tone, hair color and style. Pose, expression, gaze, head tilt, and body orientation MUST follow THIS scene's ACTION — do NOT copy pose or expression from the reference photo."
          : a.photo_url
            ? " [Reference photo provided — match facial identity; pose/expression per scene action]"
            : a.ai_description
              ? ` ${sani(a.ai_description)}`
              : "";
      const rows = [
        `• ${a.tag_name}:${refLine}`,
        a.outfit_description
          ? `  OUTFIT: ${sani(a.outfit_description)}`
          : "",
        a.ai_description && a.photo_url && hasImageUrls
          ? `  Appearance notes: ${sani(a.ai_description)}`
          : "",
      ].filter(Boolean);
      return rows.join("\n");
    });
    sections.push(
      `[CHARACTERS — IDENTITY CONSISTENCY]\nThe following characters appear in this scene. Preserve their facial identity; stage their pose and expression fresh per this scene's ACTION.\n` +
        lines.join("\n"),
    );
  }

  if (items.length > 0) {
    const lines = items.map((a) => {
      const desc = a.ai_description ? sani(a.ai_description) : "as described by tag name";
      // Same generated-reference guard as characters: when conti feeds a
      // sheet/board (multi-panel, neutral-bg) rather than the plain photo,
      // tell the model to read design identity off it WITHOUT reproducing
      // the panel layout / background into the scene frame.
      const usingGenerated = effectiveRefMode(a) !== "original" && !!pickCharacterRefUrl(a);
      const refLine =
        a.photo_url && hasImageUrls
          ? usingGenerated
            ? " [REFERENCE SHEET PROVIDED] Use it ONLY to preserve the item's design, silhouette, materials, graphic elements, and colors. The sheet shows multiple panels on a neutral background — do NOT reproduce the multi-panel layout, neutral background, panel borders, or any caption/label from the sheet."
            : " [Reference image provided — match the item's design precisely]"
          : "";
      return (
        `• ${a.tag_name}: ${desc}\n` +
        `  → THIS ITEM MUST BE VISIBLY PRESENT AND CLEARLY RECOGNIZABLE IN THE FRAME.` +
        refLine
      );
    });
    sections.push(`[PROPS — MUST BE VISIBLE AND IDENTIFIABLE]\n${lines.join("\n")}`);
  }

  if (backgrounds.length > 0) {
    const lines = backgrounds.map((a) => {
      const desc = a.space_description ? sani(a.space_description) : "as described by tag name";
      // When conti feeds a generated environment board (multi-panel, white
      // documentation layout) rather than the plain location plate, tell the
      // model to read the environment design off it WITHOUT reproducing the
      // board's panel layout / white background into the scene frame.
      const usingGenerated = effectiveRefMode(a) !== "original" && !!pickCharacterRefUrl(a);
      const refLine =
        a.photo_url && hasImageUrls
          ? usingGenerated
            ? "\n  → [ENVIRONMENT BOARD PROVIDED] Use it ONLY to preserve the location's architecture, materials, color palette, and atmosphere. The board shows multiple panels on a white background — do NOT reproduce the multi-panel layout, white background, panel borders, or any caption/label. Frame the shot freshly per SHOT TYPE above."
            : "\n  → [Reference image provided] Match the location's architectural features, materials, and color palette. Frame the shot freshly per SHOT TYPE above — do NOT reproduce the reference's camera angle or composition."
          : "\n  → Recreate this location with consistency across all scenes.";
      return `• ${a.tag_name}: ${desc}${refLine}`;
    });
    sections.push(
      `[BACKGROUND / LOCATION — MAINTAIN SPATIAL CONSISTENCY]\n` +
        lines.join("\n") +
        `\n— Every scene sharing this location must look like the same physical space, but framing/camera angle is set by this scene's SHOT TYPE.`,
    );
  }

  return sections.join("\n\n");
};

const formatVisualDir = (vd: BriefAnalysis["visual_direction"]): string => {
  if (!vd) return "";
  if (typeof vd === "string") return vd;
  return [
    vd.camera ? `Camera: ${vd.camera}` : "",
    vd.lighting ? `Lighting: ${vd.lighting}` : "",
    vd.color_grade ? `Color: ${vd.color_grade}` : "",
    vd.editing ? `Editing: ${vd.editing}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
};

/* ━━━━━ 최종 프롬프트 조립 ━━━━━ */
const buildContiPrompt = (
  scene: SceneForConti,
  allScenes: SceneForConti[],
  assetSection: string,
  enrichedContext: string,
  videoFormat: VideoFormat,
  briefAnalysis?: BriefAnalysis | null,
  styleAnchor: string = DEFAULT_STYLE_ANCHOR,
  weaponSafe: boolean = false,
): string => {
  const sani = (t: string) => sanitizeImagePrompt(t, { weaponSafe });
  const totalScenes = allScenes.length;
  const sceneIndex = allScenes.findIndex((s) => s.scene_number === scene.scene_number);
  const prevScene = sceneIndex > 0 ? allScenes[sceneIndex - 1] : null;
  const nextScene = sceneIndex < totalScenes - 1 ? allScenes[sceneIndex + 1] : null;

  const isFirstScene = scene.scene_number === 1;
  const isLastScene = scene.scene_number === totalScenes && totalScenes > 1;

  const shotDirective = resolveShotType(scene.scene_number, totalScenes, scene.camera_angle);
  const highlightBlock = buildHighlightBlock(scene, weaponSafe);
  const completedCutDiversityNote = buildCompletedCutDiversityNote(allScenes, sceneIndex);

  const visualDirStr = formatVisualDir(briefAnalysis?.visual_direction);
  const briefContext = briefAnalysis
    ? `PROJECT CONTEXT:
- Campaign goal: ${fieldToString(briefAnalysis.goal)}
- Target audience: ${fieldToString(briefAnalysis.target)}
- Key message: ${fieldToString(briefAnalysis.usp)}
- Visual tone: ${fieldToString(briefAnalysis.tone_manner)}${
        visualDirStr ? `\n- Visual direction: ${visualDirStr}` : ""
      }`
    : "";

  const sceneFlow = allScenes
    .map(
      (s) => `  Scene ${s.scene_number}${s.scene_number === scene.scene_number ? " ← CURRENT" : ""}: ${s.title ?? ""}`,
    )
    .join("\n");

  const flowContext = `COMMERCIAL FLOW (${totalScenes} scenes):
${sceneFlow}
${prevScene ? `Previous: "${prevScene.title}"` : "OPENING scene"}
${nextScene ? `Next: "${nextScene.title}"` : "CLOSING scene"}
→ Composition MUST differ from adjacent scenes.`;

  const styleRules = `${styleAnchor}\n- ${FORMAT_PROMPT_NOTE[videoFormat]}`;

  const visualInterpretation = enrichedContext ? `\n  VISUAL DIRECTION: ${enrichedContext}` : "";

  const sceneDetail = `\n═══ SCENE CONTENT (TOP PRIORITY — implement this faithfully first) ═══
  Action: ${scene.description}
  Location: ${scene.location || "fitting the narrative"}
  Mood: ${scene.mood || "consistent with campaign tone"}${visualInterpretation}
═══════════════════════════════════════`;

  // ── v2 필드 주입 블록 ──
  const hv = briefAnalysis?.hero_visual;
  const hs = briefAnalysis?.hook_strategy;
  const pi = briefAnalysis?.product_info;
  const constraints = briefAnalysis?.constraints;

  // must_show 는 하이라이트 여부와 무관하게 동일 취급한다. (하이라이트 격상은
  // buildHighlightBlock 이 순수 시네마틱/구도 결정으로만 담당하고, 여기서 브리프
  // 항목을 추가로 강조하지 않는다. 컷 관련성은 filterMustShowForScene 가 거른다.)
  const mustShowBlock =
    hv?.must_show && hv.must_show.length > 0
      ? `\n═══ MANDATORY VISIBLE ELEMENTS (from brief) ═══
${hv.must_show.map((m) => `  • ${sani(m)}`).join("\n")}
  → At least these elements MUST be clearly visible or implied in-frame.
═══════════════════════════════════════════`
      : "";

  const firstFrameBlock =
    isFirstScene && (hv?.first_frame || hs?.primary)
      ? `\n═══ FIRST-FRAME HOOK (scene 1 only) ═══${
          hv?.first_frame ? `\nOpening frame visual intent: ${sani(hv.first_frame)}` : ""
        }${
          hs?.primary
            ? `\nHook type: ${hs.primary} — mood keywords: ${buildHookMoodAddendum(hs.primary)}`
            : ""
        }${
          hv?.brand_reveal_timing === "0-3s" || hv?.product_reveal_timing === "0-3s"
            ? `\nBrand/product MUST be visibly established in this frame (first 3 seconds exposure rule).`
            : ""
        }
═══════════════════════════════════════════`
      : "";

  const ctaBlock =
    isLastScene && pi && (pi.cta_action || pi.cta_destination)
      ? `\n═══ FINAL-SCENE CTA HINT (last scene only) ═══${
          pi.cta_action ? `\nCTA call: "${sani(pi.cta_action)}"` : ""
        }${pi.cta_destination ? `\nDirects viewer to: ${sani(pi.cta_destination)}` : ""}
  → Compose frame to visually imply the CTA moment (product hero shot, emotional peak, or clear directional cue).
  → Do NOT render CTA text inside the image itself (text will be overlaid later).
═══════════════════════════════════════════`
      : "";

  const negativePromptBlock =
    constraints?.avoid && constraints.avoid.length > 0
      ? `\n═══ NEGATIVE PROMPT — AVOID ═══
${constraints.avoid.map((v) => `  ✗ ${sani(v)}`).join("\n")}
═══════════════════════════════════════════`
      : "";

  const castLockBlock = assetSection
    ? `\n═══ CAST LOCK (STRICT) ═══
The characters and objects listed in ASSET REQUIREMENTS above are the ONLY people and tangible objects allowed in this frame.
Do NOT add bystanders, extras, additional characters, pets, logos, brand signage, text, or props that are not explicitly listed.
If the scene description implies someone/something off-camera, keep them off-camera.
═══════════════════════════════════`
    : "";

  const topDirective =
    `Create a single cinematic storyboard frame for a commercial advertisement.\n` +
    `Compose this frame FRESH based on the SHOT TYPE and this scene's ACTION below. Reference images are for identity and material guidance only — never for composition, pose, or expression copying.`;

  return [
    topDirective,
    `\n${shotDirective}\n`,
    sceneDetail,
    highlightBlock,
    firstFrameBlock,
    mustShowBlock,
    ctaBlock,
    assetSection
      ? `\n═══ ASSET REQUIREMENTS (HIGHEST PRIORITY) ═══\n${assetSection}\n═══════════════════════════════════════════`
      : "",
    castLockBlock,
    briefContext,
    flowContext,
    completedCutDiversityNote,
    styleRules,
    negativePromptBlock,
  ]
    .filter(Boolean)
    .join("\n");
};

/**
 * 프로젝트의 `assets` 행을 한 번만 SELECT 해 `ProjectAssetsCache` 로 묶는다.
 * `runGenerateAll` 같은 다중-씬 사이클의 워커들이 공유해 SELECT 폭주를 막는다.
 *
 * 내부 SELECT 의 컬럼·필터는 기존 `fetchTaggedAssets` 와 정확히 동일하므로
 * (캐시 미전달 fallback 과 결과 행 형태가 같다) 동작 동일성이 보존된다.
 */
export const buildProjectAssetsCache = async (projectId: string): Promise<ProjectAssetsCache> => {
  const { data } = (await supabase
    .from("assets")
    .select(
      "tag_name, photo_url, ai_description, outfit_description, signature_items, space_description, asset_type, character_sheet_url, character_board_url, character_ref_mode, use_character_sheet",
    )
    .eq("project_id", projectId)) as { data: Asset[] | null };
  const rows: Asset[] = data ?? [];
  const projectAssetTags = rows
    .map((a) => a.tag_name ?? "")
    .filter(Boolean)
    .map((t) => (t.startsWith("@") ? t.slice(1) : t).toLowerCase());
  return { rows, projectAssetTags };
};

/* ━━━━━ fetchTaggedAssets ━━━━━
 *
 * Returns assets in the SAME order the caller passed tags in. This
 * matters: `tagged_assets` is built location-first in ContiTab /
 * AgentSceneCards, so the first background tag in the list is the
 * scene's primary location. `buildAssetImageUrls` keys its "primary
 * bg" selection on this ordering. Without explicit sort-by-input-order
 * Supabase returns rows in heap order and the primary bg becomes
 * whichever row the DB happened to return first.
 *
 * `cachedRows` 가 주어지면 Supabase round-trip 을 생략하고 같은 행 집합에서
 * 필터링한다. 캐시는 같은 `project_id` 의 풀 SELECT 결과여야 한다 — 컬럼
 * 누락 시 downstream (`buildAssetSections` 등) 이 빈 필드를 받게 된다. */
export const fetchTaggedAssets = async (
  tags: string[],
  projectId: string,
  cachedRows?: Asset[],
): Promise<Asset[]> => {
  if (!tags || tags.length === 0) return [];
  const normalizedTags = tags.map((t) => (t.startsWith("@") ? t : `@${t}`));
  const rawTags = normalizedTags.map((t) => t.slice(1));

  let allAssets: Asset[] | null;
  if (cachedRows) {
    allAssets = cachedRows;
  } else {
    const { data } = (await supabase
      .from("assets")
      .select(
        "tag_name, photo_url, ai_description, outfit_description, signature_items, space_description, asset_type, character_sheet_url, character_board_url, character_ref_mode, use_character_sheet",
      )
      .eq("project_id", projectId)) as { data: Asset[] | null };
    allAssets = data;
  }
  if (!allAssets) return [];

  const byRawTag = new Map<string, Asset>();
  for (const asset of allAssets) {
    const raw = asset.tag_name.startsWith("@") ? asset.tag_name.slice(1) : asset.tag_name;
    const norm = asset.tag_name.startsWith("@") ? asset.tag_name : `@${asset.tag_name}`;
    if (normalizedTags.includes(norm) || normalizedTags.includes(asset.tag_name) || rawTags.includes(raw)) {
      byRawTag.set(raw, asset);
    }
  }

  const out: Asset[] = [];
  const seen = new Set<string>();
  for (const raw of rawTags) {
    const hit = byRawTag.get(raw);
    if (hit && !seen.has(raw)) {
      out.push(hit);
      seen.add(raw);
    }
  }
  return out;
};

/* ━━━━━ assetImageUrls 조립 ━━━━━
 *
 * Each tag resolves to exactly one `photo_url`. There is no longer a
 * framing picker — if the user wants the close-up view of a location
 * they @-mention `@BG_close` directly, which is its own asset row.
 *
 * Order is preserved from `fetchTaggedAssets`, so `bgAssets[0]` is
 * the location tag (because `computeTaggedAssets` and
 * `handleLocChange` prepend location-derived tags). Subsequent
 * backgrounds fill in if slots remain under the 6-image cap. */
const buildAssetImageUrls = (
  assets: Asset[],
  styleImageUrl?: string,
): string[] => {
  const MAX = 6;
  const urls: string[] = [];

  if (styleImageUrl) urls.push(styleImageUrl);

  // Backgrounds follow the same original/board reference selection via
  // `pickCharacterRefUrl` (falls back to photo_url). The primary location
  // tag (bgAssets[0]) is pushed first to preserve ordering.
  const bgAssets = assets.filter((a) => a.asset_type === "background" && a.photo_url);
  if (bgAssets.length > 0) {
    const ref = pickCharacterRefUrl(bgAssets[0]);
    if (ref) urls.push(ref);
  }

  // Character ref selection: `character_ref_mode` picks original / sheet /
  // board (a generated multi-angle artifact packs identity better than the
  // single portrait). `pickCharacterRefUrl` resolves the mode, migrates
  // legacy `use_character_sheet` rows, and falls back to `photo_url` when
  // the chosen artifact is absent — so existing projects render identically
  // and the buildAssetSections branch above agrees on the chosen reference.
  for (const a of assets.filter((a) => a.asset_type === "character")) {
    if (urls.length >= MAX) break;
    const ref = pickCharacterRefUrl(a);
    if (ref) urls.push(ref);
  }

  // Items follow the same original/sheet/board reference selection as
  // characters (a generated multi-angle sheet/board packs design identity
  // better than a single photo). `pickCharacterRefUrl` falls back to
  // `photo_url` when no artifact is chosen/present.
  for (const a of assets.filter((a) => a.asset_type === "item")) {
    if (urls.length >= MAX) break;
    const ref = pickCharacterRefUrl(a);
    if (ref) urls.push(ref);
  }

  for (const a of bgAssets.slice(1)) {
    if (urls.length >= MAX) break;
    const ref = pickCharacterRefUrl(a);
    if (ref) urls.push(ref);
  }

  return urls;
};

/* ━━━━━ filterMustShowForScene ━━━━━
 *
 * `hero_visual.must_show` is a brief-level array ("things that MUST be
 * visible") and `buildContiPrompt` injects it into every non-TR scene
 * unconditionally. When the brief was built around an IP collab (e.g.
 * PUBGM × Lupi), items like "Lupi mascot visible" leak the hero character
 * into scenes where the user explicitly did NOT tag that asset — the model
 * sees a "MUST be visible" directive and quietly paints it into the
 * background.
 *
 * This filter drops must_show items that name a project asset which is not
 * tagged on the current scene. Items that reference only generic visual
 * elements (no asset name match) pass through untouched, preserving the
 * original intent for abstract must-shows like "brand logo moment" /
 * "hero product close-up" when no per-asset conflict exists.
 *
 * Matching is lowercase substring against each project asset `tag_name`
 * (minus the `@` prefix). A 2-char minimum guards against a 1-letter tag
 * (`@A`) matching every English sentence. Partial overlaps are accepted on
 * purpose — must_show items rarely contain the raw `@tag` token and usually
 * paraphrase the asset name.
 *
 * 에셋명이 없는 "일반" must_show 항목은 더 이상 모든 컷(또는 하이라이트)에
 * 무조건 주입하지 않는다. 컷의 본문 텍스트(설명/제목/무드/장소)와 토큰이
 * 겹칠 때만 주입해 "컷이 실제로 그 요소를 다룰 때"만 반영되게 한다. 예:
 * "3단계 외형 변화" must_show 는 "3단계 완성 외형" 컷엔 들어가지만 "2단계
 * 노랑 전환" 컷엔 빠진다. 하이라이트 여부는 must_show 와 무관하게 두고(연출
 * 격상은 buildHighlightBlock 이 별도 담당), 내용 관련성만으로 판단한다.
 */
const MUST_SHOW_TOKENIZE = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);
// 한 토큰이 컷 텍스트 토큰과 양방향 부분일치하는가
// (한국어 조사 접미 "오버레이와" ↔ "오버레이" 흡수).
const tokenMatchesScene = (token: string, sceneTokens: string[]): boolean =>
  sceneTokens.some((st) => st.includes(token) || token.includes(st));

function filterMustShowForScene(
  items: string[] | undefined,
  projectAssetTags: string[],
  sceneTagSet: Set<string>,
  sceneNumber: number,
  sceneText: string = "",
): string[] {
  if (!items || items.length === 0) return [];
  const sceneTokens = MUST_SHOW_TOKENIZE(sceneText);

  // 항목별 토큰 + 전체 빈도. 2개 이상 must_show 항목에 등장하는 토큰은
  // "캠페인 공통(비변별) 어휘"(예: 외형/WSUS/무기/계열)로 보고 매칭에서 제외한다.
  // 그래야 공통어 하나가 겹쳤다고 무관한 항목("3단계 외형 변화")까지 끌려오지 않고,
  // 각 항목의 고유 토큰(청록/노랑/3단계/스캔…)으로만 컷 관련성을 판정한다.
  const itemTokensList = items.map((it) => MUST_SHOW_TOKENIZE(it));
  const freq = new Map<string, number>();
  for (const toks of itemTokensList) {
    for (const t of new Set(toks)) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const isShared = (t: string) => (freq.get(t) ?? 0) >= 2;

  const kept: string[] = [];
  const dropped: string[] = [];
  items.forEach((raw, i) => {
    const lower = raw.toLowerCase();
    const mentioned = projectAssetTags.filter((t) => t.length >= 2 && lower.includes(t));
    if (mentioned.length === 0) {
      // 에셋명이 없는 일반 must_show: 고유 토큰(공통 토큰 제외)으로만 컷과 매칭.
      // 고유 토큰이 하나도 없으면(전부 공통) 전체 토큰으로 폴백.
      const tokens = itemTokensList[i];
      const distinctive = tokens.filter((t) => !isShared(t));
      const matchTokens = distinctive.length > 0 ? distinctive : tokens;
      const matched =
        sceneTokens.length > 0 && matchTokens.some((t) => tokenMatchesScene(t, sceneTokens));
      if (matched) kept.push(raw);
      else dropped.push(raw);
      return;
    }
    const allTagged = mentioned.every((t) => sceneTagSet.has(t));
    if (allTagged) kept.push(raw);
    else dropped.push(raw);
  });
  if (dropped.length > 0) {
    console.warn(
      `[generateConti] S${sceneNumber} dropped ${dropped.length} must_show item(s) — irrelevant to this cut's content:`,
      dropped,
    );
  }
  return kept;
}

/* ━━━━━ generateConti ━━━━━ */
export const generateConti = async ({
  scene,
  allScenes,
  projectId,
  videoFormat = "vertical",
  briefAnalysis,
  styleAnchor = DEFAULT_STYLE_ANCHOR,
  styleImageUrl,
  model = "nano-banana-2",
  onStageChange,
  projectAssetsCache,
  jobId,
}: ContiGenerateOptions): Promise<string> => {
  // Belt-and-suspenders: drop stale `tagged_assets` entries that are
  // no longer `@mentioned` anywhere in description/location. The UI
  // save path (computeTaggedAssets) now enforces this on every edit,
  // but legacy scene rows — especially ones duplicated before that
  // fix — may still carry zombie character/item tags from ancestors.
  // Reading the text as the source of truth here prevents their photos
  // from being quietly attached as references.
  const combinedText = `${scene.description ?? ""} ${scene.location ?? ""}`;
  const mentionTokens = (combinedText.match(/@[\w가-힣-]+/g) ?? []).map((m) =>
    m.slice(1).toLowerCase(),
  );
  const activeTagList = (scene.tagged_assets ?? []).filter((tag) => {
    const name = (tag.startsWith("@") ? tag.slice(1) : tag).toLowerCase();
    // Exact match or Korean-particle suffix (e.g. `@YD가` → tag `YD`).
    return mentionTokens.some((tok) => tok === name || tok.startsWith(name));
  });
  if (activeTagList.length !== (scene.tagged_assets ?? []).length) {
    const dropped = (scene.tagged_assets ?? []).filter((t) => !activeTagList.includes(t));
    console.warn("[generateConti] dropped stale tagged_assets", { dropped, scene: scene.scene_number });
  }
  const taggedAssets = await fetchTaggedAssets(activeTagList, projectId, projectAssetsCache?.rows);
  // 게임/무기 캠페인 자동 감지 — true면 sanitize/footer가 무기 표현을 게임-에셋
  // 친화적으로 보존한다(무기 명사 한정; 폭력/IP/연예인 가드는 유지).
  const weaponSafe = isGameWeaponContext(briefAnalysis, projectAssetsCache?.rows ?? taggedAssets);
  const sani = (t: string) => sanitizeImagePrompt(t, { weaponSafe });
  const assetImageUrls = buildAssetImageUrls(taggedAssets, styleImageUrl);
  const assetSection = buildAssetSections(taggedAssets, assetImageUrls.length > 0, weaponSafe);

  // Project asset tag names (lowercase, `@` 제거) for must_show 필터링.
  // 캐시가 있으면 같은 사이클 안에서 행 집합을 공유하고, 없으면 기존 경로
  // (전용 SELECT) 로 fallback 해 단일 호출 동작을 유지한다.
  let projectAssetTags: string[];
  if (projectAssetsCache) {
    projectAssetTags = projectAssetsCache.projectAssetTags;
  } else {
    const { data: allProjectAssetsRaw } = await supabase
      .from("assets")
      .select("tag_name")
      .eq("project_id", projectId);
    projectAssetTags = (allProjectAssetsRaw ?? [])
      .map((a: { tag_name: string | null }) => a.tag_name ?? "")
      .filter(Boolean)
      .map((t: string) => (t.startsWith("@") ? t.slice(1) : t).toLowerCase());
  }
  const sceneTagSet = new Set(
    (scene.tagged_assets ?? []).map((t) => (t.startsWith("@") ? t.slice(1) : t).toLowerCase()),
  );

  // 컷 본문(원문, 한국어) — 일반 must_show 의 관련성 판정에 사용.
  const sceneTextForMatch = `${scene.description ?? ""} ${scene.title ?? ""} ${scene.mood ?? ""} ${scene.location ?? ""}`;
  const filteredMustShow = filterMustShowForScene(
    briefAnalysis?.hero_visual?.must_show,
    projectAssetTags,
    sceneTagSet,
    scene.scene_number,
    sceneTextForMatch,
  );

  const safeBrief: BriefAnalysis | null = briefAnalysis
    ? {
        goal: fieldToArray(briefAnalysis.goal).map(sani),
        target: fieldToArray(briefAnalysis.target).map(sani),
        usp: fieldToArray(briefAnalysis.usp).map(sani),
        tone_manner: fieldToArray(briefAnalysis.tone_manner).map(sani),
        visual_direction: briefAnalysis.visual_direction,
        // v2 fields — 통과시켜 buildContiPrompt 가 활용. sanitize 는 첫프레임/CTA 시점에 국소 적용.
        hero_visual: briefAnalysis.hero_visual
          ? { ...briefAnalysis.hero_visual, must_show: filteredMustShow }
          : undefined,
        key_visual_criteria: briefAnalysis.key_visual_criteria,
        hook_strategy: briefAnalysis.hook_strategy,
        product_info: briefAnalysis.product_info,
        constraints: briefAnalysis.constraints,
      }
    : null;

  const safeScene: SceneForConti = {
    ...scene,
    title: sani(scene.title ?? ""),
    description: sani(scene.description ?? ""),
    camera_angle: sani(scene.camera_angle ?? ""),
    location: sani(scene.location ?? ""),
    mood: sani(scene.mood ?? ""),
  };

  onStageChange?.("translating");
  const [translatedScene, { enrichedContext }] = await Promise.all([
    translateSceneToEnglish(safeScene),
    enrichSceneDescription(safeScene, safeBrief as BriefAnalysis | null, weaponSafe),
  ]);
  onStageChange?.("building");

  const safeAllScenes = allScenes.map((s) => ({
    ...s,
    title: sani(s.title ?? ""),
    description: sani(s.description ?? ""),
  }));

  const rawPrompt = buildContiPrompt(
    translatedScene,
    safeAllScenes,
    assetSection,
    enrichedContext,
    videoFormat,
    safeBrief as any,
    styleAnchor,
    weaponSafe,
  );
  const safetyFooter = weaponSafe
    ? "\n\nSafe for all audiences. Stylized in-game weapon props only — no real-world violence, gore, or real people."
    : "\n\nSafe for all audiences. No violence, weapons, or real celebrities.";
  const finalPrompt = sanitizeImagePrompt(rawPrompt, { weaponSafe }) + safetyFooter;

  // Opt-in diagnostic dump. Enable in DevTools with:
  //   (window as any).__CONTI_DEBUG__ = true
  // to inspect which brief fragments landed in the prompt for a given scene.
  if (typeof window !== "undefined" && (window as any).__CONTI_DEBUG__ === true) {
    console.groupCollapsed(
      `[conti] S${scene.scene_number} prompt (${finalPrompt.length} chars)`,
    );
    console.log("scene.tagged_assets:", scene.tagged_assets);
    console.log("projectAssetTags:", projectAssetTags);
    console.log("must_show (raw):", briefAnalysis?.hero_visual?.must_show ?? "(none)");
    console.log("must_show (filtered):", filteredMustShow);
    console.log("assetImageUrls:", assetImageUrls);
    console.log(finalPrompt);
    console.groupEnd();
  }

  onStageChange?.("generating");
  const { data, error } = await supabase.functions.invoke("openai-image", {
    body: {
      prompt: finalPrompt,
      projectId,
      sceneNumber: scene.scene_number,
      imageSize: IMAGE_SIZE_MAP[videoFormat],
      assetImageUrls,
      model: model ?? "nano-banana-2",
      // GPT 경로일 때만 품질 전달(NB2 는 무시). 기능별 Settings 디폴트 사용.
      ...(model === "gpt" ? { quality: getGptQualityDefault("conti") } : {}),
      timestamp: Date.now(),
      ...(jobId ? { __jobId: jobId } : {}),
    },
  });

  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error?.message ?? data.error?.type ?? "Image generation failed");

  const publicUrl = data.publicUrl;
  if (!publicUrl) throw new Error("No image URL returned");

  if (data.usedModel) {
    console.log(`[Conti] Scene ${scene.scene_number} generated with: ${data.usedModel}`);
  }

  onStageChange?.("uploading");
  await supabase.from("scenes").update({ conti_image_url: publicUrl }).eq("id", scene.id);
  return publicUrl;
};

/* ━━━━━ styleTransfer ━━━━━ */
export const styleTransfer = async ({
  scene,
  projectId,
  styleImageUrl,
  stylePrompt,
  videoFormat,
  model,
  quality,
  onStageChange,
}: StyleTransferOptions): Promise<string> => {
  const styleDesc = stylePrompt?.trim() || "";
  // 스타일 적용은 자체 Settings 디폴트를 따른다(컨티 토글과 분리).
  const chosenStyleModel: ContiModel = model ?? (getImageModelDefault("style") as ContiModel);
  const styleQuality: GptQuality = quality ?? getGptQualityDefault("style");

  // ── imageSize: 항상 프로젝트 포맷 = 프리뷰 컨테이너 비율과 일치한 NB2 비율로 통일 ──
  // (1024x1536/1536x1024/1024x1024 → toNanoBananaAspectRatio 가 9:16/16:9/1:1 로 매핑)
  const imageSize = IMAGE_SIZE_MAP[videoFormat];

  // ── 프리뷰 비율로 source 이미지 사전-크롭 ──
  // GPT(1:1, 2:3, 3:2 등)와 NB2(9:16, 16:9, 1:1)의 지원 비율이 달라, 그대로 NB2 에 넘기면
  // 결과가 NB2 비율로 강제 변형되며 찌그러진다. 씬카드 프리뷰에 보이는 영역(=FORMAT_RATIO)을
  // 그대로 잘라서 NB2 에 넘기면 입력/출력 비율이 같아 더 이상 찌그러지지 않는다.
  let preflightSourceUrl = scene.conti_image_url;
  // preflight crop 으로 업로드한 임시 파일. 스타일 트랜스퍼 완료/실패 후
  // 디스크에서 지워야 disposable intermediate 가 계속 쌓이지 않는다.
  let preflightTempUrl: string | null = null;
  try {
    const { publicUrl } = await preflightCropToFormat(
      scene.conti_image_url,
      scene.conti_image_crop,
      videoFormat,
      projectId,
      scene.scene_number,
      "styletx-src",
    );
    preflightSourceUrl = publicUrl;
    preflightTempUrl = publicUrl;
    console.log("[StyleTransfer] pre-crop 완료", {
      videoFormat,
      formatRatio: FORMAT_RATIO[videoFormat],
      preflightSourceUrl,
    });
  } catch (cropErr) {
    console.warn("[StyleTransfer] pre-crop 실패 — 원본 이미지로 진행", cropErr);
  }

  // ── NB2용 프롬프트: 이미지 스타일만 차용, 텍스트 style_prompt 제외 ──
  const nbPrompt = [
    `The FIRST image is the SOURCE SCENE. Preserve it exactly:`,
    `- Same subjects, characters, and count (no additions or removals)`,
    `- Same background and environment`,
    `- Same camera angle, framing, composition`,
    `- Same objects and props`,
    ``,
    `The SECOND image is the STYLE REFERENCE. Extract ONLY:`,
    `- Visual rendering style and line quality`,
    `- Color palette and lighting mood`,
    `- Texture and artistic treatment`,
    ``,
    `Do NOT add any new subjects, characters, or objects from the style reference image.`,
    `This is a STYLE-ONLY transformation. Do not alter scene content.`,
  ].join("\n");

  // ── GPT 폴백용 프롬프트: style_prompt 텍스트 포함 ──
  const gptPrompt = styleDesc
    ? [`Apply this visual style to the scene: ${styleDesc}.`, ``, ...nbPrompt.split("\n")].join("\n")
    : nbPrompt;

  onStageChange?.("generating");
  console.log("[StyleTransfer] 호출", {
    scene: scene.scene_number,
    sourceImageUrl: preflightSourceUrl,
    originalImageUrl: scene.conti_image_url,
    stylePrompt: styleDesc || "(image-only)",
    imageSize,
    // model 을 로그에 노출해 "GPT 선택했는데 NB2 로 나오는 것 같다" 류의
    // 체감 버그를 서버 로그 ([StyleTransfer] stModel=...) 와 교차확인할 수 있게 한다.
    requestedModel: chosenStyleModel,
    quality: chosenStyleModel === "gpt" ? styleQuality : "(n/a)",
  });

  const { data, error } = await supabase.functions.invoke("openai-image", {
    body: {
      mode: "style_transfer",
      prompt: nbPrompt,
      gptPrompt: gptPrompt,
      sourceImageUrl: preflightSourceUrl, // 프리뷰 비율로 잘라낸 이미지
      styleImageUrl: styleImageUrl ?? null,
      imageSize, // 프로젝트 포맷 기준
      projectId,
      sceneNumber: scene.scene_number,
      // When the chosen model is "gpt", skip the NB2 primary pass entirely so
      // GPT Image 2 is used for style consistency. When "nano-banana-2" the
      // edge keeps the legacy NB2→GPT fallback chain.
      model: chosenStyleModel,
      // GPT 경로일 때만 품질 전달(NB2 는 무시).
      ...(chosenStyleModel === "gpt" ? { quality: styleQuality } : {}),
    },
  });

  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error?.message ?? data.error?.type ?? "Style transfer failed");

  const publicUrl = data.publicUrl;
  if (!publicUrl) throw new Error("No image URL returned");

  // usedModel 값은 경로 판별용 — 아래 한 가지 중 하나가 나와야 한다.
  //   "gpt-image-2"               → 사용자가 GPT 선택, GPT primary 성공
  //   "nano-banana-2"             → 사용자가 NB2(기본) 선택, NB2 primary 성공
  //   "style-gpt-fallback:...":   → NB2 primary 실패해서 GPT 폴백으로 넘어감
  // "GPT 로 해도 NB2 로 도는 것 같다" 체감이 있다면 이 값이 실제로 뭐 찍혔는지 확인.
  console.log("[StyleTransfer] 완료", {
    scene: scene.scene_number,
    requestedModel: chosenStyleModel,
    usedModel: data.usedModel,
  });

  onStageChange?.("uploading");
  // 새 이미지의 자연 비율 = FORMAT_RATIO[videoFormat] = 프리뷰 컨테이너 비율 → 별도의 crop 불필요.
  // (이전 crop 들은 옛 이미지의 콘텐츠 좌표 기준이라 새 이미지엔 안 맞으므로 모두 비운다.)
  await supabase
    .from("scenes")
    .update({ conti_image_url: publicUrl, conti_image_crop: null })
    .eq("id", scene.id);
  // 성공적으로 DB 반영됐으니 preflight 임시 파일은 더 이상 필요 없다.
  // (실패 경로에서는 호출부가 catch 후 재시도할 수도 있어 지우지 않는다.)
  if (preflightTempUrl) void deleteStoredFile(preflightTempUrl);
  return publicUrl;
};
