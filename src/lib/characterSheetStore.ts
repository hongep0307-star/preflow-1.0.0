/**
 * Character-sheet generation store — module-singleton.
 *
 * Mirrors the bgVariationStore pattern (subscribe / snapshot / start)
 * but is keyed by character `assetId` and tracks at most one in-flight
 * generation per character. The asset row itself is mutated rather
 * than spawning siblings — a character should have at most one sheet,
 * because the conti generator picks `character_sheet_url ?? photo_url`
 * and there is no UX surface for picking between multiple sheets.
 *
 * Pipeline per `startCharacterSheet(asset)`:
 *   1. Mark in-flight = 1 + clear last error, notify subscribers.
 *   2. Build the prompt via `buildCharacterSheetPrompt` using the
 *      asset's tag/aiDescription/outfit/role.
 *   3. Call openai-image edge function in `inpaint` mode with NB2
 *      and the asset's `photo_url` as the source image. Size is
 *      forced to a 16:9 mapping (1536x1024) and `nb2ImageSize: "2K"`
 *      so the four facial close-ups have enough pixels to be useful
 *      as identity anchors.
 *   4. Persist the resulting URL to `assets.character_sheet_url`,
 *      stamp `character_sheet_generated_at = now()` and snapshot the
 *      `character_sheet_source_url` so the UI can detect staleness
 *      when the user later replaces `photo_url`.
 *   5. Broadcast `preflow:asset-updated` carrying the fresh row so
 *      AssetsTab and any other listener can patch in-memory caches
 *      without a refetch.
 *
 * Concurrency policy
 * ------------------
 *   Unlike bgVariationStore (which intentionally queues siblings on
 *   repeat clicks), this store SHORT-CIRCUITS a second concurrent
 *   start for the same asset. Only one sheet is ever stored on the
 *   row; queueing two would just race on the UPDATE and confuse the
 *   user about which one "won".
 */

import { supabase } from "@/integrations/supabase/client";
import { buildCharacterSheetPrompt, type SheetStyle, type SheetKind } from "@/lib/characterSheetPrompt";
import {
  getImageModelDefault,
  getGptQualityDefault,
  modelIsGpt,
} from "@/lib/imageGenPreference";
import { deleteStoredFile } from "@/lib/storageUtils";
import { urlToBase64 } from "@/components/assets/imageUtils";
import { callCharacterSheetVision } from "@/components/assets/vision";
import type { Asset, CharacterRefMode } from "@/components/assets/types";

export type SheetStatus = "idle" | "generating" | "error" | "done";

/**
 * Runtime-safe predicate: is the generated sheet active for this asset
 * (i.e. should conti / inpaint use it instead of `photo_url`).
 *
 * The `use_character_sheet` column is stored as SQLite INTEGER and the
 * local-server adapter does not coerce numbers back to booleans on read
 * (only the explicit `BOOLEAN_COLUMNS` set is coerced; that set
 * intentionally excludes this column to preserve the tri-state NULL
 * default). So at runtime the value can be `null | number | boolean |
 * undefined` — `=== false` alone would let a freshly-stored `0` slip
 * through as "enabled". This helper normalises the comparison.
 *
 * Semantics:
 *   - false / 0  → disabled (sheet preserved on disk, conti uses photo_url)
 *   - null / undefined / true / 1 → enabled (default)
 */
export const isCharacterSheetActive = (asset: {
  character_sheet_url?: string | null;
  use_character_sheet?: boolean | number | null;
}): boolean => {
  if (!asset.character_sheet_url) return false;
  const v = asset.use_character_sheet;
  if (v === false || v === 0) return false;
  return true;
};

/** Subset of asset fields the reference-resolution helpers read. */
export interface CharacterRefAsset {
  photo_url?: string | null;
  character_sheet_url?: string | null;
  character_board_url?: string | null;
  character_ref_mode?: CharacterRefMode | null;
  use_character_sheet?: boolean | number | null;
}

