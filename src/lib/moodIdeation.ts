import { supabase } from "./supabase";
import { KNOWLEDGE_MOOD_CINEMATICS } from "./directorKnowledgeBase";
import { pickCharacterRefUrl } from "./characterSheetStore";

/* ━━━━━ Types ━━━━━ */
export interface MoodGenerateOptions {
  projectId: string;
  briefAnalysis: {
    goal?: any;
    target?: any;
    usp?: any;
    tone_manner?: any;
    idea_note?: string;
    image_analysis?: string;
    reference_mood?: string;
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
          hook?: { description?: string };
          body?: { description?: string };
          cta?: { description?: string };
        }
      | string;
  } | null;
  scenes: {
    scene_number: number;
    title?: string | null;
    description?: string | null;
    camera_angle?: string | null;
    location?: string | null;
    mood?: string | null;
    tagged_assets?: string[];
    is_highlight?: boolean;
    highlight_kind?: "hook" | "hero" | "product" | "emotion" | "cta" | null;
    highlight_reason?: string | null;
  }[];
  assets: {
    tag_name: string;
    photo_url?: string | null;
    ai_description?: string | null;
    asset_type?: string;
    outfit_description?: string | null;
    space_description?: string | null;
    role_description?: string | null;
    // 캐릭터/배경/소품 참조 선택(원본·시트·보드)을 콘티 본생성과 동일하게 존중하기
    // 위한 필드. pickCharacterRefUrl 이 이 값으로 보드/시트/원본을 고른다.
    character_sheet_url?: string | null;
    character_board_url?: string | null;
    character_ref_mode?: "original" | "sheet" | "board" | null;
    use_character_sheet?: boolean | number | null;
  }[];
  videoFormat: string;
  count?: number;
  targetSceneNumber?: number | null;
  // 이전의 "creative" | "asset" 2-way 구분을 실제 이미지 모델 명으로 대체.
  //   - "gpt-image-1.5": 가장 빠른 텍스트-only 모델. Mood Ideation 의 디폴트.
  //                       에셋 이미지는 참조하지 않고 Claude 가 생성한 풍부한 묘사문만 씀.
  //   - "gpt-image-2":   vision-aware GPT. 에셋 이미지를 레퍼런스로 함께 전달해
  //                       실제 캐릭터/배경의 외형을 반영 (callGptVisionGenerate 경로).
  //   - "nano-banana-2": Vertex NB2. 에셋 이미지 레퍼런스 기반 생성.
  model?: MoodImageModel;
  /** Sketches can opt into reference images for gpt-image-1.5 while Mood Ideation
   *  keeps 1.5 as a fast text-only batch model. */
  forceAssetRefs?: boolean;
  /** gpt-image quality knob (low|medium|high). Defaults to "high" when omitted
   *  so existing Mood Ideation behaviour is unchanged. NB2 ignores it. */
  quality?: "low" | "medium" | "high";
  /** Forwarded to the edits endpoint's input_fidelity. Only gpt-image-1.5
   *  honours it; gpt-image-2 / NB2 ignore it. Defaults to true. */
  inputFidelity?: boolean;
}

export type MoodImageModel = "gpt-image-1.5" | "gpt-image-2" | "nano-banana-2";

export const MOOD_IMAGE_MODEL_DEFAULT: MoodImageModel = "gpt-image-1.5";

/** 에셋 이미지를 실제 레퍼런스로 주입하는 모델. 이 모델군은 Claude 쪽에 ASSET system
 *  prompt(프레이밍/포지션 중심) 를 사용하고, 에셋 포토가 없으면 vision 효용이 0 이다. */
export const MOOD_MODEL_USES_ASSET_REFS: Record<MoodImageModel, boolean> = {
  "gpt-image-1.5": false,
  "gpt-image-2": true,
  "nano-banana-2": true,
};

const SAFETY_REJECTION_ERROR = "SAFETY_FILTER_REJECTED";
const ALL_GENERATIONS_FAILED_ERROR = "ALL_IMAGE_GENERATIONS_FAILED";

function isSafetyRejection(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  return /safety system|safety filter|rejected by the safety/i.test(message);
}

/* ━━━━━ Legacy 랜덤 풀 (폴백용 보존) ━━━━━ */

const CAMERA_POOL = [
  "EXTREME WIDE SHOT — vast environment, subject small in frame",
  "WIDE SHOT — full body visible, environment context clear",
  "MEDIUM SHOT — waist up, natural conversational distance",
  "MEDIUM CLOSE-UP — chest up, subtle emotional read",
  "CLOSE-UP — face fills frame, emotion dominant",
  "EXTREME CLOSE-UP — eyes or hands only, texture and detail",
  "LOW ANGLE — looking up at subject, powerful and heroic",
  "HIGH ANGLE — bird's eye view, subject looks small and vulnerable",
  "DUTCH ANGLE — 15–20° tilt, unease and dynamic energy",
  "OVER THE SHOULDER — intimacy, POV of conversation",
  "RACK FOCUS — foreground blurred to background reveal",
  "TRACKING SHOT — subject in motion, lateral movement",
];

const LIGHTING_POOL = [
  "golden hour backlight — warm amber rim, deep shadows, lens flare",
  "harsh midday sun — strong shadows, high contrast, bleached highlights",
  "soft overcast — flat diffused light, no harsh shadows, pastel tones",
  "neon city night — magenta and cyan mixed, deep blacks, wet reflections",
  "practical tungsten — warm orange interior light, moody shadows",
  "cold blue moonlight — desaturated, silver highlights, night atmosphere",
  "studio strobe — sharp clean light, controlled shadows, commercial look",
  "candle and fire glow — flickering orange warmth, vignette, intimate",
  "fluorescent office — green-tinged, flat, slightly unsettling",
  "dramatic side lighting — half-lit face Rembrandt style, chiaroscuro",
  "foggy diffused light — hazy atmosphere, soft edges, dreamy",
  "silhouette lighting — subject backlit, no detail, pure shape",
];

const COLOR_GRADE_POOL = [
  "teal and orange cinematic grade — warm skin tones, cool shadow",
  "bleach bypass — desaturated, high contrast, silver metallic look",
  "warm film emulsion — Kodak Portra 400 style, creamy highlights",
  "cold clinical — cool blue-white, antiseptic, razor sharp",
  "vintage faded — lifted blacks, muted saturation, nostalgic",
  "high saturation vivid — punchy colors, commercial energy",
  "monochromatic blue — near black-and-white with blue cast",
  "earthy desaturated — brown-green tones, documentary realism",
  "cross-processed — shifted hues, unexpected color combinations",
  "day for night — blue-tinted underexposed, simulated night",
  "high key — overexposed minimal shadows, airy and light",
  "low key — deep shadows, only essential highlights visible",
];

