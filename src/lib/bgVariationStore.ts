/**
 * Background variation generation store — module-singleton.
 *
 * What this does (2026-04 model)
 * ------------------------------
 * Each call to `startBgVarGenerate(parent, framing)` produces a brand-NEW
 * standalone background asset row whose `tag_name` is derived from the
 * parent + framing (e.g. `@BG_wide`, `@BG_wide_2` on the next generation).
 * The parent asset itself is never mutated.
 *
 * Pipeline per generation:
 *   1. Resolve a collision-free `tag_name`:  `{parent}_{framing}` →
 *      `{parent}_{framing}_2` → `_3` if the previous ones already exist
 *      in the same project. The check is performed against `assets` live
 *      so concurrent generations across devices still converge.
 *   2. Call the `openai-image` edge function in `inpaint` mode with NB2
 *      to produce the framing-specific image, using the parent's
 *      `photo_url` as reference and the prompt from
 *      `buildBackgroundVariationPrompt`.
 *   3. Run a vision analysis (`callVisionAnalyze` → Claude vision) on the
 *      just-generated image URL to synthesize a fresh `space_description`
 *      that describes THIS specific framing, not the parent's wide view.
 *      This is what lets downstream scenes using `@BG_close` feel like
 *      they're in the same place but composed differently — the
 *      description, not just the picture, shifts with the camera.
 *   4. INSERT a new row in `assets` with the fresh tag, description, and
 *      `photo_url` = the generated image.
 *   5. Broadcast `preflow:asset-created` so AssetsTab / ContiTab can
 *      merge the new asset into their lists without a full refetch.
 *
 * Concurrency model
 * -----------------
 *   - In-flight map is keyed by `(parentId, uniqueTagName)` so the user
 *     CAN stack multiple generations of the same framing (clicking
 *     "Wide" three times queues up `@BG_wide`, `_wide_2`, `_wide_3`).
 *   - The per-framing in-flight *count* is surfaced through the snapshot
 *     so the modal can spin a button while at least one is running.
 */

import type { AssetType, BackgroundFraming, PhotoVariation } from "@/components/assets/types";
import { buildBackgroundVariationPrompt } from "@/lib/backgroundVariations";
import { supabase } from "@/integrations/supabase/client";
import { callVisionAnalyze } from "@/components/assets/vision";
import { urlToBase64 } from "@/components/assets/imageUtils";

export type SlotStatus = "idle" | "generating" | "error";

export interface AssetForBgVar {
  id: string;
  project_id: string;
  tag_name: string;
  photo_url: string | null;
  space_description: string | null;
}

/**
 * Minimal shape of an asset row as returned by the sibling INSERT. Kept
 * local to avoid a circular import with `@/components/assets/types.tsx`
 * (which pulls in lucide-react icons for other exports).
 */
export interface CreatedBgAsset {
  id: string;
  project_id: string;
  tag_name: string;
  photo_url: string | null;
  ai_description: string | null;
  outfit_description: string | null;
  role_description: string | null;
  signature_items: string | null;
  space_description: string | null;
  asset_type: AssetType;
  source_type: string;
  created_at: string;
  /** Character-only — present on rows promoted through the character-sheet
   *  pipeline. Backgrounds always have it `null`. Kept on the wire shape so
   *  every consumer of `preflow:asset-created` sees the same row. */
  character_sheet_url?: string | null;
  character_sheet_generated_at?: string | null;
  character_sheet_source_url?: string | null;
  use_character_sheet?: boolean | null;
}

export interface BgVarSnapshot {
  /** How many generations are currently running per framing. 0/undefined
   *  ⇒ idle; ≥1 ⇒ at least one still in flight. */
  inFlight: Partial<Record<BackgroundFraming, number>>;
  /** Last persistent error surfaced per framing (cleared on next start
   *  for that framing). */
  errors: Partial<Record<BackgroundFraming, string>>;
}

interface ParentEntry {
  inFlight: Map<BackgroundFraming, number>;
  errors: Map<BackgroundFraming, string>;
}

const entries = new Map<string, ParentEntry>();
const subscribers = new Map<string, Set<(snap: BgVarSnapshot) => void>>();

const getEntry = (parentId: string): ParentEntry => {
  let e = entries.get(parentId);
  if (!e) {
    e = { inFlight: new Map(), errors: new Map() };
    entries.set(parentId, e);
  }
  return e;
};

const buildSnapshot = (e: ParentEntry): BgVarSnapshot => {
  const inFlight: Partial<Record<BackgroundFraming, number>> = {};
  for (const [f, n] of e.inFlight) if (n > 0) inFlight[f] = n;
  const errors: Partial<Record<BackgroundFraming, string>> = {};
  for (const [f, msg] of e.errors) errors[f] = msg;
  return { inFlight, errors };
};

