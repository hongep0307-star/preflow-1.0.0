/**
 * storyboardSheet — Phase 1 prototype.
 *
 * Generate a SINGLE multi-panel storyboard image from the project's conti
 * cards using GPT Image 2, so we can eyeball whether one pass produces a
 * cross-cut consistent set (identical style/grade/identity/motif) before
 * investing in slicing + per-cut assignment.
 *
 * Scope (Phase 1): build refs + prompt, call the existing `openai-image`
 * GPT path, return the raw sheet URL. NO slicing, NO scene assignment.
 * The image is persisted to the `mood` bucket as a throwaway test artifact.
 */

import { supabase } from "./supabase";
import { pickCharacterRefUrl } from "./characterSheetStore";
import { dataUrlToBase64 } from "./contactSheet";
import { sanitizeImagePrompt, isGameWeaponContext } from "./conti";
import type { BriefAnalysis } from "./conti";
import { generateShotPlan, type ShotPlan } from "./shotPlan";

export interface StoryboardSheetScene {
  id?: string;
  scene_number: number;
  title?: string | null;
  description?: string | null;
  /** Shot size + angle + movement (e.g. "미디엄 숏(MS), 로우 앵글, 슬로우 달리").
   *  Phase 1: passed straight through into each panel's prompt line so the
   *  sheet honours the authored framing instead of inventing random angles. */
  camera_angle?: string | null;
  mood?: string | null;
  location?: string | null;
  /** Scene-group number (1-based) shared by consecutive cuts in the same
   *  location/time/beat. Used to drive shot-to-shot continuity in the sheet
   *  prompt. May be absent (legacy / not yet persisted) — grouping then falls
   *  back to consecutive same-location runs. */
  sequence?: number | null;
  tagged_assets?: string[] | null;
  is_transition?: boolean;
}

export interface StoryboardSheetAsset {
  tag_name: string;
  photo_url?: string | null;
  asset_type?: string;
  ai_description?: string | null;
  outfit_description?: string | null;
  signature_items?: string | null;
  space_description?: string | null;
  character_sheet_url?: string | null;
  character_board_url?: string | null;
  character_ref_mode?: string | null;
  use_character_sheet?: boolean | number | null;
}

export interface GenerateStoryboardSheetOptions {
  scenes: StoryboardSheetScene[];
  assets: StoryboardSheetAsset[];
  projectId: string;
  briefAnalysis?: BriefAnalysis | null;
  /** Project video format — drives the sheet aspect + grid so cells roughly
   *  match the cut format ("vertical" | "horizontal" | "square"). */
  videoFormat?: string;
  /** Project style prompt (currentStyle.style_prompt). Falls back to a
   *  built-in cinematic anchor when absent. The registered style IMAGE is NOT
   *  attached here — generic image refs leak the style picture into panels.
   *  Image-based style is applied per cut via the dedicated style_transfer
   *  pass after slicing (see ContiTab.applyStoryboardSheetToConti). */
  styleAnchor?: string | null;
  /** Max cuts packed into one sheet. Default 12. */
  maxCuts?: number;
  /** Override the auto-derived grid column count. */
  cols?: number;
  /** Phase 2: run the LLM continuity planning pass (shot plan) before
   *  rendering. Default true. On failure it silently falls back to the
   *  deterministic Phase-1 grouping. Set false to force the deterministic path. */
  enableShotPlan?: boolean;
  /** Progress callback so the UI can surface "planning" vs "generating". */
  onStage?: (stage: "planning" | "generating") => void;
  /** GPT generation quality for the sheet render. Defaults to "high".
   *  Driven by the Settings → "Storyboard Sheet" preference
   *  (getGptQualityDefault("storyboardSheet")). Only affects the GPT sheet
   *  pass — the downstream NB2 refine ignores quality. */
  quality?: "low" | "medium" | "high";
}

export interface StoryboardSheetResult {
  url: string;
  promptUsed: string;
  refCount: number;
  cutCount: number;
  sizeUsed: string;
  /** Grid the sheet was generated with (for later slicing). */
  cols: number;
  rows: number;
  /** Scene ids in panel order (left-to-right, top-to-bottom). Used by
   *  "apply to conti" to map tile i → scene. May contain undefined-filtered
   *  ids only; length === cutCount. */
  sceneIds: string[];
  /** Self-heal hint: the LLM shot plan's normalized scene grouping, keyed by
   *  scene id (sceneId → sequence). Undefined when no shot plan ran. The caller
   *  may write this back to the scenes' `sequence` so the grouping hint
   *  converges over time. */
  sequenceBySceneId?: Record<string, number>;
}

/** GPT `/v1/images/edits` attaches at most this many image[] entries
 *  (callGptVisionGenerate caps at 8). Budget refs accordingly. */
const GPT_REF_CAP = 8;

/** Sheet size candidates per project format, highest-resolution first.
 *  gpt-image-2 accepts larger sizes than gpt-image-1, so we attempt a 2K
 *  sheet first (much higher per-cell detail) and gracefully fall back to a
 *  guaranteed-supported size if the endpoint rejects it. The actual size used
 *  is logged + returned (`sizeUsed`) so we can confirm what landed. */
const SIZE_CANDIDATES_BY_FORMAT: Record<string, string[]> = {
  horizontal: ["2560x1440", "1536x1024", "1024x1024"],
  vertical: ["1440x2560", "1024x1536", "1024x1024"],
  square: ["2048x2048", "1024x1024"],
};