const VISUAL_STYLE_POOL = [
  "35mm film grain — visible grain, slight vignette, organic texture",
  "hyperreal CGI render — perfectly crisp, no film artifacts, smooth",
  "editorial fashion — sharp confident poses, high fashion lighting",
  "documentary handheld — slight camera movement, naturalistic",
  "painterly impressionist — soft edges, visible brushstroke texture",
  "graphic novel — strong outlines, flat color zones, stylized",
  "vintage advertisement — retro feel, muted palette, nostalgic",
  "luxury commercial — pristine surfaces, perfect lighting, aspirational",
  "social media vertical — bold framing, native mobile energy",
  "slow cinema — minimal movement, wide lens, contemplative",
  "abstract art direction — shapes and color over narrative clarity",
  "photo collage — layered textures, mixed media, tactile",
];

const MOOD_TONE_POOL = [
  "tense and suspenseful — held breath, anticipation",
  "joyful and energetic — movement, brightness, warmth",
  "melancholy and introspective — stillness, muted tones",
  "epic and grand — scale, drama, orchestral feel",
  "intimate and tender — close, soft, deeply emotional",
  "gritty and raw — imperfect, real, unpolished",
  "surreal and dreamlike — logic-defying, soft boundaries",
  "sleek and corporate — clean lines, confidence, trust",
  "playful and quirky — unexpected angles, bold colors",
  "romantic and nostalgic — warm light, soft focus, longing",
  "urgent and kinetic — motion blur, fast pace, adrenaline",
  "peaceful and meditative — silence, simplicity, open space",
];

const SIZE_MAP: Record<string, string> = {
  vertical: "1024x1536",
  horizontal: "1536x1024",
  square: "1024x1024",
};

/* ━━━━━ 헬퍼 ━━━━━ */
const fieldToString = (f: any): string => {
  if (!f) return "";
  if (Array.isArray(f))
    return f.map((item) => (typeof item === "object" && item.keyword ? item.keyword : String(item))).join(", ");
  if (typeof f === "object" && f.summary) return f.summary;
  return String(f);
};

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

const normalize = (tag: string) => tag.replace(/^@/, "");

/* ━━━━━ Legacy 프롬프트 빌더 (폴백용) ━━━━━ */
function buildLegacyMoodPrompt(opts: MoodGenerateOptions): string {
  const { briefAnalysis, scenes, assets, videoFormat, targetSceneNumber } = opts;

  const camera = pick(CAMERA_POOL);
  const lighting = pick(LIGHTING_POOL);
  const colorGrade = pick(COLOR_GRADE_POOL);
  const style = pick(VISUAL_STYLE_POOL);
  const moodTone = pick(MOOD_TONE_POOL);

  const formatNote =
    videoFormat === "vertical"
      ? "vertical 9:16 mobile-first composition"
      : videoFormat === "horizontal"
        ? "horizontal 16:9 widescreen composition"
        : "square 1:1 social media composition";

  const parts: string[] = [
    `Camera: ${camera}`,
    `Lighting: ${lighting}`,
    `Color grade: ${colorGrade}`,
    `Visual style: ${style}`,
    `Mood: ${moodTone}`,
  ];

  const scenePool = targetSceneNumber != null ? scenes.filter((s) => s.scene_number === targetSceneNumber) : scenes;

  if (scenePool.length > 0) {
    const scene = scenePool[Math.floor(Math.random() * scenePool.length)];
    if (scene.mood) parts.push(`Scene mood: ${scene.mood}`);
    if (scene.location) parts.push(`Location: ${scene.location.replace(/@/g, "")}`);
    if (scene.description) parts.push(`Scene content: ${scene.description.replace(/@/g, "")}`);

    const activeTags = filterActiveTags(scene);
    if (activeTags.length) {
      const descs = activeTags
        .map((tag) => {
          const a = assets.find(
            (asset) =>
              asset.tag_name === tag || asset.tag_name === `@${tag}` || normalize(asset.tag_name) === normalize(tag),
          );
          if (!a) return null;
          if (a.asset_type === "character" || !a.asset_type)
            return `${normalize(a.tag_name)}: ${a.ai_description ?? a.tag_name}${
              a.outfit_description ? `, wearing ${a.outfit_description}` : ""
            }`;
          if (a.asset_type === "background") return `Setting: ${a.space_description ?? a.ai_description ?? ""}`;
          return `${normalize(a.tag_name)}: ${a.ai_description ?? ""}`;
        })
        .filter(Boolean);
      if (descs.length) parts.push(descs.join(". "));
    }
  } else {
    if (briefAnalysis) {
      const tone = fieldToString(briefAnalysis.tone_manner);
      const goal = fieldToString(briefAnalysis.goal);
      const usp = fieldToString(briefAnalysis.usp);
      const idea = briefAnalysis.idea_note;
      if (goal) parts.push(`Campaign goal: ${goal}`);
      if (tone) parts.push(`Brand tone: ${tone}`);
      if (usp && Math.random() > 0.5) parts.push(`Key message: ${usp}`);
      if (idea && Math.random() > 0.5) parts.push(`Creative direction: ${idea}`);
    }

    const characters = assets.filter((a) => !a.asset_type || a.asset_type === "character");
    if (characters.length > 0) {
      const char = pick(characters);
      parts.push(
        `Subject: ${char.ai_description ?? char.tag_name}${
          char.outfit_description ? `, wearing ${char.outfit_description}` : ""
        }`,
      );
    }

    const backgrounds = assets.filter((a) => a.asset_type === "background");
    if (backgrounds.length > 0 && Math.random() > 0.4) {
      const bg = pick(backgrounds);
      parts.push(`Environment: ${bg.space_description ?? bg.ai_description ?? ""}`);
    }
  }

  parts.push(formatNote);
  parts.push(
    "Cinematic storyboard reference frame, film still quality, professional photography. " +
      "This is a mood reference image — prioritize atmosphere, composition, and color direction.",
  );

  return parts.filter(Boolean).join(". ");
}

/* ━━━━━ Stage 1: Claude 시네마틱 연출 ━━━━━ */

interface CineShotDescription {
  full_prompt: string;
  composition: string;
  camera: string;
  lens: string;
  lighting: string;
  mood: string;
}

/** Camera variant for a single mood shot — angle, lens, composition
 *  pre-assigned so each shot in a batch explores a distinct cinematic
 *  choice. Mood ideation's whole point is angle/composition reference,
 *  so the camera axis is the variety axis while scene content stays
 *  pinned by ShotAssignment.scene. */
interface CameraVariant {
  label: string;
  camera: string;
  lens: string;
  composition: string;
}

/** Ordered pool of 10 visually distinct variants. A mood batch cycles
 *  through this list so shots that share a scene still land on
 *  different angles/lenses/compositions. The order is intentional:
 *  wide → medium → extreme close → low → high → OTS → dutch → foreground
 *  occlusion → silhouette → reflection. In a typical 9-shot batch this
 *  covers roughly one of each archetypal coverage slot. */
