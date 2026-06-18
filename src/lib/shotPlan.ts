/**
 * shotPlan — Phase 2: an OpenArt-style "director's brain" pass.
 *
 * Before the storyboard sheet is rendered as a SINGLE multi-panel image (where
 * all cross-cut consistency comes from), we run ONE cheap LLM call that reads
 * the cuts in order and returns a structured continuity plan:
 *   - a one-line story through-line so the sheet reads as one narrative,
 *   - scene GROUPS (consecutive cuts that share location/time/beat) with a
 *     locked screen direction / time-of-day / lighting state, and
 *   - per-cut continuity notes (what carries over from the previous cut) +
 *     a terse top-down blocking line (who is where, which side the camera is on).
 *
 * The plan is INJECTED into `buildStoryboardPrompt` (see storyboardSheet.ts).
 * It is strictly best-effort: any failure (network, bad JSON, empty) returns
 * `null` so the caller falls back to the deterministic Phase-1 grouping and
 * sheet generation still proceeds.
 *
 * Cost note: one `claude-proxy` call per sheet (NOT per cut). We use
 * sonnet-4-6 because continuity reasoning benefits from it and the call is
 * infrequent; drop to haiku if cost becomes a concern.
 */

import { supabase } from "./supabase";
import type { BriefAnalysis } from "./conti";
import type { StoryboardSheetScene } from "./storyboardSheet";

export type ScreenDirection = "left-to-right" | "right-to-left" | "neutral";

export interface ShotPlanGroup {
  /** 1-based scene-group number. */
  sequence: number;
  /** 1-based panel indices (position in the cut order) that belong to this group. */
  panels: number[];
  location?: string;
  timeOfDay?: string;
  lighting?: string;
  screenDirection?: ScreenDirection;
}

export interface ShotPlanCut {
  /** 1-based panel index (position in the cut order). */
  panel: number;
  /** Normalized English shot size + angle + lens (no camera movement — the
   *  sheet is a still frame, so dolly/push/pan adds nothing and reads as
   *  repetitive noise). */
  camera?: string;
  /** What continues from the previous cut (character position, props, lighting state). */
  carryOver?: string;
  /** Terse top-down blocking: who is where + which side the camera sits on. */
  blocking?: string;
  /** Emotional beat / dramatic intent for this panel (e.g. shock, dominance,
   *  reconciliation). Drives dynamic, non-repetitive shot design. */
  beat?: string;
}

/**
 * Global production spec synthesized once per sheet from brief + cuts. Unlike the
 * image-reference SPACE LOCK (which only fires when a background asset photo is
 * attached), this is a TEXT-ONLY anchor so a single shared space, palette, and
 * composition language can be enforced across every panel even with no reference
 * image. Best-effort: any/all fields may be absent.
 */
export interface GlobalSpec {
  /** One terse paragraph: the SINGLE shared space (architecture, materials,
   *  lighting, atmosphere) every panel must take place in. */
  setLock?: string;
  /** Named colors applied identically to every panel. */
  colorPalette?: string[];
  /** Shared composition/shot language (negative space, contrast, framing). */
  compositionNotes?: string;
}

export interface ShotPlan {
  throughLine: string;
  groups: ShotPlanGroup[];
  cuts: ShotPlanCut[];
  /** Text-only global anchor (set lock + palette + composition). */
  globalSpec?: GlobalSpec;
}

export interface GenerateShotPlanOptions {
  /** Non-transition cuts, in panel order (== the order the sheet packs them). */
  scenes: StoryboardSheetScene[];
  briefAnalysis?: BriefAnalysis | null;
  videoFormat?: string;
}

/** Flatten a BriefAnalysis field (string[] | { summary } ) into one line. */
function briefFieldToString(field: unknown): string {
  if (!field) return "";
  if (Array.isArray(field)) return field.filter(Boolean).join(", ");
  if (typeof field === "object" && field && "summary" in field) {
    return String((field as { summary?: unknown }).summary ?? "");
  }
  return String(field);
}