/** Per-format DEFAULT cut count (cols*rows = 12). The actual grid columns are
 *  derived from the real cut count via `chooseCols` so cells stay format-shaped
 *  even for fewer cuts; this map only seeds the default maxCuts. */
const GRID_BY_FORMAT: Record<string, { cols: number; rows: number }> = {
  horizontal: { cols: 4, rows: 3 },
  vertical: { cols: 3, rows: 4 },
  square: { cols: 4, rows: 3 },
};

/** Default cinematic anchor when the project has no saved style prompt. */
const DEFAULT_CINEMATIC_ANCHOR =
  "High-end cinematic commercial advertising still, photorealistic, shallow depth of field, dramatic directional lighting, teal-orange grade, 35mm anamorphic look, subtle film grain.";

const parseSize = (s: string): { w: number; h: number } => {
  const [w, h] = s.split("x").map((n) => parseInt(n, 10));
  return { w: w || 1, h: h || 1 };
};

/**
 * Pick the column count so each cell's aspect (= sheetAspect * rows/cols) is as
 * close as possible to the target cut aspect. This adapts to the ACTUAL cut
 * count: e.g. 3 cuts on a 16:9 sheet → 2x2 (cells 16:9) instead of 4x1 (tall,
 * top/bottom cropped). Uses linear aspect distance; on ties prefers fewer
 * columns (vertical) or fewer rows (horizontal/square) for a natural layout.
 */
function chooseCols(
  n: number,
  sheetW: number,
  sheetH: number,
  targetCellAspect: number,
  vertical: boolean,
): number {
  const sheetAspect = sheetW / sheetH;
  let best = 1;
  let bestErr = Infinity;
  let bestRows = n;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellAspect = sheetAspect * (rows / cols);
    const err = Math.abs(cellAspect - targetCellAspect);
    const better =
      err < bestErr - 1e-9 ||
      (Math.abs(err - bestErr) <= 1e-9 && (vertical ? cols < best : rows < bestRows));
    if (better) {
      best = cols;
      bestErr = err;
      bestRows = rows;
    }
  }
  return best;
}

/**
 * Draw an empty cols×rows grid (dark cells, thin white gutters, no text) at
 * the sheet size. Used purely as an INVISIBLE layout guide reference so the
 * model places one panel per equal cell instead of merging/spanning cells.
 * Returns a PNG data URL, or "" if canvas is unavailable.
 */
function buildGridTemplateDataUrl(cols: number, rows: number, w: number, h: number): string {
  if (typeof document === "undefined") return "";
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const gutter = Math.max(6, Math.round(Math.min(w, h) * 0.012));
  const cellW = (w - gutter * (cols + 1)) / cols;
  const cellH = (h - gutter * (rows + 1)) / rows;
  ctx.fillStyle = "#ffffff"; // gutters
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#101010"; // empty cells
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.fillRect(gutter + c * (cellW + gutter), gutter + r * (cellH + gutter), cellW, cellH);
    }
  }
  return canvas.toDataURL("image/png");
}

/** Aspect ratio (w/h) of one cut for each project format. */
const FORMAT_RATIO: Record<string, number> = {
  horizontal: 16 / 9,
  vertical: 9 / 16,
  square: 1,
};

/**
 * Center-crop a tile data URL to the project's cut aspect ratio. Used by
 * "apply to conti" so a sliced panel fits the scene card without letterboxing.
 * Returns the original data URL unchanged if canvas is unavailable.
 */
export async function centerCropToFormatDataUrl(srcDataUrl: string, format: string): Promise<string> {
  if (typeof document === "undefined") return srcDataUrl;
  const targetRatio = FORMAT_RATIO[format] ?? FORMAT_RATIO.horizontal;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("tile image load failed"));
    el.src = srcDataUrl;
  });
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  if (!sw || !sh) return srcDataUrl;
  const srcRatio = sw / sh;
  let cw = sw;
  let ch = sh;
  if (srcRatio > targetRatio) {
    // too wide → trim sides
    cw = Math.round(sh * targetRatio);
  } else {
    // too tall → trim top/bottom
    ch = Math.round(sw / targetRatio);
  }
  const sx = Math.round((sw - cw) / 2);
  const sy = Math.round((sh - ch) / 2);
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return srcDataUrl;
  ctx.drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch);
  return canvas.toDataURL("image/png");
}

/**
 * Pad (letterbox) a tile to the project's cut aspect WITHOUT cropping any
 * content. Used before the NB2 refine so the model OUT-PAINTS the added bands
 * instead of cropping the panel: the sheet's cell aspect only approximates the
 * cut aspect (and is often far off for vertical layouts), so a plain "reframe"
 * forces NB2 to trim subjects to the wrong region. By embedding the full tile
 * centered on a target-aspect canvas — with a stretched copy behind it as a
 * scene-like fill hint — the refine becomes additive (extend the bands) rather
 * than subtractive (crop), preserving the whole panel.
 *
 * Returns the original data URL unchanged if canvas is unavailable or the tile
 * already matches the target aspect.
 */
