import type { VideoFormat } from "@/lib/conti";
import { KR, KR_BG } from "@/lib/brand";

// ─── Color constants ───
export { KR, KR_BG };
export const KR_BG2 = "rgba(249,66,58,0.14)";
export const KR_BORDER2 = "rgba(249,66,58,0.20)";
export const NONE_ID = "__none__";

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

// ─── Types ───
/**
 * Sketch — a per-scene composition/draft image generated from the scene's
 * text description in ContiStudio's Sketches tab. Stored on the owning scene
 * row so the lifecycle is tied to that scene (scene delete → sketches gone).
 *
 * Role distinction vs `briefs.mood_image_urls` (Mood Ideation in the Ideation
 * tab): Mood is project-scoped tone exploration; Sketches are scene-scoped
 * compositional candidates you can promote into `conti_image_url`.
 */
export interface Sketch {
  id: string;
  url: string;
  /** Generator model used — "nano-banana-2" | "gpt-image-1.5" | "gpt-image-2".
   *  Kept free-form string so adding new models later does not widen this union. */
  model: string;
  createdAt: string;
  liked?: boolean;
}

/** One persisted Camera Variation 9-up grid in a scene's history. */
export interface CameraVariationGrid {
  id: string;
  /** Stored 3×3 grid image URL — re-split client-side into 9 tiles. */
  rawUrl: string;
  generatedAt: number;
}

/** Coerce a scene's `camera_variation_grid` (array, legacy single object, or
 *  null) into a clean `CameraVariationGrid[]`, dropping malformed entries. */
export function normalizeGridHistory(
  v: Scene["camera_variation_grid"] | undefined,
): CameraVariationGrid[] {
  if (Array.isArray(v)) {
    return v.filter((g): g is CameraVariationGrid => !!g && typeof g.rawUrl === "string");
  }
  if (v && typeof v === "object" && typeof (v as { rawUrl?: unknown }).rawUrl === "string") {
    const o = v as { rawUrl: string; generatedAt?: number; id?: string };
    return [{ id: o.id ?? "legacy", rawUrl: o.rawUrl, generatedAt: o.generatedAt ?? 0 }];
  }
  return [];
}

export interface Scene {
  id: string;
  project_id: string;
  scene_number: number;
  /** Scene-group number (1-based) shared by consecutive cuts in the same
   *  location/time/beat. Distinct from `scene_number` (= cut number): several
   *  cuts can share one `sequence`. Optional because legacy rows / version
   *  snapshots may not carry it; consumers fall back to location-run grouping. */
  sequence?: number | null;
  title: string | null;
  description: string | null;
  camera_angle: string | null;
  location: string | null;
  mood: string | null;
  duration_sec: number | null;
  tagged_assets: string[];
  conti_image_url: string | null;
  conti_image_history: string[];
  is_transition?: boolean;
  transition_type?: string | null;
  conti_image_crop?: any;
  /** 모션 모드 전용 키네틱 노트 — 컷 진입/이탈 핸드오프. 이미지 생성 프롬프트엔
   *  넣지 않는다(정지 프레임 품질 보존). 레거시 행엔 없을 수 있어 옵셔널. */
  motion_in?: string | null;
  motion_out?: string | null;
  /** 다음 컷으로의 추천 트랜지션 기법 키(TransitionKey) 또는 짧은 의도. */
  transition_to_next?: string | null;
  /** Per-scene Sketches; lives on the scene row so a scene delete cascades.
   *  Optional because legacy rows may not have the column yet. */
  sketches?: Sketch[];
  /** Persisted Camera Variation 9-up grid HISTORY for this scene. Each entry's
   *  `rawUrl` is a stored 3×3 grid image; the modal re-splits it into 9 tiles
   *  on open so results survive a refresh. "Generate again" appends a new entry
   *  (gallery history) rather than replacing. Legacy rows may hold a single
   *  object — `normalizeGridHistory` coerces both shapes to an array. */
  camera_variation_grid?: CameraVariationGrid[] | { rawUrl: string; generatedAt: number } | null;
  /** User-confirmed "final" marker. Dashboard progress counts only scenes
   *  with `is_final === true`. When every non-transition scene is final,
   *  ContiTab auto-promotes `projects.status` to `completed`; unmarking
   *  any demotes back to `active`. Legacy rows lack the column → treated
   *  as `false`. */
  is_final?: boolean;
  /** Marks a scene as a key visual candidate. This is a soft creative signal:
   *  generation should give the shot stronger composition/lighting attention,
   *  without forcing every highlight into the same hero-shot template. */
  is_highlight?: boolean;
  highlight_kind?: "hook" | "hero" | "product" | "emotion" | "cta" | null;
  highlight_reason?: string | null;
}

