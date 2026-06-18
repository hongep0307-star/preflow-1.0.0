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
  | "TIME_FREEZE"
  // ── Graphic / Motion (motion-graphics native) ───────────────────────
  | "SHAPE_WIPE"
  | "IRIS_WIPE"
  | "LAYER_SLIDE"
  | "LAYER_PUSH"
  | "KINETIC_TYPO"
  | "GRAPHIC_MATCH";

export type TransitionCategory =
  | "Camera Movement"
  | "Light & Optics"
  | "Digital / Glitch"
  | "Geometric / Morph"
  | "Environmental"
  | "Temporal"
  | "Graphic / Motion";

/** Production medium a technique fits. Motion mode filters OUT `live`-only
 *  techniques (they assume a filmed lens/optical/environmental event). */
export type TransitionMedium = "live" | "mograph" | "both";

/** What the TR card should produce for this technique:
 *   · "peak_still"      — a single hero frame at the technique's peak is
 *                          meaningful → AI-generate via generateTransitionFrame.
 *   · "note_pair"       — a single still is uninformative (temporal/layer wipe);
 *                          show the existing A & B cut thumbnails + a direction
 *                          note. NO AI image generation.
 *   · "note_pair_crop"  — note_pair PLUS a deterministic focal-aligned crop of
 *                          A & B so a graphic match visually lines up. No AI. */
export type TransitionDeliverable = "peak_still" | "note_pair" | "note_pair_crop";

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
  /** Production medium fit. Motion mode excludes `live`-only entries.
   *  Optional on the entry — authoritative source is `MEDIUM_BY_KEY` below,
   *  read via `transitionMedium(key)` (defaults to "both"). */
  medium?: TransitionMedium;
  /** TR-card output type — drives generate-vs-note rendering. Optional on the
   *  entry — authoritative source is `DELIVERABLE_BY_KEY`, read via
   *  `transitionDeliverable(key)` (defaults to "peak_still"). */
  deliverable?: TransitionDeliverable;
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

  /* ── Graphic / Motion (motion-graphics native) ──
   * These are NOT a single filmed peak moment; they are temporal/layer
   * events whose value is the MOTION between the two cuts, so the TR card
   * shows the existing A & B thumbnails + a direction note rather than an
   * AI-generated bridge still (deliverable = note_pair / note_pair_crop). */
  {
    key: "SHAPE_WIPE",
    label: "Shape Wipe",
    tagline: "Geometric mask reveal A→B",
    anchor: "technique",
    guide:
      "A geometric shape (circle, bar, diagonal, brand mark) sweeps across frame and Shot B is revealed inside the growing mask while Shot A is pushed out. The wipe edge / shape is the carrier of the cut. Note the shape, its direction, and which element of Shot A the shape grows from.",
    category: "Graphic / Motion",
    medium: "mograph",
    deliverable: "note_pair",
  },
  {
    key: "IRIS_WIPE",
    label: "Iris / Circle Wipe",
    tagline: "Circular open/close reveal",
    anchor: "technique",
    guide:
      "A circular iris closes on a focal point of Shot A and opens onto Shot B (or vice versa). Best when A's and B's focal points sit at the same screen position so the iris feels motivated. Note the iris center and open/close direction.",
    category: "Graphic / Motion",
    medium: "mograph",
    deliverable: "note_pair",
  },
  {
    key: "LAYER_SLIDE",
    label: "Layer Slide",
    tagline: "Shot B slides over Shot A",
    anchor: "technique",
    guide:
      "Shot B slides in as a layer (from an edge) and covers Shot A, optionally with parallax/offset of sub-elements and an eased overshoot. Note the slide direction and any element that motivates it (a moving subject, a swipe).",
    category: "Graphic / Motion",
    medium: "mograph",
    deliverable: "note_pair",
  },
  {
    key: "LAYER_PUSH",
    label: "Layer Push",
    tagline: "Shot A pushes Shot B in",
    anchor: "technique",
    guide:
      "Shot A is pushed off-frame while Shot B pushes in from the opposite edge, the two locked together like panels (no overlap). Reads as a kinetic, rhythmic cut. Note the push axis and speed/easing.",
    category: "Graphic / Motion",
    medium: "mograph",
    deliverable: "note_pair",
  },
  {
    key: "KINETIC_TYPO",
    label: "Kinetic Typography",
    tagline: "Type-driven bridge",
    anchor: "technique",
    guide:
      "Animated typography (a key word, number, or the CTA) scales/slides across the cut and masks or wipes between Shot A and Shot B — the type itself carries the transition. Note the word, its motion, and whether it masks-reveals B.",
    category: "Graphic / Motion",
    medium: "mograph",
    deliverable: "note_pair",
  },
  {
    key: "GRAPHIC_MATCH",
    label: "Graphic Match",
    tagline: "Shape/color match cut A→B",
    anchor: "bridge",
    guide:
      "A seamless match cut where a shape, line, color mass, or composition in Shot A aligns with a matching element in Shot B so the eye reads continuity across the cut (e.g. A's round headlight → B's round logo). Note the matched element and where it sits in frame so A & B can be aligned.",
    category: "Graphic / Motion",
    medium: "mograph",
    deliverable: "note_pair_crop",
  },
];