const MOOD_CAMERA_VARIANTS: CameraVariant[] = [
  {
    label: "WIDE ESTABLISHING",
    camera: "wide establishing shot at eye level, static frame",
    lens: "24mm f/5.6 deep focus, spacious environment visible front-to-back",
    composition: "leading lines",
  },
  {
    label: "MEDIUM — RULE OF THIRDS",
    camera: "medium shot at eye level, slight push-in",
    lens: "50mm f/2.8 classic standard lens",
    composition: "rule of thirds",
  },
  {
    label: "EXTREME CLOSE-UP",
    camera: "extreme close-up on eyes, hands, or texture detail",
    lens: "100mm macro f/2.8, razor-thin focus plane",
    composition: "extreme detail — texture-driven, subject fills frame",
  },
  {
    label: "LOW-ANGLE HERO",
    camera: "low angle looking up at the subject, powerful and heroic",
    lens: "28mm f/4, slight wide-angle distortion emphasizing scale",
    composition: "worm's eye",
  },
  {
    label: "HIGH-ANGLE OVERHEAD",
    camera: "high angle, near-top-down overhead perspective",
    lens: "35mm f/5.6, flattened perspective",
    composition: "overhead flat lay",
  },
  {
    label: "OVER THE SHOULDER",
    camera: "over-the-shoulder intimate coverage, shallow focus on subject",
    lens: "85mm f/1.8 shallow DOF, creamy bokeh background",
    composition: "OTS rack focus",
  },
  {
    label: "DUTCH TILT",
    camera: "dutch angle, 15–20° lateral tilt, hand-held kinetic energy",
    lens: "35mm f/2.8",
    composition: "dutch angle",
  },
  {
    label: "FOREGROUND OCCLUSION",
    camera: "shot through a foreground element — window frame, leaves, bars, glass",
    lens: "50mm f/1.4, foreground melted into soft bokeh",
    composition: "frame within frame / foreground bokeh",
  },
  {
    label: "SILHOUETTE / NEGATIVE SPACE",
    camera: "profile silhouette against a bright or graphic background",
    lens: "85mm f/2.8 telephoto compression",
    composition: "silhouette, negative space",
  },
  {
    label: "REFLECTION",
    camera: "reflection in water, glass, or mirror — subject shown indirectly",
    lens: "35mm f/2.8",
    composition: "reflection",
  },
];

/** One shot's full scope: the scene it represents + the assets that may
 *  appear in it + the pre-assigned camera variant. Built up-front so
 *  Claude context, reference image list, asset appendix, and camera
 *  directive are all sourced from the same truth and stay consistent. */
interface ShotAssignment {
  scene: MoodGenerateOptions["scenes"][number] | null;
  tagged: MoodGenerateOptions["assets"];
  variant: CameraVariant;
}

const FORMAT_COMPOSITION_HINTS: Record<string, string> = {
  vertical:
    "FORMAT RULE — 9:16 VERTICAL: Favor portrait-oriented compositions. " +
    "Use center-weighted verticals, tall negative space above or below subject, " +
    "stacked depth layers (feet → face → sky), and strong top-to-bottom leading lines. " +
    "Avoid wide horizontal compositions — fill the vertical frame deliberately.",
  horizontal:
    "FORMAT RULE — 16:9 HORIZONTAL: Favor wide establishing shots and panoramic depth layers. " +
    "Use rule-of-thirds horizontal placement, side-to-side leading lines, " +
    "and environmental storytelling across the full width. " +
    "Avoid center-locked portrait framing — use the horizontal canvas.",
  square:
    "FORMAT RULE — 1:1 SQUARE: Favor centered symmetry, overhead flat lays, or tight close-ups. " +
    "The equal frame rewards bold graphic compositions — strong shapes, center subjects, " +
    "or deliberate corner anchoring. Avoid wide landscape or tall portrait framings.",
};

/** Strip leading "@" from tag mentions inside scene copy. */
const cleanTagsInText = (text: string): string => text.replace(/@([\w가-힣-]+)/g, "$1");

/** Video format / brief preamble used by both single-scene and shot-plan
 *  contexts. Extracted so the preamble is identical regardless of mode. */
function buildBriefPreamble(opts: MoodGenerateOptions): string {
  const { briefAnalysis, videoFormat, targetSceneNumber } = opts;
  const lines: string[] = [];

  const formatLabel =
    videoFormat === "vertical"
      ? "9:16 vertical (mobile)"
      : videoFormat === "horizontal"
        ? "16:9 horizontal (widescreen)"
        : "1:1 square";
  lines.push(`VIDEO FORMAT: ${formatLabel}`);

  if (briefAnalysis) {
    if (briefAnalysis.reference_mood) {
      lines.push(`\nREFERENCE MOOD (use as primary visual atmosphere guide):\n${briefAnalysis.reference_mood}`);
    }

    const vd = briefAnalysis.visual_direction;
    if (vd && typeof vd === "object") {
      const vdLines: string[] = [];
      if (vd.camera) vdLines.push(`  Camera style: ${vd.camera}`);
      if (vd.lighting) vdLines.push(`  Lighting style: ${vd.lighting}`);
      if (vd.color_grade) vdLines.push(`  Color grade: ${vd.color_grade}`);
      if (vd.editing) vdLines.push(`  Editing rhythm: ${vd.editing}`);
      if (vdLines.length) lines.push(`\nVISUAL DIRECTION (align shots to this direction):\n${vdLines.join("\n")}`);
    } else if (typeof vd === "string" && vd) {
      lines.push(`\nVISUAL DIRECTION: ${vd}`);
    }

    const sf = briefAnalysis.scene_flow;
    if (sf && typeof sf === "object" && targetSceneNumber == null) {
      const sfLines: string[] = [];
      if (sf.hook?.description) sfLines.push(`  HOOK: ${sf.hook.description}`);
      if (sf.body?.description) sfLines.push(`  BODY: ${sf.body.description}`);
      if (sf.cta?.description) sfLines.push(`  CTA: ${sf.cta.description}`);
      if (sfLines.length) lines.push(`\nSTORY FLOW STRUCTURE:\n${sfLines.join("\n")}`);
    }
  }

  return lines.join("\n");
}

/** Single-scene context: Claude makes N variations of the same scene —
 *  all share the same tagged_assets / headcount, but each shot gets a
 *  distinct pre-assigned CameraVariant so angle/lens/composition stay
 *  varied (mood's primary purpose). */