/**
 * Coerce a single scene's `sketches` field to a real `Sketch[]`.
 *
 * Some legacy `scene_versions.scenes` JSON snapshots have `sketches` stored as
 * the **string** `"[]"` (or even a JSON-encoded array string) instead of an
 * actual array. The symptoms in the UI are:
 *   · `SortableContiCard` reads `scene.sketches.length` → for a 2-char string
 *     `"[]"` that yields 2, so a phantom "2 sketches" badge appears even
 *     though the user never generated any.
 *   · Clicking the card opens `StudioSketchesTab` whose `useState<Sketch[]>`
 *     receives the string as-is, and the very next render calls
 *     `sketches.filter(...)` → `TypeError: sketches.filter is not a function`
 *     and the storyboard tab crashes into the error boundary.
 *
 * Normalising at the read boundary (after deserialisation, before the value
 * touches React state) fixes both symptoms in one place. We also try
 * `JSON.parse` for the rare case the string actually contains a stringified
 * array of real sketches — those should not be silently dropped.
 */
export function normalizeSceneSketches(scene: Scene): {
  scene: Scene;
  changed: boolean;
} {
  const raw = (scene as any).sketches;
  if (Array.isArray(raw)) return { scene, changed: false };
  if (raw === null || raw === undefined || raw === "") {
    // Treat absence/empty-string as "no sketches"; only mark changed if the
    // shape was non-array (so we know to re-persist sanitised JSON).
    if (raw === undefined) return { scene, changed: false };
    return { scene: { ...scene, sketches: [] }, changed: true };
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return { scene: { ...scene, sketches: parsed }, changed: true };
    } catch {
      /* fall through */
    }
    return { scene: { ...scene, sketches: [] }, changed: true };
  }
  // Any other shape (object, number, boolean…) is invalid → reset to empty.
  return { scene: { ...scene, sketches: [] }, changed: true };
}

/** Apply `normalizeSceneSketches` over an array, also reporting whether ANY
 *  scene was mutated. Caller can use the boolean to decide if the cleaned
 *  array should be re-persisted to scene_versions for self-healing. */
export function normalizeScenesSketches(scenes: Scene[]): {
  scenes: Scene[];
  changed: boolean;
} {
  let anyChanged = false;
  const out = scenes.map((s) => {
    const r = normalizeSceneSketches(s);
    if (r.changed) anyChanged = true;
    return r.scene;
  });
  return { scenes: anyChanged ? out : scenes, changed: anyChanged };
}
/** Camera framing buckets for background variations.
 *  Mirrors src/components/assets/types.tsx → BackgroundFraming.
 *  Kept narrow here so the conti pipeline can match by exact string. */
export type BackgroundFraming = "wide" | "medium" | "close" | "detail" | "alt";

export interface PhotoVariation {
  url: string;
  framing: BackgroundFraming;
  caption?: string | null;
  generated_at: string;
}

