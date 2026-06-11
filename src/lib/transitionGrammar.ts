/**
 * Transition Grammar — single source of truth for TR card techniques.
 *
 * A TR card in PreFlow is NOT an editing-timing decision (cut / match-cut /
 * jump-cut etc. — those live between two regular scenes without needing a
 * dedicated bridging frame). A TR card exists precisely because the
 * director wants ONE hero frame that visually carries a camera move,
 * optical event, digital distortion, or environmental beat across the cut.
 *
 * ── Core design principle (added in anchor-bias fix) ──────────────────
 *
 * A TR frame represents a SINGLE MOMENT on the A→B timeline, usually at
 * the technique's peak (~70–80% through the transition). It is NOT a
 * composite showing both shots' subjects at equal weight — that reads
 * as a "crossover poster", not a transition. Each technique therefore
 * declares an `anchor` so Claude knows, structurally:
 *
 *   · "A"         — frame lives inside Shot A; the technique is happening
 *                   TO Shot A's subjects; Shot B is absent or at most a
 *                   faint emergent hint. (The majority of techniques.)
 *   · "B"         — symmetric inverse. Reserved; no current technique
 *                   uses it (future-proofing only).
 *   · "bridge"    — frame legitimately shows both sides at once because
 *                   the technique IS the meeting of the two (an orbital
 *                   camera move that literally sweeps from one environment
 *                   to the other, or a morph where one silhouette becomes
 *                   another). Very rare — only 2 entries today.
 *   · "technique" — the effect itself owns the frame. Subjects from Shot
 *                   A and Shot B are degraded into texture / fragments /
 *                   channel ghosts; neither reads as a clean "protagonist
 *                   present" in the frame.
 *
 * This file is the ONLY place new techniques should be added. Three
 * consumers read from it:
 *
 *   1. `SortableContiCard`        — TR body dropdown + per-option tooltip.
 *   2. `lib/transitions.ts`       — injects `KNOWLEDGE_TRANSITION_GRAMMAR`
 *                                   into the Claude system prompt and
 *                                   `spec.guide` into the user message.
 *   3. Legacy `transition_type`   — `normalizeTransitionKey` maps stored
 *      normalizer                   strings (including the old catch-all
 *                                   `"TRANSITION"` and any unknown values)
 *                                   to a valid key or `null`.
 *
 * Categories are presentational (drives Select option grouping); they
 * deliberately mirror the six craft families a DP / editor would reach
 * for when deciding "what carries this bridge".
 */

export type TransitionKey =
  // ── Camera Movement ────────────────────────────────────────────────
  | "WHIP_PAN"
  | "ZOOM_PUNCH"
  | "DOLLY_ZOOM"
  | "CAMERA_ROLL"
  | "ARC_SWEEP"
  // ── Light & Optics ─────────────────────────────────────────────────
  | "LIGHT_LEAK"
  | "LENS_FLARE"
  | "DEFOCUS_PULL"
  // ── Digital / Glitch ───────────────────────────────────────────────
  | "GLITCH"
  | "DATAMOSH"
  | "CHROMATIC_SPLIT"
  | "VHS_WARP"
  // ── Geometric / Morph ──────────────────────────────────────────────
  | "MORPH"
  | "LIQUID_WARP"
  | "SHATTER"
  | "PRISM"
  // ── Environmental ──────────────────────────────────────────────────
  | "SMOKE_VEIL"
  | "WATER_RIPPLE"
  // ── Temporal ───────────────────────────────────────────────────────
  | "TIME_FREEZE";

export type TransitionCategory =
  | "Camera Movement"
  | "Light & Optics"
  | "Digital / Glitch"
  | "Geometric / Morph"
  | "Environmental"
  | "Temporal";

/** Anchor declares where in the A→B flow the hero frame LIVES.
 *  See the file-level docblock for the full taxonomy. */
export type TransitionAnchor = "A" | "B" | "bridge" | "technique";

