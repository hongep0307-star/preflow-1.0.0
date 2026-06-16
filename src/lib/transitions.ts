/**
 * Transitions — TR (transition) card image generation.
 *
 * Why a separate module?
 *   Regular scenes go through `generateConti` (brief-aware, per-scene asset
 *   refs, single prompt). Mood / Sketches go through `generateMoodImages`
 *   (Claude cinematic pre-pass + multi-shot plan). Neither fits a TR card,
 *   which is a one-frame *bridge* between two already-rendered shots.
 *
 *   Until now, TR generation was hardcoded to NB2 inpaint with a simple
 *   template prompt. It ignored the brief and couldn't follow the user's
 *   selected model (NB2 / GPT Image 2). This module unifies TR with the
 *   rest of the pipeline:
 *
 *   1. Claude pre-pass (same `claude-proxy` edge function as Mood) that
 *      reads the brief + prev / next scene context + TR directive and
 *      returns a single cinematic "transition beat" description — i.e.
 *      what the bridging frame should look like from a directorial POV.
 *      This is the "연출적 관점" the user asked for.
 *   2. Model routing identical in shape to `generateConti`:
 *        · nano-banana-2 → inpaint mode (prev as source, next as ref);
 *          NB2 blends two images better via the edits path than via
 *          generate + assetImageUrls.
 *        · gpt            → generate mode with gpt-image-2 and both
 *          adjacent images passed as `assetImageUrls`. Matches the
 *          shape used by `generateConti` so the openai-image edge
 *          function dispatches consistently.
 *
 *   Claude failure is never fatal: we fall back to a rich template
 *   prompt (ported from the old `buildTransitionPrompt` in ContiTab)
 *   so the user still gets a transition frame on a Claude outage.
 */

import { supabase } from "./supabase";
import { IMAGE_SIZE_MAP, type VideoFormat, type ContiModel, type BriefAnalysis } from "./conti";
import { getGptQualityDefault } from "./imageGenPreference";
import {
  DEFAULT_TRANSITION_KEY,
  KNOWLEDGE_TRANSITION_GRAMMAR,
  TRANSITION_MAP,
  normalizeTransitionKey,
  isFollowIntentTransition,
  type TransitionAnchor,
  type TransitionKey,
  type TransitionSpec,
} from "./transitionGrammar";

/** One-line plain-English restatement of a technique's anchor, shown
 *  right next to the technique's guide in the user message. Repeating
 *  this per-TR (the same info is already in the system KB) is
 *  deliberate: the system prompt tends to be cached / de-prioritized
 *  under long narrative context, and the anchor is the one rule we
 *  absolutely cannot let Claude skim past. */
function describeAnchorForUserMessage(anchor: TransitionAnchor): string {
  switch (anchor) {
    case "A":
      return "frame lives inside Shot A; Shot B's subject is NOT rendered (at most a faint edge hint is allowed if the guide permits).";
    case "B":
      return "frame lives inside Shot B; Shot A's subject is NOT rendered (at most a faint edge hint is allowed if the guide permits).";
    case "bridge":
      return "this is one of the rare techniques where both shots legitimately share the frame — apply only because the guide explicitly authorizes it.";
    case "technique":
      return "the effect itself owns the frame; subjects from both shots are degraded into corrupted texture / vector ghosts / channel offsets — neither reads as a cleanly-present protagonist.";
  }
}

/* ━━━━━ Types ━━━━━ */

/** Minimum scene shape we need from both sides of the transition. Kept
 *  structural on purpose so callers don't have to pull in the full
 *  `Scene` type. `conti_image_url` is REQUIRED for both adjacent scenes
 *  (strict image gate — a transition beat has nothing to blend without
 *  the two shots). */
export interface TransitionAdjacentScene {
  scene_number: number;
  title?: string | null;
  description?: string | null;
  camera_angle?: string | null;
  mood?: string | null;
  location?: string | null;
  conti_image_url: string;
}

/** TR card itself. `conti_image_url` is ignored (we're about to overwrite
 *  it). `description` is the user-written transition intent and may be
 *  empty — in which case Claude infers the beat from context alone.
 *  `transition_type` is the raw stored string; it's normalized through
 *  `normalizeTransitionKey` so legacy `"TRANSITION"` rows transparently
 *  map to the default technique. */