function buildSingleSceneContext(opts: MoodGenerateOptions, assignments: ShotAssignment[]): string {
  const { scenes, assets, targetSceneNumber } = opts;
  const lines: string[] = [buildBriefPreamble(opts)];

  const scene = scenes.find((s) => s.scene_number === targetSceneNumber);
  if (!scene) return lines.join("\n");

  lines.push(
    `\n⚠️ SINGLE SCENE MODE — You are generating ${opts.count ?? 1} shot variations for ONE specific scene.`,
  );
  lines.push(`SCENE FIDELITY (cast, props, location) IS LOCKED.`);
  lines.push(
    `All shots share the same subject and setting. The VARIETY axis is the CAMERA — each shot uses a different angle / lens / composition assigned below.`,
  );
  lines.push(
    `Do NOT reinterpret, substitute, or upgrade the scene's cast, props, or location. Do NOT override the assigned camera variant.`,
  );
  lines.push(`\nSCENE DIRECTIVE:`);
  const sl: string[] = [];
  if (scene.title) sl.push(`Title: ${scene.title}`);
  if (scene.description) sl.push(`Description (EXECUTE LITERALLY): ${cleanTagsInText(scene.description)}`);
  if (scene.mood) sl.push(`Mood: ${scene.mood}`);
  if (scene.location) sl.push(`Location: ${cleanTagsInText(scene.location)}`);
  // NOTE: scene.camera_angle is intentionally omitted. Mood ideation's
  // whole purpose is to explore DIFFERENT angles than the conti shot —
  // echoing the conti camera choice here forced Claude toward a single
  // uniform composition across all N variations.
  lines.push(`  ` + sl.join(" | "));

  const activeTagsForDetails = filterActiveTags(scene);
  if (activeTagsForDetails.length > 0) {
    const taggedAssetDetails = activeTagsForDetails
      .map((tag) => {
        const a = assets.find(
          (asset) =>
            asset.tag_name === tag || asset.tag_name === `@${tag}` || normalize(asset.tag_name) === normalize(tag),
        );
        if (!a) return null;
        const name = normalize(a.tag_name);
        const type = a.asset_type ?? "character";
        const desc =
          type === "background"
            ? (a.space_description ?? a.ai_description ?? "")
            : `${a.ai_description ?? name}${a.outfit_description ? `, wearing ${a.outfit_description}` : ""}`;
        return `  - [${type}] ${name}: ${desc}`;
      })
      .filter(Boolean);

    if (taggedAssetDetails.length > 0) {
      lines.push(`\nREQUIRED ELEMENTS — ALL must appear simultaneously in EVERY shot:`);
      lines.push(...(taggedAssetDetails as string[]));
      if (taggedAssetDetails.length >= 2) {
        lines.push(
          `→ These ${taggedAssetDetails.length} elements MUST co-exist in the same frame. None may be omitted.`,
        );
        lines.push(`→ Compose the spatial relationship between them based on the scene description above.`);
      } else {
        lines.push(`→ This element MUST be visibly present and clearly recognizable in every shot.`);
      }
      lines.push(
        `→ Do NOT add extra characters, props, or locations that are not listed above — this scene's headcount is exactly what is tagged.`,
      );
    }
  }

  lines.push(...buildSketchHighlightNote(scene));

  lines.push(`\nASSIGNED CAMERA VARIANTS — each shot (in array order) MUST use its variant. No two shots may share a variant.`);
  assignments.forEach((a, i) => {
    lines.push(
      `  Shot ${i + 1}: ${a.variant.label}\n    Camera: ${a.variant.camera}\n    Lens: ${a.variant.lens}\n    Composition: ${a.variant.composition}`,
    );
  });
  lines.push(
    `→ The scene content is identical across shots; only the camera axis changes. Execute each variant literally — do NOT default to a safer standard angle.`,
  );

  return lines.join("\n");
}

function buildSketchHighlightNote(
  scene: MoodGenerateOptions["scenes"][number],
): string[] {
  if (!scene.is_highlight) return [];
  const lines = [
    `\nKEY VISUAL EMPHASIS — SOFT SIGNAL`,
    `This scene is marked as a Highlight / key visual candidate.`,
  ];
  if (scene.highlight_kind) lines.push(`Highlight type: ${scene.highlight_kind}`);
  if (scene.highlight_reason) lines.push(`Reason: ${cleanTagsInText(scene.highlight_reason)}`);
  lines.push(
    `Across the sketch candidates, let 1-2 options feel more suitable as a representative image for the scene.`,
  );
  lines.push(
    `Prioritize clear subject hierarchy, recognizable silhouette, expressive body language, depth layering, distinctive lighting/color accent, and uncluttered negative space.`,
  );
  lines.push(
    `Keep cast, props, and location locked. Do not force a generic centered close-up or stock hero pose.`,
  );
  return lines;
}

/** Multi-scene shot plan: one row per shot, explicitly pinned to a
 *  specific scene so Claude can't invent cross-scene compositions.
 *
 *  Why this exists: when Claude was given a single "STORY OVERVIEW"
 *  plus a flat ASSETS list, it freely combined assets that never
 *  co-appear in any scene (e.g. rendering all 3 characters in one
 *  frame even when no scene has that). Pinning each shot to a single
 *  scene + that scene's tagged_assets stops that hallucination cold. */
function buildShotPlanContext(opts: MoodGenerateOptions, assignments: ShotAssignment[]): string {
  const lines: string[] = [buildBriefPreamble(opts)];

  lines.push(`\nSHOT PLAN — ${assignments.length} shots total.`);
  lines.push(
    `Each shot below is PINNED to one specific scene. The shot MUST faithfully execute ONLY that scene's description and MUST contain ONLY that scene's tagged elements.`,
  );
  lines.push(
    `Do NOT merge characters, props, or locations across scenes. Do NOT add any person or object that is not tagged in the shot's assigned scene.`,
  );
  lines.push(
    `Your JSON array output MUST have exactly ${assignments.length} entries in the SAME ORDER as this plan — array index N corresponds to SHOT ${assignments[0] ? 1 : 0}+N below.`,
  );

  assignments.forEach((a, i) => {
    const scene = a.scene;
    const tagLine =
      a.tagged.length > 0
        ? a.tagged
            .map((t) => {
              const type = t.asset_type ?? "character";
              const name = normalize(t.tag_name);
              const short =
                type === "background"
                  ? (t.space_description ?? t.ai_description ?? "")
                  : `${t.ai_description ?? ""}${t.outfit_description ? `, wearing ${t.outfit_description}` : ""}`;
              return `${name} [${type}]${short ? ` — ${short.slice(0, 120)}` : ""}`;
            })
            .join("; ")
        : "(no tagged assets — pure environment / atmosphere shot)";

    const headcountHint = (() => {
      const chars = a.tagged.filter((t) => (t.asset_type ?? "character") === "character");
      if (chars.length === 0) return "No characters in frame.";
      if (chars.length === 1) return "Exactly ONE character in frame — do NOT add other people.";
      return `Exactly ${chars.length} characters in frame (the ones listed above) — no extras, no crowd.`;
    })();

    lines.push(
      `\nSHOT ${i + 1} → Scene ${scene.scene_number}${scene.title ? ` "${scene.title}"` : ""}`,
    );
    if (scene.description) lines.push(`  Description (RENDER LITERALLY): ${cleanTagsInText(scene.description)}`);
    if (scene.location) lines.push(`  Location: ${cleanTagsInText(scene.location)}`);
    if (scene.mood) lines.push(`  Mood: ${scene.mood}`);
    // NOTE: scene.camera_angle deliberately NOT forwarded. Mood's job is
    // to explore *alternative* angles to the conti shot; echoing the
    // conti camera here caused every shot pinned to the same scene to
    // converge on one composition. The Camera directive below (pre-
    // assigned per shot) is the sole angle source.
    lines.push(`  Required elements (ONLY these): ${tagLine}`);
    lines.push(`  Headcount rule: ${headcountHint}`);
    lines.push(
      `  Camera directive: ${a.variant.label} — ${a.variant.camera} | Lens: ${a.variant.lens} | Composition: ${a.variant.composition}`,
    );
    lines.push(
      `    → Execute this camera variant literally. Do NOT fall back to a standard angle. No other shot uses the same variant.`,
    );
  });

  return lines.join("\n");
}

