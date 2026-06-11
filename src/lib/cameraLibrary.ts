/**
 * cameraLibrary — Shared vocabulary for cinematic camera direction used across
 * CameraVariationsModal (Presets / Contact Sheet) and ChangeAngleModal
 * (Advanced A-then-B chain).
 *
 * Why this lives in one file
 * --------------------------
 * Every NB2 (Gemini 3.1 Flash Image) call we make for "re-photograph this
 * scene from a different camera position" pays a tax in consistency. The
 * model has no real 3D scene understanding, so the only lever we have is
 * prompt craft. Our field-tested pattern is:
 *
 *   1. Lead with an imperative verb + object ("Re-photograph ...").
 *   2. State what must be preserved — identity, costume, props, environment,
 *      lighting, art style — because NB2's default failure mode is to
 *      redesign the character rather than move the camera.
 *   3. Hand NB2 a single declarative camera-position phrase it already
 *      recognises (ECU, OTS, Dutch, over-shoulder etc.) rather than
 *      coordinate-style input (yaw/pitch/zoom) which it ignores.
 *   4. Optionally colour the shot with an emotion/intent chip, because the
 *      Notion reference library shows NB2 reacts well to "tense", "intimate",
 *      "triumphant" etc. — they bias framing and expression without
 *      overwriting subject identity.
 *   5. For big moves (distance + angle combined), use "A, then B" chaining
 *      instead of stacking adjectives: "Frame it as a WIDE ESTABLISHING
 *      SHOT, then make it a LOW-ANGLE HEROIC SHOT." This consistently beats
 *      the naive "wide low-angle heroic shot" for NB2.
 *
 * This library encodes all of the above:
 *   - CAMERA_PRESETS:  22 individual shot primitives, grouped by category.
 *   - EMOTION_CHIPS:   small adjective packs that bias framing/expression.
 *   - CONTACT_SHEET_IDS: curated 9-up grid designed to survive a single
 *                         NB2 call (distance × angle coverage).
 *   - buildPresetPrompt / buildAdvancedChainPrompt / buildContactSheetPrompt:
 *     the prompt builders each modal in this app should use. Keeping them
 *     here means any future tuning happens once, not three times.
 */

export type CameraCategory = "distance" | "angle" | "creative";