async function padTileToFormatDataUrl(srcDataUrl: string, format: string): Promise<string> {
  if (typeof document === "undefined") return srcDataUrl;
  const targetRatio = FORMAT_RATIO[format] ?? FORMAT_RATIO.horizontal;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("tile image load failed"));
    el.src = srcDataUrl;
  });
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  if (!sw || !sh) return srcDataUrl;
  const srcRatio = sw / sh;
  let cw = sw;
  let ch = sh;
  if (srcRatio > targetRatio) {
    // tile too wide for the cut → add top/bottom bands (taller canvas)
    ch = Math.round(sw / targetRatio);
  } else if (srcRatio < targetRatio) {
    // tile too tall for the cut → add left/right bands (wider canvas)
    cw = Math.round(sh * targetRatio);
  } else {
    return srcDataUrl; // already the target aspect
  }
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return srcDataUrl;
  const dx = Math.round((cw - sw) / 2);
  const dy = Math.round((ch - sh) / 2);
  // Stretched full-bleed copy as a scene-coloured fill hint for the bands…
  ctx.drawImage(img, 0, 0, sw, sh, 0, 0, cw, ch);
  // …then the crisp, unscaled original centered on top (this is what NB2 keeps).
  ctx.drawImage(img, dx, dy, sw, sh);
  return canvas.toDataURL("image/png");
}

/** Per-cut output size (maps to an exact NB2 aspect) for the refine pass. */
const REFINE_SIZE_BY_FORMAT: Record<string, string> = {
  horizontal: "1536x1024", // 16:9
  vertical: "1024x1536", // 9:16
  square: "1024x1024", // 1:1
};
const REFINE_ASPECT_LABEL: Record<string, string> = {
  horizontal: "16:9",
  vertical: "9:16",
  square: "1:1",
};

const sheetRefinePrompt = (aspect: string) =>
  `Upscale this storyboard panel into a single full-bleed cinematic film still at ${aspect} aspect ratio. ` +
  `The input already contains the FULL panel centered, surrounded by uniform stretched/placeholder border bands (along the top/bottom OR the left/right) that were added only to reach the target aspect. ` +
  `KEEP the central original content 100% unchanged: do NOT crop, zoom, reframe, relocate, or rescale any existing subject, prop, or background element — every subject that is fully visible in the center must stay fully visible. ` +
  `ONLY synthesize a seamless, photorealistic continuation of the EXISTING scene INSIDE those border bands so the frame fills edge-to-edge with no bars and no margins — extend the existing environment naturally, do not add new objects. ` +
  `Reproduce the central region FAITHFULLY: keep the exact same subjects, background, layout, props, signage, screens, composition, pose, lighting, and color grade. ` +
  `Preserve ALL on-screen text, UI, logos, and typography EXACTLY as they appear — never alter, translate, paraphrase, blur, or remove any text. ` +
  `Render at crisp high resolution with photorealistic detail. No added watermark, no caption bars, no panel border.`;

/** Persist a base64 image via the local-server save path and return its URL. */
async function saveLocalImageBase64(args: {
  base64: string;
  projectId: string;
  sceneNumber: number;
  suffix: string;
  folder: string;
}): Promise<string> {
  const { data, error } = await supabase.functions.invoke("openai-image", {
    body: {
      mode: "save_local",
      imageBase64: args.base64,
      projectId: args.projectId,
      sceneNumber: args.sceneNumber,
      suffix: args.suffix,
      folder: args.folder,
    },
  });
  if (error) throw new Error(error.message);
  const url = (data as { publicUrl?: string } | null)?.publicUrl;
  if (!url) throw new Error("save_local returned no url");
  return url;
}

/**
 * Refine ONE sliced storyboard tile into a final, full-resolution cut at the
 * project's exact aspect ratio using nano-banana-2.
 *
 * Why this exists: slicing a single sheet gives low-res tiles whose cell aspect
 * only approximates the cut ratio, so the legacy center-crop both lost detail
 * and trimmed content (top/bottom). Feeding the (white-trimmed) tile to NB2 as
 * the content reference and requesting the exact cut size makes NB2 reframe to
 * fill the aspect edge-to-edge (no letterbox / no hard crop) while upscaling.
 *
 * Returns the persisted public URL of the refined cut. Throws on failure so the
 * caller can fall back to center-crop.
 */
export async function refineTileToFormat(opts: {
  tileDataUrl: string;
  projectId: string;
  sceneNumber: number;
  videoFormat: string;
}): Promise<string> {
  const size = REFINE_SIZE_BY_FORMAT[opts.videoFormat] ?? REFINE_SIZE_BY_FORMAT.horizontal;
  const aspect = REFINE_ASPECT_LABEL[opts.videoFormat] ?? "16:9";

  // 0) Pad the tile to the exact cut aspect so NB2 OUT-PAINTS the added bands
  //    instead of cropping the panel (the sheet cell aspect only approximates
  //    the cut aspect — often far off for vertical — so a bare reframe trims
  //    content to the wrong region). No-op when the tile already matches.
  const padded = await padTileToFormatDataUrl(opts.tileDataUrl, opts.videoFormat);

  // 1) Upload the padded tile so NB2 can fetch it as the content reference.
  const srcUrl = await saveLocalImageBase64({
    base64: dataUrlToBase64(padded),
    projectId: opts.projectId,
    sceneNumber: opts.sceneNumber,
    suffix: "sheet-src",
    folder: "mood",
  });

  // 2) NB2 variation at the exact cut aspect → full-bleed, upscaled. Content
  //    only — style is applied separately via the style_transfer pass so the
  //    style reference image is never copied into the cut.
  const { data, error } = await supabase.functions.invoke("openai-image", {
    body: {
      mode: "variation",
      sourceImageUrl: srcUrl,
      prompt: sheetRefinePrompt(aspect),
      imageSize: size,
      model: "nano-banana-2",
    },
  });
  if (error) throw new Error(error.message);
  const refinedBase64 = (data as { imageBase64?: string } | null)?.imageBase64;
  if (!refinedBase64) throw new Error("NB2 refine returned no image");

  // 3) Persist the refined cut into the contis folder.
  return saveLocalImageBase64({
    base64: refinedBase64,
    projectId: opts.projectId,
    sceneNumber: opts.sceneNumber,
    suffix: "sheet-cut",
    folder: "contis",
  });
}