/* ━━━━━ 시스템 프롬프트 빌더 ━━━━━ */

const SYSTEM_PROMPT_BASE_CREATIVE = `You are an elite cinematic director and director of photography. You create vivid, highly specific shot descriptions for mood reference image generation.

For each shot you MUST specify ALL 6 elements:
1. CAMERA: shot type + angle + movement (e.g., "low-angle tracking shot, steadicam, slightly pushing in")
2. LENS: focal length + depth of field (e.g., "85mm f/1.4 shallow DOF, background melted into creamy bokeh")
3. COMPOSITION: composition technique from the approved list
4. DEPTH_LAYERS: foreground / midground / background description (e.g., "FG: out-of-focus leaves, MG: subject standing, BG: city skyline at dusk")
5. LIGHTING: direction + quality + color temperature (e.g., "side-lit golden hour, warm amber key, cool fill from open sky")
6. MOOD: cinematic reference or emotional tone (e.g., "Blade Runner 2049 isolation", "Wes Anderson symmetry")

COMPOSITION TECHNIQUES (use from this pool, no repeats across shots):
rule of thirds, center symmetry, frame within frame, leading lines, negative space, foreground bokeh, dutch angle, overhead flat lay, reflection, split composition, silhouette, depth layering, worm's eye, OTS rack focus, anamorphic flare

DIVERSITY RULES (CRITICAL):
- No two shots may use the same composition technique
- At least 1 extreme close-up (eyes, hands, texture detail)
- At least 1 wide/establishing shot
- At least 1 unconventional angle (dutch tilt, worm's eye, reflection, overhead)
- At least 1 foreground occlusion shot (shooting through/between objects)
- Lens variety: at least 1 wide-angle (24mm or below), 1 standard (35-50mm), 1 telephoto (85mm+)

BRIEF ALIGNMENT (IMPORTANT):
- REFERENCE MOOD in the context is your primary atmosphere guide — let it define the emotional palette of your shots
- VISUAL DIRECTION camera/lighting/color_grade fields tell you the intended style — honor them, do not contradict
- Distribute shots across the STORY FLOW (hook / body / cta) if provided

OUTPUT FORMAT: Return ONLY a valid JSON array. No markdown, no code fences.
Each element: {"full_prompt": "2-4 sentence vivid visual description in English", "composition": "technique used", "camera": "shot+angle+movement", "lens": "focal+dof", "lighting": "direction+quality+color", "mood": "cinematic reference"}

Write full_prompt as a rich, visual, English-only description that an image generation AI can directly use. Include subject, environment, lighting, color palette, texture, and atmosphere. Do NOT include technical metadata in full_prompt — keep it purely descriptive and evocative.`;

const SYSTEM_PROMPT_BASE_ASSET = `You are an elite cinematic director and director of photography. You create vivid, highly specific shot descriptions for mood reference image generation.

IMPORTANT: Reference images of actual characters and backgrounds will be provided to the image generator.
Your full_prompt MUST include specific placement instructions for these characters:
- Where in the frame each character appears (left third, center, background, etc.)
- Their pose, action, and interaction with environment
- How they relate to the camera angle you've chosen
Do NOT describe character appearance (the reference images handle that).
Instead focus on: position in frame, body language, scale relative to environment, and interaction with lighting.

For each shot you MUST specify ALL 6 elements:
1. CAMERA: shot type + angle + movement (e.g., "low-angle tracking shot, steadicam, slightly pushing in")
2. LENS: focal length + depth of field (e.g., "85mm f/1.4 shallow DOF, background melted into creamy bokeh")
3. COMPOSITION: composition technique from the approved list
4. DEPTH_LAYERS: foreground / midground / background description (e.g., "FG: out-of-focus leaves, MG: subject standing, BG: city skyline at dusk")
5. LIGHTING: direction + quality + color temperature (e.g., "side-lit golden hour, warm amber key, cool fill from open sky")
6. MOOD: cinematic reference or emotional tone (e.g., "Blade Runner 2049 isolation", "Wes Anderson symmetry")

COMPOSITION TECHNIQUES (use from this pool, no repeats across shots):
rule of thirds, center symmetry, frame within frame, leading lines, negative space, foreground bokeh, dutch angle, overhead flat lay, reflection, split composition, silhouette, depth layering, worm's eye, OTS rack focus, anamorphic flare

DIVERSITY RULES (CRITICAL):
- No two shots may use the same composition technique
- At least 1 extreme close-up (eyes, hands, texture detail)
- At least 1 wide/establishing shot
- At least 1 unconventional angle (dutch tilt, worm's eye, reflection, overhead)
- At least 1 foreground occlusion shot (shooting through/between objects)
- Lens variety: at least 1 wide-angle (24mm or below), 1 standard (35-50mm), 1 telephoto (85mm+)

BRIEF ALIGNMENT (IMPORTANT):
- REFERENCE MOOD in the context is your primary atmosphere guide — let it define the emotional palette of your shots
- VISUAL DIRECTION camera/lighting/color_grade fields tell you the intended style — honor them, do not contradict
- Distribute shots across the STORY FLOW (hook / body / cta) if provided

OUTPUT FORMAT: Return ONLY a valid JSON array. No markdown, no code fences.
Each element: {"full_prompt": "2-4 sentence vivid visual description in English focusing on FRAMING and PLACEMENT, not character appearance", "composition": "technique used", "camera": "shot+angle+movement", "lens": "focal+dof", "lighting": "direction+quality+color", "mood": "cinematic reference"}

Write full_prompt as a rich, visual, English-only description that an image generation AI can directly use. Focus on framing, positioning, body language, environment, lighting, color palette, texture, and atmosphere. Do NOT describe what characters look like — only WHERE they are and WHAT they do.`;

const SINGLE_SCENE_PRIORITY = `CRITICAL OVERRIDE — SINGLE SCENE MODE:
SCENE FIDELITY IS THE ABSOLUTE FIRST PRIORITY.
Your job is to faithfully execute the given scene description across multiple shot variations.
All REQUIRED ELEMENTS listed in the context MUST appear in every single shot — no exceptions.
If 2+ elements are listed, they MUST co-exist in the same frame simultaneously.
Cinematic style (angle, lens, lighting) must SERVE the scene content. Never override it.
Do NOT omit any required element. Do NOT substitute with similar alternatives.

`;

function buildSystemPrompt(isAssetMode: boolean, videoFormat: string, isSingleSceneMode = false): string {
  const base = isAssetMode ? SYSTEM_PROMPT_BASE_ASSET : SYSTEM_PROMPT_BASE_CREATIVE;
  const formatHint = FORMAT_COMPOSITION_HINTS[videoFormat] ?? FORMAT_COMPOSITION_HINTS.horizontal;
  const prefix = isSingleSceneMode ? SINGLE_SCENE_PRIORITY : "";
  return `${prefix}${base}\n\n${KNOWLEDGE_MOOD_CINEMATICS}\n\n${formatHint}`;
}