const SYSTEM_PROMPT = `You are a film director and cinematographer planning the CONTINUITY of a storyboard before it is drawn.

You receive an ordered list of cuts (panels) for one short video. Treat them as ONE connected story, not isolated images. Apply real cinematography grammar:
- 180-DEGREE RULE: within a scene, keep a consistent screen direction so spatial relationships stay readable across cuts.
- EYELINE MATCH: characters looking off-frame should look in directions consistent with the blocking.
- SCENE GROUPING: consecutive cuts in the same location/time/beat form ONE scene group; a return to an earlier place starts a NEW group.
- CONTINUITY: within a group keep wardrobe, props, time-of-day and lighting state consistent; only change at group boundaries.
- SHOT DESIGN: vary shot size/angle between adjacent cuts (~30%) while keeping the group's spatial logic.

Output STRICT JSON ONLY (no markdown, no code fences, no commentary) with this exact shape:
{
  "global_spec": {
    "set_lock": "one terse paragraph: the SINGLE shared space (architecture, materials, lighting, atmosphere) that EVERY panel takes place in",
    "color_palette": ["named color", "named color"],
    "composition_notes": "one short line of shared shot/composition language (negative space, contrast, framing)"
  },
  "through_line": "one sentence describing the whole video's narrative arc",
  "groups": [
    { "sequence": 1, "panels": [1,2], "location": "short", "time_of_day": "short", "lighting": "short", "screen_direction": "left-to-right" }
  ],
  "cuts": [
    { "panel": 1, "camera": "normalized english shot size + angle + lens (NO camera movement — this is a still frame)", "carry_over": "what continues from the previous cut (empty for panel 1)", "blocking": "terse top-down: who is where, which side the camera is on", "beat": "the panel's emotional beat / dramatic intent (e.g. shock, dominance, reveal)" }
  ]
}

Rules:
- "panels" / "panel" use the 1-based panel numbers exactly as given in the input.
- Every input panel must appear in exactly one group and have exactly one cut entry.
- "screen_direction" is one of: "left-to-right", "right-to-left", "neutral".
- "camera" must be ENGLISH cinematography terms even if the input camera note is in another language. Include shot size + angle + a lens (e.g. 24mm, 85mm); do NOT include camera movement (dolly / push-in / pan / handheld) — the storyboard is a STILL frame, so movement reads as repetitive noise.
- "global_spec": derive from the campaign context (tone, color grade) and the cuts' locations. "set_lock" must describe ONE coherent space consistent with the cuts' primary location, so every panel can share it even when no reference photo exists. Use named colors (e.g. "matte black", "burnished gold") for "color_palette".
- "beat": each cut gets a DIFFERENT, concrete emotional beat where the story allows, so panels are not flat repeats of one another.
- Keep every string terse (a short phrase). No prose, no extra keys.`;

interface RawGroup {
  sequence?: unknown;
  panels?: unknown;
  location?: unknown;
  time_of_day?: unknown;
  lighting?: unknown;
  screen_direction?: unknown;
}
interface RawCut {
  panel?: unknown;
  camera?: unknown;
  carry_over?: unknown;
  blocking?: unknown;
  beat?: unknown;
}
interface RawPlan {
  through_line?: unknown;
  groups?: unknown;
  cuts?: unknown;
  global_spec?: unknown;
}

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

const asStringArray = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const arr = v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
  return arr.length ? arr : undefined;
};

const asScreenDirection = (v: unknown): ScreenDirection | undefined =>
  v === "left-to-right" || v === "right-to-left" || v === "neutral" ? v : undefined;

/**
 * Run the continuity planning pass. Returns a validated ShotPlan, or null on
 * any failure so the caller can fall back to deterministic grouping.
 */
