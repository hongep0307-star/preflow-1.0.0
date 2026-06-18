/**
 * CameraVariationsModal — re-photographs the current shot from 9 camera angles
 * in a single model call, kept as a GALLERY of grids so "generate again" never
 * discards earlier results.
 *
 * Pipeline:
 *   1. Generate — one BACKGROUND call (owned by ContiTab via `onGenerateGrid`)
 *      produces a 3×3 grid of the scene re-shot from 9 angles, then appends it
 *      to the scene's persisted grid history. Because it runs in ContiTab and
 *      is tracked in `camVarGridState`, the generation survives this popup (or
 *      the whole Conti tab) closing — the scene card shows a spinner on its
 *      Camera Variations icon until it lands.
 *   2. Split — each persisted grid image is sliced client-side into 9 tiles
 *      (cached by URL) and shown as a gallery section.
 *   3. Apply — the chosen tile is upscaled + reframed to the project's exact
 *      aspect at full resolution (ContiTab `onApplyTile`, background) and
 *      written back to the scene.
 *
 * Model is chosen in the footer toggle (seeded from Settings → Image models →
 * Camera Variations); grids generated with any model live in the same history.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Loader2, X, Trash2, RefreshCw } from "lucide-react";
import { DotGrid3x3 } from "@/components/icons/DotGrid3x3";
import { Button } from "@/components/ui/button";
import type { Scene } from "./contiTypes";
import { normalizeGridHistory } from "./contiTypes";
import { IMAGE_SIZE_MAP, FORMAT_RATIO } from "@/lib/conti";
import { buildContactSheetPrompt, CONTACT_SHEET_IDS, getPreset } from "@/lib/cameraLibrary";
import { splitContactSheetDataUrl } from "@/lib/contactSheet";
import { subscribeCamVarGen, getCamVarGen } from "./camVarGridState";
import { useT } from "@/lib/uiLanguage";

type VideoFormat = keyof typeof IMAGE_SIZE_MAP;

/* Module-level split cache: grid image URL → 9 tile data-URLs. Survives modal
 * open/close so re-splitting a persisted grid is instant. */
const tileCache = new Map<string, string[]>();

/* Module-level aspect cache: grid image URL → original (generated) width/height
 * ratio. A 3×3 sheet splits into even thirds, so each tile's aspect equals the
 * sheet's own W/H. We pin tiles to THIS ratio (not the current project format)
 * so that changing the project's aspect later never re-crops past grids. */
const aspectCache = new Map<string, number>();

/** Load an image just to read its natural W/H ratio. Resolves 0 on failure. */
function measureAspect(src: string): Promise<number> {
  if (typeof document === "undefined") return Promise.resolve(0);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 0);
    img.onerror = () => resolve(0);
    img.src = src;
  });
}

/* ━━━ Color tokens ━━━ */
const ACCENT = "hsl(var(--primary))";

/* ━━━ Styles ━━━ */
const BACKDROP_STYLE: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 50,
  background: "hsl(0 0% 0% / 0.8)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
};

const PANEL_STYLE: React.CSSProperties = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border-subtle))",
  boxShadow: "0 10px 15px -3px hsl(0 0% 0% / 0.5), 0 4px 6px -4px hsl(0 0% 0% / 0.4)",
  width: "min(1024px, 100%)",
  height: "min(90vh, 820px)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "14px 20px",
  borderBottom: "1px solid hsl(var(--border-subtle))",
  userSelect: "none",
  flexShrink: 0,
};

const FOOTER_STYLE: React.CSSProperties = {
  padding: "12px 20px",
  borderTop: "1px solid hsl(var(--border-subtle))",
  display: "flex",
  alignItems: "center",
  gap: 10,
  justifyContent: "flex-end",
  flexShrink: 0,
  background: "hsl(var(--surface-nav))",
};

const FOOTER_DIVIDER_STYLE: React.CSSProperties = {
  width: 1,
  height: 20,
  background: "hsl(var(--border-subtle))",
  margin: "0 2px",
  flexShrink: 0,
};

const sectionLabelStyle: React.CSSProperties = {
  color: "hsl(var(--foreground) / 0.55)",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: "uppercase",
};