async function generateCineShotDescriptions(
  opts: MoodGenerateOptions,
  count: number,
  assignments: ShotAssignment[],
): Promise<CineShotDescription[] | null> {
  try {
    const model = opts.model ?? MOOD_IMAGE_MODEL_DEFAULT;
    const isAssetMode = opts.forceAssetRefs || MOOD_MODEL_USES_ASSET_REFS[model];
    const isSingleSceneMode = opts.targetSceneNumber != null;
    const systemPrompt = buildSystemPrompt(isAssetMode, opts.videoFormat, isSingleSceneMode);

    // Has at least one shot pinned to a real scene? If so we go through
    // the strict shot-plan path (each shot is scoped to exactly one
    // scene's content). Otherwise fall back to the brief-only prompt.
    const hasScenes = assignments.some((a) => a.scene !== null);

    let userMessage: string;
    if (isSingleSceneMode) {
      const context = buildSingleSceneContext(opts, assignments);
      userMessage = `Based on the following scene directive, generate exactly ${count} cinematic shot variations as a JSON array.

${context}

CRITICAL:
- Every shot MUST include ALL REQUIRED ELEMENTS simultaneously in the same frame.
- Array index N corresponds to Shot N+1 in the ASSIGNED CAMERA VARIANTS list. Each shot's full_prompt MUST execute its assigned variant literally (angle + lens + composition).
- The scene cast/props/location are LOCKED across all ${count} shots. Only the camera axis varies.
- Do NOT substitute an easier standard angle. No two shots may share a variant.
- Output ONLY the JSON array.`;
    } else if (hasScenes) {
      const context = buildShotPlanContext(opts, assignments);
      userMessage = `Generate exactly ${count} cinematic shots as a JSON array. The array index MUST match the SHOT number in the plan below.

${context}

CRITICAL RULES:
- Shot N renders ONLY scene N's description. Never merge characters, props, or locations across different shots/scenes.
- Respect each shot's Headcount rule exactly — do not invent extra people or crowds.
- Each shot's full_prompt MUST literally execute its pre-assigned Camera directive (angle + lens + composition). Do NOT substitute a standard angle or ignore the directive.
- full_prompt MUST literally execute the assigned scene's Description. Do not reinterpret or expand the cast.
- No two shots may share a Camera directive label.
- Output ONLY the JSON array with exactly ${count} entries in plan order.`;
    } else {
      // No scenes at all — very early in a project. Keep the old
      // brief-only behaviour so Claude can still produce mood refs.
      const context = buildBriefPreamble(opts);
      userMessage = `Based on the following project brief, generate exactly ${count} cinematic shot descriptions as a JSON array.

${context}

Remember: ALL ${count} shots must have unique composition techniques. Ensure lens and angle diversity as specified. Align the atmosphere and color palette with the REFERENCE MOOD and VISUAL DIRECTION provided. Output ONLY the JSON array.`;
    }

    const { data, error } = await supabase.functions.invoke("claude-proxy", {
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content: userMessage }],
        system: systemPrompt,
      },
    });

    if (error || !data) {
      console.warn("Claude proxy call failed:", error?.message);
      return null;
    }

    const textBlock = data.content?.find((b: any) => b.type === "text");
    const rawText = textBlock?.text ?? "";
    if (!rawText) {
      console.warn("Claude returned empty text");
      return null;
    }

    const jsonStr = rawText
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.warn("Claude returned non-array or empty array");
      return null;
    }

    const valid = parsed.filter(
      (item: any) => typeof item === "object" && typeof item.full_prompt === "string" && item.full_prompt.length > 10,
    );

    return valid.length > 0 ? (valid as CineShotDescription[]) : null;
  } catch (err) {
    console.warn("Claude cinematic pipeline failed:", err);
    return null;
  }
}

/* ━━━━━ Asset mode helpers ━━━━━
 *
 * Mood ideation originally told Claude to *not* describe asset appearance
 * (the system prompt says "the reference images handle that"). In
 * practice this fails for multi-asset scenes because:
 *   1) `/v1/images/edits` caps attached image[] entries — when a scene
 *      has background + 2 characters + weapon + mood ref, some refs
 *      get dropped and there is no text anchor to recover the identity.
 *   2) Items (props / weapons) were enumerated AFTER characters and
 *      backgrounds, so they were always the first to fall off the cap.
 *   3) The prompt used *all* project assets for refs, not just the ones
 *      actually tagged by the scene, diluting relevance further.
 *
 * Fix — mirror the conti pipeline:
 *   - Build a conti-style "ASSET REQUIREMENTS" appendix with identity +
 *     outfit + "MUST be visible" anchors, and concatenate it into the
 *     final gpt-image prompt. That way the text alone already carries
 *     enough identity detail to reconstruct the scene even if a ref is
 *     dropped at the edits endpoint.
 *   - In single-scene mode, resolve `scene.tagged_assets` first and
 *     place those photos at the head of the ref list so they always
 *     survive the cap.
 */

/** Distribute `count` shots across the scene pool, round-robin. Each
 *  shot gets its own `ShotAssignment` so downstream prompt + ref + appendix
 *  construction stays strictly per-scene.
 *
 *  - Single-scene mode (`targetSceneNumber != null`): every shot points
 *    at that one scene (all variations share the same tagged assets).
 *  - Multi-scene: cycles through `scenes` so each scene gets roughly
 *    `count / scenes.length` shots, preserving narrative coverage.
 *  - No scenes at all: returns a list of empty assignments; the caller
 *    falls back to brief-only prompts. */
function buildShotAssignments(opts: MoodGenerateOptions, count: number): ShotAssignment[] {
  const pool =
    opts.targetSceneNumber != null
      ? opts.scenes.filter((s) => s.scene_number === opts.targetSceneNumber)
      : opts.scenes;
  // Camera variants cycle through the full pool. We also shuffle the
  // starting offset per batch so consecutive regenerations don't always
  // start on "WIDE ESTABLISHING" — otherwise users would see the same
  // lead shot every time.
  const variantOffset = Math.floor(Math.random() * MOOD_CAMERA_VARIANTS.length);
  const pickVariant = (i: number) =>
    MOOD_CAMERA_VARIANTS[(variantOffset + i) % MOOD_CAMERA_VARIANTS.length];

  if (pool.length === 0) {
    return Array.from({ length: count }, (_, i) => ({
      scene: null,
      tagged: [],
      variant: pickVariant(i),
    }));
  }
  return Array.from({ length: count }, (_, i) => {
    const scene = pool[i % pool.length];
    return {
      scene,
      tagged: resolveTaggedAssets(opts.assets, filterActiveTags(scene)),
      variant: pickVariant(i),
    };
  });
}

/** Belt-and-suspenders: drop `scene.tagged_assets` entries that no
 *  longer appear as `@mentions` in the scene's description/location
 *  text. Mirrors the guard in conti.ts `generateConti`. Fixes the
 *  "untagged character still appears" symptom on duplicated scenes
 *  whose `tagged_assets` column still carries ancestor cast. */
