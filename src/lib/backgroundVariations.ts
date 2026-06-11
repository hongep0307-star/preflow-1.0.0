/**
 * backgroundVariations — vocabulary + prompt builder for the
 * "Generate Camera Framings" feature on background assets.
 *
 * Design note (2026-04)
 * ---------------------
 * Earlier builds treated variations as alternate views stored on the parent
 * asset's `photo_variations` column, and used a keyword classifier
 * (`classifyShotFraming`) at scene-gen time to pick the matching slot. That
 * model was fragile: gaps in the keyword list silently fell back to wide,
 * and secondary backgrounds never got framing matches at all. The current
 * model treats every generated framing as its OWN standalone asset row
 * (`@{parent}_{framing}[_n]`), which the user then @-mentions explicitly.
 * No classifier, no fallback chain — the tag the user typed is the tag
 * the generator uses.
 *
 * This module therefore only exposes:
 *   1. The framing vocabulary (BACKGROUND_FRAMINGS) used to render the
 *      "Generate" buttons in AssetDetailModal.
 *   2. The prompt builder (buildBackgroundVariationPrompt) that
 *      bgVariationStore feeds to NB2 per generation.
 */

import type { BackgroundFraming } from "@/components/assets/types";

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Framing presets — four practical storyboard shot sizes. Order
 * matters: the modal renders these left-to-right in a single row.
 * The `alt` literal stays in `BackgroundFraming` for backward
 * compatibility with stored `photo_variations` data from older
 * builds, but is intentionally not listed here.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface BackgroundFramingPreset {
  id: BackgroundFraming;
  /** Short label for the generate button. */
  label: string;
  /** One-line UX hint shown on the button. */
  shortDesc: string;
  /** Declarative camera-position phrase fed straight to NB2. */
  phrase: string;
}

export const BACKGROUND_FRAMINGS: BackgroundFramingPreset[] = [
  {
    id: "wide",
    label: "Wide",
    shortDesc: "Full establishing view",
    phrase:
      "a WIDE ESTABLISHING SHOT of the same location. Camera pulled back to show the full architectural scope of the space — major walls, ceiling line, floor, primary light sources, the room as a whole. Subject-free environmental composition with strong foreground/midground/background depth.",
  },
  {
    id: "medium",
    label: "Medium",
    shortDesc: "Meaningful corner",
    phrase:
      "a MEDIUM ENVIRONMENTAL SHOT of the same location. Camera framed on a single meaningful corner or character-scaled area of the same room — a doorway, a workstation, a seating nook — at roughly waist-to-eye-level perspective. Subject-free; only the location itself is in frame.",
  },
  {
    id: "close",
    label: "Close",
    shortDesc: "Wall / fixture / sign",
    phrase:
      "a CLOSE-UP SHOT inside the same location. Camera moved in tight on a single feature of the room — a wall surface, a window, a sign, a light fixture, a piece of furniture — that visibly belongs to this same space. Soft background bokeh of the surrounding location.",
  },
  {
    id: "detail",
    label: "Detail",
    shortDesc: "Texture / material macro",
    phrase:
      "an EXTREME DETAIL MACRO SHOT of materials and textures from the same location — brick grain, fabric weave, scratched metal, peeling paint, a single decorative motif. Tight focus on surface and material, almost abstract, but unmistakably from this same place.",
  },
];

export const BACKGROUND_FRAMINGS_BY_ID: Record<BackgroundFraming, BackgroundFramingPreset> =
  Object.fromEntries(BACKGROUND_FRAMINGS.map((f) => [f.id, f])) as Record<
    BackgroundFraming,
    BackgroundFramingPreset
  >;

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Prompt builder
 *
 * Pattern: lead with the imperative "Re-photograph this exact location
 * as ${phrase}", then list everything that must stay constant. NB2 is
 * surprisingly disciplined about preserving these when given a numbered
 * bullet list AND given the original photo as a reference image.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const PRESERVE_BULLETS_BG = [
  "• Architectural style, structural geometry, and major building features",
  "• Time of day, weather, and overall lighting direction",
  "• Color palette, dominant materials, and surface finishes",
  "• Any visible signage, decor motifs, and props (where consistent with the new framing)",
  "• The atmospheric mood — moody, sunlit, neon, fluorescent, candlelit, etc.",
  "• Art style, rendering technique, grain, and painterly feel of the reference",
].join("\n");

export interface BackgroundVariationPromptInput {
  framing: BackgroundFraming;
  /** Optional textual location description from the parent asset's
   *  `space_description` — gives NB2 a redundant written anchor on top
   *  of the visual reference. */
  spaceDescription?: string | null;
  /** Optional human label (parent asset tag_name) — used in the lead
   *  line to ground the model's "this exact location" instruction. */
  locationName?: string | null;
}

export function buildBackgroundVariationPrompt({
  framing,
  spaceDescription,
  locationName,
}: BackgroundVariationPromptInput): string {
  const preset = BACKGROUND_FRAMINGS_BY_ID[framing];
  if (!preset) throw new Error(`Unknown background framing: ${framing}`);

  const locTag = locationName ? `@${locationName.replace(/^@/, "")}` : "this exact location";
  const descLine = spaceDescription?.trim()
    ? `Reference description: ${spaceDescription.trim()}\n\n`
    : "";

  return [
    `Re-photograph ${locTag} as ${preset.phrase}`,
    "",
    descLine + `STRICTLY PRESERVE (must match the reference image):`,
    PRESERVE_BULLETS_BG,
    "",
    "The room, building, or environment depicted in the reference image is unchanged — think of a second camera placed inside the same physical space, shooting it from a new framing. Do NOT redesign the location. Do NOT change the lighting, time of day, weather, or art style. The output must read as 'the same place, different angle' to a viewer comparing thumbnails.",
    "",
    "No human characters in frame unless they are clearly part of the architecture (statues, posters, photos on walls). Subject-free environmental shot.",
  ].join("\n");
}