export interface TransitionCardScene {
  scene_number: number;
  description?: string | null;
  transition_type?: string | null;
}

/** Narrative context entry — a lightweight scene summary for ±2 neighbors
 *  of the TR. Kept minimal on purpose: we want Claude to *sense* the
 *  story beat before and after the cut, not reconstruct each shot's
 *  visuals (the two adjacent images are already attached for that). */
export interface TransitionNarrativeScene {
  scene_number: number;
  title?: string | null;
  description?: string | null;
  is_transition?: boolean;
}

export interface GenerateTransitionFrameOptions {
  projectId: string;
  prev: TransitionAdjacentScene;
  next: TransitionAdjacentScene;
  tr: TransitionCardScene;
  videoFormat: VideoFormat;
  briefAnalysis?: BriefAnalysis | null;
  model?: ContiModel;
  /** Full scene list so we can build a ±2-window narrative snippet around
   *  the TR. Optional — if omitted we still generate, but Claude only
   *  sees the two immediate adjacent shots. */
  allScenes?: TransitionNarrativeScene[];
  onStageChange?: (stage: "translating" | "building" | "generating") => void;
  /** Phase 2.0: in-flight dedup key (see `ContiGenerateOptions.jobId`). */
  jobId?: string;
}

/* ━━━━━ Brief summary (shared with Claude + fallback template) ━━━━━ */

const briefFieldToString = (f: unknown): string => {
  if (!f) return "";
  if (Array.isArray(f)) return f.join(", ");
  if (typeof f === "object" && f !== null) {
    const summary = (f as { summary?: unknown }).summary;
    if (typeof summary === "string") return summary;
  }
  return typeof f === "string" ? f : "";
};

function buildBriefSummaryLines(brief: BriefAnalysis | null | undefined): string[] {
  if (!brief) return [];
  const lines: string[] = [];

  // Core four — goal / target / USP / tone — mirror the fields BriefTab
  // persists as `BriefField` entries. Previously this function only
  // pulled goal + tone, so TR generation was flying blind on who the
  // spot is for and what the single differentiating claim is. Adding
  // target + usp puts TR on the same brief-depth footing as
  // `generateConti` / `moodIdeation`.
  const goal = briefFieldToString(brief.goal);
  const target = briefFieldToString(brief.target);
  const usp = briefFieldToString(brief.usp);
  const tone = briefFieldToString(brief.tone_manner);
  if (goal) lines.push(`Campaign goal: ${goal}`);
  if (target) lines.push(`Target audience: ${target}`);
  if (usp) lines.push(`Key message / USP: ${usp}`);
  if (tone) lines.push(`Brand tone: ${tone}`);

  const vd = brief.visual_direction;
  if (vd && typeof vd === "object") {
    const parts: string[] = [];
    if (vd.camera) parts.push(`camera ${vd.camera}`);
    if (vd.lighting) parts.push(`lighting ${vd.lighting}`);
    if (vd.color_grade) parts.push(`color grade ${vd.color_grade}`);
    if (vd.editing) parts.push(`editing rhythm ${vd.editing}`);
    if (parts.length) lines.push(`Visual direction: ${parts.join(" · ")}`);
  } else if (typeof vd === "string" && vd) {
    lines.push(`Visual direction: ${vd}`);
  }

  // v2 fields — optional, only present when BriefTab ran the richer
  // analysis path. Include whichever is set; skip silently otherwise.
  // `first_frame` is the single most evocative anchor for a TR beat
  // since it tells us the opening visual-language contract the spot
  // made with the viewer; the technique we pick should ideally
  // rhyme with it.
  const hero = brief.hero_visual;
  if (hero && typeof hero === "object" && typeof hero.first_frame === "string" && hero.first_frame.trim()) {
    lines.push(`Hero first-frame motif: ${hero.first_frame.trim()}`);
  }
  const product = brief.product_info;
  if (product && typeof product === "object" && typeof product.what === "string" && product.what.trim()) {
    lines.push(`Product / subject: ${product.what.trim()}`);
  }

  return lines;
}