function filterActiveTags(scene: {
  description?: string | null;
  location?: string | null;
  tagged_assets?: string[];
}): string[] {
  if (!scene.tagged_assets || scene.tagged_assets.length === 0) return [];
  const text = `${scene.description ?? ""} ${scene.location ?? ""}`;
  const mentionTokens = (text.match(/@[\w가-힣-]+/g) ?? []).map((m) => m.slice(1).toLowerCase());
  if (mentionTokens.length === 0) return [];
  return scene.tagged_assets.filter((tag) => {
    const name = (tag.startsWith("@") ? tag.slice(1) : tag).toLowerCase();
    return mentionTokens.some((tok) => tok === name || tok.startsWith(name));
  });
}

/** Fuzzy-match `tag` (with or without leading `@`) to one of the
 *  project's assets. Mirrors the loose equality used by conti's
 *  `fetchTaggedAssets`. */
function resolveTaggedAssets(
  assets: MoodGenerateOptions["assets"],
  taggedRaw: string[] | undefined,
): MoodGenerateOptions["assets"] {
  if (!taggedRaw || taggedRaw.length === 0) return [];
  const out: MoodGenerateOptions["assets"] = [];
  const seen = new Set<string>();
  for (const t of taggedRaw) {
    const a = assets.find(
      (asset) =>
        asset.tag_name === t ||
        asset.tag_name === `@${t}` ||
        normalize(asset.tag_name) === normalize(t),
    );
    if (a && !seen.has(a.tag_name)) {
      out.push(a);
      seen.add(a.tag_name);
    }
  }
  return out;
}

/** Conti-style asset requirement appendix. Only includes assets that
 *  will also be sent as reference photos, so the "[Reference image
 *  provided — …]" marker stays truthful. */
function buildMoodAssetAppendix(
  assets: MoodGenerateOptions["assets"],
  refUrls: string[],
): string {
  if (!assets || assets.length === 0) return "";
  const refSet = new Set(refUrls);
  const hasRef = (a: MoodGenerateOptions["assets"][number]) => !!a.photo_url && refSet.has(a.photo_url);

  const characters = assets.filter((a) => (a.asset_type ?? "character") === "character");
  const items = assets.filter((a) => a.asset_type === "item");
  const backgrounds = assets.filter((a) => a.asset_type === "background");
  const sections: string[] = [];

  if (characters.length > 0) {
    const lines = characters.map((a) => {
      const name = normalize(a.tag_name);
      const rows = [
        `• ${name}:${
          hasRef(a)
            ? " [REFERENCE IMAGE PROVIDED] Preserve ONLY the facial identity — face shape, skin tone, hair color and style. Pose, expression, gaze, head tilt, and body orientation MUST follow THIS shot's assigned camera variant and the scene's action — do NOT copy pose or expression from the reference photo."
            : a.ai_description
              ? ` ${a.ai_description}`
              : ""
        }`,
        a.outfit_description ? `  OUTFIT: ${a.outfit_description}` : "",
        a.ai_description && hasRef(a) ? `  Appearance notes: ${a.ai_description}` : "",
      ].filter(Boolean);
      return rows.join("\n");
    });
    sections.push(
      `[CHARACTERS — IDENTITY CONSISTENCY]\nThe following characters appear in this shot. Preserve their facial identity; stage their pose and expression fresh per this shot's camera variant and scene action.\n` +
        lines.join("\n"),
    );
  }

  if (items.length > 0) {
    const lines = items.map((a) => {
      const name = normalize(a.tag_name);
      const desc = a.ai_description ?? "as described by tag name";
      return (
        `• ${name}: ${desc}\n` +
        `  → THIS ITEM MUST BE VISIBLY PRESENT AND CLEARLY RECOGNIZABLE IN THE FRAME.` +
        (hasRef(a) ? " [Reference image provided — match the item's design.]" : "")
      );
    });
    sections.push(`[PROPS — MUST BE VISIBLE AND IDENTIFIABLE]\n${lines.join("\n")}`);
  }

  if (backgrounds.length > 0) {
    const lines = backgrounds.map((a) => {
      const name = normalize(a.tag_name);
      const desc = a.space_description ?? a.ai_description ?? "as described by tag name";
      return (
        `• ${name}: ${desc}` +
        (hasRef(a)
          ? "\n  → [Reference image provided] Match the location's architectural features, materials, and color palette. Frame the shot per this shot's assigned camera variant — do NOT reproduce the reference's camera angle or composition."
          : "")
      );
    });
    sections.push(
      `[BACKGROUND / LOCATION — SPATIAL IDENTITY]\n${lines.join("\n")}\n— Framing/camera angle is set by this shot's assigned camera variant, not by the reference image.`,
    );
  }

  if (sections.length === 0) return "";
  const castLock = `\n\n═══ CAST LOCK (STRICT) ═══
The characters and objects listed in ASSET REQUIREMENTS above are the ONLY people and tangible objects allowed in this frame.
Do NOT add bystanders, extras, additional characters, pets, logos, brand signage, text, or props that are not explicitly listed.
If the scene implies someone/something off-camera, keep them off-camera.
═══════════════════════════════════`;
  return (
    `\n\n═══ ASSET REQUIREMENTS (HIGHEST PRIORITY) ═══\n` +
    sections.join("\n\n") +
    `\n═══════════════════════════════════════════` +
    castLock
  );
}

/** Build the ordered list of ref image URLs for ONE shot. Only the
 *  assets actually tagged in that shot's scene are passed as references,
 *  so gpt-image-2 / NB2 never sees off-scene people, props, or
 *  backgrounds that could bleed into the frame. Order mirrors how users
 *  typed the tags, which also matches conti's `fetchTaggedAssets`. */
function buildShotRefUrls(tagged: MoodGenerateOptions["assets"]): string[] {
  const MAX_REFS = 14;
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const a of tagged) {
    // 콘티 본생성(buildAssetImageUrls)과 동일하게 character_ref_mode 를 존중해
    // 보드/시트/원본을 고른다(없으면 photo_url 폴백). 과거엔 photo_url 만 읽어서
    // 보드로 등록한 캐릭터도 원본 사진이 참조로 들어가, 원본 배경의 소품 등이
    // 생성 이미지에 새어 들어오는 문제가 있었다.
    const u = pickCharacterRefUrl(a);
    if (!u || seen.has(u) || urls.length >= MAX_REFS) continue;
    urls.push(u);
    seen.add(u);
  }
  return urls;
}

/** 모든 스케치 샷의 이미지 프롬프트 맨 앞에 붙는 시네마틱 + 구도 지시.
 *  구조화된 카메라 variant 는 Claude 의 컨텍스트로만 들어가고, 이미지 모델
 *  (특히 산문 가중치가 낮고 레퍼런스를 거의 복사하는 NB2) 에는 Claude 의
 *  full_prompt 산문만 도달한다. 그래서 여기서 각도/렌즈/구도를 명령형으로 다시
 *  못 박고(angle 다양성은 그대로 variant 가 담당), 평면화 방지 깊이/주피사체
 *  규칙과 film-still 품질 앵커를 더해 NB2 에서도 구도가 무너지지 않게 한다.
 *  전 모델 공통 적용. */