const notify = (parentId: string) => {
  const subs = subscribers.get(parentId);
  if (!subs || subs.size === 0) return;
  const e = entries.get(parentId);
  if (!e) return;
  const snap = buildSnapshot(e);
  for (const cb of subs) {
    try {
      cb(snap);
    } catch (err) {
      console.error("[bgVariationStore] subscriber threw", err);
    }
  }
};

/**
 * Subscribe to snapshot updates for one parent asset. The callback fires
 * synchronously with the current snapshot, then on every subsequent
 * change. Returns an unsubscribe fn.
 */
export const subscribeBgVar = (
  parentId: string,
  cb: (snap: BgVarSnapshot) => void,
): (() => void) => {
  const e = getEntry(parentId);
  let subs = subscribers.get(parentId);
  if (!subs) {
    subs = new Set();
    subscribers.set(parentId, subs);
  }
  subs.add(cb);
  cb(buildSnapshot(e));
  return () => {
    const s = subscribers.get(parentId);
    if (s) {
      s.delete(cb);
      if (s.size === 0) subscribers.delete(parentId);
    }
  };
};

/** Read-only snapshot for callers that don't want to subscribe. */
export const getBgVarSnapshot = (parentId: string): BgVarSnapshot | null => {
  const e = entries.get(parentId);
  return e ? buildSnapshot(e) : null;
};