/* ━━━━━ Narrative context (±2 scenes around the TR) ━━━━━
 *
 * A TR bridge is a story beat, not just a visual effect applied to two
 * frames. Giving Claude a tiny window of surrounding real scenes lets
 * it read the *direction* of the story at the cut (rising tension vs
 * resolution vs reveal) and pick how forcefully to apply the chosen
 * technique. We keep this brief — at most ±2 non-TR neighbors — to
 * avoid the user message ballooning on long boards. */

function summarizeScene(s: TransitionNarrativeScene, role: string): string {
  const title = s.title?.trim();
  const desc = s.description?.trim();
  const head = title ? ` "${title}"` : "";
  const body = desc ? ` — ${desc}` : "";
  return `  ${role} (Scene ${s.scene_number})${head}${body}`;
}

function buildNarrativeContextLines(
  allScenes: TransitionNarrativeScene[] | undefined,
  prevSceneNumber: number,
  nextSceneNumber: number,
): string[] {
  if (!allScenes || allScenes.length === 0) return [];

  const prevIdx = allScenes.findIndex((s) => s.scene_number === prevSceneNumber);
  const nextIdx = allScenes.findIndex((s) => s.scene_number === nextSceneNumber);
  if (prevIdx < 0 || nextIdx < 0) return [];

  // Collect up to 2 non-TR neighbors on each side so the model sees
  // the real narrative flow around the cut, not a chain of adjacent
  // TR cards.
  const before: TransitionNarrativeScene[] = [];
  for (let i = prevIdx - 1; i >= 0 && before.length < 2; i--) {
    if (!allScenes[i].is_transition) before.unshift(allScenes[i]);
  }
  const after: TransitionNarrativeScene[] = [];
  for (let i = nextIdx + 1; i < allScenes.length && after.length < 2; i++) {
    if (!allScenes[i].is_transition) after.push(allScenes[i]);
  }
  if (before.length === 0 && after.length === 0) return [];

  // Story position estimate (intro / body / climax / resolution) based
  // on where the TR sits among real (non-TR) scenes. A rough signal
  // but enough for the model to calibrate intensity.
  const realScenes = allScenes.filter((s) => !s.is_transition);
  const realIndexOfPrev = realScenes.findIndex((s) => s.scene_number === prevSceneNumber);
  let position: string | null = null;
  if (realIndexOfPrev >= 0 && realScenes.length > 0) {
    const pct = (realIndexOfPrev + 1) / realScenes.length;
    if (pct <= 0.25) position = "opening / intro beat";
    else if (pct <= 0.6) position = "mid-body development";
    else if (pct <= 0.85) position = "climax / turn";
    else position = "resolution / closing";
  }

  const lines: string[] = ["NARRATIVE CONTEXT around this transition:"];
  if (position) lines.push(`  Story position: ${position}`);
  for (const s of before) lines.push(summarizeScene(s, "← earlier"));
  lines.push(`  ★ TRANSITION sits between Scene ${prevSceneNumber} and Scene ${nextSceneNumber}`);
  for (const s of after) lines.push(summarizeScene(s, "→ later"));
  return lines;
}

function buildShotContextBlock(label: string, s: TransitionAdjacentScene): string {
  const lines = [`[${label}]`];
  if (s.title?.trim()) lines.push(`Title: ${s.title.trim()}`);
  if (s.description?.trim()) lines.push(`Description: ${s.description.trim()}`);
  const meta: string[] = [];
  if (s.camera_angle?.trim()) meta.push(`Camera: ${s.camera_angle.trim()}`);
  if (s.mood?.trim()) meta.push(`Mood: ${s.mood.trim()}`);
  if (s.location?.trim()) meta.push(`Location: ${s.location.trim()}`);
  if (meta.length) lines.push(meta.join(" | "));
  return lines.join("\n");
}

/* ━━━━━ Stage 1: Claude pre-pass (directorial beat) ━━━━━ */