function buildSketchCinematicPrefix(variant?: CameraVariant): string {
  const cameraBlock = variant
    ? `CAMERA (execute literally — do NOT revert to a flat reference copy):
${variant.camera} | Lens: ${variant.lens} | Composition: ${variant.composition}
`
    : "";
  return `${cameraBlock}COMPOSITION DISCIPLINE: Build clear depth across foreground / midground / background — never a flat lineup. If 3 or more people appear, pick ONE primary subject and direct the others' gaze, body, or line of action toward that subject across distinct depth planes.
Cinematic film still, premium key-visual quality, dramatic directional lighting, intentional negative space, anamorphic depth.

`;
}

/* ━━━━━ 메인 함수 ━━━━━ */
export const generateMoodImages = async (
  opts: MoodGenerateOptions,
  onBatchDone?: (urls: string[]) => void,
): Promise<string[]> => {
  const count = opts.count ?? 9;
  const imageSize = SIZE_MAP[opts.videoFormat] ?? SIZE_MAP.horizontal;
  const model = opts.model ?? MOOD_IMAGE_MODEL_DEFAULT;
  const usesAssetRefs = opts.forceAssetRefs || MOOD_MODEL_USES_ASSET_REFS[model];

  // Pre-assign every shot to exactly one scene. This is the single
  // source of truth for the whole generation: Claude sees each
  // assignment as a pinned shot, and `generateOne` uses `assignments[idx]`
  // to scope refs + appendix to only that shot's tagged assets.
  //
  // The previous flat-context approach handed Claude the full asset
  // list with no per-shot boundary, so it would freely generate "3
  // characters together" shots even when no single scene had that
  // headcount. Pinning shots to scenes makes cross-scene hallucinations
  // structurally impossible — a shot simply has no way to reach assets
  // outside its assigned scene.
  const assignments = buildShotAssignments(opts, count);

  const cineShots = await generateCineShotDescriptions(opts, count, assignments);
  const useCinePipeline = cineShots !== null && cineShots.length > 0;

  // ★ 단일 이미지 호출 헬퍼
  const generateOne = async (idx: number): Promise<string> => {
    const assignment = assignments[idx] ?? { scene: null, tagged: [] };

    let prompt: string;
    if (useCinePipeline && idx < cineShots!.length) {
      // Claude 가 공들여 만든 시네마틱 묘사를 sanitize 하지 않고 그대로 전달.
      prompt = cineShots![idx].full_prompt;
    } else {
      prompt = buildLegacyMoodPrompt(opts);
    }

    // 각도 다양성은 variant 가 유지하되, 시네마틱/구도 지시를 이미지 모델에
    // 명시적으로 prepend 한다(특히 NB2 가 산문 속 구도 단서를 무시하는 문제 보정).
    prompt = buildSketchCinematicPrefix(assignments[idx]?.variant) + prompt;

    // Per-shot refs + appendix. We only ship the photos of assets
    // tagged in THIS shot's scene, and the appendix describes only
    // those same assets — so even if the edits endpoint drops a ref,
    // the text fallback is about the right people/props, and
    // gpt-image-2 can't be tempted by unrelated refs.
    const shotRefUrls = usesAssetRefs ? buildShotRefUrls(assignment.tagged) : [];
    const shotAppendix =
      usesAssetRefs && shotRefUrls.length > 0 ? buildMoodAssetAppendix(assignment.tagged, shotRefUrls) : "";
    if (shotAppendix) prompt = prompt + shotAppendix;

    const body: Record<string, any> = {
      prompt,
      projectId: opts.projectId,
      sceneNumber: -1,
      imageSize,
      quality: opts.quality ?? "high",
      inputFidelity: opts.inputFidelity ?? true,
      folder: "mood",
    };

    // 모델별 라우팅:
    //   gpt-image-1.5  → Mood 기본값은 text-only. 단, Sketches 처럼 forceAssetRefs
    //                     를 켠 호출은 edits 경로로 에셋 이미지를 함께 전달.
    //   gpt-image-2    → vision-aware GPT. 에셋 포토를 레퍼런스로 넘겨서
    //                     api-handlers 의 callGptVisionGenerate 경로로 흐름.
    //   nano-banana-2  → Vertex NB2. 에셋 레퍼런스 기반 생성.
    if (model === "nano-banana-2") {
      body.model = "nano-banana-2";
      if (shotRefUrls.length > 0) body.assetImageUrls = shotRefUrls;
    } else {
      body.model = "gpt";
      body.gptModel = model;
      if ((model === "gpt-image-2" || opts.forceAssetRefs) && shotRefUrls.length > 0) {
        body.assetImageUrls = shotRefUrls;
      }
    }

    const { data, error } = await supabase.functions.invoke("openai-image", { body });
    if (error || !data?.publicUrl) throw new Error(error?.message ?? "No URL returned");
    console.log(
      `[Mood] Image ${idx + 1} generated with: ${data.usedModel ?? "unknown"} (requested: ${model})`,
      assignment.scene
        ? { scene: assignment.scene.scene_number, taggedCount: assignment.tagged.length }
        : { scene: "none" },
    );
    return data.publicUrl as string;
  };

  const urls: string[] = [];
  const failures: unknown[] = [];

  // 동시 상한 없이 전체 이미지를 병렬로 띄운다. 시작 시점만 idx × STAGGER_MS 만큼
  // 엇갈려 launch burst (canvas/업로드/서버 호출) 를 분산하되, 결국 전부 동시
  // in-flight 가 되어 다량 생성을 최대한 병렬화한다. NB2 는 호출이 더 무거워
  // 살짝 더 넓은 간격을 둔다. (콘티 전체 생성 / 스타일 변형과 동일한 패턴)
  const STAGGER_MS = model === "nano-banana-2" ? 600 : 300;
  const settled = await Promise.allSettled(
    Array.from({ length: count }, (_, idx) =>
      (idx > 0
        ? new Promise((r) => setTimeout(r, idx * STAGGER_MS))
        : Promise.resolve()
      ).then(() =>
        generateOne(idx).then((url) => {
          onBatchDone?.([url]);
          return url;
        }),
      ),
    ),
  );
  for (const r of settled) {
    if (r.status === "fulfilled") urls.push(r.value);
    else {
      failures.push(r.reason);
      console.warn(`[Mood] ${model} image failed:`, r.reason);
    }
  }

  if (!urls.length) {
    throw new Error(failures.some(isSafetyRejection) ? SAFETY_REJECTION_ERROR : ALL_GENERATIONS_FAILED_ERROR);
  }

  // NOTE: 여기서 DB 에 직접 append 하지 않는다.
  //       MoodIdeationPanel 쪽의 persistMoodGenResultToDB 가
  //       skeletonIds 와 arrivedUrls 를 기반으로 최종 merge 를 책임진다.
  //       과거에 이 곳에서 [...existing, ...urls] 로 문자열을 append 했더니
  //       persist 단계에서 skel ID 기반 객체가 또 prepend 되어 같은 URL 이
  //       맨 위·맨 아래 모두에 중복 저장되던 버그가 있었음.

  return urls;
};