/** Upload the grid template to the throwaway `mood` bucket and return its URL.
 *  Returns null on any failure so the caller proceeds without the template. */
async function uploadGridTemplate(projectId: string, dataUrl: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.functions.invoke("openai-image", {
      body: {
        mode: "save_local",
        imageBase64: dataUrlToBase64(dataUrl),
        projectId,
        sceneNumber: -1,
        suffix: "gridtmpl",
        folder: "mood",
      },
    });
    if (error || !data?.publicUrl) return null;
    return data.publicUrl as string;
  } catch {
    return null;
  }
}

/** Flatten the brief's visual_direction (object or string) into one line. */
function formatVisualDirection(vd: BriefAnalysis["visual_direction"] | undefined): string {
  if (!vd) return "";
  if (typeof vd === "string") return vd.trim();
  const parts: string[] = [];
  if (vd.camera) parts.push(`camera: ${vd.camera}`);
  if (vd.lighting) parts.push(`lighting: ${vd.lighting}`);
  if (vd.color_grade) parts.push(`color grade: ${vd.color_grade}`);
  return parts.join(" | ");
}

const normalizeTag = (t: string): string => (t.startsWith("@") ? t.slice(1) : t).toLowerCase();

/** Resolve the reference image URL for one asset, honouring the user's
 *  per-asset choice (original / sheet / board) via `pickCharacterRefUrl`
 *  (resolves `character_ref_mode`, falls back to the portrait). Applies to
 *  every asset type so the storyboard respects what the user picked in the
 *  Asset modal's 원본/시트/보드 tabs. */
const refUrlForAsset = (a: StoryboardSheetAsset): string | null =>
  pickCharacterRefUrl(a) ?? a.photo_url ?? null;

/**
 * Collect a deduped, ordered list of { url, asset } across the chosen scenes.
 * Order = characters → ITEMS (hero products) → backgrounds, so the weapon/
 * product gets strong weight (above background) and is named in the roster.
 * Returns the asset alongside the URL so the prompt can bind each reference
 * image to its identity by name + description (prevents wrong-person and
 * generic-prop renders).
 */
function collectRefs(
  scenes: StoryboardSheetScene[],
  assets: StoryboardSheetAsset[],
): { url: string; asset: StoryboardSheetAsset }[] {
  const byTag = new Map<string, StoryboardSheetAsset>();
  for (const a of assets) byTag.set(normalizeTag(a.tag_name), a);

  // Frequency of each asset across the scene set.
  const freq = new Map<string, number>();
  for (const s of scenes) {
    for (const raw of s.tagged_assets ?? []) {
      const name = normalizeTag(raw);
      if (byTag.has(name)) freq.set(name, (freq.get(name) ?? 0) + 1);
    }
  }

  const typeOf = (name: string) => byTag.get(name)?.asset_type ?? "character";
  const bucket = (wanted: string) =>
    [...freq.entries()]
      .filter(([name]) => typeOf(name) === wanted)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => byTag.get(name)!)
      .filter(Boolean);

  const ordered = [
    ...bucket("character"),
    ...bucket("item"),
    ...bucket("background"),
  ];

  const out: { url: string; asset: StoryboardSheetAsset }[] = [];
  const seen = new Set<string>();
  for (const a of ordered) {
    const u = refUrlForAsset(a);
    if (u && !seen.has(u)) {
      out.push({ url: u, asset: a });
      seen.add(u);
    }
  }
  return out;
}

/**
 * Trim the collected refs to the reference-image cap WITHOUT letting the scene's
 * background (space) anchors get starved by many characters/items. Space
 * consistency is the priority here, so we reserve slots for backgrounds first
 * (but leave at least half the slots for identity refs when both kinds exist),
 * then keep the canonical character → item → background order from `all`.
 */
function budgetRefs(
  all: { url: string; asset: StoryboardSheetAsset }[],
  maxAssetRefs: number,
): { url: string; asset: StoryboardSheetAsset }[] {
  if (maxAssetRefs <= 0) return [];
  if (all.length <= maxAssetRefs) return all;

  const isBg = (r: { asset: StoryboardSheetAsset }) =>
    (r.asset.asset_type ?? "character") === "background";
  const bgs = all.filter(isBg);
  const nonBgs = all.filter((r) => !isBg(r));

  const bgReserve =
    nonBgs.length === 0
      ? Math.min(bgs.length, maxAssetRefs)
      : Math.min(bgs.length, Math.max(1, Math.floor(maxAssetRefs / 2)));

  const keep = new Set<StoryboardSheetAsset>();
  for (const r of bgs.slice(0, bgReserve)) keep.add(r.asset);
  for (const r of nonBgs) {
    if (keep.size >= maxAssetRefs) break;
    keep.add(r.asset);
  }
  for (const r of bgs.slice(bgReserve)) {
    if (keep.size >= maxAssetRefs) break;
    keep.add(r.asset);
  }
  // Preserve the canonical ordering (characters → items → backgrounds) from
  // `all` so hero products keep their weighting above generic backgrounds.
  return all.filter((r) => keep.has(r.asset));
}