const TRANSITION_SYSTEM_PROMPT = `${KNOWLEDGE_TRANSITION_GRAMMAR}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are a senior film editor and director of photography. Your single job is to design ONE bridging frame — a hero still — that visually carries a special transition effect between two already-shot cuts: Shot A (preceding) and Shot B (following).

A TR (transition) card in this project is NOT invoked for a simple edit-timing decision (hard cut, match cut, dissolve, fade). It is invoked ONLY when the director wants a real visual event — a camera move, an optical phenomenon, a digital distortion, a geometric transformation, or an environmental beat — to live as its own frame at the cut. Treat the requested technique as the reason the TR frame exists in the first place.

You will receive:
  · the project's creative brief (goal, target, USP, tone, visual direction, optional hero visual & product)
  · a narrative-context snippet — up to ±2 surrounding real scenes so you can read the story beat at the cut (opening / mid-body / climax / resolution)
  · Shot A's full context (title, description, camera, mood, location) and its rendered image as an attached reference
  · Shot B's full context and its rendered image as an attached reference
  · the requested TRANSITION TECHNIQUE key + name + its authoritative guide from the library above
  · optional transition intent written by the director

Produce a single, vivid, visual English paragraph (3–5 sentences) describing the bridging frame from a directorial standpoint. Your paragraph must obey these rules in order — rule #0 is absolute and overrides all others:

  0. ANCHOR DISCIPLINE (HARD CONSTRAINT). A TR frame represents a SINGLE MOMENT on the A→B timeline, typically at the technique's peak (~70–80% through the transition). It is NOT a composite showing both shots' subjects at equal weight. Honor the technique's declared [Anchor=…] tag exactly:
       · Anchor=ShotA → the frame lives inside Shot A; describe Shot A's subjects and environment being transformed by the technique; Shot B's subject / protagonist / product is NOT in the frame (at most a faint color-temperature edge hint is allowed if the guide permits).
       · Anchor=ShotB → symmetric inverse.
       · Anchor=Bridge → the rare case where both shots legitimately share the frame. Apply only when the technique explicitly requires it.
       · Anchor=Technique → the effect owns the frame; subjects from both shots are degraded into corrupted texture, vector ghosts, or channel offsets; neither reads as a clean present protagonist.
     Do NOT — under any circumstance, regardless of how tempting the story beat makes it — render Shot A's protagonist and Shot B's protagonist side-by-side with the effect between them. That is a crossover poster, not a transition. When in doubt, collapse to the anchor shot.
  1. Honor the requested technique as the structural spine of the frame. Apply its library entry concretely — not generically. Name the specific visual artifact of that technique (the smear of a WHIP_PAN, the shard geometry of a SHATTER, the tracking bands of a VHS_WARP, the suspended particles of a TIME_FREEZE, etc.).
  2. Preserve the identities from the ANCHOR shot (characters, wardrobe, props, location materials, mood palette) using that shot's attached reference image as ground truth. Do NOT introduce new people, props, or environments. The non-anchor shot's reference image is provided so you know what the transition is moving toward — NOT as a second subject to render in this frame.
  3. Respect the brief's visual direction (camera language, lighting, color grade) and calibrate the technique's intensity to the story position (a climax beat can punch harder than an opening beat).
  4. Describe the frame in concrete cinematography terms — what we see in foreground / midground / background, how the technique's energy is concentrated in the frame, and (if anything) where in frame a faint hint of the non-anchor shot might bleed in. If the guide does not explicitly grant the non-anchor shot a visible role, assume its subject is not in frame.
  5. If the director's transition intent is provided, treat it as the highest-priority creative directive and let it override category defaults — but rule #0 still holds unless the intent text explicitly asks for a bridge composition.

OUTPUT FORMAT: plain English prose only — no JSON, no bullet points, no markdown, no quotes. One paragraph. End with the sentence: "Do not render any text, subtitles, logos, UI overlays, or watermarks in the frame."`;

/** Appended to the system prompt when the TR card is in "follow description"
 *  (NONE) mode — i.e. the director intentionally picked no preset technique.
 *  It overrides the technique-centric rules above so the director's free-form
 *  intent becomes the sole design basis (for motion-specific transitions that
 *  don't map to any of the preset techniques). */
const FOLLOW_INTENT_SYSTEM_OVERRIDE = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OVERRIDE — "FOLLOW DESCRIPTION" MODE (this section supersedes the technique rules above):