export async function generateShotPlan(
  opts: GenerateShotPlanOptions,
): Promise<ShotPlan | null> {
  const scenes = (opts.scenes ?? []).filter((s) => !s.is_transition);
  // A single cut has no shot-to-shot continuity to plan.
  if (scenes.length < 2) return null;

  const brief = opts.briefAnalysis ?? null;
  const briefLines = brief
    ? [
        `Campaign goal: ${briefFieldToString(brief.goal)}`,
        `Key message: ${briefFieldToString(brief.usp)}`,
        `Tone: ${briefFieldToString(brief.tone_manner)}`,
      ]
        .filter((l) => l.split(": ")[1])
        .join("\n")
    : "";

  const panelLines = scenes
    .map((s, i) => {
      const parts = [
        `Panel ${i + 1}:`,
        (s.description ?? s.title ?? `Scene ${s.scene_number}`).trim(),
      ];
      if (s.camera_angle) parts.push(`| camera(raw): ${s.camera_angle.trim()}`);
      if (s.location) parts.push(`| location: ${s.location.trim()}`);
      if (s.mood) parts.push(`| mood: ${s.mood.trim()}`);
      if (s.sequence != null) parts.push(`| sequence_hint: ${s.sequence}`);
      return parts.join(" ");
    })
    .join("\n");

  const userContent = [
    brief ? `CAMPAIGN CONTEXT:\n${briefLines}\n` : "",
    `VIDEO FORMAT: ${opts.videoFormat ?? "horizontal"}`,
    ``,
    `CUTS (in order, ${scenes.length} panels):`,
    panelLines,
    ``,
    `Return the continuity plan as STRICT JSON.`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  try {
    const { data, error } = await supabase.functions.invoke("claude-proxy", {
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 1800,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      },
    });
    if (error || !data) {
      console.warn("[shotPlan] claude-proxy failed", error);
      return null;
    }
    const text: string = data.content?.[0]?.text ?? "";
    const clean = text.replace(/```json|```/g, "").trim();
    if (!clean) return null;

    const parsed = JSON.parse(clean) as RawPlan;
    const throughLine = asString(parsed.through_line) ?? "";

    const validPanels = new Set(scenes.map((_, i) => i + 1));

    const groups: ShotPlanGroup[] = Array.isArray(parsed.groups)
      ? (parsed.groups as RawGroup[])
          .map((g, gi) => {
            const panels = Array.isArray(g.panels)
              ? g.panels
                  .map((p) => Number(p))
                  .filter((p) => Number.isInteger(p) && validPanels.has(p))
              : [];
            const sequence = Number.isInteger(Number(g.sequence)) ? Number(g.sequence) : gi + 1;
            return {
              sequence,
              panels,
              location: asString(g.location),
              timeOfDay: asString(g.time_of_day),
              lighting: asString(g.lighting),
              screenDirection: asScreenDirection(g.screen_direction),
            } as ShotPlanGroup;
          })
          .filter((g) => g.panels.length > 0)
      : [];

    const cuts: ShotPlanCut[] = Array.isArray(parsed.cuts)
      ? (parsed.cuts as RawCut[])
          .map((c) => ({
            panel: Number(c.panel),
            camera: asString(c.camera),
            carryOver: asString(c.carry_over),
            blocking: asString(c.blocking),
            beat: asString(c.beat),
          }))
          .filter((c) => Number.isInteger(c.panel) && validPanels.has(c.panel))
      : [];

    let globalSpec: GlobalSpec | undefined;
    const rawSpec = parsed.global_spec;
    if (rawSpec && typeof rawSpec === "object") {
      const gs = rawSpec as { set_lock?: unknown; color_palette?: unknown; composition_notes?: unknown };
      const setLock = asString(gs.set_lock);
      const colorPalette = asStringArray(gs.color_palette);
      const compositionNotes = asString(gs.composition_notes);
      if (setLock || colorPalette || compositionNotes) {
        globalSpec = { setLock, colorPalette, compositionNotes };
      }
    }

    // Need at least the through-line OR usable structure to be worth injecting.
    if (!throughLine && groups.length === 0 && cuts.length === 0 && !globalSpec) return null;

    return { throughLine, groups, cuts, globalSpec };
  } catch (err) {
    console.warn("[shotPlan] generate failed", err);
    return null;
  }
}