/** Strip a leading @ from a tag for display (keeps original case). */
const displayTag = (t: string): string => (t.startsWith("@") ? t.slice(1) : t);

/**
 * Bind each attached reference image to its asset by name + description so the
 * model preserves the exact tagged appearance (the whole point of registering
 * boards). Numbering matches the actual image[] order; image 1 is the grid
 * template when present.
 */
function buildAssetRoster(
  refs: { url: string; asset: StoryboardSheetAsset }[],
  hasTemplate: boolean,
  sani: (t: string) => string,
): string {
  if (refs.length === 0) return "";
  const base = hasTemplate ? 2 : 1; // 1-based; template is image 1
  const lines = refs.map((r, i) => {
    const a = r.asset;
    const type = a.asset_type ?? "character";
    const name = displayTag(a.tag_name);
    let desc: string;
    let tail: string;
    if (type === "background") {
      desc = a.space_description ?? a.ai_description ?? "";
      tail = "match this location's architecture, materials, and color palette.";
    } else if (type === "item") {
      desc = a.ai_description ?? "";
      tail =
        "HERO PRODUCT — reproduce its EXACT design, materials, parts, and silhouette; never substitute a generic or stylized version.";
    } else {
      desc = [a.ai_description, a.outfit_description, a.signature_items].filter(Boolean).join("; ");
      tail = "match this character's face, hairstyle, outfit, and signature items EXACTLY.";
    }
    const descStr = desc ? `: ${sani(desc)}` : "";
    return `  Reference image ${base + i} = "${name}" [${type}]${descStr} — ${tail}`;
  });
  return `ASSET ROSTER (each reference image maps to ONE tagged asset; preserve its appearance EXACTLY and place the right asset in the right panel):\n${lines.join("\n")}`;
}

const normalizeLoc = (s?: string | null): string => (s ?? "").trim().toLowerCase();

/**
 * Assign a continuity-group id to each panel. Consecutive panels that share a
 * scene group get the same id so the prompt can ask the model to treat them as
 * ONE continuous scene (same setting / screen direction / time-of-day).
 *
 * Grouping key, in priority order:
 *   1. `sequence` (when authored) — the agent's scene grouping.
 *   2. normalized `location` — consecutive cuts in the same place.
 *   3. per-panel unique — a lone shot stands alone.
 *
 * A location/sequence that recurs later (A→B→A) starts a NEW group on return,
 * matching the conti rule that a return to a space is a new scene.
 */
function deriveContinuityGroups(scenes: StoryboardSheetScene[]): number[] {
  const ids: number[] = [];
  let gid = 0;
  let prevKey: string | null = null;
  scenes.forEach((s, i) => {
    const key =
      s.sequence != null
        ? `seq:${s.sequence}`
        : normalizeLoc(s.location)
          ? `loc:${normalizeLoc(s.location)}`
          : `idx:${i}`;
    if (i > 0 && key !== prevKey) gid++;
    ids.push(gid);
    prevKey = key;
  });
  return ids;
}

/** Contiguous panel ranges (1-based, inclusive) per continuity group. */
function continuityRanges(
  scenes: StoryboardSheetScene[],
): { start: number; end: number; location: string | null }[] {
  const ids = deriveContinuityGroups(scenes);
  const ranges: { start: number; end: number; location: string | null }[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const last = ranges[ranges.length - 1];
    if (last && ids[i] === ids[i - 1]) {
      last.end = i + 1;
    } else {
      ranges.push({ start: i + 1, end: i + 1, location: scenes[i].location ?? null });
    }
  }
  return ranges;
}

/**
 * Map each background asset that has a reference image to its 1-based reference
 * image number (matching `buildAssetRoster`'s numbering: image 1 is the grid
 * template when present, so `base` = 2 with a template else 1). Used to bind a
 * scene group to "the ONE image that defines this space".
 */
function buildBgRefByTag(
  refs: { url: string; asset: StoryboardSheetAsset }[],
  base: number,
): Map<string, { refNumber: number; name: string }> {
  const m = new Map<string, { refNumber: number; name: string }>();
  refs.forEach((r, i) => {
    if ((r.asset.asset_type ?? "character") === "background") {
      m.set(normalizeTag(r.asset.tag_name), {
        refNumber: base + i,
        name: displayTag(r.asset.tag_name),
      });
    }
  });
  return m;
}

/**
 * Pick the canonical SPACE reference for a set of panels: the background asset
 * most frequently tagged across those panels that also has a reference image.
 * Group-level (not per-panel) so that even a freshly-added, still-untagged cut
 * inherits its group's space anchor as long as the group has one tagged bg.
 */
function bgRefForPanels(
  panels: number[],
  scenes: StoryboardSheetScene[],
  bgRefByTag: Map<string, { refNumber: number; name: string }>,
): { refNumber: number; name: string } | null {
  if (bgRefByTag.size === 0) return null;
  const freq = new Map<string, number>();
  for (const p of panels) {
    const s = scenes[p - 1];
    if (!s) continue;
    for (const raw of s.tagged_assets ?? []) {
      const tag = normalizeTag(raw);
      if (bgRefByTag.has(tag)) freq.set(tag, (freq.get(tag) ?? 0) + 1);
    }
  }
  if (freq.size === 0) return null;
  const bestTag = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return bgRefByTag.get(bestTag) ?? null;
}