The director has intentionally chosen NO preset technique for this TR. There is no library technique to honor as the structural spine. Instead:
  · The DIRECTOR'S TRANSITION INTENT below is the SINGLE, AUTHORITATIVE design basis for the frame. Realize exactly the visual event it describes — even if it is not one of the preset techniques (e.g. lights flickering off then on, a color-grade flip, a custom motif). Do NOT substitute a generic camera move (whip pan, zoom) just because the catalog defaults to one.
  · Ignore rule #1 (technique spine). Rules about identity preservation and the brief's visual direction still apply.
  · ANCHOR DISCIPLINE is relaxed to a soft default: keep the anchor shot's identities/environment as the base of the frame UNLESS the intent explicitly calls for both shots or a non-anchor element. Still avoid a flat crossover poster of both protagonists at equal weight unless the intent asks for it.
  · Capture the intent at its single most expressive instant (one still frame). If the intent describes a temporal beat (e.g. "lights flicker off then on"), render the most telling moment of that beat.`;

/** Resolve the effective technique for this TR. Legacy / unknown stored
 *  values normalize to `null`, and we fall back to the default at the
 *  last moment so the Claude prompt always has a concrete spec to
 *  point at. Callers that need to render "unset" state (e.g. the UI)
 *  should use `normalizeTransitionKey` directly. */
function resolveTransitionSpec(raw: string | null | undefined): {
  key: TransitionKey;
  spec: TransitionSpec;
  wasUnset: boolean;
} {
  const normalized = normalizeTransitionKey(raw);
  const key = normalized ?? DEFAULT_TRANSITION_KEY;
  return { key, spec: TRANSITION_MAP[key], wasUnset: normalized === null };
}

/** Build the user message shown to Claude. The two reference images
 *  are ALSO attached as image parts in the same user message so Claude
 *  can literally see the two cuts it's bridging. */
function buildTransitionUserMessage(opts: GenerateTransitionFrameOptions): string {
  const { prev, next, tr, briefAnalysis, allScenes } = opts;
  const briefLines = buildBriefSummaryLines(briefAnalysis);
  const parts: string[] = [];

  if (briefLines.length) {
    parts.push("PROJECT BRIEF:");
    parts.push(...briefLines.map((l) => `  ${l}`));
    parts.push("");
  }

  const narrativeLines = buildNarrativeContextLines(allScenes, prev.scene_number, next.scene_number);
  if (narrativeLines.length) {
    parts.push(...narrativeLines);
    parts.push("");
  }

  parts.push(buildShotContextBlock(`SHOT A — Scene ${prev.scene_number} (preceding)`, prev));
  parts.push("");
  parts.push(buildShotContextBlock(`SHOT B — Scene ${next.scene_number} (following)`, next));
  parts.push("");

  const intent = tr.description?.trim();
  // "설명 따름(NONE)": 프리셋 기법 뼈대를 강제하지 않고 의도 텍스트로만 생성.
  // 단 의도가 비어 있으면 가이드 없이 생성될 수 없으므로 기본 기법으로 폴백한다.
  const followIntent = isFollowIntentTransition(tr.transition_type) && !!intent;
  if (followIntent) {
    parts.push("TRANSITION TECHNIQUE: (none — no preset technique imposed)");
    parts.push(
      "The director intentionally left the technique unset so the transition is driven SOLELY by the intent below. Do not force any of the preset techniques; build the bridge motion/visual exactly from the director's intent.",
    );
  } else {
    const { key, spec, wasUnset } = resolveTransitionSpec(tr.transition_type);
    parts.push(`TRANSITION TECHNIQUE: ${key} — ${spec.label}`);
    parts.push(`ANCHOR: ${spec.anchor} — ${describeAnchorForUserMessage(spec.anchor)}`);
    parts.push(`TECHNIQUE GUIDE: ${spec.guide}`);
    if (wasUnset) {
      parts.push(
        "(The director has not yet picked a specific technique for this TR; the default above was applied. Still follow its guide and anchor as the structural spine of the frame.)",
      );
    }
  }

  if (intent) {
    parts.push("");
    parts.push("DIRECTOR'S TRANSITION INTENT (highest-priority creative directive):");
    parts.push(intent);
  }

  parts.push("");
  if (followIntent) {
    parts.push(
      "Write ONE paragraph (3–5 sentences) describing the bridging frame that realizes the DIRECTOR'S TRANSITION INTENT above as faithfully as possible. The two attached images give you the identities, materials, and palette to draw on. Render the specific visual event the intent describes (do not substitute a generic camera move). Keep the anchoring shot's identities/environment as the base unless the intent explicitly calls for both shots; still avoid a flat side-by-side crossover of both protagonists unless the intent asks for it.",
    );
  } else {
    parts.push(
      "Write ONE paragraph (3–5 sentences) describing the bridging frame. The two attached images show all the identities and materials you may draw on. Identities and environment for the rendered frame come from the ANCHOR shot; the other shot's reference image tells you what the transition is moving toward but its protagonist / product should NOT appear as a second subject in this frame. Avoid rendering both subjects at equal weight — that reads as a crossover poster, not a transition.",
    );
  }
  return parts.join("\n");
}

/** Call claude-proxy with the brief + shot context + both reference
 *  images. Returns the generated prompt string, or null on any failure
 *  (empty response, JSON error, network). Caller falls back to the
 *  template builder. */
async function generateTransitionBeat(opts: GenerateTransitionFrameOptions): Promise<string | null> {
  try {
    const userText = buildTransitionUserMessage(opts);
    const imageParts = [opts.prev.conti_image_url, opts.next.conti_image_url].map((url) => ({
      type: "image",
      source: { type: "url", url },
    }));

    // "설명 따름(NONE)" + 의도가 있으면 기법 중심 규칙을 의도 중심으로 덮어쓴다.
    const followIntent = isFollowIntentTransition(opts.tr.transition_type) && !!opts.tr.description?.trim();
    const systemPrompt = followIntent
      ? `${TRANSITION_SYSTEM_PROMPT}\n\n${FOLLOW_INTENT_SYSTEM_OVERRIDE}`
      : TRANSITION_SYSTEM_PROMPT;

    const { data, error } = await supabase.functions.invoke("claude-proxy", {
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [...imageParts, { type: "text", text: userText }],
          },
        ],
      },
    });

    if (error || !data) {
      console.warn("[Transition] Claude pre-pass failed:", error?.message);
      return null;
    }

    const textBlock = data.content?.find((b: { type?: string }) => b.type === "text") as
      | { text?: string }
      | undefined;
    const raw = textBlock?.text?.trim();
    if (!raw || raw.length < 40) {
      console.warn("[Transition] Claude returned empty/too-short prompt");
      return null;
    }
    return raw;
  } catch (err) {
    console.warn("[Transition] Claude pre-pass threw:", err);
    return null;
  }
}

/* ━━━━━ Fallback template ━━━━━
 *
 * Ported verbatim from the old `buildTransitionPrompt` in ContiTab so
 * the user still gets a reasonable prompt when claude-proxy is down.
 * Kept here (rather than exported from ContiTab) so the only consumer
 * of TR generation logic is this file. */

function buildLegacyTransitionPrompt(
  prev: TransitionAdjacentScene,
  tr: TransitionCardScene,
  next: TransitionAdjacentScene,
  brief: BriefAnalysis | null | undefined,
): string {
  const intent = tr.description?.trim();
  const followIntent = isFollowIntentTransition(tr.transition_type) && !!intent;

  // "설명 따름(NONE)": 프리셋 기법 없이 디렉터 의도만으로 한 프레임을 만든다.
  if (followIntent) {
    const parts: string[] = [
      "Create a single cinematic transition frame between two already-shot cuts, driven SOLELY by the director's transition intent below (no preset technique).",
      "Render exactly the visual event the intent describes — do not substitute a generic camera move. Capture its single most expressive instant as one still frame.",
    ];
    const briefLines = buildBriefSummaryLines(brief);
    if (briefLines.length) parts.push("", "[Project brief]", ...briefLines);
    parts.push("", buildShotContextBlock("Shot A — previous scene", prev));
    parts.push("", buildShotContextBlock("Shot B — next scene", next));
    parts.push("", "[Director's transition intent — the sole design basis]", intent!);
    parts.push(
      "",
      "Use the two reference images for identities, materials, and palette. Keep the anchoring shot's identities/environment as the base unless the intent explicitly calls for both shots. Avoid a flat side-by-side crossover of both protagonists unless the intent asks for it. Do not render any text, subtitles, logos, UI overlays, or watermarks.",
    );
    return parts.join("\n");
  }

  const { key, spec } = resolveTransitionSpec(tr.transition_type);
  const parts: string[] = [
    `Create a single cinematic transition frame using the ${spec.label} technique (${key}).`,
    `Anchor: ${spec.anchor} — ${describeAnchorForUserMessage(spec.anchor)}`,
    `Technique guide: ${spec.guide}`,
    `The output is ONE hero bridging frame representing a single moment (~70–80% through the A→B transition). It is NOT a composite showing both shots' subjects. Honor the anchor above: identities and environment come from the anchor shot's reference image; the other shot's reference is provided so you know what follows, but its protagonist / product must NOT appear as a second subject in this frame.`,
  ];

  const briefLines = buildBriefSummaryLines(brief);
  if (briefLines.length) {
    parts.push("", "[Project brief]", ...briefLines);
  }

  parts.push("", buildShotContextBlock("Shot A — previous scene", prev));
  parts.push("", buildShotContextBlock("Shot B — next scene", next));

  if (intent) {
    parts.push("", "[Director's transition intent — highest priority]", intent);
  }

  parts.push(
    "",
    "Preserve the identities, wardrobe, and environment of the ANCHOR shot. Apply the technique as the structural spine of the frame. Avoid rendering both shots' subjects at equal weight — that reads as a crossover poster, not a transition. Do not render any text, subtitles, logos, UI overlays, or watermarks.",
  );
  return parts.join("\n");
}