/* ── Authoritative medium / deliverable per technique ──────────────────
 * Single source of truth (keeps the 19 legacy entries untouched). Entries
 * may also carry inline `medium`/`deliverable`; the helpers below prefer the
 * inline value, then this map, then a safe default. */
const MEDIUM_BY_KEY: Partial<Record<TransitionKey, TransitionMedium>> = {
  // Camera / optical / environmental / temporal events assume a filmed lens.
  DOLLY_ZOOM: "live",
  CAMERA_ROLL: "live",
  ARC_SWEEP: "live",
  LIGHT_LEAK: "live",
  LENS_FLARE: "live",
  DEFOCUS_PULL: "live",
  SMOKE_VEIL: "live",
  WATER_RIPPLE: "live",
  TIME_FREEZE: "live",
  // Equally at home in live action and motion graphics.
  WHIP_PAN: "both",
  ZOOM_PUNCH: "both",
  GLITCH: "both",
  DATAMOSH: "both",
  CHROMATIC_SPLIT: "both",
  VHS_WARP: "both",
  MORPH: "both",
  LIQUID_WARP: "both",
  SHATTER: "both",
  PRISM: "both",
  // Motion-graphics native.
  SHAPE_WIPE: "mograph",
  IRIS_WIPE: "mograph",
  LAYER_SLIDE: "mograph",
  LAYER_PUSH: "mograph",
  KINETIC_TYPO: "mograph",
  GRAPHIC_MATCH: "mograph",
};

const DELIVERABLE_BY_KEY: Partial<Record<TransitionKey, TransitionDeliverable>> = {
  SHAPE_WIPE: "note_pair",
  IRIS_WIPE: "note_pair",
  LAYER_SLIDE: "note_pair",
  LAYER_PUSH: "note_pair",
  KINETIC_TYPO: "note_pair",
  GRAPHIC_MATCH: "note_pair_crop",
  // everything else defaults to peak_still (AI-generated bridge frame).
};

/* ── 실행 레시피 (편집자/모션 디자이너 관점) ───────────────────────────
 * `guide` 는 "브릿지 정지 프레임 1장" 을 생성하기 위한 영문 묘사다(이미지 모델
 * 용). 그것만으로는 "사람이 편집기에서 실제로 어떻게 실행하는가" 가 빠져 있어
 * 사용자에게 전환을 설명할 때 답이 추상적이 된다.
 *
 * EXECUTION_BY_KEY 는 각 기법을 "단박에 그려지는 실행 단위" 로 풀어 쓴 한국어
 * 레시피다. 가능한 한 다음 축을 담는다(전부는 아님, 기법별로 관련된 것만):
 *   · 길이(프레임/초) + 컷 타입(하드컷/모핑)
 *   · 무엇이 움직이고 무엇이 고정인가 (카메라/요소/레이어)
 *   · 경계 정렬 기준 또는 시선 유도(eye-trace) — A·B 의 무엇을 같은 화면
 *     위치·스케일·각도로 맞춰야 하는가
 *   · 사운드 싱크 큐
 *   · 적합/부적합 톤 + 실패 시 대안 기법
 *
 * KNOWLEDGE_TRANSITION_GRAMMAR 가 이 값을 각 기법 라인의 "실행(편집 레시피)"
 * 서브라인으로 함께 주입한다. 프레임 수치는 24–30fps 기준 권장값(절대치 아님). */