export interface Asset {
  tag_name: string;
  photo_url: string | null;
  asset_type?: string;
  ai_description?: string | null;
  outfit_description?: string | null;
  space_description?: string | null;
  /** Background-only alternate views per camera framing. Used by
   *  buildAssetImageUrls to pick a framing-matched reference image
   *  for a scene; falls back to photo_url when absent. */
  photo_variations?: PhotoVariation[] | null;
  /** Character-only multi-angle reference sheet. Conti generation
   *  prefers this over `photo_url` for character ref slots; falls back
   *  to `photo_url` when absent. Mirrors
   *  src/components/assets/types.tsx → Asset.character_sheet_url. */
  character_sheet_url?: string | null;
  /** Character-only multi-angle reference BOARD. Selected when
   *  `character_ref_mode === "board"`. Mirrors
   *  src/components/assets/types.tsx → Asset.character_board_url. */
  character_board_url?: string | null;
  /** Which artifact the conti/sketch pipelines feed as the character
   *  reference: "original" (photo_url) / "sheet" / "board". Resolved by
   *  pickCharacterRefUrl (falls back to photo_url). */
  character_ref_mode?: "original" | "sheet" | "board" | null;
  /** User-controlled off-switch for the sheet. `false` means "ignore
   *  sheet, fall back to photo_url"; null/undefined/true keep sheet
   *  preference. Mirrors src/components/assets/types.tsx. */
  use_character_sheet?: boolean | null;
}
export interface ProjectInfo {
  title: string;
  client: string | null;
  active_version_id: string | null;
  conti_style_id: string | null;
  /** "active" | "completed". Mirrored in ContiTab state so auto-status toggle
   *  on final-toggle can skip DB writes when already in desired state. */
  status?: string | null;
}
export interface SceneVersion {
  id: string;
  project_id: string;
  version_number: number;
  version_name: string | null;
  scenes: any[];
  created_at: string;
  is_active: boolean;
  display_order: number;
}
export interface StylePreset {
  id: string;
  name: string;
  description: string | null;
  thumbnail_url: string | null;
  style_prompt: string | null;
  is_default: boolean;
}
export interface Props {
  projectId: string;
  videoFormat: VideoFormat;
  isActive?: boolean;
}
// `single`  = "shot grid" — 1 column, narrow centered cards (cap max width)
// `auto`    = adaptive grid driven by user slider (cardSize)
// 이전엔 `grid2` (고정 2 컬럼) 도 있었지만 `auto` 의 minmax 가 같은 역할을
// 더 유연하게 커버해 중복이었고, UI 아이콘도 LayoutGrid 가 `auto` 의 대표
// 시각으로 더 어울려서 그쪽으로 옮겼다.
export type ViewMode = "single" | "auto";

// ─── Conti card info-field visibility ───
// Replaces the old single `showInfo` boolean so each text field can be toggled
// independently. All-false means "image only" (no text body rendered).
export type ContiInfoVisibility = {
  title: boolean;
  camera: boolean;
  mood: boolean;
  location: boolean;
  duration: boolean;
  description: boolean;
};

export const DEFAULT_CONTI_INFO_VISIBILITY: ContiInfoVisibility = {
  title: true,
  camera: true,
  mood: true,
  location: true,
  duration: true,
  description: true,
};

// Render order for the info dropdown. Labels are resolved via i18n at render
// time (key = `conti.infoField.<key>`).
export const CONTI_INFO_FIELD_ORDER: (keyof ContiInfoVisibility)[] = [
  "title",
  "camera",
  "mood",
  "location",
  "duration",
  "description",
];

// ─── Scene-group (sequence) visualization palette ───
// Cycled by group index so adjacent scenes get distinct hues. Muted tones so
// the rail/badge reads as "grouping" rather than a status color.
export const SCENE_GROUP_COLORS: string[] = [
  "#6366f1", // indigo
  "#059669", // emerald
  "#d97706", // amber
  "#db2777", // pink
  "#0891b2", // cyan
  "#7c3aed", // violet
  "#65a30d", // lime
  "#dc2626", // red
];

export const sceneGroupColor = (groupIndex: number): string =>
  SCENE_GROUP_COLORS[((groupIndex % SCENE_GROUP_COLORS.length) + SCENE_GROUP_COLORS.length) % SCENE_GROUP_COLORS.length];

export const ASPECT_CLASS: Record<VideoFormat, string> = {
  vertical: "aspect-[9/16]",
  horizontal: "aspect-video",
  square: "aspect-square",
};

// 로컬(SQLite) 환경이라 DB 부담이 적어 씬 카드당 conti 히스토리를 넉넉히 보관한다.
export const MAX_HISTORY = 20;
