/**
 * Sketches — per-scene composition candidates.
 *
 * Role split vs Mood Ideation (Ideation tab):
 *   · MoodIdeationPanel generates project-scoped tone references and persists
 *     them into `briefs.mood_image_urls`. The generator there can attach any
 *     result to a specific scene via `sceneRef`, but the store is global.
 *   · Sketches live on the individual scene row (`scenes.sketches`). They are
 *     scene-scoped composition drafts that the user can promote into
 *     `conti_image_url` from the ContiStudio Sketches tab. Deleting the scene
 *     deletes the sketches (FK cascade).
 *
 * This module is an intentionally thin wrapper around the same low-level
 * image pipeline (`generateMoodImages` in lib/moodIdeation). We only reuse the
 * generator — NOT the persistence path. Sketches never touch
 * `briefs.mood_image_urls`; the caller is responsible for writing the returned
 * URLs to `scenes.sketches` so role separation stays clean.
 */

import {
  generateMoodImages,
  MOOD_IMAGE_MODEL_DEFAULT,
  MOOD_MODEL_USES_ASSET_REFS,
  type MoodGenerateOptions,
  type MoodImageModel,
} from "./moodIdeation";
import { generateTransitionFrame } from "./transitions";
import type { BriefAnalysis, ContiModel, VideoFormat } from "./conti";
import type { Sketch } from "@/components/conti/contiTypes";
import { supabase } from "./supabase";
import { urlToVisionBase64 } from "./referenceLibrary";
import { pickCharacterRefUrl } from "./characterSheetStore";

/** Default model for the Sketches tab.
 *  gpt-image-2 reads the tagged references more semantically/compositionally
 *  (keeps the original location but varies the camera angle) instead of
 *  near-copying the reference like NB2 does, which is the preferred behaviour
 *  for composition drafts. The new Quality preset (see SKETCH_QUALITY_PRESETS)
 *  offsets gpt-image-2's slower render by letting the user trade fidelity for
 *  speed per generation. */
export const SKETCH_MODEL_DEFAULT: MoodImageModel = "gpt-image-2";
export type { MoodImageModel as SketchModel };

/** Quality presets for the Sketches toolbar. Sketches are throwaway
 *  composition candidates, so the meaningful axis is speed vs fidelity.
 *  Each preset maps to the two real latency levers on the gpt-image edits
 *  endpoint: `quality` (applies to all GPT models) and `input_fidelity`
 *  (only honoured by gpt-image-1.5; gpt-image-2 ignores it). NB2 ignores
 *  both. */
export type SketchQualityPreset = "fast" | "balanced" | "quality";
export const SKETCH_QUALITY_PRESETS: Record<
  SketchQualityPreset,
  { quality: "low" | "medium" | "high"; inputFidelity: boolean }
> = {
  fast: { quality: "low", inputFidelity: false },
  balanced: { quality: "medium", inputFidelity: false },
  quality: { quality: "high", inputFidelity: true },
};
export const SKETCH_QUALITY_PRESET_DEFAULT: SketchQualityPreset = "balanced";

export const SKETCH_MODEL_USES_ASSET_REFS: Record<MoodImageModel, boolean> = {
  ...MOOD_MODEL_USES_ASSET_REFS,
  "gpt-image-1.5": true,
};

export const SKETCH_MODEL_LABELS: Record<MoodImageModel, string> = {
  "nano-banana-2": "Nano Banana 2",
  "gpt-image-2": "GPT Image 2",
  "gpt-image-1.5": "GPT Image 1.5",
};

export const SKETCH_MODEL_DESCRIPTIONS: Record<MoodImageModel, string> = {
  "nano-banana-2": "Best default · Uses asset images for stable character/background likeness",
  "gpt-image-2": "High quality vision · Strong reference reading, slower generation",
  "gpt-image-1.5": "Faster vision · Reads asset images with lighter reference fidelity",
};

export interface GenerateSketchesOptions {
  projectId: string;
  /** Scene to tailor the prompts to. Sketches are always per-scene, so
   *  `sceneNumber` is required (MoodIdeationPanel allows null for "all scenes",
   *  we do not). */
  sceneNumber: number;
  scene: NonNullable<MoodGenerateOptions["scenes"]>[number];
  briefAnalysis: MoodGenerateOptions["briefAnalysis"];
  assets: MoodGenerateOptions["assets"];
  videoFormat: string;
  count: number;
  model?: MoodImageModel;
  /** gpt-image quality knob. Defaults to "high" (legacy behaviour) when omitted. */
  quality?: "low" | "medium" | "high";
  /** Forwarded to the edits endpoint's input_fidelity (gpt-image-1.5 only). */
  inputFidelity?: boolean;
}