/**
 * The effective reference mode for a character, resolving legacy rows and
 * guarding against a chosen-but-missing artifact.
 *
 *   - explicit `character_ref_mode` wins, but falls back to "original" if
 *     the chosen artifact's URL is absent (e.g. user deleted the board it
 *     had selected).
 *   - legacy rows (mode null): "sheet" when a sheet exists and
 *     `use_character_sheet` isn't disabled, else "original".
 */
export const effectiveRefMode = (asset: CharacterRefAsset): CharacterRefMode => {
  const m = asset.character_ref_mode;
  if (m === "board") return asset.character_board_url ? "board" : "original";
  if (m === "sheet") return asset.character_sheet_url ? "sheet" : "original";
  if (m === "original") return "original";
  // Legacy migration.
  if (isCharacterSheetActive(asset)) return "sheet";
  return "original";
};

/** The actual reference image URL the conti pipeline should feed, after
 *  resolving the mode and falling back to the portrait. */
export const pickCharacterRefUrl = (asset: CharacterRefAsset): string | null => {
  switch (effectiveRefMode(asset)) {
    case "board":
      return asset.character_board_url ?? asset.photo_url ?? null;
    case "sheet":
      return asset.character_sheet_url ?? asset.photo_url ?? null;
    default:
      return asset.photo_url ?? null;
  }
};

/** Column trio per artifact style. Keeps the UPDATE/cleanup paths generic. */
const STYLE_COLUMNS: Record<
  SheetStyle,
  { url: keyof Asset; generatedAt: keyof Asset; sourceUrl: keyof Asset }
> = {
  sheet: {
    url: "character_sheet_url",
    generatedAt: "character_sheet_generated_at",
    sourceUrl: "character_sheet_source_url",
  },
  board: {
    url: "character_board_url",
    generatedAt: "character_board_generated_at",
    sourceUrl: "character_board_source_url",
  },
};

export interface CharacterSheetSnapshot {
  /** 0 = idle, 1 = generation in flight. Higher values are not
   *  produced (we short-circuit duplicate starts); modeled as a number
   *  so the snapshot shape stays interchangeable with bgVariationStore
   *  for any future shared subscribe helper. */
  inFlight: number;
  /** Last persistent error message; cleared on next successful start
   *  or via `clearCharacterSheetError`. */
  error: string | null;
  /** Which artifact the in-flight (or most recent) generation targets.
   *  Lets subscribers show "Generating board…" vs "Generating sheet…"
   *  without threading the style through every call site. */
  style: SheetStyle | null;
}

interface AssetEntry {
  inFlight: number;
  error: string | null;
  style: SheetStyle | null;
}

const entries = new Map<string, AssetEntry>();
const subscribers = new Map<string, Set<(snap: CharacterSheetSnapshot) => void>>();

const getEntry = (assetId: string): AssetEntry => {
  let e = entries.get(assetId);
  if (!e) {
    e = { inFlight: 0, error: null, style: null };
    entries.set(assetId, e);
  }
  return e;
};

const buildSnapshot = (e: AssetEntry): CharacterSheetSnapshot => ({
  inFlight: e.inFlight,
  error: e.error,
  style: e.style,
});

const notify = (assetId: string) => {
  const subs = subscribers.get(assetId);
  if (!subs || subs.size === 0) return;
  const e = entries.get(assetId);
  if (!e) return;
  const snap = buildSnapshot(e);
  for (const cb of subs) {
    try {
      cb(snap);
    } catch (err) {
      console.error("[characterSheetStore] subscriber threw", err);
    }
  }
};

/**
 * Subscribe to snapshot updates for one character asset. The callback
 * fires synchronously with the current snapshot, then on every
 * subsequent change. Returns an unsubscribe fn.
 */