/* ━━━ Props ━━━ */
export interface CameraVariationsModalProps {
  scene: Scene;
  videoFormat: VideoFormat;
  onClose: () => void;
  /** Kick off a background grid generation with the given prompt. Fire-and-
   *  forget: the result is appended to the scene's grid history. Model is fixed
   *  (GPT Image 2) by ContiTab — parity with the storyboard sheet. */
  onGenerateGrid: (prompt: string) => void;
  /** Remove one grid from the scene's history. */
  onDeleteGrid: (gridId: string) => void;
  /** Apply the chosen tile (ContiTab refines in the background + shows the
   *  scene card overlay); the modal closes right after. */
  onApplyTile: (tileDataUrl: string) => void;
  /** Save the chosen tile as a NEW neighbouring cut (before/after this one),
   *  inheriting the source cut's scene group + location. `cameraAngle` is the
   *  selected tile's preset label (the 9 tiles map 1:1 to fixed angles) so the
   *  new cut's camera_angle is pre-filled. The modal closes right after;
   *  ContiTab does the crop/save/insert in the background. */
  onSaveTileAsNeighbor: (
    tileDataUrl: string,
    position: "before" | "after",
    cameraAngle?: string,
  ) => void;
}

type Selection = { gridId: string; index: number } | null;

export function CameraVariationsModal({
  scene,
  videoFormat,
  onClose,
  onGenerateGrid,
  onDeleteGrid,
  onApplyTile,
  onSaveTileAsNeighbor,
}: CameraVariationsModalProps) {
  const t = useT();
  const sourceUrl = scene.conti_image_url;
  const tileRatio = FORMAT_RATIO[videoFormat] ?? FORMAT_RATIO.horizontal;

  // Newest grid first. Recomputes only when the scene's history changes.
  const grids = useMemo(
    () => normalizeGridHistory(scene.camera_variation_grid).slice().reverse(),
    [scene.camera_variation_grid],
  );
  const total = grids.length;

  // In-flight grid generation for this scene (background, survives this modal).
  const generating = useSyncExternalStore(
    (cb) => subscribeCamVarGen(scene.project_id, scene.id, cb),
    () => !!getCamVarGen(scene.project_id, scene.id),
  );

  const [selected, setSelected] = useState<Selection>(null);
  const [tilesByUrl, setTilesByUrl] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const g of grids) {
      const c = tileCache.get(g.rawUrl);
      if (c) init[g.rawUrl] = c;
    }
    return init;
  });
  // Original (generated) aspect per grid — see aspectCache note above.
  const [aspectByUrl, setAspectByUrl] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const g of grids) {
      const a = aspectCache.get(g.rawUrl);
      if (a) init[g.rawUrl] = a;
    }
    return init;
  });

  // Split any grid images not yet split (using the module cache to decide).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const g of grids) {
        const cached = tileCache.get(g.rawUrl);
        let tiles = cached;
        if (cached) {
          setTilesByUrl((p) => (p[g.rawUrl] ? p : { ...p, [g.rawUrl]: cached }));
        } else {
          try {
            tiles = await splitContactSheetDataUrl(g.rawUrl);
            tileCache.set(g.rawUrl, tiles);
            if (!cancelled) setTilesByUrl((p) => ({ ...p, [g.rawUrl]: tiles! }));
          } catch {
            /* unreadable grid image — skip; user can delete + regenerate */
            continue;
          }
        }
        // Pin the grid to its generated ratio (measured from the actual sliced
        // tile, so the gutter-bleed inset is accounted for) so a later project-
        // format change can't distort/crop past grids — this modal is a viewer.
        if (tiles && tiles[0] && !aspectCache.has(g.rawUrl)) {
          const asp = await measureAspect(tiles[0]);
          if (asp > 0) {
            aspectCache.set(g.rawUrl, asp);
            if (!cancelled) setAspectByUrl((p) => (p[g.rawUrl] ? p : { ...p, [g.rawUrl]: asp }));
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [grids]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const handleGenerate = () => {
    if (!sourceUrl) return;
    setSelected(null);
    // Subject/emotion/notes intentionally omitted — the source image is the
    // only identity reference and the 9 angles are fixed.
    onGenerateGrid(buildContactSheetPrompt({ subject: "" }));
  };

  const handleApply = () => {
    if (!selected) return;
    const grid = grids.find((g) => g.id === selected.gridId);
    const tile = grid ? tilesByUrl[grid.rawUrl]?.[selected.index] : undefined;
    if (!tile) return;
    onApplyTile(tile);
    onClose();
  };

  const handleSaveNeighbor = (position: "before" | "after") => {
    if (!selected) return;
    const grid = grids.find((g) => g.id === selected.gridId);
    const tile = grid ? tilesByUrl[grid.rawUrl]?.[selected.index] : undefined;
    if (!tile) return;
    // The 9 tiles map 1:1 to fixed contact-sheet angles, so the tile index tells
    // us which camera angle the user picked — pre-fill the new cut's angle.
    const angleId = CONTACT_SHEET_IDS[selected.index];
    const cameraAngle = angleId ? getPreset(angleId)?.label : undefined;
    onSaveTileAsNeighbor(tile, position, cameraAngle);
    onClose();
  };

  const handleDeleteGrid = (gridId: string) => {
    const grid = grids.find((g) => g.id === gridId);
    if (grid) {
      tileCache.delete(grid.rawUrl);
      aspectCache.delete(grid.rawUrl);
    }
    if (selected?.gridId === gridId) setSelected(null);
    onDeleteGrid(gridId);
  };

  return (
    <div style={BACKDROP_STYLE} onClick={onClose}>
      <div style={PANEL_STYLE} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={HEADER_STYLE}>
          <DotGrid3x3 className="w-4 h-4" style={{ color: "hsl(var(--foreground) / 0.78)" }} />
          <div
            style={{
              color: "hsl(var(--foreground) / 0.95)",
              fontSize: 14,
              fontWeight: 600,
              flex: 1,
              letterSpacing: 0.1,
            }}
          >
            {t("cameraVar.title")}
          </div>
          <button
            onClick={onClose}
            className="text-white/60 hover:text-white/90"
            style={{ background: "transparent", border: "none", cursor: "pointer", display: "flex" }}
            title={t("cameraVar.closeEsc")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
          {!sourceUrl ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "hsl(var(--foreground) / 0.6)",
                fontSize: 13,
                padding: 24,
                textAlign: "center",
              }}
            >
              {t("cameraVar.noSourceShot")}
            </div>
          ) : (
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: "grid",
                gridTemplateColumns: "minmax(220px, 280px) 1fr",
                overflow: "hidden",
              }}
            >
              {/* Source preview */}
              <div
                style={{
                  borderRight: "1px solid hsl(var(--foreground) / 0.06)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  minHeight: 0,
                  padding: 16,
                  background: "hsl(var(--background))",
                  gap: 10,
                }}
              >
                <img
                  src={sourceUrl}
                  alt={t("cameraVar.shotAlt", { n: String(scene.scene_number).padStart(2, "0") })}
                  style={{
                    maxWidth: "100%",
                    maxHeight: "70%",
                    objectFit: "contain",
                    display: "block",
                    border: "1px solid hsl(var(--foreground) / 0.08)",
                  }}
                />
                <div style={{ color: "hsl(var(--foreground) / 0.45)", fontSize: 11, letterSpacing: 0.3 }}>
                  {t("cameraVar.shotAlt", { n: String(scene.scene_number).padStart(2, "0") })}
                </div>
              </div>

              {/* Gallery */}
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflow: "auto",
                  padding: "16px 20px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 18,
                }}
              >
                {/* In-flight grid */}
                {generating && (
                  <div
                    style={{
                      border: "1px solid hsl(var(--foreground) / 0.08)",
                      background: "hsl(var(--foreground) / 0.02)",
                      padding: 24,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 10,
                      minHeight: 200,
                    }}
                  >
                    <Loader2
                      className="w-6 h-6"
                      style={{ color: "hsl(var(--foreground) / 0.6)", animation: "spin 1s linear infinite" }}
                    />
                    <div style={{ color: "hsl(var(--foreground) / 0.75)", fontSize: 12 }}>
                      {t("cameraVar.rendering")}
                    </div>
                  </div>
                )}

                {/* Empty state */}
                {!generating && total === 0 && (
                  <div
                    style={{
                      flex: 1,
                      border: "1px dashed hsl(var(--foreground) / 0.12)",
                      padding: 28,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      textAlign: "center",
                      color: "hsl(var(--foreground) / 0.55)",
                      fontSize: 12,
                      lineHeight: 1.55,
                      minHeight: 240,
                    }}
                  >
                    {t("cameraVar.pressGenerateHint")}
                  </div>
                )}

                {/* Grid history (newest first). Each grid is a bordered panel so
                    consecutive grids read as distinct sets when scrolling; the
                    panel border + header chip turn accent when it holds the
                    current selection. */}
                {grids.map((grid, gi) => {
                  const tiles = tilesByUrl[grid.rawUrl];
                  const gridNumber = total - gi; // chronological label
                  const isNewest = gi === 0;
                  const gridSelected = selected?.gridId === grid.id;
                  return (
                    <div
                      key={grid.id}
                      style={{
                        border: `1px solid ${gridSelected ? "hsl(var(--primary) / 0.55)" : "hsl(var(--foreground) / 0.1)"}`,
                        background: gridSelected ? "hsl(var(--primary) / 0.05)" : "hsl(var(--foreground) / 0.02)",
                        padding: 12,
                        transition: "border-color 120ms ease, background 120ms ease",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 700,
                            letterSpacing: 0.4,
                            color: gridSelected ? "hsl(var(--primary) / 0.95)" : "hsl(var(--foreground) / 0.8)",
                            background: gridSelected ? "hsl(var(--primary) / 0.16)" : "hsl(var(--foreground) / 0.08)",
                            padding: "2px 8px",
                          }}
                        >
                          {t("cameraVar.gridN", { n: gridNumber })}
                        </span>
                        {isNewest && (
                          <span
                            style={{
                              fontSize: 9.5,
                              fontWeight: 600,
                              letterSpacing: 0.3,
                              textTransform: "uppercase",
                              color: "hsl(var(--foreground) / 0.5)",
                            }}
                          >
                            {t("cameraVar.latest")}
                          </span>
                        )}
                        <div style={{ flex: 1 }} />
                        <button
                          onClick={() => handleDeleteGrid(grid.id)}
                          title={t("cameraVar.deleteGridTitle")}
                          className="flex items-center justify-center w-6 h-6 rounded-none text-white/55 hover:text-white/90"
                          style={{
                            background: "transparent",
                            border: "1px solid hsl(var(--foreground) / 0.12)",
                            cursor: "pointer",
                          }}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      {tiles ? (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                          {tiles.map((tile, i) => {
                            const active = selected?.gridId === grid.id && selected.index === i;
                            return (
                              <button
                                key={i}
                                onClick={() => setSelected({ gridId: grid.id, index: i })}
                                style={{
                                  position: "relative",
                                  padding: 0,
                                  background: "hsl(var(--background))",
                                  border: `2px solid ${active ? ACCENT : "hsl(var(--foreground) / 0.08)"}`,
                                  cursor: "pointer",
                                  overflow: "hidden",
                                  // 생성 당시 원본 비율로 표시 — 프로젝트 포맷을 바꿔도
                                  // 과거 그리드가 재크롭되지 않게 한다. 측정 전엔 현재
                                  // 포맷 비율로 임시 표시(fallback).
                                  aspectRatio: String(aspectByUrl[grid.rawUrl] ?? tileRatio),
                                  transition: "border-color 120ms ease",
                                }}
                              >
                                <img
                                  src={tile}
                                  alt={t("cameraVar.panelN", { n: i + 1 })}
                                  style={{
                                    width: "100%",
                                    height: "100%",
                                    objectFit: "cover",
                                    display: "block",
                                    pointerEvents: "none",
                                  }}
                                />
                                <div
                                  style={{
                                    position: "absolute",
                                    top: 4,
                                    left: 4,
                                    fontSize: 9,
                                    padding: "1px 5px",
                                    background: active ? ACCENT : "rgba(0,0,0,0.6)",
                                    color: "hsl(var(--primary-foreground))",
                                    fontWeight: 700,
                                    letterSpacing: 0.4,
                                  }}
                                >
                                  {i + 1}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            minHeight: 120,
                            color: "hsl(var(--foreground) / 0.4)",
                          }}
                        >
                          <Loader2 className="w-4 h-4" style={{ animation: "spin 1s linear infinite" }} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer — model is fixed (GPT Image 2 → NB2 refine), so no model
            picker here; configured (quality only) in Settings, like the sheet. */}
        {sourceUrl && (
          <div style={FOOTER_STYLE}>
            {/* Left group: generate a (new) grid — separated from the
                selection actions by the auto margin below. */}
            <Button
              variant={total > 0 || generating ? "outline" : "default"}
              size="sm"
              onClick={handleGenerate}
              disabled={generating}
              style={{ marginRight: "auto" }}
            >
              {generating ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              )}
              {total > 0 ? t("cameraVar.generateAgain") : t("cameraVar.generate")}
            </Button>
            {/* Right group: act on the selected tile. The divider visually
                splits the "new cut" inserts from the "replace" apply. */}
            {selected && (
              <>
                <div style={{ fontSize: 11, color: "hsl(var(--foreground) / 0.6)" }}>
                  {t("cameraVar.selected")}{" "}
                  <b style={{ color: "hsl(var(--primary) / 0.9)" }}>
                    {t("cameraVar.gridN", { n: total - grids.findIndex((g) => g.id === selected.gridId) })} ·{" "}
                    {t("cameraVar.panelN", { n: selected.index + 1 })}
                  </b>
                </div>
                <div style={FOOTER_DIVIDER_STYLE} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleSaveNeighbor("before")}
                  title={t("cameraVar.saveAsPrevCutTitle")}
                >
                  {t("cameraVar.saveAsPrevCut")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleSaveNeighbor("after")}
                  title={t("cameraVar.saveAsNextCutTitle")}
                >
                  {t("cameraVar.saveAsNextCut")}
                </Button>
              </>
            )}
            <Button
              size="sm"
              onClick={handleApply}
              disabled={!selected}
              title={!selected ? t("cameraVar.clickTileFirst") : t("cameraVar.replaceWithTile")}
            >
              {t("cameraVar.apply")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