export interface GenerateTransitionSketchesOptions {
  projectId: string;
  prev: {
    scene_number: number;
    title?: string | null;
    description?: string | null;
    camera_angle?: string | null;
    mood?: string | null;
    location?: string | null;
    conti_image_url: string;
  };
  next: {
    scene_number: number;
    title?: string | null;
    description?: string | null;
    camera_angle?: string | null;
    mood?: string | null;
    location?: string | null;
    conti_image_url: string;
  };
  tr: {
    scene_number: number;
    description?: string | null;
    transition_type?: string | null;
  };
  allScenes?: Array<{
    scene_number: number;
    title?: string | null;
    description?: string | null;
    is_transition?: boolean;
  }>;
  briefAnalysis: BriefAnalysis | null;
  videoFormat: VideoFormat | string;
  count: number;
  model?: MoodImageModel;
}

/**
 * Generate N composition candidates for a single scene. Returns a flat URL
 * array. Does NOT write to `briefs.mood_image_urls` or `scenes.sketches`.
 * The caller decides persistence.
 *
 * `onBatchDone` streams URLs as they arrive so the Sketches tab can swap
 * skeleton placeholders for real images without waiting for the full batch.
 */
export async function generateSceneSketches(
  opts: GenerateSketchesOptions,
  onBatchDone?: (urls: string[]) => void,
): Promise<string[]> {
  const model = opts.model ?? SKETCH_MODEL_DEFAULT;
  return generateMoodImages(
    {
      projectId: opts.projectId,
      briefAnalysis: opts.briefAnalysis,
      // Only the target scene is sent. generateMoodImages honours
      // `targetSceneNumber` to bias prompts to that scene's description.
      scenes: [opts.scene],
      assets: opts.assets,
      videoFormat: opts.videoFormat,
      count: opts.count,
      targetSceneNumber: opts.sceneNumber,
      model,
      forceAssetRefs: true,
      quality: opts.quality,
      inputFidelity: opts.inputFidelity,
    },
    onBatchDone,
  );
}

/* ━━━━━ 이미지 베리에이션(원본 컷 다각도화) 스케치 ━━━━━
 *
 * "장면 기반" 스케치(generateSceneSketches)가 씬 설명 + 에셋 태그로 새 구도를
 * 짓는 것과 달리, 이 경로는 **이미 등록된 컷 이미지를 원본(source)으로** 삼아
 * 같은 피사체/의상/무드를 유지한 채 카메라 앵글·샷 사이즈·구도만 크게 바꾼
 * 후보들을 만든다. (Reference Library 의 "빠른 변형"과 동일한 발상)
 *
 * 백엔드는 openai-image 의 `mode:"inpaint"` 경로를 쓴다 — 마스크 없이 원본을
 * 통째로 재구성하는 instruction-based edit 으로, 결과를 프로젝트 스토리지에
 * 자동 저장하고 publicUrl 을 돌려준다(별도 업로드 불필요). bgVariationStore /
 * characterSheetStore 의 inpaint 호출부와 동일한 요청 형태를 따른다.
 */

/** SIZE_MAP — moodIdeation 의 동일 매핑을 복제(내부 const 라 export 되지 않음). */
const SKETCH_SIZE_MAP: Record<string, string> = {
  vertical: "1024x1536",
  horizontal: "1536x1024",
  square: "1024x1024",
};

/** "같은 장면을 다른 카메라 셋업으로 다시 찍는다"는 컨셉. 구도(앵글·샷 사이즈)만
 *  바꾸고 배경/장소/의상/소품/캐릭터 정체성은 원본 이미지·참조 사진과 동일하게
 *  유지하도록 강하게 지시한다. (이전 버전은 "정체성·의상만 유지, 나머지 자유"로
 *  너무 공격적이어서 클로즈업 베리에이션 시 배경·옷이 다 바뀌는 문제가 있었음) */