function buildStoryboardPrompt(
  scenes: StoryboardSheetScene[],
  cols: number,
  rows: number,
  sani: (t: string) => string,
  mustShow: string[],
  styleAnchor: string,
  visualDirection: string,
  hasTemplate: boolean,
  assetRoster: string,
  shotPlan: ShotPlan | null,
  refs: { url: string; asset: StoryboardSheetAsset }[],
): string {
  const n = scenes.length;
  const cells = cols * rows;

  // Bind scene groups to the reference image that defines their space. Numbering
  // matches buildAssetRoster: image 1 is the grid template when present.
  const refBase = hasTemplate ? 2 : 1;
  const bgRefByTag = buildBgRefByTag(refs, refBase);

  // Per-panel continuity lookup from the LLM shot plan (1-based panel index).
  const cutByPanel = new Map<number, ShotPlan["cuts"][number]>();
  if (shotPlan) for (const c of shotPlan.cuts) cutByPanel.set(c.panel, c);

  const panels = scenes
    .map((s, i) => {
      const cut = cutByPanel.get(i + 1);
      const desc = sani((s.description ?? s.title ?? `Scene ${s.scene_number}`).trim());
      // Prefer the shot plan's normalized (English) camera note; fall back to
      // the authored camera_angle, which Phase 1 already started forwarding.
      const camText = cut?.camera ?? s.camera_angle ?? "";
      const cam = camText ? ` | camera: ${sani(camText.trim())}` : "";
      // Annotate the location with its space reference image so each panel knows
      // which photo to reproduce its setting from (covers lone cuts too).
      const spaceRef = bgRefForPanels([i + 1], scenes, bgRefByTag);
      const refTag = spaceRef ? ` (reference image ${spaceRef.refNumber})` : "";
      const loc = s.location
        ? ` | location: ${sani(s.location.trim())}${refTag}`
        : spaceRef
          ? ` | location: reference image ${spaceRef.refNumber} ("${spaceRef.name}")`
          : "";
      const mood = s.mood ? ` | mood: ${sani(s.mood.trim())}` : "";
      const carry = cut?.carryOver ? ` | continuity: ${sani(cut.carryOver.trim())}` : "";
      const block = cut?.blocking ? ` | blocking: ${sani(cut.blocking.trim())}` : "";
      return `Panel ${i + 1}: ${desc}${cam}${loc}${mood}${carry}${block}`;
    })
    .join("\n");

  // STORY CONTINUITY block. When the LLM shot plan is available we use its
  // through-line + explicit groups (richer: screen direction, time-of-day,
  // lighting). Otherwise fall back to the deterministic Phase-1 grouping
  // (consecutive same-location / sequence runs).
  let groupLines: string[];
  let leadLines: string[];
  if (shotPlan && (shotPlan.throughLine || shotPlan.groups.length > 0)) {
    leadLines = [
      shotPlan.throughLine
        ? `- Story through-line (the whole sheet tells this in order): ${sani(shotPlan.throughLine.trim())}`
        : `- Panels progress as a single narrative; only change wardrobe/props/location at scene boundaries.`,
      `- Honour each panel's "camera" note for shot size/angle/movement, and its "continuity"/"blocking" notes for what carries over and where subjects sit.`,
    ];
    groupLines = shotPlan.groups
      .filter((g) => g.panels.length > 1)
      .map((g) => {
        const list = g.panels.slice().sort((a, b) => a - b).join(", ");
        const locName = g.location ? sani(g.location.trim()) : "the same location";
        const tod = g.timeOfDay ? `, ${sani(g.timeOfDay.trim())}` : "";
        const light = g.lighting ? `, ${sani(g.lighting.trim())} lighting` : "";
        const dir = g.screenDirection ? ` Keep screen direction ${g.screenDirection} (180-degree rule) and eyeline match.` : "";
        const spaceRef = bgRefForPanels(g.panels, scenes, bgRefByTag);
        const spaceBind = spaceRef
          ? ` SPACE LOCK: all of these panels happen in reference image ${spaceRef.refNumber} ("${spaceRef.name}") — reproduce that EXACT space (architecture, layout, materials, fixtures, color palette) in EVERY one of these panels; do NOT reinvent or redesign the room between them.`
          : "";
        return `  Panels ${list} are ONE continuous scene (${locName}${tod}${light}): keep an identical setting, time-of-day, and lighting across them;${dir} Carry characters and key props over with consistent positions; vary ONLY the shot size / angle / framing.${spaceBind}`;
      });
  } else {
    const ranges = continuityRanges(scenes);
    leadLines = [
      `- Panels progress as a single narrative. Keep character identity, wardrobe, and prop state consistent from one panel to the next; let them change only when the scene/location changes.`,
      `- Honour each panel's "camera" note for its shot size, angle, and movement so the framing reads as intentional shot design, not random angles.`,
    ];
    groupLines = ranges
      .filter((r) => r.end > r.start)
      .map((r) => {
        const locName = r.location ? sani(r.location.trim()) : "the same location";
        const panelsInRange: number[] = [];
        for (let p = r.start; p <= r.end; p++) panelsInRange.push(p);
        const spaceRef = bgRefForPanels(panelsInRange, scenes, bgRefByTag);
        const spaceBind = spaceRef
          ? ` SPACE LOCK: all of these panels happen in reference image ${spaceRef.refNumber} ("${spaceRef.name}") — reproduce that EXACT space (architecture, layout, materials, fixtures, color palette) in EVERY one of these panels; do NOT reinvent or redesign the room between them.`
          : "";
        return `  Panels ${r.start}-${r.end} are ONE continuous scene (${locName}): keep an identical setting, time-of-day, lighting state, and screen direction across them — respect the 180-degree rule and eyeline match, and carry characters and key props over with consistent positions. Vary ONLY the shot size / angle / framing (per each panel's "camera" note).${spaceBind}`;
      });
  }
  const storyBlock = [
    ``,
    `STORY CONTINUITY (read the whole sheet as ONE connected story in reading order, left-to-right then top-to-bottom — NOT a set of unrelated images):`,
    ...leadLines,
    ...groupLines,
  ];

  const mustShowBlock =
    mustShow.length > 0
      ? [
          ``,
          `REQUIRED ELEMENTS (must appear where the panel's action calls for them): ${mustShow.map(sani).join(" / ")}.`,
        ]
      : [];

  const styleLine = `VISUAL STYLE (apply identically to EVERY panel): ${styleAnchor}`;
  const vdLine = visualDirection ? `VISUAL DIRECTION: ${visualDirection}` : "";

  const gridIntro = hasTemplate
    ? `The FIRST reference image is an INVISIBLE LAYOUT GRID: a strict ${cols}x${rows} matrix of ${cells} identical equal cells. Place exactly ONE panel inside each cell, in reading order (left-to-right, top-to-bottom). Do NOT render the grid's lines, borders, gutters, or fill color into the artwork — it is only a placement guide.`
    : `Produce ONE clean storyboard sheet: a strict ${cols}x${rows} grid (${cells} cells), arranged left-to-right then top-to-bottom, separated by thin clean white gutters.`;

  const refUsage = hasTemplate
    ? `REFERENCE USAGE (strict): aside from the layout grid, reference images are for IDENTITY ONLY — character faces, prop/vehicle design, and the location's materials and palette. Do NOT copy any reference's pose, camera angle, or composition. If a reference is a multi-panel board or turnaround, do NOT reproduce its panel layout, neutral/white background, or its standing/T-pose stance; restage each character into the panel's action.`
    : `REFERENCE USAGE (strict): reference images are for IDENTITY ONLY — character faces, prop/vehicle design, and the location's materials and palette. Do NOT copy any reference's pose, camera angle, or composition. If a reference is a multi-panel board or turnaround, do NOT reproduce its panel layout, neutral/white background, or its standing/T-pose stance; restage each character into the panel's action.`;

  return [
    gridIntro,
    `UNIFORM GRID (critical): EVERY cell is an identical-size rectangle with equal thin white gutters. No cell may be larger, wider, or taller than another. NO merged, spanning, or hero/feature panels. Fill ${n} cells in order; leave any remaining cells empty.`,
    `Even if a panel's content is a sequence, progress bar, step comparison, or banner, it MUST fit ENTIRELY inside its single equal cell — never widen or merge cells for it. Render each panel as ONE single framed shot.`,
    ``,
    `Render every panel as a PHOTOREALISTIC CINEMATIC FILM STILL — premium commercial-advertising grade, shallow depth of field, dramatic directional lighting, lens bokeh, subtle film grain. Do NOT produce flat product-catalog shots, UI/screen mockups, diagrams, or icon layouts. Do NOT render any captions, labels, numbers, watermarks, or text inside the image.`,
    ``,
    styleLine,
    vdLine,
    ``,
    `CONSISTENCY (critical): ALL panels MUST share an identical art style, color grade, lighting logic, and character identity. If a recurring motif or symbol appears, keep its visual treatment IDENTICAL across panels — only its placement may vary. Only the scene content and composition change from panel to panel.`,
    `Each panel is composed FRESHLY per its own description below, fully depicting that panel's action/situation — avoid a flat repeat of the same framing or a default standing pose.`,
    ...storyBlock,
    ``,
    `CAST LOCK (strict): each panel may show ONLY the people explicitly described in that panel's line below. Do NOT add bystanders, extras, crowds, staff, or any additional person that the panel does not name. If a panel implies someone off-frame, keep them off-frame.`,
    ``,
    refUsage,
    ...(assetRoster ? [``, assetRoster] : []),
    ...mustShowBlock,
    ``,
    `Panels:`,
    panels,
    ``,
    `Reminder: keep the STRICT uniform ${cols}x${rows} grid — identical equal cells, equal gutters, no spanning or merged panels.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Generate the storyboard sheet. Sizes the sheet to the project format,
 * attempting the highest-resolution size first (gpt-image-2 supports 2K) and
 * gracefully falling back through smaller supported sizes. The grid columns
 * are auto-derived so each cell roughly matches the cut aspect.
 */
export async function generateStoryboardSheet(
  opts: GenerateStoryboardSheetOptions,
): Promise<StoryboardSheetResult> {
  const format = opts.videoFormat ?? "horizontal";
  const grid = GRID_BY_FORMAT[format] ?? GRID_BY_FORMAT.horizontal;
  const maxCuts = opts.maxCuts ?? grid.cols * grid.rows;

  const scenes = (opts.scenes ?? [])
    .filter((s) => !s.is_transition)
    .slice(0, maxCuts);
  if (scenes.length === 0) throw new Error("No non-transition scenes to build a storyboard sheet from.");

  const weaponSafe = isGameWeaponContext(opts.briefAnalysis ?? null, opts.assets as any);
  const sani = (t: string) => sanitizeImagePrompt(t, { weaponSafe });

  const mustShow = (opts.briefAnalysis?.hero_visual?.must_show ?? []).filter(
    (m): m is string => typeof m === "string" && m.trim().length > 0,
  );

  const candidates = SIZE_CANDIDATES_BY_FORMAT[format] ?? SIZE_CANDIDATES_BY_FORMAT.horizontal;
  const primary = parseSize(candidates[0]);
  // Count-adaptive grid: columns chosen so each cell ~ the cut aspect, for the
  // ACTUAL cut count (e.g. 3 horizontal cuts → 2x2, not 4x1 tall cells).
  const cols =
    opts.cols ??
    chooseCols(
      scenes.length,
      primary.w,
      primary.h,
      FORMAT_RATIO[format] ?? FORMAT_RATIO.horizontal,
      format === "vertical",
    );
  const rows = Math.ceil(scenes.length / cols);

  const styleAnchor = opts.styleAnchor?.trim() || DEFAULT_CINEMATIC_ANCHOR;
  const visualDirection = formatVisualDirection(opts.briefAnalysis?.visual_direction);

  // Phase 2: LLM continuity planning pass (best-effort). Runs once per sheet
  // before the GPT render. On any failure `shotPlan` is null and the prompt
  // builder falls back to the deterministic Phase-1 grouping.
  let shotPlan: ShotPlan | null = null;
  if (opts.enableShotPlan !== false) {
    opts.onStage?.("planning");
    shotPlan = await generateShotPlan({
      scenes,
      briefAnalysis: opts.briefAnalysis,
      videoFormat: format,
    });
  }
  opts.onStage?.("generating");

  // Build + upload an invisible layout-grid template (best-effort). If it
  // fails we still generate, just without the strong layout anchor.
  const templateDataUrl = buildGridTemplateDataUrl(cols, rows, primary.w, primary.h);
  const templateUrl = templateDataUrl ? await uploadGridTemplate(opts.projectId, templateDataUrl) : null;

  // Identity refs (with their assets, for the roster). Reserve one ref slot for
  // the template so the asset refs are capped accordingly.
  const maxAssetRefs = templateUrl ? GPT_REF_CAP - 1 : GPT_REF_CAP;
  const usedRefs = budgetRefs(collectRefs(scenes, opts.assets ?? []), maxAssetRefs);
  const assetImageUrls = templateUrl
    ? [templateUrl, ...usedRefs.map((r) => r.url)]
    : usedRefs.map((r) => r.url);
  const assetRoster = buildAssetRoster(usedRefs, !!templateUrl, sani);

  const prompt = buildStoryboardPrompt(
    scenes,
    cols,
    rows,
    sani,
    mustShow,
    styleAnchor,
    visualDirection,
    !!templateUrl,
    assetRoster,
    shotPlan,
    usedRefs,
  );

  console.info("[storyboardSheet] start", {
    cutCount: scenes.length,
    refCount: assetImageUrls.length,
    hasTemplate: !!templateUrl,
    shotPlan: shotPlan ? { groups: shotPlan.groups.length, cuts: shotPlan.cuts.length } : null,
    cols,
    rows,
    promptLen: prompt.length,
    videoFormat: format,
    sizeCandidates: candidates,
  });

  const invokeOnce = async (imageSize: string): Promise<string> => {
    const { data, error } = await supabase.functions.invoke("openai-image", {
      body: {
        model: "gpt",
        gptModel: "gpt-image-2",
        prompt,
        assetImageUrls,
        imageSize,
        projectId: opts.projectId,
        sceneNumber: -1,
        folder: "mood",
        quality: opts.quality ?? "high",
      },
    });
    if (error) throw new Error(error.message ?? String(error));
    if (data?.error) throw new Error(data.error?.message ?? data.error?.type ?? "Storyboard sheet generation failed");
    const url = data?.publicUrl;
    if (!url) throw new Error("No image URL returned");
    return url as string;
  };

  // Try sizes high → low; only fall back on error so we keep the best size
  // the endpoint actually accepts.
  let url: string | null = null;
  let sizeUsed = candidates[0];
  let lastErr: unknown = null;
  for (const size of candidates) {
    try {
      url = await invokeOnce(size);
      sizeUsed = size;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`[storyboardSheet] size ${size} failed (${e instanceof Error ? e.message : String(e)}); trying next`);
    }
  }
  if (!url) throw lastErr instanceof Error ? lastErr : new Error("Storyboard sheet generation failed at all sizes");

  console.info("[storyboardSheet] done", { url, sizeUsed });

  // Self-heal grouping hint: map each scene id to the shot plan's normalized
  // group sequence (panel numbers are 1-based positions in `scenes`).
  let sequenceBySceneId: Record<string, number> | undefined;
  if (shotPlan && shotPlan.groups.length > 0) {
    sequenceBySceneId = {};
    for (const g of shotPlan.groups) {
      for (const p of g.panels) {
        const sc = scenes[p - 1];
        if (sc?.id) sequenceBySceneId[sc.id] = g.sequence;
      }
    }
    if (Object.keys(sequenceBySceneId).length === 0) sequenceBySceneId = undefined;
  }

  return {
    url,
    promptUsed: prompt,
    refCount: assetImageUrls.length,
    cutCount: scenes.length,
    sizeUsed,
    cols,
    rows,
    sceneIds: scenes.map((s) => s.id).filter((id): id is string => !!id),
    sequenceBySceneId,
  };
}