export const subscribeCharacterSheet = (
  assetId: string,
  cb: (snap: CharacterSheetSnapshot) => void,
): (() => void) => {
  const e = getEntry(assetId);
  let subs = subscribers.get(assetId);
  if (!subs) {
    subs = new Set();
    subscribers.set(assetId, subs);
  }
  subs.add(cb);
  cb(buildSnapshot(e));
  return () => {
    const s = subscribers.get(assetId);
    if (s) {
      s.delete(cb);
      if (s.size === 0) subscribers.delete(assetId);
    }
  };
};

/** Read-only snapshot for callers that don't want to subscribe. */
export const getCharacterSheetSnapshot = (
  assetId: string,
): CharacterSheetSnapshot | null => {
  const e = entries.get(assetId);
  return e ? buildSnapshot(e) : null;
};

/** Clear the error state for one asset (e.g. after the user dismisses
 *  a toast or clicks Retry — the start path also clears it). */
export const clearCharacterSheetError = (assetId: string) => {
  const e = entries.get(assetId);
  if (!e) return;
  if (e.error !== null) {
    e.error = null;
    notify(assetId);
  }
};

/**
 * Toggle whether downstream pipelines (conti generate, ContiStudio
 * inpaint) consume the persisted sheet. Disabling does NOT delete the
 * sheet — the file and URL stay on disk so the user can re-enable
 * later without paying the regeneration cost. Phase 3 addition.
 *
 * Side-effects: writes `use_character_sheet` to the `assets` row and
 * broadcasts `preflow:asset-updated` so AssetsTab + ContiTab patch
 * their in-memory caches and the toggle UI stays in sync across
 * surfaces.
 */
export const setCharacterSheetEnabled = async (
  assetId: string,
  enabled: boolean,
): Promise<Asset | null> => {
  const { data: updated, error } = await supabase
    .from("assets")
    .update({ use_character_sheet: enabled })
    .eq("id", assetId)
    .select()
    .single();
  if (error) {
    console.error("[characterSheetStore] setCharacterSheetEnabled failed", error);
    return null;
  }
  const row = (updated as Asset) ?? null;
  if (row) {
    try {
      window.dispatchEvent(
        new CustomEvent("preflow:asset-updated", { detail: row }),
      );
    } catch {
      /* non-window contexts */
    }
  }
  return row;
};

/**
 * Set which reference (original / sheet / board) the conti pipeline uses
 * for this character. Persists `character_ref_mode` and broadcasts so
 * every surface (AssetsTab grid, ContiTab) reconciles without a refetch.
 */
export const setCharacterRefMode = async (
  assetId: string,
  mode: CharacterRefMode,
): Promise<Asset | null> => {
  const { data: updated, error } = await supabase
    .from("assets")
    .update({ character_ref_mode: mode })
    .eq("id", assetId)
    .select()
    .single();
  if (error) {
    console.error("[characterSheetStore] setCharacterRefMode failed", error);
    return null;
  }
  const row = (updated as Asset) ?? null;
  if (row) {
    try {
      window.dispatchEvent(
        new CustomEvent("preflow:asset-updated", { detail: row }),
      );
    } catch {
      /* non-window contexts */
    }
  }
  return row;
};

/**
 * Wipe the persisted sheet for one character. The opposite of
 * `startCharacterSheet`. Used by AssetDetailModal's "Remove Sheet"
 * action when the user wants to fall back to the plain portrait
 * without regenerating.
 *
 * Side-effects:
 *   1. Storage file deleted (best-effort — failure is logged but does
 *      not abort the row update; orphan sweep eventually catches it).
 *   2. `assets` row patched to clear all three sheet columns.
 *   3. `preflow:asset-updated` event broadcast so AssetsTab and any
 *      modal patches their in-memory copy and the badge flips off.
 *   4. Per-asset error/in-flight state cleared so the next start has
 *      a clean slate.
 *
 * Concurrency: refuses while a generation is in flight to avoid the
 * UPDATE racing the in-flight start. The caller (UI) should disable
 * the Remove button while `inFlight > 0`.
 */