const VARIATION_COMPOSITION_TEMPLATE =
  "Re-shoot the SAME scene from a BOLDLY different camera setup — like a different camera operator covering the same " +
  "moment from a fresh position. " +
  "KEEP EVERYTHING CONSISTENT with the input image and the provided reference photos: the exact same location and " +
  "background, the same characters with their exact wardrobe/outfit, the same props, and the same time-of-day, " +
  "color grade and lighting mood. Do NOT redesign the set, change clothing, swap props, add or remove people, " +
  "or alter the environment. " +
  "But DO change the cinematography decisively: commit FULLY to the specified shot size, camera angle, camera height, " +
  "lens and subject placement. The result MUST look clearly different in framing from the input — NOT a re-crop or a " +
  "slight zoom of it. Move the camera to a genuinely new vantage point, reveal more or less of the environment as the " +
  "shot demands, and reposition the subject within the frame accordingly. " +
  "High-quality, photographic, cinematic.";

/** 씬의 tagged_assets 를 라이브러리 에셋과 매칭해 참조 이미지 URL 로 변환한다.
 *  moodIdeation.resolveTaggedAssets 의 느슨한 매칭(@ 접두/대소문자 무시)을 따르고,
 *  참조 이미지는 콘티 본생성과 동일하게 pickCharacterRefUrl 로 character_ref_mode
 *  (보드/시트/원본)를 존중해 고른다(없으면 photo_url 폴백). photo_url 만 읽던 과거엔
 *  보드로 등록한 캐릭터도 원본 사진이 들어가 원본 배경의 소품이 새어 들어왔다. */
function resolveTaggedAssetPhotos(
  assets: MoodGenerateOptions["assets"] | undefined,
  tagged: string[] | undefined,
  max = 8,
): string[] {
  if (!assets || !tagged || tagged.length === 0) return [];
  const norm = (s: string) => s.replace(/^@/, "").trim().toLowerCase();
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const t of tagged) {
    if (urls.length >= max) break;
    const a = assets.find(
      (x) => x.tag_name === t || x.tag_name === `@${t}` || (x.tag_name != null && norm(x.tag_name) === norm(t)),
    );
    const ref = a ? pickCharacterRefUrl(a) : null;
    if (ref && !seen.has(ref)) {
      urls.push(ref);
      seen.add(ref);
    }
  }
  return urls;
}

/** 샷별로 배정할 구도 지시 — img2img 의 보수적 재현 성향을 상쇄하기 위해 샷 사이즈·
 *  앵글·카메라 높이·렌즈·피사체 배치를 한꺼번에 묶어 명령형으로 못 박는다. 풀이
 *  count 보다 크고, 호출마다 셔플되므로(아래 generateImageVariationSketches 참고)
 *  한 배치 안에서는 서로 다른 구도가, 재생성 때마다는 새로운 조합이 나온다. */
const VARIATION_SHOT_DIRECTIVES = [
  "Extreme wide establishing shot, high angle, very wide 18mm lens — the subject is small in the lower third, the environment dominates.",
  "Full shot from a low worm's-eye angle looking up, 24mm — dramatic perspective, generous headroom.",
  "Cowboy shot (mid-thigh up) at eye level, 35mm — subject pushed to one side on a rule-of-thirds line.",
  "Medium shot from a 3/4 front angle, 50mm — subject off-center with clear leading room.",
  "Medium close-up from a slightly high angle, 85mm — the face sits in the upper third.",
  "Tight close-up from a low angle, 100mm — looking up at the face, shallow depth of field.",
  "Over-the-shoulder shot from behind another element/character, 50mm — strong foreground framing, shallow focus.",
  "Profile / side-on medium shot, 50mm — subject in clean side silhouette with negative space ahead.",
  "Extreme close-up of a single key detail (eyes, hands, or a prop) — macro intimacy, background thrown far out of focus.",
  "Bird's-eye / near top-down high-angle wide shot — flattened graphic composition from above.",
  "Dutch-angle wide shot, 28mm — tilted horizon for tension, diagonal lines across the frame.",
  "Two-shot / wide medium from a frontal 3/4 angle, 35mm — more of the setting visible around the subject.",
  "Low three-quarter back angle, 35mm — camera behind and below, looking past the subject into the scene.",
  "High-angle medium-wide from across the space, 50mm — subject small-ish, surrounded by environmental context.",
];