const EXECUTION_BY_KEY: Record<TransitionKey, string> = {
  WHIP_PAN:
    "길이 4~8프레임. A 끝에서 카메라(또는 전체 레이어)를 한 방향으로 급가속해 모션블러 줄무늬를 만들고, 같은 방향·같은 속도로 B 첫 프레임이 감속하며 멈춘다. A·B 의 블러 방향축을 일치시켜야 '한 번의 휘두름' 으로 읽힌다. 팁: 패닝 축에 수직인 강한 수직선(기둥·문틀)에서 컷하면 가림이 자연스럽다. 컷에 '훅' 스와이프 사운드. 안 맞으면 그냥 하드컷.",
  ZOOM_PUNCH:
    "길이 3~6프레임. A 를 주 피사체 중심으로 급격히 인(또는 아웃)시켜 방사형 블러를 만들고, 그 소실점 화면위치에 B 의 주 피사체를 같은 좌표로 배치해 펀치아웃한다. 정렬 핵심: A 의 소실점 = B 주 피사체의 화면 위치. 빠른 편집 구간에서만, 남발 시 멀미. 컷에 저음 '둠'/임팩트.",
  DOLLY_ZOOM:
    "본래 한 컷 안에서 쓰는 심리효과라 전환용으론 드물다. 전환으로 쓸 땐 A 후반 0.5~1초간 피사체 스케일은 고정한 채 배경 원근만 수축/팽창시키고, 그 불안 정점에서 B 로 하드컷. 카메라 이동과 줌이 반대방향인 게 핵심. 광고 전환으론 과해서 권장 빈도 낮음.",
  CAMERA_ROLL:
    "길이 6~12프레임. A 프레임을 렌즈축으로 45~90° 회전시키며 회전 반대방향으로 모션블러를 깔고, 그 각운동량을 이어 B 가 같은 방향에서 수평으로 정착한다. A 끝 각도와 B 시작 각도가 연속되게. 화면 중앙 피사체를 두 컷이 공유하면 안정적. 사운드: 휙 도는 '우-웅'.",
  ARC_SWEEP:
    "길이 0.5~1초. A·B 가 공유하는 단일 피사체(인물/제품)를 화면 중앙에 고정한 채 배경만 A환경→B환경으로 호를 그리며 스윕한다. 중앙 피사체의 스케일·위치를 두 컷에서 동일하게. ⚠ 공유 피사체가 없으면 쓰지 말 것 — 크로스오버 포스터처럼 보인다.",
  LIGHT_LEAK:
    "길이 8~15프레임. A 끝에서 한쪽 모서리부터 따뜻한 빛이 번져 화면을 하얗게 덮고(피크), 그 하얀 정점에서 B 가 같은 밝기에서 빠져나오며 드러난다. A 빛 번짐 방향 = B 빛 빠짐 방향. 감성·시간경과 컷에 적합, 액션엔 부적합. 사운드는 없거나 부드러운 스월.",
  LENS_FLARE:
    "길이 6~12프레임. A 의 가장 강한 실광원에서 가로 플레어가 화면을 쓸고 지나가 가장 밝은 순간 B 로 교체한다. 플레어 스윕 방향과 광원의 화면위치를 A·B 가 맞춰야 자연스럽다. 따뜻·시네마틱 톤. 사운드: 부드러운 '휨'.",
  DEFOCUS_PULL:
    "길이 8~14프레임. A 를 완전히 아웃포커스(보케 덩어리)로 흐려 형태만 남기고, 같은 색·같은 보케 위치에서 B 가 초점으로 잡혀 들어온다. A 흐림 색감과 B 색감이 비슷할수록 매끄럽다. 감성 전환. 사운드 거의 없음.",
  GLITCH:
    "길이 3~8프레임을 2~4회 깜빡임으로. A 를 블록 깨짐·스캔라인 찢김으로 파괴하다 가장 깨진 프레임에서 B 로 점프한다. 효과가 주인공이라 정밀 정렬 불필요. 디지털/사이버 톤 전용. 사운드: 비트크러시·지직 노이즈 필수. 깜빡임 2~3회 넘기지 말 것.",
  DATAMOSH:
    "길이 6~12프레임. A 의 모션벡터가 유지된 채 B 의 픽셀색이 밀려들어와 번진다. A 에 큰 움직임(팬·제스처)이 있는 지점에서 컷해야 모션벡터가 살아 효과가 강하다 — 정적 컷에선 약하다. 사운드: 글리치 텍스처.",
  CHROMATIC_SPLIT:
    "길이 4~8프레임. 컷 경계 전후로 RGB 채널을 좌우로 벌렸다 모으며 B 로 전환한다. 가벼운 강조용이라 단독보다 GLITCH·ZOOM_PUNCH 와 결합. 빠른 비트 구간. 사운드: 짧은 전자음.",
  VHS_WARP:
    "길이 6~12프레임. A 에 트래킹 밴드·세로 롤 찢김을 넣어 신호 붕괴 정점에서 B 로 넘긴다. 레트로·노스탤지어 톤 전용(현대적·프리미엄 톤엔 부적합). 사운드: 테이프 워블·트래킹 노이즈.",
  MORPH:
    "길이 8~16프레임. A 실루엣이 B 실루엣으로 고무처럼 연속 변형한다. A·B 피사체의 포즈·형태·화면크기가 비슷해야 성립한다(둥근 것→둥근 것). 변형 중심점을 두 형태가 공유하게. ⚠ 안 닮은 형태끼리는 쓰지 말 것 — 흉하게 녹는다. 사운드: 부드러운 '위잉'.",
  LIQUID_WARP:
    "길이 8~14프레임. A 를 물/유리 너머처럼 출렁이게 왜곡하다 왜곡 정점에서 B 로 넘긴다. 카메라 고정, 왜곡 레이어만 작동. A→B 색감을 이어 흐르게 하면 매끄럽다. 사운드: 물·점성 텍스처.",
  SHATTER:
    "길이 6~12프레임. A 가 유리처럼 조각나 날아가고 조각 사이 틈으로 B 가 흐릿한 배경으로 드러나다 B 로 정착한다. 파편 비산 방향을 한쪽으로 통일해 시선을 정리한다. 충격·반전 비트에. 사운드: 유리 깨짐 임팩트 필수.",
  PRISM:
    "길이 4~10프레임. A 를 프리즘처럼 분광 복제(적/청 고스트)했다 한 점으로 수렴하며 B 로 넘긴다. 분광 수렴 중심점 = B 주 피사체 위치. 화려·몽환 톤. 사운드: 반짝이는 셔머.",
  SMOKE_VEIL:
    "길이 10~18프레임. A 를 연기/안개가 삼켜 형태가 사라지는 정점(가장 짙을 때)에서 B 가 같은 연무에서 빠져나온다. 연기 진입 방향 = B 노출 방향. ⚠ A·B 주인공을 연기 사이에 나란히 두지 말 것 — 크로스오버가 된다. 사운드: 휘파람 바람·'휘익'.",
  WATER_RIPPLE:
    "길이 8~14프레임. A 화면에 충격점에서 동심원 파문이 퍼져 굴절 왜곡 정점에서 B 로 넘긴다. 충격점(파문 중심) = B 주 피사체 위치면 동기가 분명하다. 회상·꿈·정화 비트. 사운드: 물방울·첨벙.",
  TIME_FREEZE:
    "정지 0.5~1.5초 후 컷. A 피사체 주변의 입자·물방울·천을 공중에 정지시키고(원하면 카메라만 회전) 그 정지 정점에서 B 로 넘긴다. A 안에서 끝나는 효과라 B 는 미리 보이지 않는다. 영웅·결정적 순간. 사운드: '슈웅' 후 정적, 컷에서 재시동.",
  SHAPE_WIPE:
    "길이 6~12프레임. 도형(원·바·대각선·브랜드마크)이 화면을 쓸며 그 마스크 안에서 B 가 드러나고 A 는 밀려난다. 도형이 A 의 어떤 요소(공·헤드라이트·로고)에서 자라나오게 하면 동기가 분명하다. 와이프 방향·도형 종류를 정할 것. 사운드: 스와이프.",
  IRIS_WIPE:
    "길이 8~14프레임. 원형 조리개가 A 의 한 초점에서 닫혔다 B 의 같은 화면위치에서 열린다. 정렬 핵심: A 닫힘 중심 = B 열림 중심을 같은 좌표로. 레트로·포커스 강조. 사운드: 휙 닫힘.",
  LAYER_SLIDE:
    "길이 8~14프레임, ease-out + 살짝 오버슈트. B 가 한 모서리에서 레이어로 밀려들어와 A 를 덮는다. 슬라이드 방향을 A 안의 움직임(이동하는 피사체·스와이프 제스처)과 일치시키면 동기가 생긴다. 하위요소 패럴랙스로 깊이. 사운드: 스와이프/'우-웅'.",
  LAYER_PUSH:
    "길이 6~12프레임, 등속 또는 ease-in-out. A 가 한쪽으로 밀려나며 반대쪽에서 B 가 같이 밀려들어온다(겹침 없이 판넬처럼). 리듬감 있는 컷이라 음악 비트에 맞춘다. 밀림 축(좌우/상하)을 정할 것. 사운드: 탁 붙는 푸시음.",
  KINETIC_TYPO:
    "길이 8~16프레임. 핵심 단어/숫자/CTA 가 화면을 가로지르며 스케일·슬라이드하다 그 글자가 마스크가 되어 B 를 드러내거나 와이프한다. 글자가 화면을 가장 덮는 순간이 컷 지점. 어떤 단어가·어디로 움직이며·B 를 마스크하는지 정할 것. 사운드: 타이포 임팩트·비트 동기.",
  GRAPHIC_MATCH:
    "길이 1프레임 하드컷(기본) 또는 6~8프레임 모핑. A 의 형태/선/색덩어리/구도를 B 의 대응 요소와 같은 화면좌표·스케일·각도로 겹치게 정렬한다(예: A 둥근 헤드라이트→B 둥근 로고). 정렬 기준점을 명시하고 시선을 그 요소에 고정. 카메라 고정, 요소만 연속. ⚠ 위치·크기가 안 맞으면 매치가 붕괴 → SHAPE_WIPE 로 대체. 사운드: 컷에 짧은 악센트.",
};