export interface TransitionSpec {
  key: TransitionKey;
  /** English technique name shown in the dropdown trigger/option. */
  label: string;
  /** English one-line gloss used as the first tooltip line. 3–6 words. */
  tagline: string;
  /** Which shot (if any) is the frame's primary subject at the technique's
   *  peak. Surfaces to Claude as a required rule via the KB prefix, so the
   *  model cannot default to a 50/50 crossover composition. */
  anchor: TransitionAnchor;
  /** Directorial prompt guide (English, 2–3 sentences) — sent to Claude
   *  AND rendered as the second block of the option tooltip so the user
   *  sees exactly what the model will be told. Each guide MUST explicitly
   *  state: (a) the anchor it respects, (b) the peak moment being
   *  captured, (c) whether (and how faintly) the non-anchor shot's
   *  subject is allowed to appear. */
  guide: string;
  category: TransitionCategory;
}

export const TRANSITIONS: TransitionSpec[] = [
  /* ── Camera Movement ── */
  {
    key: "WHIP_PAN",
    label: "Whip Pan",
    tagline: "Peak of directional motion blur",
    anchor: "A",
    guide:
      "Anchor: Shot A. Capture the apex of a fast pan (~75% through the transition): Shot A's subjects and environment are smeared into long directional streaks of color along the pan axis, sharp detail collapsing into light trails. Shot B's subject is NOT rendered; at most a thin band of Shot B's color palette may bleed in from the leading edge of the pan.",
    category: "Camera Movement",
  },
  {
    key: "ZOOM_PUNCH",
    label: "Zoom Punch",
    tagline: "Peak frame of rapid zoom",
    anchor: "A",
    guide:
      "Anchor: Shot A. Frame the peak of an aggressive zoom (~75% through): Shot A's subjects and environment are being pulled into extreme radial motion blur, edges of frame stretched into speed lines along the lens axis. Shot B is NOT a co-equal subject — at most, a tiny, barely-resolved shape may sit at the exact focal vanishing point hinting at what follows, but it must read as 'not yet arrived,' never as a second protagonist sharing the frame.",
    category: "Camera Movement",
  },
  {
    key: "DOLLY_ZOOM",
    label: "Dolly Zoom (Vertigo)",
    tagline: "Perspective warp, Vertigo effect",
    anchor: "A",
    guide:
      "Anchor: Shot A. The Hitchcock / Vertigo effect rendered on Shot A: Shot A's subject stays locked in scale at center while Shot A's background perspective collapses inward or stretches outward unnaturally. Shot B's subject does NOT appear in the frame — this technique is a psychological warp of Shot A's world, and splitting focus defeats its dread.",
    category: "Camera Movement",
  },
  {
    key: "CAMERA_ROLL",
    label: "Camera Roll",
    tagline: "Mid-roll on lens axis",
    anchor: "A",
    guide:
      "Anchor: Shot A. The entire Shot A frame rotated 45–90° around the lens axis mid-transition, horizon tilted, world spinning. Motion blur trails opposite the roll direction so the rotation reads as movement rather than a static Dutch angle. Shot B's subject is NOT in frame; the roll is a pre-roll into the next cut, not a meeting of two worlds.",
    category: "Camera Movement",
  },
  {
    key: "ARC_SWEEP",
    label: "Arc Sweep",
    tagline: "Mid-arc orbital sweep",
    anchor: "bridge",
    guide:
      "Anchor: bridge. This is one of the few techniques that legitimately shows both shots at once — the mid-point of an orbital camera move where the curved path has swung roughly half-way from Shot A's environment toward Shot B's. A shared central subject (commonly a character or product the two shots agree on) remains centered while the background transitions from Shot A's setting on one side of frame to Shot B's on the other. Use this anchor ONLY when there is genuinely a single subject both shots share; otherwise the frame turns into a crossover poster.",
    category: "Camera Movement",
  },

  /* ── Light & Optics ── */
  {
    key: "LIGHT_LEAK",
    label: "Light Leak",
    tagline: "Film light leak exposure",
    anchor: "A",
    guide:
      "Anchor: Shot A. A warm amber, orange, or magenta chemical light wash bleeds in from one or more frame edges across Shot A, washing out detail near the leak and leaving grain, halation, and organic imperfection. The leak is the point — it evokes 8mm / 16mm film at the moment of over-exposure. Shot B's subject does NOT appear; at most, the color temperature of the leak may rhyme with Shot B's upcoming palette.",
    category: "Light & Optics",
  },
  {
    key: "LENS_FLARE",
    label: "Lens Flare Sweep",
    tagline: "Flare overwhelms the frame",
    anchor: "A",
    guide:
      "Anchor: Shot A. An anamorphic horizontal streak or bright circular flare sweeps across Shot A, with secondary ghost aperture reflections dominating the composition and the flare origin aligned with the strongest practical light in Shot A. Shot B's subject is NOT rendered; the flare is Shot A's world being overwhelmed by light, not a portal to a second scene.",
    category: "Light & Optics",
  },
  {
    key: "DEFOCUS_PULL",
    label: "Defocus Pull",
    tagline: "Focus fully dissolved",
    anchor: "A",
    guide:
      "Anchor: Shot A. The extreme out-of-focus state of Shot A at its peak dissolution: Shot A's silhouettes have melted into soft bokeh disks and abstract color fields, the viewer reads only shape and palette. Shot B's subject is NOT in frame; if anything, the bokeh's color temperature may begin to drift toward Shot B's palette, hinting at what focus will resolve into.",
    category: "Light & Optics",
  },

  /* ── Digital / Glitch ── */
  {
    key: "GLITCH",
    label: "Digital Glitch",
    tagline: "Digital artifact disruption",
    anchor: "technique",
    guide:
      "Anchor: technique. Blocky compression artifacts, torn horizontal scanlines, and displaced pixel bars fracture the frame so aggressively that the effect itself is the subject. Fragments of Shot A dominate the composition with slivers of Shot B's color visible in the displaced pixel bars, but NEITHER shot's protagonist / product reads as cleanly present — both are degraded into corrupted texture. High-contrast, broken, unstable.",
    category: "Digital / Glitch",
  },
  {
    key: "DATAMOSH",
    label: "Datamosh",
    tagline: "Frame blend collapse",
    anchor: "technique",
    guide:
      "Anchor: technique. Motion vectors from Shot A drag Shot B's pixel colors across the macroblock grid, producing smeared, oil-painted flow where neither image is cleanly legible. Shot A's silhouettes persist as vector ghosts; Shot B's textures flood across them. The codec failure is the subject — do NOT render a clean Shot A subject beside a clean Shot B subject.",
    category: "Digital / Glitch",
  },
  {
    key: "CHROMATIC_SPLIT",
    label: "Chromatic Split",
    tagline: "RGB channel offsets",
    anchor: "technique",
    guide:
      "Anchor: technique. Red, green, and blue channels offset spatially across Shot A, producing ghost-colored edges around every silhouette — the image reads like a mis-registered print, three parallel worlds failing to reconverge. Shot B is NOT rendered as a second subject; if anything, one of the channel offsets may carry Shot B's color cast as a ghost layer, but Shot B's protagonist does not appear.",
    category: "Digital / Glitch",
  },
  {
    key: "VHS_WARP",
    label: "VHS Warp",
    tagline: "Analog tape tracking warp",
    anchor: "A",
    guide:
      "Anchor: Shot A. Horizontal tracking bands, chroma bleeding, a vertical roll tear, and analog tape noise degrade Shot A; saturation pushes hot, edges smear into 1980s–90s VHS aesthetic at the moment of worst signal integrity. Shot B's subject does NOT appear; at most, a brief flash of Shot B's chroma may leak through the worst tear band.",
    category: "Digital / Glitch",
  },

  /* ── Geometric / Morph ── */
  {
    key: "MORPH",
    label: "Morph",
    tagline: "Silhouette morph in motion",
    anchor: "bridge",
    guide:
      "Anchor: bridge. A continuous rubber-sheet transformation captured mid-morph: the silhouette from Shot A is roughly half-way through becoming the silhouette from Shot B, features stretched and blended, the outline itself in motion. Unlike a dissolve, this is a single morphing form — NOT two separate subjects side by side. Use only when Shot A and Shot B's subjects visually rhyme enough to morph (similar pose, shape, or framing).",
    category: "Geometric / Morph",
  },
  {
    key: "LIQUID_WARP",
    label: "Liquid Warp",
    tagline: "Fluid viscous distortion",
    anchor: "A",
    guide:
      "Anchor: Shot A. Shot A viewed behind flowing water or molten glass: smooth curvilinear distortion ripples across Shot A's composition, the deformation continuous and viscous with no sharp breaks. Shot B's subject does NOT appear; the warp may bend Shot A's color palette toward Shot B's, suggesting the impending change, but Shot B's protagonist is not rendered.",
    category: "Geometric / Morph",
  },
  {
    key: "SHATTER",
    label: "Shatter",
    tagline: "Glass / shard fracture",
    anchor: "A",
    guide:
      "Anchor: Shot A. Shot A fractures into angular reflective shards flying outward or toward the camera, each shard carrying a distorted slice of Shot A's image and refracting light at its edges. Through the widening gaps between shards, Shot B may be glimpsed as a distant, unfocused backdrop — NOT as a second protagonist in frame, just a faint field of color and shape. Shot A's subject remains the dominant element in the breaking pieces.",
    category: "Geometric / Morph",
  },
  {
    key: "PRISM",
    label: "Prism Split",
    tagline: "Prism spectral split",
    anchor: "A",
    guide:
      "Anchor: Shot A. Shot A viewed through a prism: the image replicates into offset spectral copies (red-shifted, blue-shifted ghost frames) that overlap kaleidoscopically. Shot B's subject does NOT appear as an additional protagonist; at most one of the spectral copies may carry Shot B's color temperature as a chromatic hint.",
    category: "Geometric / Morph",
  },

  /* ── Environmental ── */
  {
    key: "SMOKE_VEIL",
    label: "Smoke Veil",
    tagline: "Veiled by billowing smoke",
    anchor: "A",
    guide:
      "Anchor: Shot A. Frame the moment ~75% through the transition: Shot A's subjects are nearly consumed by billowing smoke, fog, or steam — outlines only barely readable through the densest volume, volumetric light rays cutting down through the haze. Shot B's subject is NOT in frame; at most, a faint color-temperature bleed from one edge where the smoke is thinnest hints that something follows. Do NOT place Shot A's protagonist and Shot B's protagonist together in the frame separated by smoke — that is a crossover poster, not a smoke veil.",
    category: "Environmental",
  },
  {
    key: "WATER_RIPPLE",
    label: "Water Ripple",
    tagline: "Water ripple refraction",
    anchor: "A",
    guide:
      "Anchor: Shot A. Shot A seen through a disturbed water surface: concentric ripples emanate from an impact point, refraction distortion sweeps across the image, and droplet beading catches practical light. Lensing effects warp Shot A most where the water is thickest. Shot B's subject does NOT appear; the ripple is Shot A being disrupted, not a portal revealing Shot B's protagonist.",
    category: "Environmental",
  },

  /* ── Temporal ── */
  {
    key: "TIME_FREEZE",
    label: "Time Freeze",
    tagline: "Hero in suspended time",
    anchor: "A",
    guide:
      "Anchor: Shot A. A single frozen moment INSIDE Shot A — dust, water droplets, debris, or particles suspended mid-air around Shot A's subject; hair and fabric caught mid-motion; motion streaks held in place. The camera may circle the frozen subject ('bullet time') even as time has stopped. Shot B's subject is NOT in frame; the freeze is an interruption of Shot A's world, not a meeting with the next shot's world.",
    category: "Temporal",
  },
];