export interface GenerateImageVariationSketchesOptions {
  projectId: string;
  /** Sketches are per-scene; used for the synthetic upload filename token. */
  sceneNumber: number;
  /** 원본 컷 이미지 URL. 호출부에서 non-null 을 보장한다(scene.conti_image_url). */
  sourceImageUrl: string;
  /** 씬 메타(설명/태그된 에셋) — 정체성 유지용 참조·프롬프트 컨텍스트로 쓴다. */
  scene: NonNullable<MoodGenerateOptions["scenes"]>[number];
  /** 프로젝트 에셋 라이브러리 — tagged_assets 를 사진 URL 로 해석할 때 쓴다. */
  assets: MoodGenerateOptions["assets"];
  videoFormat: VideoFormat | string;
  count: number;
  model?: MoodImageModel;
  /** gpt-image 품질 노브. NB2 는 무시. */
  quality?: "low" | "medium" | "high";
}

/**
 * 등록된 컷 이미지를 원본으로 N 개의 구도 베리에이션을 생성한다. generateMoodImages /
 * generateTransitionSketches 와 동일하게 스태거 병렬 + 부분 실패 허용 패턴을 쓰고,
 * 성공한 publicUrl 들을 평탄한 배열로 반환한다. persistence 는 호출부 책임.
 */