export const removeCharacterArtifact = async (
  assetId: string,
  style: SheetStyle,
): Promise<Asset | null> => {
  const e = getEntry(assetId);
  if (e.inFlight > 0) {
    console.warn(
      `[characterSheetStore] removeCharacterArtifact(${style}) skipped — generation still in flight for ${assetId}`,
    );
    return null;
  }

  const cols = STYLE_COLUMNS[style];

  // Snapshot the current URL before we null it out so we can free the
  // storage file. Pulling from DB (not the caller's stale copy) keeps
  // this resilient to concurrent edits in another tab.
  const { data: existing } = await supabase
    .from("assets")
    .select()
    .eq("id", assetId)
    .single();
  const existingRow = existing as Asset | null;
  const prevUrl = (existingRow?.[cols.url] as string | null | undefined) ?? null;

  const patch: Record<string, unknown> = {
    [cols.url]: null,
    [cols.generatedAt]: null,
    [cols.sourceUrl]: null,
  };
  // If the removed artifact was the active reference, fall back to the
  // portrait so conti doesn't dangle on a now-missing URL.
  if (effectiveRefMode(existingRow ?? {}) === style) {
    patch.character_ref_mode = "original";
  }

  const { data: updated, error: updateErr } = await supabase
    .from("assets")
    .update(patch)
    .eq("id", assetId)
    .select()
    .single();
  if (updateErr) {
    e.error = updateErr instanceof Error ? updateErr.message : String(updateErr);
    notify(assetId);
    return null;
  }

  if (prevUrl) {
    try {
      await deleteStoredFile(prevUrl);
    } catch (err) {
      // Storage cleanup is best-effort. The DB row is already cleared,
      // so even if this throws the user's UX state is correct; the
      // orphan sweeper will collect the file on next run.
      console.warn("[characterSheetStore] deleteStoredFile failed", err);
    }
  }

  // Clear the in-memory error too so a stale "generation failed"
  // doesn't linger after the user explicitly removed the artifact.
  e.error = null;
  notify(assetId);

  const row = (updated as Asset) ?? null;
  if (row) {
    try {
      window.dispatchEvent(
        new CustomEvent("preflow:asset-updated", { detail: row }),
      );
    } catch {
      /* non-window contexts */
    }
  }
  return row;
};

/** Subset of the Asset row needed to start a generation. Kept narrow
 *  so callers don't have to load the full Asset type if they only
 *  hold the registration data. */
export interface AssetForCharacterSheet {
  id: string;
  project_id: string;
  tag_name: string;
  photo_url: string | null;
  ai_description: string | null;
  outfit_description: string | null;
  role_description: string | null;
  /** Which reference artifact to build — classic turnaround `sheet`
   *  (default) or the AAA design-bible `board`. Each writes to its own
   *  column trio (sheet vs board) so both can be preserved; the freshly
   *  generated artifact is auto-set as `character_ref_mode`. */
  style?: SheetStyle;
  /** Optional generation-input override. Defaults to `photo_url`. Used
   *  by "develop sheet → board", which feeds the existing turnaround
   *  sheet (richer, multi-angle) as the source instead of the single
   *  portrait. Staleness tracking still snapshots `photo_url`. */
  sourceImageUrl?: string | null;
  /** Which prompt family to use — "character" (default, face/identity)
   *  or "item" (object/product design language). */
  kind?: SheetKind;
}

/**
 * Public entry: start a sheet generation for one character.
 *
 * Returns the updated Asset row on success, or null on failure /
 * duplicate-start short-circuit. Errors are surfaced via the snapshot
 * so subscribers (the badge in AssetsTab, the modal in Phase 2) can
 * react without the caller threading the failure through.
 */