/** Effective production medium for a technique (default "both").
 *  Reads the BY_KEY maps (authoritative) so it has no init-order dependency
 *  on TRANSITION_MAP (declared later). */
export function transitionMedium(key: TransitionKey): TransitionMedium {
  return MEDIUM_BY_KEY[key] ?? "both";
}

/** Effective TR-card output type for a technique (default "peak_still"). */
export function transitionDeliverable(key: TransitionKey): TransitionDeliverable {
  return DELIVERABLE_BY_KEY[key] ?? "peak_still";
}

/** Editor-facing execution recipe (Korean) for a technique. Empty string if
 *  none registered. Surfaced to the model via KNOWLEDGE_TRANSITION_GRAMMAR so
 *  transition explanations are concrete (frames, alignment, sound, fallback)
 *  rather than a restatement of the concept. */
export function transitionExecution(key: TransitionKey): string {
  return EXECUTION_BY_KEY[key] ?? "";
}

/** Technique keys usable in MOTION direction mode (excludes `live`-only). */
export const MOTION_TRANSITION_KEYS: TransitionKey[] = TRANSITIONS
  .map((t) => t.key)
  .filter((k) => transitionMedium(k) !== "live");

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
    "Graphic / Motion",
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

/** Sentinel stored in `transition_type` for "follow the director's intent
 *  text — impose no preset technique". Distinct from unset/legacy (which
 *  silently falls back to DEFAULT_TRANSITION_KEY): NONE is an explicit user
 *  choice that tells the generator to drop the fixed technique spine and let
 *  the free-form intent (`description`) drive the frame. Useful for
 *  motion-specific transitions that don't map to any of the preset 19. */