export interface CameraPreset {
  id: string;
  label: string;
  category: CameraCategory;
  /** One-line blurb shown on the preset card. */
  shortDesc: string;
  /**
   * Declarative NB2-ready camera-position phrase. Always written in the
   * imperative / third person so it can be dropped straight into a sentence
   * like "Frame it as ${phrase}." with no grammatical stitching needed.
   */
  phrase: string;
  /** Surfaced as a chip-group filter in the UI. */
  recommended?: boolean;
  /**
   * Novel-view difficulty tier (6-C).
   *   "stable"       — distance presets + gentle angle changes (default).
   *   "experimental" — back / overhead / worm's-eye / dutch etc. — large
   *                    viewpoint moves that can drift from the source.
   * Absent is treated as "stable".
   */
  reliability?: "stable" | "experimental";
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 22 Camera presets — sourced from the Notion reference library
 * (Phase 1 of the Camera Variations plan). Grouped by category so
 * the UI can section them the same way a DOP thinks about it:
 *   Distance  — how far is the camera from the subject?
 *   Angle     — where is the camera relative to eye line?
 *   Creative  — stylised framings that combine both.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export const CAMERA_PRESETS: CameraPreset[] = [
  // ── Distance ─────────────────────────────────────────────
  {
    id: "els",
    label: "Extreme Wide",
    category: "distance",
    shortDesc: "Location dominates, subject tiny",
    phrase:
      "an EXTREME LONG SHOT (ELS). Camera pulled far back. The subject is small within the frame, deeply integrated into the whole environment. Clear foreground, midground, and background layers.",
    recommended: true,
  },
  {
    id: "ls",
    label: "Wide",
    category: "distance",
    shortDesc: "Full body + environment context",
    phrase:
      "a WIDE SHOT / LONG SHOT (LS). Subject full-body within the frame with generous space around them. Environment is clearly readable but the subject anchors the composition.",
    recommended: true,
  },
  {
    id: "ms",
    label: "Medium",
    category: "distance",
    shortDesc: "Waist-up, eye level",
    phrase:
      "a MEDIUM SHOT (MS). Camera at eye level. Subject framed from the waist up, centered, moderate headroom, background softly secondary.",
  },
  {
    id: "mcu",
    label: "Medium Close-Up",
    category: "distance",
    shortDesc: "Chest-up, conversational",
    phrase:
      "a MEDIUM CLOSE-UP (MCU). Camera moved in to frame the subject from roughly the chest up. Intimate but still shows shoulders and immediate surroundings.",
    recommended: true,
  },
  {
    id: "cu",
    label: "Close-Up",
    category: "distance",
    shortDesc: "Face fills the frame",
    phrase:
      "a TIGHT CLOSE-UP (CU). The subject's face and upper chest fill the frame. Strong shallow depth of field, background reduced to soft bokeh. Detailed and intimate.",
    recommended: true,
  },
  {
    id: "ecu",
    label: "Extreme Close-Up",
    category: "distance",
    shortDesc: "Eye / single feature",
    phrase:
      "an EXTREME CLOSE-UP (ECU). The frame holds a single feature — the subject's eye, mouth, or hand. Extreme shallow focus, nearly abstract composition.",
  },

  // ── Angle ────────────────────────────────────────────────
  {
    id: "eye_level",
    label: "Eye Level",
    category: "angle",
    shortDesc: "Neutral, observational",
    phrase:
      "an EYE-LEVEL SHOT. Camera at the subject's eye height, lens roughly parallel to the ground. Neutral, documentary feel.",
  },
  {
    id: "low_angle",
    label: "Low Angle",
    category: "angle",
    shortDesc: "Looking up — heroic",
    phrase:
      "a LOW-ANGLE HEROIC SHOT. Camera placed below waist height, tilted upward at the subject. The subject towers into the frame against the sky or ceiling. Strong upward foreshortening, imposing perspective.",
    recommended: true,
  },
  {
    id: "high_angle",
    label: "High Angle",
    category: "angle",
    shortDesc: "Looking down — observational",
    phrase:
      "a HIGH-ANGLE SHOT. Camera placed well above the subject, tilted downward. The subject appears smaller and vulnerable; ground or floor is visible around them.",
  },
  {
    id: "overhead",
    label: "Overhead / Top-down",
    category: "angle",
    shortDesc: "Bird's-eye flat-lay",
    phrase:
      "an OVERHEAD TOP-DOWN SHOT. Camera directly above the subject, lens pointed straight down. Bird's-eye view. Subject and surrounding elements laid out as a flat composition.",
    reliability: "experimental",
  },
  {
    id: "worms_eye",
    label: "Worm's Eye",
    category: "angle",
    shortDesc: "Ground-up, extreme low",
    phrase:
      "a WORM'S-EYE VIEW. Camera placed at ground level looking almost straight up. The subject looms enormous overhead, sky or ceiling dominates the top of the frame.",
    reliability: "experimental",
  },
  {
    id: "birds_eye",
    label: "Bird's Eye",
    category: "angle",
    shortDesc: "High aerial survey",
    phrase:
      "a BIRD'S-EYE VIEW. Camera high in the air looking down at a steep angle. The subject is visible within a wide swath of surrounding environment, map-like perspective.",
    reliability: "experimental",
  },
  {
    id: "dutch",
    label: "Dutch Tilt",
    category: "angle",
    shortDesc: "Canted horizon, uneasy",
    phrase:
      "a DUTCH ANGLE / CANTED SHOT. Camera rolled 15–25° so the horizon line is noticeably tilted. Dynamic off-kilter tension while the subject stays centered.",
    reliability: "experimental",
  },

  // ── Creative ─────────────────────────────────────────────
  {
    id: "ots",
    label: "Over the Shoulder",
    category: "creative",
    shortDesc: "POV from behind a character",
    phrase:
      "an OVER-THE-SHOULDER SHOT (OTS). Camera positioned just behind one character's shoulder, looking past it toward the other subject. Foreground shoulder and back of head softly out of focus. Classic conversation framing.",
    recommended: true,
  },
  {
    id: "pov",
    label: "POV",
    category: "creative",
    shortDesc: "Through the subject's eyes",
    phrase:
      "a FIRST-PERSON POINT-OF-VIEW SHOT. Camera placed exactly where the subject's eyes are — we see what they see, hands or arms may enter the bottom of the frame, no face of the subject is visible.",
    reliability: "experimental",
  },
  {
    id: "two_shot",
    label: "Two Shot",
    category: "creative",
    shortDesc: "Two subjects sharing frame",
    phrase:
      "a TWO-SHOT. Both subjects framed together, roughly equal visual weight, eye-level camera. Their relationship, not either individual, is the subject of the frame.",
  },
  {
    id: "profile",
    label: "Profile",
    category: "creative",
    shortDesc: "Pure side view",
    phrase:
      "a PROFILE SHOT. Camera perpendicular to the subject's face — a clean side view. Silhouette of the nose, lips, and jaw reads cleanly against the background.",
  },
  {
    id: "back",
    label: "Back View",
    category: "creative",
    shortDesc: "Facing away from camera",
    phrase:
      "a BACK VIEW. Camera directly behind the subject, framing them from behind as they face into the scene. The audience sees what the subject is walking toward.",
    reliability: "experimental",
  },
  {
    id: "wide_low_hero",
    label: "Wide Low Hero",
    category: "creative",
    shortDesc: "Wide + low-angle heroic combo",
    phrase:
      "a WIDE LOW-ANGLE HEROIC SHOT. Camera far back and below waist height, tilted up. The subject is small enough for the full environment to read but the upward angle makes them the visual anchor.",
  },
  {
    id: "cu_dutch",
    label: "Close-up Dutch",
    category: "creative",
    shortDesc: "Close-up with canted horizon",
    phrase:
      "a CLOSE-UP with a DUTCH TILT. Face fills the frame, but the whole image is rotated 15–20° so the eye line cuts across the frame diagonally. Intimate and unsettled.",
    reliability: "experimental",
  },
  {
    id: "silhouette",
    label: "Silhouette",
    category: "creative",
    shortDesc: "Backlit outline only",
    phrase:
      "a SILHOUETTE SHOT. Strong backlight behind the subject, the subject rendered as a dark outline with little interior detail, environmental light sources glowing around them.",
  },
  {
    id: "reflection",
    label: "Reflection / Mirror",
    category: "creative",
    shortDesc: "Seen via reflective surface",
    phrase:
      "a REFLECTION SHOT. The subject is seen via a mirror, puddle, glass, or other reflective surface somewhere in the scene. The reflection is the primary image, the 'real' subject may be partly visible at frame edge.",
    reliability: "experimental",
  },
];

/** Lookup by id — constant-time via map built once at module load. */
const PRESET_BY_ID: Record<string, CameraPreset> = Object.fromEntries(
  CAMERA_PRESETS.map((p) => [p.id, p]),
);
export const getPreset = (id: string): CameraPreset | undefined => PRESET_BY_ID[id];

export const CAMERA_PRESETS_BY_CATEGORY: Record<CameraCategory, CameraPreset[]> = {
  distance: CAMERA_PRESETS.filter((p) => p.category === "distance"),
  angle: CAMERA_PRESETS.filter((p) => p.category === "angle"),
  creative: CAMERA_PRESETS.filter((p) => p.category === "creative"),
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Emotion / Intent chips.
 * Not camera geometry — these are tone modifiers that slip into the
 * prompt as "... shot with a <mood> feel." The Notion reference
 * library shows NB2 picks them up and biases framing/expression
 * without overwriting subject identity.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export interface EmotionChip {
  id: string;
  label: string;
  /** Phrase inserted into the prompt tail (e.g. "intimate and reverent"). */
  phrase: string;
}
export const EMOTION_CHIPS: EmotionChip[] = [
  { id: "neutral", label: "Neutral", phrase: "" },
  { id: "tense", label: "Tense", phrase: "tense, anxious atmosphere" },
  { id: "intimate", label: "Intimate", phrase: "intimate and quiet, close emotional distance" },
  { id: "triumphant", label: "Triumphant", phrase: "triumphant, heroic, uplifting" },
  { id: "melancholy", label: "Melancholy", phrase: "melancholic, contemplative, wistful" },
  { id: "playful", label: "Playful", phrase: "playful, light-hearted energy" },
  { id: "ominous", label: "Ominous", phrase: "ominous, foreboding mood" },
  { id: "reverent", label: "Reverent", phrase: "reverent, awe-struck, cinematic grandeur" },
  { id: "chaotic", label: "Chaotic", phrase: "chaotic, kinetic, fast-paced energy" },
];
export const getEmotion = (id: string): EmotionChip | undefined =>
  EMOTION_CHIPS.find((e) => e.id === id);

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contact-sheet picks.
 * NB2 can reliably lay out 9 sub-panels in a single 1:1 / 2K output
 * if we prompt it like a DOP's contact sheet. We hand-pick 9
 * presets that together give strong distance + angle coverage
 * while being visually distinct enough to survive a shared prompt.
 * Order matters: left→right, top→bottom in the 3x3 grid.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export const CONTACT_SHEET_IDS: string[] = [
  "els",        // 1  top-left     — extreme wide
  "ls",         // 2  top-center   — wide
  "ms",         // 3  top-right    — medium
  "mcu",        // 4  mid-left     — medium close-up
  "cu",         // 5  mid-center   — close-up
  "low_angle",  // 6  mid-right    — low-angle heroic
  "high_angle", // 7  bot-left     — high-angle
  "ots",        // 8  bot-center   — over-the-shoulder
  "dutch",      // 9  bot-right    — dutch tilt
];
export const contactSheetPresets = (): CameraPreset[] =>
  CONTACT_SHEET_IDS.map((id) => PRESET_BY_ID[id]).filter(Boolean);

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Preserve-bullets — the non-negotiable "keep this exactly" list
 * that every camera-variation prompt must lead with. Centralised so
 * the Presets, Contact Sheet, and Advanced paths all speak NB2 the
 * same way.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/* Bullets that hold for ALL camera moves. The background/location bullet is
 * pulled OUT of this list because at large yaw (>90°) "keep the background
 * layout" physically contradicts "the camera moved to the other side" — the
 * model then compromises by rotating only the subject. See BG_BULLET_* below. */
const PRESERVE_BULLETS_COMMON = [
  "• Every character — identical face, hair, skin tone, body proportions, age, expression",
  "• All clothing and accessories — identical designs, colors, fabrics, patterns, wear",
  "• All props, vehicles, and objects — same models, colors, surface details",
  "• Time of day, weather, overall lighting direction and color palette",
  "• Art style, rendering technique, line quality, grain, and painterly feel",
  // Image models trained with horizontal-flip augmentation routinely
  // mirror left/right when the prompt includes a side word, so a watch
  // jumps wrists, hair part swaps sides, etc. The bullet below gives an
  // explicit anti-mirror rule. Examples are kept generic + parenthetical
  // so we don't accidentally hint that a human subject MUST exist when
  // the reference is actually an object-only still (weapon on a
  // platform, vehicle, set piece) — earlier wording listed body-part
  // examples and the model occasionally invented a person to satisfy
  // them.
  "• LEFT/RIGHT orientation — do NOT mirror or horizontally flip the image. Whatever feature sits on the LEFT side of the subject in the reference must stay on the LEFT side in the new shot, and the same for the RIGHT side. (Examples: for a person, a watch on the right wrist stays on the right wrist; hair parted on the right stays parted on the right. For an object, any asymmetric detail — a side rail, a logo, a bullet ejection port — keeps the same side as in the reference.) Re-photographing from a new camera angle never swaps which side of the subject a feature is on.",
];

/** yaw ≤ 90°: 기존과 동일 — 배경 레이아웃 자체를 보존. */
const BG_BULLET_PRESERVE =
  "• The environment, architecture, set dressing, terrain, and background layout";

/** yaw > 90°: 같은 장소이되 새 시점에선 보이는 배경이 반드시 바뀌어야 함을 명시. */
const BG_BULLET_ORBIT =
  "• The LOCATION — the same physical place, same architecture, same materials, " +
  "same set dressing style. HOWEVER: because the camera has moved to the other " +
  "side of the subject, the VISIBLE BACKDROP MUST CHANGE. The area that was " +
  "BEHIND the original camera is now visible behind the subject. Do NOT keep " +
  "the original backdrop pixels behind the subject — that would mean the camera " +
  "did not actually move. Render a plausible continuation of the same location " +
  "as seen from the new camera position.";

export interface PreserveOptions {
  /** 카메라 yaw 절대값(도). 90 초과 시 배경 불릿을 "일관 변경" 지시로 교체. */
  yawAbs?: number;
}

const preserveBlock = (subject: string, opts?: PreserveOptions): string => {
  const subjectLine = subject
    ? `Reference subject: ${subject}.\n\n`
    : "";
  const yawAbs = Math.abs(opts?.yawAbs ?? 0);
  const isOrbit = yawAbs > 90;
  const bgBullet = isOrbit ? BG_BULLET_ORBIT : BG_BULLET_PRESERVE;
  // 배경 불릿을 props(index 2) 다음, time-of-day(index 3) 앞에 끼워 기존 순서 유지.
  const bullets = [
    ...PRESERVE_BULLETS_COMMON.slice(0, 3),
    bgBullet,
    ...PRESERVE_BULLETS_COMMON.slice(3),
  ].join("\n");
  // 큰 오빗에선 마지막 invent-guard 불릿을 "새로 보이는 영역 채우기는 필수" 로 강화.
  const newlyVisibleBullet = isOrbit
    ? "• Newly visible regions (the backdrop behind the subject from this new angle) must be filled with a plausible continuation of the SAME location — same architecture, materials, lighting, and style as the reference — never with new characters, new props, or new story content. Filling these regions IS required; leaving the original backdrop unchanged is an error."
    : "• If a region of the scene becomes newly visible because of the camera move, fill it with a plausible continuation of what is already shown in the reference (same materials, lighting, style) — never with new characters or new story content.";
  return (
    `${subjectLine}STRICTLY PRESERVE (must match the reference image):\n` +
    bullets +
    "\n\nThe world depicted in the reference image is unchanged — only the camera viewpoint has moved. " +
    "Think of a second camera on the same set, shooting the same moment from a new angle.\n\n" +
    "DO NOT INVENT CONTENT THAT IS NOT IN THE REFERENCE:\n" +
    "• If the reference contains NO people, the new shot must also contain no people. Do not add a soldier, a hand, a figure, a bystander, or any human element that was not visible in the reference.\n" +
    "• If the reference contains exactly N figures, the new shot must contain exactly N figures (same identities, same outfits, same poses adjusted only for the new viewpoint).\n" +
    "• Do not add new props, weapons, vehicles, furniture, signage, text, screens, particle effects, weather, or background elements that are not visible in the reference.\n" +
    "• Do not add new staging, blocking, action beats, or storytelling moments. The same instant in time is being re-photographed — nothing has happened between the reference and the new shot.\n" +
    newlyVisibleBullet
  );
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Preset prompt (single camera move).
 * Used by: CameraVariationsModal → Presets tab, for each selected
 * preset. This is the workhorse prompt for the app.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export interface PresetPromptInput {
  preset: CameraPreset;
  subject: string;
  emotion?: EmotionChip | null;
  extraNotes?: string;
}
export function buildPresetPrompt({
  preset,
  subject,
  emotion,
  extraNotes,
}: PresetPromptInput): string {
  const emoPhrase = emotion && emotion.phrase ? emotion.phrase : "";
  const notes = (extraNotes ?? "").trim();
  const moodTail = emoPhrase ? ` The overall feel is ${emoPhrase}.` : "";
  const notesTail = notes ? `\n\nAdditional notes: ${notes}` : "";

  return (
    "Re-photograph the EXACT SAME scene shown in the reference image from a different camera position.\n\n" +
    `Frame it as ${preset.phrase}${moodTail}\n\n` +
    preserveBlock(subject) +
    notesTail
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Advanced chain prompt ("A, then B").
 * Used by: ChangeAngleModal (and future Advanced tab).
 * NB2 follows a two-step natural-language chain noticeably better
 * than a stacked adjective run. Empirically: "wide, low-angle,
 * heroic" is often flattened to "wide" only; whereas
 * "Frame it as a WIDE SHOT, then make it a LOW-ANGLE HEROIC SHOT"
 * retains both intents.
 *
 * distance / angle are each OPTIONAL. Callers pass whichever the
 * user has moved from neutral — if both are neutral, we fall back
 * to a single-step "same reference scene" prompt for a safe reroll.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export interface AdvancedChainInput {
  subject: string;
  /** Camera distance descriptor sentence (e.g. yawPhrase+zoomPhrase). */
  distanceClause?: string | null;
  /** Camera angle descriptor sentence (e.g. pitchPhrase or orbit dir). */
  angleClause?: string | null;
  emotion?: EmotionChip | null;
  extraNotes?: string;
  /** 카메라 yaw 절대값(도). ChangeAngleModal 이 cfg.yaw 절대값을 전달 (4-B). */
  yawAbs?: number;
}
export function buildAdvancedChainPrompt({
  subject,
  distanceClause,
  angleClause,
  emotion,
  extraNotes,
  yawAbs,
}: AdvancedChainInput): string {
  const d = (distanceClause ?? "").trim();
  const a = (angleClause ?? "").trim();
  const emoPhrase = emotion && emotion.phrase ? emotion.phrase : "";
  const notes = (extraNotes ?? "").trim();
  const moodTail = emoPhrase ? ` The overall feel is ${emoPhrase}.` : "";
  const notesTail = notes ? `\n\nAdditional notes: ${notes}` : "";

  if (!d && !a) {
    // No camera move — user just wants a safe reroll of the same frame.
    return (
      "Re-render the same reference scene — same character, same outfit, same props, same location, same lighting, same style, same camera position." +
      moodTail +
      notesTail
    );
  }

  let chain: string;
  if (d && a) {
    // Two-step chain. Order matters: distance first (establishes framing
    // bucket), angle second (refines viewpoint). Reversing this makes NB2
    // frequently ignore the distance step.
    chain = `Frame it as ${d}, then make it ${a}.`;
  } else {
    chain = `Frame it as ${d || a}.`;
  }

  return (
    "Re-photograph the EXACT SAME scene shown in the reference image from a different camera position.\n\n" +
    chain +
    moodTail +
    "\n\n" +
    preserveBlock(subject, { yawAbs }) +
    notesTail
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Contact-sheet prompt (3x3 grid in one image).
 * Used by: CameraVariationsModal → Contact Sheet tab.
 * NB2 is surprisingly good at laying out multiple sub-frames in a
 * single output when prompted like a real contact sheet, and this
 * gives us 9 camera explorations for the cost of one API call
 * with strong intra-image consistency (the model keeps the same
 * character across panels because they all exist in one canvas).
 *
 * We ask for a 3x3 grid of clearly numbered panels so the client
 * splitter can count tiles reliably. Thin white gutters are
 * cosmetically helpful too — they let the splitter snap cleanly
 * to the tile boundaries and signal to NB2 that these ARE
 * separate frames, not a single widescreen image.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export interface ContactSheetPromptInput {
  subject: string;
  /** Ordered list of 9 preset phrases, one per grid cell. */
  presets?: CameraPreset[];
  emotion?: EmotionChip | null;
  extraNotes?: string;
}
export function buildContactSheetPrompt({
  subject,
  presets,
  emotion,
  extraNotes,
}: ContactSheetPromptInput): string {
  const selected = presets ?? contactSheetPresets();
  const lines = selected
    .slice(0, 9)
    .map((p, i) => `  Panel ${i + 1} — ${p.label}: ${p.phrase}`)
    .join("\n");
  const emoPhrase = emotion && emotion.phrase ? emotion.phrase : "";
  const moodTail = emoPhrase ? ` The overall feel is ${emoPhrase}.` : "";
  const notes = (extraNotes ?? "").trim();
  const notesTail = notes ? `\n\nAdditional notes: ${notes}` : "";

  return (
    "Produce a 3x3 cinematographer's CONTACT SHEET of the EXACT SAME scene shown in the reference image, each panel re-photographed from a different camera position.\n\n" +
    "Layout: 9 panels arranged in a 3x3 grid, left→right then top→bottom, separated by thin clean white gutters. Each panel is a complete, properly framed film still — not a tile of a larger image. All 9 panels share the exact same characters, costumes, props, location, lighting, and art style as the reference image.\n\n" +
    "Panels:\n" +
    lines +
    "\n\n" +
    preserveBlock(subject) +
    moodTail +
    "\n\nAll 9 panels depict the same moment from 9 different camera angles. Do not change identity, outfit, or environment between panels." +
    notesTail
  );
}