/* ━━━━━ Stage 2: image generation (model-aware) ━━━━━ */

/** Main entry — produces a single transition frame URL. Caller is
 *  responsible for writing it back to the scene row + version snapshot
 *  + history. */
export async function generateTransitionFrame(opts: GenerateTransitionFrameOptions): Promise<string> {
  const { projectId, prev, next, tr, videoFormat, briefAnalysis, model, onStageChange, jobId } = opts;
  const chosenModel: ContiModel = model ?? "nano-banana-2";

  onStageChange?.("translating");
  const claudePrompt = await generateTransitionBeat(opts);
  const prompt = claudePrompt ?? buildLegacyTransitionPrompt(prev, tr, next, briefAnalysis);

  onStageChange?.("generating");

  // NB2 path — keep the existing inpaint route. NB2's edits endpoint
  // produces meaningfully better two-image blends than sending both
  // images through the generate path as assetImageUrls.
  if (chosenModel === "nano-banana-2") {
    const { data, error } = await supabase.functions.invoke("openai-image", {
      body: {
        mode: "inpaint",
        prompt,
        sourceImageUrl: prev.conti_image_url,
        referenceImageUrls: [next.conti_image_url],
        useNanoBanana: true,
        projectId,
        sceneNumber: tr.scene_number,
        imageSize: IMAGE_SIZE_MAP[videoFormat],
        timestamp: Date.now(),
        ...(jobId ? { __jobId: jobId } : {}),
      },
    });
    if (error) throw new Error(error.message ?? "NB2 transition generation failed");
    const url = (data?.publicUrl ?? data?.url ?? null) as string | null;
    if (!url) throw new Error("NB2 returned no URL");
    return url;
  }

  // GPT Image 2 path — same shape as `generateConti` regular scenes.
  // Both adjacent images ride along as `assetImageUrls` so the vision
  // generator can lock identity / wardrobe / location across the cut.
  const { data, error } = await supabase.functions.invoke("openai-image", {
    body: {
      prompt,
      projectId,
      sceneNumber: tr.scene_number,
      imageSize: IMAGE_SIZE_MAP[videoFormat],
      assetImageUrls: [prev.conti_image_url, next.conti_image_url],
      model: "gpt",
      // 일반 컷(generateConti)과 동일하게 콘티 기능의 GPT 품질 설정을 따른다.
      // (이게 없으면 백엔드가 전역 settings.gpt_image_quality 로 폴백해 콘티탭
      //  품질 선택이 TR 에만 안 먹는 불일치가 생긴다.)
      quality: getGptQualityDefault("conti"),
      timestamp: Date.now(),
      ...(jobId ? { __jobId: jobId } : {}),
    },
  });
  if (error) throw new Error(error.message ?? "GPT transition generation failed");
  const url = (data?.publicUrl ?? data?.url ?? null) as string | null;
  if (!url) throw new Error("GPT returned no URL");
  return url;
}
