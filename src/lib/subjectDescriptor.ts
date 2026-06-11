/**
 * buildSubjectDescriptor — cheap heuristic to produce a short natural-language
 * description of who's in the scene, pulled from the scene's tagged_assets
 * cross-referenced with the project's asset library.
 *
 * This string gets injected into the "Reference subject: ..." line of every
 * camera-variation prompt, giving NB2 a redundant written anchor on top of
 * the visual reference image. Two reasons we do this despite NB2 already
 * "seeing" the source:
 *
 *   1. NB2 occasionally misreads subtle identity cues (age, fabric, hair
 *      colour) when the camera angle change is large. A short text descriptor
 *      reinforces the "don't redesign" instruction.
 *   2. When the user's `ai_description` / `outfit_description` fields exist
 *      on an asset, those fields already contain the language the operator
 *      thinks describes this subject. Echoing it back in the prompt aligns
 *      the model's latent space with the operator's intent.
 *
 * Deliberately tiny. This isn't supposed to be an essay — NB2's text token
 * budget is precious and we want the camera phrase to be the strongest
 * signal in the prompt, not the subject essay.
 */

import type { Scene, Asset } from "@/components/conti/contiTypes";

const stripAt = (s: string): string => (s.startsWith("@") ? s.slice(1) : s);

/** Find the asset backing a tag, tolerating +/- leading "@" and exact/prefix matches. */
function resolveTag(raw: string, assets: Asset[]): Asset | null {
  const clean = stripAt(raw);
  for (const a of assets) {
    if (stripAt(a.tag_name) === clean) return a;
  }
  // Prefix — longest tag name wins.
  const byLen = [...assets].sort((a, b) => b.tag_name.length - a.tag_name.length);
  for (const a of byLen) {
    const n = stripAt(a.tag_name);
    if (clean.startsWith(n) && clean.length > n.length) return a;
  }
  return null;
}

/**
 * Produce the subject line. Empty string is a valid output — the prompt
 * builders will just drop the "Reference subject:" line entirely, which is
 * fine because the visual reference still carries the identity.
 */
export function buildSubjectDescriptor(scene: Scene, assets: Asset[]): string {
  const tags = scene.tagged_assets ?? [];
  if (tags.length === 0 || assets.length === 0) return "";

  const chunks: string[] = [];
  const seen = new Set<string>();

  for (const t of tags) {
    const asset = resolveTag(t, assets);
    if (!asset) continue;
    const key = stripAt(asset.tag_name);
    if (seen.has(key)) continue;
    seen.add(key);

    // Prefer outfit + ai descriptions if present; fall back to just the tag
    // name. This order mirrors how the conti prompt builder elsewhere in
    // the app stitches the same fields.
    const bits: string[] = [];
    if (asset.ai_description) bits.push(asset.ai_description.trim());
    if (asset.outfit_description) bits.push(`wearing ${asset.outfit_description.trim()}`);
    if (asset.space_description) bits.push(asset.space_description.trim());

    if (bits.length > 0) {
      chunks.push(`@${key} (${bits.join(", ")})`);
    } else {
      chunks.push(`@${key}`);
    }
  }

  if (chunks.length === 0) return "";
  // Scene-level hints are genuinely useful — mood and location help NB2
  // hold the atmospheric through-line across camera moves.
  const ctxBits: string[] = [];
  if (scene.location) ctxBits.push(`in ${scene.location.trim()}`);
  if (scene.mood) ctxBits.push(`${scene.mood.trim()} mood`);
  const ctx = ctxBits.length > 0 ? `, ${ctxBits.join(", ")}` : "";

  return `${chunks.join(" · ")}${ctx}`;
}