export const TRANSITION_NONE = "NONE";

/** True when the stored value is the explicit "follow intent" sentinel. */
export function isFollowIntentTransition(raw: string | null | undefined): boolean {
  return typeof raw === "string" && raw.trim().toUpperCase() === TRANSITION_NONE;
}

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
    "각 기법에는 '실행(편집 레시피)' 서브라인이 붙어 있다(한국어). 이는 정지 프레임 생성용 guide 와 별개로, 편집자가 실제로 실행하는 방법(길이/프레임·무엇이 이동/고정·경계 정렬·시선·사운드·실패 대안)이다. 사용자가 두 컷의 전환을 '어떻게 하느냐'고 물으면 개념을 되풀이하지 말고 이 실행 레시피를 그 두 컷의 실제 내용에 대입해 구체 수치·화면 위치로 답한다.",
    "",
  ];
  for (const group of TRANSITION_CATEGORIES) {
    lines.push(`## ${group.category}`);
    for (const t of group.items) {
      const med = transitionMedium(t.key);
      const del = transitionDeliverable(t.key);
      const exec = transitionExecution(t.key);
      lines.push(
        `- ${t.key} (${t.label}) [${anchorLabel(t.anchor)}] [medium=${med}] [deliverable=${del}]: ${t.guide}${
          exec ? `\n    실행(편집 레시피, 사용자 설명용): ${exec}` : ""
        }`,
      );
    }
    lines.push("");
  }
  lines.push(
    "When a specific technique is requested downstream, honor that technique's entry as the structural spine of the bridging frame AND respect its declared anchor. Never blend two entries into one frame unless the user's intent text explicitly asks for it.",
  );
  return lines.join("\n");
})();
