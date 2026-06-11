import { Users, Package, MapPin } from "lucide-react";
import type React from "react";
import { KR, KR_BG } from "@/lib/brand";

export { KR, KR_BG };
export const KR_BORDER = "rgba(249,66,58,0.25)";

export type AssetType = "character" | "item" | "background";

/** Which reference image the conti pipeline feeds for a character. */
export type CharacterRefMode = "original" | "sheet" | "board";

export interface FocalPoint {
  x: number;
  y: number;
  scale?: number;
}

/**
 * Camera framing buckets for background asset variations. Used both as the
 * generation slot key in `photo_variations` and as the matching key when
 * the conti pipeline picks a reference image for a scene's shot type.
 *
 * - wide   : Wide / establishing — full architectural scope of the location
 * - medium : Medium — meaningful corner / a character-scaled area of the room
 * - close  : Close-up — a wall surface, a single feature (door, window, sign)
 * - detail : Extreme detail — texture, material, prop micro-shot
 *
 * NOTE: An `alt` (alternative wide vantage point) slot was removed — NB2
 * kept regenerating outputs visually indistinguishable from the primary
 * `wide` shot, so the slot wasted UI space and generation budget. The
 * literal stays in the union for backward compatibility with already-
 * stored variations on existing assets; new generations and the picker's
 * fallback chain no longer reference it.
 */
export type BackgroundFraming = "wide" | "medium" | "close" | "detail" | "alt";

export interface PhotoVariation {
  url: string;
  framing: BackgroundFraming;
  caption?: string | null;
  /** ISO timestamp — useful for staleness UX ("regenerate older than X"). */
  generated_at: string;
}

export interface Asset {
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
  /** Optional. Background-only. Up to 5 framing-tagged alternate views of
   *  the same location, generated from `photo_url` via the
   *  background_variations IPC. Falls back to `photo_url` when absent. */
  photo_variations?: PhotoVariation[] | null;
  /** Optional. Character-only. 16:9 turnaround / face-grid reference sheet
   *  generated from `photo_url` by NB2. Conti generation prefers this over
   *  `photo_url` so the model has a multi-angle identity anchor. Absent
   *  characters fall back to `photo_url`. */
  character_sheet_url?: string | null;
  /** ISO timestamp of last successful sheet generation. */
  character_sheet_generated_at?: string | null;
  /** Snapshot of the `photo_url` that was used to generate the current
   *  sheet. When `photo_url` later differs from this, the sheet is "stale"
   *  and the UI offers a Regenerate prompt. */
  character_sheet_source_url?: string | null;
  /** Legacy single-slot marker. Superseded by the separate board columns
   *  + `character_ref_mode`; retained only for back-compat reads. */
  character_sheet_style?: "sheet" | "board" | null;
  /** AAA design-bible board, stored independently of the turnaround sheet
   *  so both can be preserved at once. Mirrors the `character_sheet_*`
   *  trio. Absent → no board generated yet. */
  character_board_url?: string | null;
  character_board_generated_at?: string | null;
  character_board_source_url?: string | null;
  /** Which reference the conti pipeline uses for this character:
   *  - `"original"` → `photo_url`
   *  - `"sheet"`    → `character_sheet_url`
   *  - `"board"`    → `character_board_url`
   *  - `undefined` / `null` → legacy: derived from `use_character_sheet`. */
  character_ref_mode?: CharacterRefMode | null;
  /** User-controlled off-switch for the generated sheet. Tri-state:
   *  - `undefined` / `null` → default enabled (legacy rows, never set)
   *  - `true`               → enabled
   *  - `false`              → disabled (sheet preserved on disk but
   *                            conti / inpaint fall back to `photo_url`)
   *  Conti pipeline reads `value !== false`. */
  use_character_sheet?: boolean | null;
}

export const TYPE_LABEL: Record<AssetType, string> = {
  character: "캐릭터",
  item: "아이템",
  background: "배경",
};

export const TYPE_META: Record<
  AssetType,
  {
    label: string;
    icon: React.ReactNode;
    gridCols: string;
    emptyIcon: React.ReactNode;
    emptyText: string;
    addLabel: string;
  }
> = {
  character: {
    label: "캐릭터",
    icon: <Users className="w-3.5 h-3.5" />,
    gridCols: "grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
    emptyIcon: <Users className="w-12 h-12 text-border mb-4" />,
    emptyText: "Register characters to @tag them in scenes and reference during conti generation",
    addLabel: "캐릭터 추가",
  },
  item: {
    label: "아이템",
    icon: <Package className="w-3.5 h-3.5" />,
    gridCols: "grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
    emptyIcon: <Package className="w-12 h-12 text-border mb-4" />,
    emptyText: "Register props to auto-inject material and detail info when tagging scenes",
    addLabel: "아이템 추가",
  },
  background: {
    label: "배경",
    icon: <MapPin className="w-3.5 h-3.5" />,
    gridCols: "grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
    emptyIcon: <MapPin className="w-12 h-12 text-border mb-4" />,
    emptyText: "Register locations to maintain spatial consistency across tagged scenes",
    addLabel: "배경 추가",
  },
};