export async function generateImageVariationSketches(
  opts: GenerateImageVariationSketchesOptions,
  onBatchDone?: (urls: string[]) => void,
): Promise<string[]> {
  const count = Math.max(1, opts.count);
  const model = opts.model ?? SKETCH_MODEL_DEFAULT;
  const imageSize = SKETCH_SIZE_MAP[opts.videoFormat] ?? SKETCH_SIZE_MAP.horizontal;

  // 원본을 생성 모델이 받아들이는 포맷으로 정규화한다(AVIF/HEIC 거부 방지).
  // createVariation 과 동일하게 best-effort — 실패하면 원본 URL 그대로 넘긴다.
  const toModelSafeUrl = async (url: string): Promise<string> => {
    try {
      const { base64, mediaType } = await urlToVisionBase64(url, 1536);
      return `data:${mediaType};base64,${base64}`;
    } catch {
      return url;
    }
  };
  const safeSource = await toModelSafeUrl(opts.sourceImageUrl);

  // 태그된 에셋 사진을 정체성 앵커로 함께 넘긴다 — inpaint 경로(GPT 앵글/NB2 모두)
  // 는 referenceImageUrls 를 [sourceImageUrl, ...refs] 로 입력 이미지에 합쳐 쓰므로
  // 배경/의상/소품 일관성이 크게 좋아진다(api-handlers.ts inpaint 라우팅 참고).
  // 우리 로컬 스토리지/Supabase URL 은 핸들러가 직접 fetch 하므로 정규화 불필요.
  const assetRefUrls = resolveTaggedAssetPhotos(opts.assets, opts.scene.tagged_assets);

  // 씬 설명을 프롬프트 컨텍스트로 덧붙여 "무엇을 담은 장면인지"를 모델이 알게 한다.
  const sceneContext = [
    opts.scene.description ? `Scene: ${opts.scene.description}` : "",
    opts.scene.location ? `Location: ${opts.scene.location}` : "",
    assetRefUrls.length > 0
      ? "Reference photos of the characters / location / props in this scene are provided — match their identity, wardrobe, and design exactly while only changing the camera setup."
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  // 호출마다 풀을 셔플(Fisher–Yates) — 한 배치 안에선 서로 다른 구도가 배정되고,
  // "다시 생성"을 누를 때마다 다른 조합/순서가 나와 누적 다양성이 커진다.
  // (Math.random 은 앱 런타임에서 정상 사용 가능 — 워크플로 스크립트 제약과 무관)
  const directivePool = [...VARIATION_SHOT_DIRECTIVES];
  for (let i = directivePool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [directivePool[i], directivePool[j]] = [directivePool[j], directivePool[i]];
  }

  const generateOne = async (idx: number): Promise<string> => {
    const directive = directivePool[idx % directivePool.length];
    const prompt = [`${VARIATION_COMPOSITION_TEMPLATE}\n\nFor THIS variation: ${directive}`, sceneContext]
      .filter(Boolean)
      .join("\n\n");

    const body: Record<string, unknown> = {
      mode: "inpaint",
      sourceImageUrl: safeSource,
      // 원본 컷 + 태그된 에셋 사진을 참조로 함께 전달해 정체성을 고정한다.
      referenceImageUrls: assetRefUrls,
      prompt,
      projectId: opts.projectId,
      // 동시 생성 파일명 충돌 방지용 synthetic scene-number(인덱스 + ms 토큰).
      sceneNumber: `sketchvar-${opts.sceneNumber}-${idx}-${Date.now()}`,
      imageSize,
      folder: "mood",
      ...(model === "nano-banana-2"
        ? { useNanoBanana: true }
        : { preferredAngleModel: model, quality: opts.quality ?? "high" }),
    };

    const { data, error } = await supabase.functions.invoke("openai-image", { body });
    if (error) {
      const msg =
        typeof error === "object" && error && "message" in error
          ? String((error as { message?: unknown }).message)
          : String(error);
      throw new Error(msg || "베리에이션 스케치 요청에 실패했습니다.");
    }
    const d = (data ?? {}) as {
      publicUrl?: string;
      url?: string;
      error?: { message?: string; type?: string };
    };
    if (d.error) throw new Error(d.error?.message ?? d.error?.type ?? "베리에이션 스케치 생성 실패");
    const url = d.publicUrl ?? d.url;
    if (!url) throw new Error("베리에이션 스케치 결과 URL 이 비어 있습니다.");
    return url;
  };

  // 스태거 병렬 — generateMoodImages / generateTransitionSketches 와 동일 패턴.
  const STAGGER_MS = model === "nano-banana-2" ? 600 : 300;
  const settled = await Promise.allSettled(
    Array.from({ length: count }, (_, idx) =>
      (idx > 0 ? new Promise((r) => setTimeout(r, idx * STAGGER_MS)) : Promise.resolve()).then(() =>
        generateOne(idx).then((url) => {
          onBatchDone?.([url]);
          return url;
        }),
      ),
    ),
  );
  const urls: string[] = [];
  const failures: unknown[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") urls.push(r.value);
    else {
      failures.push(r.reason);
      console.warn("[Sketch] image-variation frame failed:", r.reason);
    }
  }
  if (!urls.length) {
    throw failures[0] instanceof Error ? failures[0] : new Error("모든 베리에이션 스케치 생성 실패");
  }
  return urls;
}

function sketchModelToContiModel(model: MoodImageModel | undefined): ContiModel {
  return model === "nano-banana-2" ? "nano-banana-2" : "gpt";
}

export async function generateTransitionSketches(
  opts: GenerateTransitionSketchesOptions,
  onBatchDone?: (urls: string[]) => void,
): Promise<string[]> {
  const count = Math.max(1, opts.count);
  // 동시 상한 없이 전체 후보를 병렬로 생성하되, 시작 시점만 i × STAGGER_MS 로 엇갈려
  // launch burst 를 분산한다. (콘티 전체 생성 / 무드 생성과 동일한 패턴) 부분 실패는
  // allSettled 로 견디고, 전부 실패할 때만 throw 한다.
  const STAGGER_MS = 600;
  const settled = await Promise.allSettled(
    Array.from({ length: count }, (_, i) =>
      (i > 0
        ? new Promise((r) => setTimeout(r, i * STAGGER_MS))
        : Promise.resolve()
      ).then(() =>
        generateTransitionFrame({
          projectId: opts.projectId,
          prev: opts.prev,
          next: opts.next,
          tr: {
            ...opts.tr,
            // Give each candidate a tiny variation hint while preserving the
            // selected transition technique and anchor discipline.
            description: [opts.tr.description, `Sketch candidate ${i + 1}: vary the composition and timing within the same transition beat.`]
              .filter(Boolean)
              .join("\n"),
          },
          allScenes: opts.allScenes,
          briefAnalysis: opts.briefAnalysis,
          videoFormat: opts.videoFormat as VideoFormat,
          model: sketchModelToContiModel(opts.model),
        }).then((url) => {
          onBatchDone?.([url]);
          return url;
        }),
      ),
    ),
  );
  const urls: string[] = [];
  const failures: unknown[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") urls.push(r.value);
    else {
      failures.push(r.reason);
      console.warn("[Sketch] transition frame failed:", r.reason);
    }
  }
  if (!urls.length) {
    throw failures[0] instanceof Error ? failures[0] : new Error("모든 전환 스케치 생성 실패");
  }
  return urls;
}

export function makeSketchFromUrl(url: string, model: MoodImageModel): Sketch {
  return {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    url,
    model,
    createdAt: new Date().toISOString(),
  };
}

export { MOOD_IMAGE_MODEL_DEFAULT };