export const startCharacterSheet = async (
  asset: AssetForCharacterSheet,
): Promise<Asset | null> => {
  const e = getEntry(asset.id);

  if (e.inFlight > 0) {
    console.log(
      `[characterSheetStore] skipping duplicate start for asset ${asset.id} — already in flight`,
    );
    return null;
  }

  if (!asset.photo_url) {
    e.error = "No source image registered on the character asset.";
    notify(asset.id);
    return null;
  }

  const style: SheetStyle = asset.style ?? "sheet";
  // Generation input: caller override (develop-from-sheet) or the
  // portrait. `asset.photo_url` is guaranteed non-null by the guard above.
  const src = asset.sourceImageUrl ?? asset.photo_url;

  e.error = null;
  e.inFlight = 1;
  e.style = style;
  notify(asset.id);

  try {
    const prompt = buildCharacterSheetPrompt({
      tagName: asset.tag_name,
      aiDescription: asset.ai_description,
      outfitDescription: asset.outfit_description,
      roleDescription: asset.role_description,
      style,
      kind: asset.kind ?? "character",
    });

    // Fetch the source as base64 so the edge function's NB2→GPT fallback
    // can actually run if the NB2 (Vertex) primary fails. Without this,
    // a NB2 failure dead-ends at "GPT edits 폴백에 imageBase64 가 필요합니다"
    // and the whole generation fails. Best-effort: if the fetch throws we
    // proceed without it (NB2 may still succeed on its own).
    let sourceImageBase64: string | null = null;
    try {
      sourceImageBase64 = (await urlToBase64(src)).base64;
    } catch (e2) {
      console.warn("[characterSheetStore] source base64 fetch failed (NB2-only)", e2);
    }

    // Model is user-selectable via Settings → Image Generation Defaults
    // ("sheet" feature). Both sheet & board styles share this one choice
    // since they ride the same inpaint pipeline.
    //   · NB2 (default) → useNanoBanana + nb2ImageSize "2K" (the right
    //     half is a 2x2 face grid, so each face cell is ~1/4 of the
    //     canvas; 1K would leave each face ~512px which the conti
    //     pipeline cannot reliably use as an identity anchor).
    //   · GPT image (1.5 / 2) → routed through the same GPT-edits path
    //     ChangeAngle uses via `preferredAngleModel`, with the Settings
    //     quality applied. NB2-only params are dropped.
    //   imageSize: explicit 16:9 mapping recognised by sizeToNB2Aspect
    //              (1536x1024 → "16:9"); also a valid gpt-image edit size.
    //   sceneNumber: synthetic — includes assetId + ms so concurrent
    //                generations across assets cannot clash on the
    //                uploaded filename.
    const model = getImageModelDefault("sheet");
    const useGpt = modelIsGpt("sheet", model);
    const modelBody = useGpt
      ? {
          preferredAngleModel: model,
          quality: getGptQualityDefault("sheet"),
        }
      : {
          useNanoBanana: true,
          nb2ImageSize: "2K",
        };
    const { data, error } = await supabase.functions.invoke("openai-image", {
      body: {
        mode: "inpaint",
        sourceImageUrl: src,
        // Enables the NB2→GPT fallback when the NB2 primary fails.
        ...(sourceImageBase64 ? { imageBase64: sourceImageBase64 } : {}),
        referenceImageUrls: [],
        prompt,
        projectId: asset.project_id,
        sceneNumber: `char${style}-${asset.id}-${Date.now()}`,
        imageSize: "1536x1024",
        folder: "assets",
        ...modelBody,
      },
    });
    // The functions adapter returns errors as `{ message }` objects (not
    // Error instances). Throwing the raw object would stringify to
    // "[object Object]" in the catch below, so normalise to an Error with
    // the real message here.
    if (error) {
      const m =
        typeof error === "object" && error && "message" in error
          ? String((error as { message?: unknown }).message)
          : String(error);
      throw new Error(m || "Sheet generation failed");
    }
    const d = data as { publicUrl?: string; url?: string } | null;
    const sheetUrl = d?.publicUrl ?? d?.url ?? null;
    if (!sheetUrl) throw new Error("Sheet generation returned no image URL");

    // Read the previous sheet URL before the UPDATE so we can free
    // the orphaned file after the row points at the new URL. We rely
    // on the caller's stale copy via a fresh SELECT; if we threaded
    // the previous URL through the function arg we'd risk deleting a
    // file the user already manually removed mid-generation.
    const { data: prevRow } = await supabase
      .from("assets")
      .select()
      .eq("id", asset.id)
      .single();
    // Each style owns its own column trio, so generating a board does NOT
    // clobber the sheet (and vice-versa) — both last images are preserved.
    const cols = STYLE_COLUMNS[style];
    const prevStyleUrl =
      ((prevRow as Asset | null)?.[cols.url] as string | null | undefined) ?? null;

    const generatedAt = new Date().toISOString();
    const { data: updated, error: updateErr } = await supabase
      .from("assets")
      .update({
        [cols.url]: sheetUrl,
        [cols.generatedAt]: generatedAt,
        [cols.sourceUrl]: asset.photo_url,
        // Auto-activate the freshly generated artifact as the conti
        // reference. The user can switch back via the ref-mode selector.
        character_ref_mode: style,
      })
      .eq("id", asset.id)
      .select()
      .single();
    if (updateErr) throw updateErr;
    let row = (updated as Asset) ?? null;

    // Free only the PREVIOUS file of THIS style after the row commit so a
    // crash between the two would leave at most one orphan (orphanSweep
    // handles it) instead of clearing the file before the row is updated.
    if (prevStyleUrl && prevStyleUrl !== sheetUrl) {
      try {
        await deleteStoredFile(prevStyleUrl);
      } catch (err) {
        console.warn("[characterSheetStore] previous artifact cleanup failed", err);
      }
    }

    // Phase 3 §3 — vision auto-fill.
    // The freshly minted sheet packs more identity signal than the
    // single uploaded portrait (face from 4 angles + full body), so
    // it's the highest-leverage moment to extract structured
    // descriptions. We ONLY fill empty fields — never overwrite
    // values the user explicitly typed, which would be a surprising
    // data loss. If everything is already populated we skip the
    // round-trip entirely. Failures are non-fatal: the sheet itself
    // is the user's primary deliverable, so a vision-API hiccup
    // should never roll back the successful generation.
    // Items skip this — callCharacterSheetVision is tuned for people
    // (appearance/outfit), which doesn't map onto props.
    if (row && (asset.kind ?? "character") === "character") {
      const needsAppearance = !(row.ai_description ?? "").trim();
      const needsOutfit = !(row.outfit_description ?? "").trim();
      if (needsAppearance || needsOutfit) {
        try {
          const { base64, mediaType } = await urlToBase64(sheetUrl);
          const result = await callCharacterSheetVision(base64, mediaType);
          const patch: Partial<Asset> = {};
          if (needsAppearance && result.appearance) {
            patch.ai_description = result.appearance;
          }
          if (needsOutfit && result.outfit) {
            patch.outfit_description = result.outfit;
          }
          if (Object.keys(patch).length > 0) {
            const { data: refilled, error: refillErr } = await supabase
              .from("assets")
              .update(patch)
              .eq("id", asset.id)
              .select()
              .single();
            if (refillErr) {
              console.warn("[characterSheetStore] vision auto-fill UPDATE failed", refillErr);
            } else if (refilled) {
              row = refilled as Asset;
            }
          }
        } catch (err) {
          console.warn("[characterSheetStore] vision auto-fill skipped", err);
        }
      }
    }

    if (row) {
      try {
        window.dispatchEvent(
          new CustomEvent("preflow:asset-updated", { detail: row }),
        );
      } catch {
        /* non-window contexts (e.g. tests) */
      }
    }

    return row;
  } catch (err) {
    console.error(`[characterSheetStore] generation failed for ${asset.id}`, err);
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err && "message" in err
          ? String((err as { message?: unknown }).message)
          : String(err);
    e.error = msg || "Sheet generation error";
    return null;
  } finally {
    e.inFlight = 0;
    notify(asset.id);
  }
};