/** Category display order + contents. Drives Select grouping. */
export const TRANSITION_CATEGORIES: Array<{
  category: TransitionCategory;
  items: TransitionSpec[];
}> = (() => {
  const order: TransitionCategory[] = [
    "Camera Movement",
    "Light & Optics",
    "Digital / Glitch",
    "Geometric / Morph",
    "Environmental",
    "Temporal",
  ];
  return order.map((category) => ({
    category,
    items: TRANSITIONS.filter((t) => t.category === category),
  }));
})();

/** Fast lookup by key. Built once at module load. */
export const TRANSITION_MAP: Record<TransitionKey, TransitionSpec> = Object.fromEntries(
  TRANSITIONS.map((t) => [t.key, t]),
) as Record<TransitionKey, TransitionSpec>;

const VALID_KEYS = new Set<string>(TRANSITIONS.map((t) => t.key));

/** Default for a freshly-inserted TR card. Whip Pan is the most common
 *  camera-driven transition and the safest starting point for the LLM
 *  to refine via the director's intent text. */
export const DEFAULT_TRANSITION_KEY: TransitionKey = "WHIP_PAN";

/**
 * Normalizes a stored `transition_type` string into a known key, or
 * `null` if we can't confidently map it.
 *
 *   · Known keys (incl. case-insensitive, spaces / hyphens tolerated)
 *     → that key.
 *   · Legacy catch-all `"TRANSITION"` — used to be the ONLY value every
 *     TR card was inserted with before this grammar existed — is
 *     treated as unset (null) so the UI can surface it as "Select a
 *     technique" rather than silently pretending it's a specific technique.
 *   · null / undefined / empty / any other string → null.
 *
 * Callers that need a concrete key (e.g. the Claude prompt builder)
 * should fall back to `DEFAULT_TRANSITION_KEY` themselves; we
 * deliberately don't do that here so the UI layer can tell "unset"
 * from "picked Whip Pan".
 */