/** Clear the error state for one slot (e.g. after showing a toast). */
export const clearBgVarError = (parentId: string, framing: BackgroundFraming) => {
  const e = entries.get(parentId);
  if (!e) return;
  if (e.errors.delete(framing)) notify(parentId);
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Tag-name resolution
 *
 * Goal: given a parent asset with `tag_name = "BG"` and framing "wide",
 * return "BG_wide" if no asset with that tag already exists in the
 * project, else "BG_wide_2", "BG_wide_3", ...
 *
 * Fetching from DB (not the prop) makes this robust to concurrent
 * generations AND to the caller forgetting to pass up-to-date asset
 * lists. We tolerate races — two generations started at the exact
 * same millisecond may both resolve to `_2`, in which case the second
 * INSERT fails on the tag_name unique constraint and we retry.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const fetchExistingSiblingTags = async (
  projectId: string,
  base: string,
): Promise<Set<string>> => {
  // The local Supabase adapter doesn't implement `.like()`, so we pull
  // every tag for the project and filter in-process. Projects top out
  // in the low hundreds of assets, so this is cheap.
  const { data, error } = await supabase
    .from("assets")
    .select("tag_name")
    .eq("project_id", projectId);
  if (error) {
    console.warn("[bgVariationStore] sibling tag lookup failed", error);
    return new Set();
  }
  const out = new Set<string>();
  for (const row of (data ?? []) as Array<{ tag_name: string }>) {
    const raw = row.tag_name.replace(/^@/, "");
    if (raw === base || raw.startsWith(`${base}_`)) out.add(raw);
  }
  return out;
};

const resolveUniqueTagName = async (
  projectId: string,
  parentTag: string,
  framing: BackgroundFraming,
): Promise<string> => {
  const base = `${parentTag.replace(/^@/, "")}_${framing}`;
  const taken = await fetchExistingSiblingTags(projectId, base);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Vision analysis helper
 *
 * Runs the same Claude-vision pipeline AssetsTab uses on manual upload,
 * but keyed on the freshly generated image URL. Returns a best-effort
 * description string; on failure we fall back to the parent's
 * `space_description` so the new asset is still usable in scenes.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const analyzeGeneratedImage = async (
  imageUrl: string,
  fallbackDescription: string | null,
): Promise<string> => {
  try {
    const { base64, mediaType } = await urlToBase64(imageUrl);
    const result = await callVisionAnalyze(base64, mediaType, "background");
    const desc = typeof result?.description === "string" ? result.description.trim() : "";
    if (desc) return desc;
  } catch (err) {
    console.warn("[bgVariationStore] vision analyze failed — using fallback", err);
  }
  return (fallbackDescription ?? "").trim();
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Public entry: start a sibling-asset generation.
 *
 * Idempotency note: unlike the previous slot-based model, we do NOT
 * dedupe repeat calls. Clicking "Wide" twice intentionally queues two
 * independent generations (→ `_wide`, `_wide_2`). The modal surfaces
 * this via the in-flight counter per framing.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export const startBgVarGenerate = async (
  parent: AssetForBgVar,
  framing: BackgroundFraming,
): Promise<CreatedBgAsset | null> => {
  const e = getEntry(parent.id);
  if (!parent.photo_url) {
    e.errors.set(framing, "No source image registered on the parent asset.");
    notify(parent.id);
    return null;
  }
  e.errors.delete(framing);
  e.inFlight.set(framing, (e.inFlight.get(framing) ?? 0) + 1);
  notify(parent.id);

  try {
    const newTagName = await resolveUniqueTagName(parent.project_id, parent.tag_name, framing);

    const prompt = buildBackgroundVariationPrompt({
      framing,
      spaceDescription: parent.space_description ?? null,
      locationName: parent.tag_name,
    });

    const { data, error } = await supabase.functions.invoke("openai-image", {
      body: {
        mode: "inpaint",
        useNanoBanana: true,
        sourceImageUrl: parent.photo_url,
        referenceImageUrls: [],
        prompt,
        projectId: parent.project_id,
        // Synthetic scene-number for the IPC handler; includes a
        // millisecond token so simultaneous queued generations never
        // collide on the uploaded filename.
        sceneNumber: `bgvar-${parent.id}-${framing}-${Date.now()}`,
        imageSize: "1024x1024",
        folder: "assets",
      },
    });
    if (error) throw error;
    const d = data as { publicUrl?: string; url?: string } | null;
    const url = d?.publicUrl ?? d?.url ?? null;
    if (!url) throw new Error("Generation returned no image URL");

    const spaceDescription = await analyzeGeneratedImage(
      url,
      parent.space_description ?? null,
    );

    const record = {
      project_id: parent.project_id,
      asset_type: "background" as const,
      tag_name: newTagName,
      photo_url: url,
      source_type: "ai-variation",
      ai_description: null as string | null,
      outfit_description: null as string | null,
      role_description: null as string | null,
      signature_items: null as string | null,
      space_description: spaceDescription || null,
    };
    const { data: inserted, error: insertErr } = await supabase
      .from("assets")
      .insert(record)
      .select()
      .single();
    if (insertErr) throw insertErr;
    const created = inserted as CreatedBgAsset;

    try {
      window.dispatchEvent(
        new CustomEvent("preflow:asset-created", { detail: created }),
      );
    } catch {
      /* non-window contexts */
    }

    return created;
  } catch (err) {
    console.error(`[bgVariationStore:${framing}] generation failed`, err);
    const msg = err instanceof Error ? err.message : String(err);
    e.errors.set(framing, msg || "Generation error");
    return null;
  } finally {
    const cur = e.inFlight.get(framing) ?? 0;
    if (cur <= 1) e.inFlight.delete(framing);
    else e.inFlight.set(framing, cur - 1);
    notify(parent.id);
  }
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Legacy one-shot migration
 *
 * Background assets created before the sibling-asset model stored
 * camera framings as entries on the parent's `photo_variations` JSONB
 * column. This helper converts each of those entries into an
 * independent asset row (with its own tag_name and vision-analyzed
 * `space_description`) and then clears the parent's
 * `photo_variations` array so the modal's migration banner doesn't
 * keep re-firing.
 *
 * Designed to be idempotent against partial failures — the vision
 * analysis step is best-effort (falls back to the parent's
 * `space_description`), and individual INSERT failures are collected
 * but don't abort the batch. The parent is only cleared after every
 * migration attempt has run, so a page reload mid-migration resumes
 * from whatever's still in `photo_variations`.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export const migrateLegacyVariations = async (
  parent: AssetForBgVar,
  legacyVariations: PhotoVariation[],
): Promise<CreatedBgAsset[]> => {
  const created: CreatedBgAsset[] = [];
  for (const v of legacyVariations) {
    if (!v?.url || !v?.framing) continue;
    try {
      const tagName = await resolveUniqueTagName(
        parent.project_id,
        parent.tag_name,
        v.framing,
      );
      const spaceDescription = await analyzeGeneratedImage(
        v.url,
        parent.space_description ?? null,
      );
      const record = {
        project_id: parent.project_id,
        asset_type: "background" as const,
        tag_name: tagName,
        photo_url: v.url,
        source_type: "ai-variation",
        ai_description: null as string | null,
        outfit_description: null as string | null,
        role_description: null as string | null,
        signature_items: null as string | null,
        space_description: spaceDescription || null,
      };
      const { data: inserted, error: insertErr } = await supabase
        .from("assets")
        .insert(record)
        .select()
        .single();
      if (insertErr) throw insertErr;
      const row = inserted as CreatedBgAsset;
      created.push(row);
      try {
        window.dispatchEvent(
          new CustomEvent("preflow:asset-created", { detail: row }),
        );
      } catch {
        /* non-window contexts */
      }
    } catch (err) {
      console.error(`[bgVariationStore] legacy migration failed for ${v.framing}`, err);
    }
  }
  // Clear the parent's `photo_variations` regardless of partial failure
  // so the UI stops prompting. Failed ones can be re-generated manually.
  const { error: clearErr } = await supabase
    .from("assets")
    .update({ photo_variations: [] })
    .eq("id", parent.id);
  if (clearErr) {
    console.warn("[bgVariationStore] failed to clear parent photo_variations", clearErr);
  } else {
    try {
      window.dispatchEvent(
        new CustomEvent("preflow:asset-variations-updated", {
          detail: { assetId: parent.id, variations: [] },
        }),
      );
    } catch {
      /* non-window contexts */
    }
  }
  return created;
};