export function normalizeTransitionKey(raw: string | null | undefined): TransitionKey | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Legacy: the old default before any technique choice existed.
  if (trimmed.toUpperCase() === "TRANSITION") return null;
  // Tolerate display-ish variants ("Whip Pan", "whip-pan", "whip pan").
  const canon = trimmed.toUpperCase().replace(/[\s-]+/g, "_");
  if (VALID_KEYS.has(canon)) return canon as TransitionKey;
  return null;
}

/** Human-readable version of the `anchor` field, surfaced to Claude as
 *  an inline tag on each technique entry so the model cannot skim past
 *  it. Kept close to the data so drift between the spec and the KB is
 *  a single-point-of-failure. */
function anchorLabel(anchor: TransitionAnchor): string {
  switch (anchor) {
    case "A":
      return "Anchor=ShotA (Shot B's subject absent / at most a faint edge hint)";
    case "B":
      return "Anchor=ShotB (Shot A's subject absent / at most a faint edge hint)";
    case "bridge":
      return "Anchor=Bridge (both shots legitimately share this frame — use only when genuinely warranted)";
    case "technique":
      return "Anchor=Technique (effect owns the frame; neither subject is cleanly protagonist)";
  }
}

/**
 * The directorial knowledge block we prepend to the Claude system
 * prompt. Each line is: `- KEY (Label) [AnchorLabel]: guide`.
 *
 * Rationale for injecting as system rather than user content: the
 * guidance is stable across every TR generation request in a session
 * and benefits from prompt caching on the Anthropic side; the per-TR
 * user message only needs to say "pick technique X and apply its
 * guide to these two specific shots".
 *
 * The anchor tag is front-loaded on every entry because the #1
 * failure mode we're designing against is Claude splitting focus
 * 50/50 between Shot A and Shot B even when the technique clearly
 * anchors in one shot.
 */
export const KNOWLEDGE_TRANSITION_GRAMMAR: string = (() => {
  const lines: string[] = [
    "TRANSITION TECHNIQUE LIBRARY — authoritative reference for bridging frames between two already-shot cuts. Each entry describes what a single hero frame in that technique should look like from a director / DP standpoint.",
    "",
    "CORE PRINCIPLE — READ FIRST:",
    "  A TR frame is a SINGLE MOMENT on the A→B timeline, usually at the technique's peak (~70–80% through the transition). It is NOT a composite showing both shots' subjects at equal weight. The overwhelming failure mode is rendering Shot A's protagonist and Shot B's protagonist side-by-side with the effect between them — this reads as a crossover poster, not a transition. Each entry below carries an [Anchor=…] tag stating where the frame lives:",
    "    · Anchor=ShotA / Anchor=ShotB — frame lives inside that shot; the OTHER shot's subject is absent or at most a faint edge hint.",
    "    · Anchor=Bridge — the rare case where both shots legitimately share the frame (orbital sweeps, morphs that literally fuse silhouettes).",
    "    · Anchor=Technique — the effect itself owns the frame; subjects are degraded into texture / ghosts / fragments.",
    "  Honor the anchor as a hard constraint, not a suggestion.",
    "",
  ];
  for (const group of TRANSITION_CATEGORIES) {
    lines.push(`## ${group.category}`);
    for (const t of group.items) {
      lines.push(`- ${t.key} (${t.label}) [${anchorLabel(t.anchor)}]: ${t.guide}`);
    }
    lines.push("");
  }
  lines.push(
    "When a specific technique is requested downstream, honor that technique's entry as the structural spine of the bridging frame AND respect its declared anchor. Never blend two entries into one frame unless the user's intent text explicitly asks for it.",
  );
  return lines.join("\n");
})();
