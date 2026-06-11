import { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  ZoomIn,
  ZoomOut,
  Package,
  MapPin,
  Users,
  User,
  Shirt,
  Camera,
  Loader2,
  AlertCircle,
  AlertTriangle,
  Plus,
  ArrowRight,
  Sparkles,
  RefreshCw,
  Trash2,
  ImageOff,
} from "lucide-react";
import { type Asset, KR } from "./types";
import {
  BACKGROUND_FRAMINGS,
  BACKGROUND_FRAMINGS_BY_ID,
} from "@/lib/backgroundVariations";
import {
  type BgVarSnapshot,
  startBgVarGenerate,
  subscribeBgVar,
  migrateLegacyVariations,
} from "@/lib/bgVariationStore";
import {
  type CharacterSheetSnapshot,
  startCharacterSheet,
  subscribeCharacterSheet,
  removeCharacterArtifact,
  setCharacterRefMode,
  effectiveRefMode,
} from "@/lib/characterSheetStore";
import type { SheetStyle } from "@/lib/characterSheetPrompt";
import type { CharacterRefMode } from "./types";
import { useToast } from "@/hooks/use-toast";
import { HelpTooltip } from "@/components/common/ui-primitives";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { useT } from "@/lib/uiLanguage";

interface Props {
  asset: Asset;
  sceneCount: number;
  onClose: () => void;
  /** Notify parent that a brand-new background asset was created from a
   *  framing generation. Parent should append it to its in-memory asset
   *  list so subsequent lookups (sibling chips, scene @-mention resolution)
   *  see it immediately. */
  onAssetCreated?: (newAsset: Asset) => void;
  /** Switch the modal to view a different asset. Used when the user
   *  clicks a sibling chip in the framings panel. Parent owns the
   *  `previewAsset` state, so it does the swap. */
  onSwitchAsset?: (nextAsset: Asset) => void;
  /** The project's full asset list — used to render existing sibling
   *  chips ("already generated: @BG_wide, @BG_wide_2 ...") so the user
   *  can tell at a glance how many framings they've already made
   *  without scanning the Assets grid. */
  allAssets?: Asset[];
}

export const AssetDetailModal = ({
  asset,
  sceneCount,
  onClose,
  onAssetCreated,
  onSwitchAsset,
  allAssets,
}: Props) => {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  // 이미지 클릭 시 우측 패널 없이 화면 꽉 차게 보는 풀스크린 라이트박스.
  const [fullscreen, setFullscreen] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const { toast } = useToast();
  const t = useT();

  // Subscribe to the module-singleton bgVariationStore so in-flight
  // counts and errors survive modal close/reopen cycles.
  const [snapshot, setSnapshot] = useState<BgVarSnapshot>(() => ({
    inFlight: {},
    errors: {},
  }));
  useEffect(() => {
    const unsub = subscribeBgVar(asset.id, setSnapshot);
    return unsub;
  }, [asset.id]);
  const { inFlight, errors } = snapshot;

  // Per-asset character-sheet generation state — same pattern, but the
  // store keys on assetId and tracks at most one in-flight job.
  const [sheetSnap, setSheetSnap] = useState<CharacterSheetSnapshot>({
    inFlight: 0,
    error: null,
    style: null,
  });
  useEffect(() => {
    const unsub = subscribeCharacterSheet(asset.id, setSheetSnap);
    return unsub;
  }, [asset.id]);

  // Surface character-sheet failures via toast on the leading edge so
  // the user notices even when the modal isn't focused on the badge.
  const lastSheetErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (sheetSnap.error && sheetSnap.error !== lastSheetErrorRef.current) {
      toast({
        title: t("assets.characterSheet.error"),
        description: sheetSnap.error,
        variant: "destructive",
      });
    }
    lastSheetErrorRef.current = sheetSnap.error;
  }, [sheetSnap.error, t, toast]);

  // Main image preview source — 3-way: original / sheet / board. Opens on
  // whichever reference the character currently uses (effectiveRefMode),
  // falling back to original. Re-syncs when the asset itself changes
  // (sibling switch via onSwitchAsset keeps the modal mounted).
  const [viewMode, setViewMode] = useState<CharacterRefMode>(() =>
    effectiveRefMode(asset),
  );
  useEffect(() => {
    setViewMode(effectiveRefMode(asset));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id, asset.character_sheet_url, asset.character_board_url, asset.character_ref_mode]);

  // 풀스크린 라이트박스가 열려 있을 때 Esc 로 라이트박스만 먼저 닫는다.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fullscreen]);

  const [isRemovingSheet, setIsRemovingSheet] = useState(false);
  // In-app confirm dialog state (replaces native window.confirm). When
  // set, the styled ConfirmDialog renders; `onConfirm` runs the pending
  // action and clears the state.
  const [confirmState, setConfirmState] = useState<{
    message: string;
    confirmLabel?: string;
    destructive?: boolean;
    onConfirm: () => void;
  } | null>(null);
  // Surface persistent generation errors to the user via toast — but
  // only on transition to error (not every snapshot fan-out).
  const lastErrorsRef = useRef<BgVarSnapshot["errors"]>({});
  useEffect(() => {
    const prev = lastErrorsRef.current;
    for (const [framing, msg] of Object.entries(errors)) {
      if (msg && prev[framing as keyof BgVarSnapshot["errors"]] !== msg) {
        toast({
          title: t("assets.framingFailed", { framing }),
          description: msg,
          variant: "destructive",
        });
      }
    }
    lastErrorsRef.current = errors;
  }, [errors, t, toast]);

  // The main image area renders exactly the artifact the picked tab maps to
  // — no portrait fallback. If the user opens the 시트/보드 tab before that
  // artifact exists, the preview shows an empty "not generated yet" state
  // instead of misleadingly displaying the original.
  const effectivePrimaryUrl =
    viewMode === "board"
      ? (asset.character_board_url ?? null)
      : viewMode === "sheet"
        ? (asset.character_sheet_url ?? null)
        : asset.photo_url;
  // True when a non-original tab is selected but its artifact isn't ready.
  const artifactMissing = viewMode !== "original" && !effectivePrimaryUrl;

  /* Siblings = every existing asset whose tag_name looks like
   * `{parent}_{framing}` or `{parent}_{framing}_{n}`. These are the
   * framings the user has already generated off this parent. We render
   * them as chips so the user sees at a glance what they've already
   * made, and can hop to any of them without closing the modal. */
  const siblings = useMemo(() => {
    if (!allAssets || asset.asset_type !== "background") return [];
    const parentTag = asset.tag_name.replace(/^@/, "");
    const framingIds = BACKGROUND_FRAMINGS.map((f) => f.id);
    // Match `{parent}_{framing}` optionally followed by `_<number>`.
    const patterns = framingIds.map(
      (f) => new RegExp(`^${escapeRegExp(parentTag)}_${f}(?:_(\\d+))?$`),
    );
    const out: Array<{ asset: Asset; framing: string; n: number }> = [];
    for (const a of allAssets) {
      if (a.id === asset.id) continue;
      if (a.asset_type !== "background") continue;
      const tag = a.tag_name.replace(/^@/, "");
      for (let i = 0; i < patterns.length; i++) {
        const m = tag.match(patterns[i]);
        if (m) {
          out.push({
            asset: a,
            framing: framingIds[i],
            n: m[1] ? parseInt(m[1], 10) : 1,
          });
          break;
        }
      }
    }
    // Sort by framing order, then by numeric suffix.
    const orderIndex = new Map<string, number>(framingIds.map((f, i) => [f, i] as const));
    out.sort((a, b) => {
      const ai = orderIndex.get(a.framing) ?? 99;
      const bi = orderIndex.get(b.framing) ?? 99;
      if (ai !== bi) return ai - bi;
      return a.n - b.n;
    });
    return out;
  }, [allAssets, asset.id, asset.tag_name, asset.asset_type]);

  /* Legacy data migration: if this background asset still carries
   * `photo_variations` entries from the pre-sibling-asset era, convert
   * each to a standalone sibling (with vision analysis) and clear the
   * array. Runs once per asset-id per mount, gated by a ref so re-renders
   * don't re-trigger it mid-flight. Silent on empty arrays. */
  const migratingRef = useRef<string | null>(null);
  const [isMigrating, setIsMigrating] = useState(false);
  useEffect(() => {
    const legacy = Array.isArray(asset.photo_variations) ? asset.photo_variations : [];
    if (legacy.length === 0) return;
    if (asset.asset_type !== "background") return;
    if (migratingRef.current === asset.id) return;
    migratingRef.current = asset.id;
    setIsMigrating(true);
    (async () => {
      try {
        const created = await migrateLegacyVariations(
          {
            id: asset.id,
            project_id: asset.project_id,
            tag_name: asset.tag_name,
            photo_url: asset.photo_url,
            space_description: asset.space_description,
          },
          legacy,
        );
        for (const row of created) {
          onAssetCreated?.(row as unknown as Asset);
        }
        if (created.length > 0) {
          toast({
            title: t("assets.cameraFramingsUpgraded"),
            description: t("assets.cameraFramingsUpgradedDesc", { count: created.length }),
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast({
          title: t("assets.variationMigrationFailed"),
          description: msg,
          variant: "destructive",
        });
      } finally {
        setIsMigrating(false);
      }
    })();
  }, [
    asset.id,
    asset.photo_variations,
    asset.project_id,
    asset.tag_name,
    asset.photo_url,
    asset.space_description,
    asset.asset_type,
    onAssetCreated,
    t,
    toast,
  ]);

  const generateOne = async (framing: (typeof BACKGROUND_FRAMINGS)[number]["id"]) => {
    if (!asset.photo_url) {
      toast({
        title: t("assets.noSourceImage"),
        description: t("assets.noSourceImageDesc"),
        variant: "destructive",
      });
      return;
    }
    const created = await startBgVarGenerate(
      {
        id: asset.id,
        project_id: asset.project_id,
        tag_name: asset.tag_name,
        photo_url: asset.photo_url,
        space_description: asset.space_description,
      },
      framing,
    );
    if (created) {
      onAssetCreated?.(created as unknown as Asset);
      toast({
        title: t("assets.framingCreated"),
        description: t("assets.framingCreatedDesc", { tag: created.tag_name }),
      });
    }
  };

  const generateAll = () => {
    if (!asset.photo_url) {
      toast({
        title: t("assets.noSourceImage"),
        description: t("assets.noSourceImageDesc"),
        variant: "destructive",
      });
      return;
    }
    for (const f of BACKGROUND_FRAMINGS) void generateOne(f.id);
  };

  const zoom = (delta: number) => {
    setScale((p) => {
      const next = Math.max(0.5, Math.min(5, p + delta));
      if (next <= 1) setOffset({ x: 0, y: 0 });
      return next;
    });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (scale <= 1) return;
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setOffset((p) => ({ x: p.x + dx, y: p.y + dy }));
  };
  const onMouseUp = () => {
    dragging.current = false;
  };

  const isChar = !asset.asset_type || asset.asset_type === "character";
  const isItem = asset.asset_type === "item";
  const isBackground = asset.asset_type === "background";
  // Characters, items, and backgrounds all support a generated board via the
  // top tabs. Characters/items also support a turnaround sheet (3 tabs);
  // backgrounds go original → board only (2 tabs) and keep their camera-
  // framings panel, shown only while viewing the original.
  const supportsRef = isChar || isItem || isBackground;
  // Prompt family for sheet/board generation.
  const refKind: "character" | "item" | "background" = isBackground
    ? "background"
    : isItem
      ? "item"
      : "character";
  // Background tabs omit 시트. Ref mode is persisted for ALL kinds so the
  // grid thumbnail reflects the selected tab (원본/보드) and conti consumes
  // the chosen reference. The "콘티 사용 중" dot shows for every kind now.
  const tabModes: CharacterRefMode[] = isBackground
    ? ["original", "board"]
    : ["original", "sheet", "board"];
  const persistRefMode = supportsRef;
  const showContiDot = supportsRef;
  // Characters get a slightly wider left panel when they have a sheet
  // so the 16:9 sheet preview doesn't feel cramped under the avatar.
  // Without a sheet we keep the legacy 360-wide column to avoid jolting
  // existing layouts.
  const hasSheet = !!asset.character_sheet_url;
  const hasBoard = !!asset.character_board_url;
  const imgPanelW = isBackground
    ? 580
    : asset.asset_type === "item"
      ? 500
      : isChar && (hasSheet || hasBoard)
        ? 460
        : 360;

  // The store tracks a single in-flight slot shared by sheet + board, but
  // `sheetSnap.style` records which artifact is actually generating. Scope the
  // "generating" label per tab so generating a board does not show "Generating
  // sheet…" on the Sheet tab. Buttons still disable while EITHER runs, since
  // only one generation can be in flight at a time.
  const anyArtifactGenerating = sheetSnap.inFlight > 0;
  const sheetGenerating = anyArtifactGenerating && sheetSnap.style === "sheet";
  const boardGenerating = anyArtifactGenerating && sheetSnap.style === "board";
  // Which reference conti currently uses for this character.
  const refMode = effectiveRefMode(asset);
  // Widen the popup whenever a 16:9 artifact EXISTS (sheet or board), not
  // just when it's the active tab. This keeps the popup the same size
  // across 원본/시트/보드 tabs (sized to the largest = board) so switching
  // tabs no longer resizes the window.
  const viewingWide = supportsRef && (hasSheet || hasBoard);
  // Stale = the portrait used to make the artifact differs from the
  // current portrait (photo replaced after generation). source_url null
  // (legacy / never-generated) → treat as not-stale.
  const isSheetStale =
    hasSheet &&
    !!asset.character_sheet_source_url &&
    !!asset.photo_url &&
    asset.character_sheet_source_url !== asset.photo_url;

  const startSheet = (opts: {
    style: SheetStyle;
    /** Generate from the existing sheet instead of the portrait. */
    develop?: boolean;
    confirm?: boolean;
  }) => {
    if (!asset.photo_url) {
      toast({
        title: t("assets.characterSheet.noPhoto"),
        variant: "destructive",
      });
      return;
    }
    const { style, develop = false, confirm = false } = opts;
    if (develop && !asset.character_sheet_url) return;
    const run = () => {
      void startCharacterSheet({
        id: asset.id,
        project_id: asset.project_id,
        tag_name: asset.tag_name,
        photo_url: asset.photo_url,
        // Backgrounds carry their description in `space_description`; feed it
        // as the design-notes hint so the environment board has context.
        ai_description: isBackground ? asset.space_description : asset.ai_description,
        outfit_description: asset.outfit_description,
        role_description: asset.role_description,
        style,
        kind: refKind,
        sourceImageUrl: develop ? asset.character_sheet_url : undefined,
      });
    };
    if (confirm) {
      const msg = develop
        ? t("assets.characterSheet.confirmDevelopBoard")
        : style === "board"
          ? t("assets.characterSheet.confirmRegenerateBoard")
          : t("assets.characterSheet.confirmRegenerate");
      setConfirmState({ message: msg, onConfirm: run });
      return;
    }
    run();
  };

  const handleSetRefMode = (mode: CharacterRefMode) => {
    if (mode === refMode) return;
    void setCharacterRefMode(asset.id, mode);
  };

  const runRemoveArtifact = async (style: SheetStyle) => {
    setIsRemovingSheet(true);
    try {
      const removed = await removeCharacterArtifact(asset.id, style);
      if (removed) {
        toast({ title: t("assets.characterSheet.removed") });
      }
    } catch (err) {
      toast({
        title: t("assets.characterSheet.removeFailed"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setIsRemovingSheet(false);
    }
  };

  const handleRemoveArtifact = (style: SheetStyle) => {
    if (anyArtifactGenerating) return;
    if (style === "sheet" ? !hasSheet : !hasBoard) return;
    setConfirmState({
      message: t(
        style === "board"
          ? "assets.characterSheet.confirmRemoveBoard"
          : "assets.characterSheet.confirmRemove",
      ),
      confirmLabel: t(style === "board" ? "assets.characterSheet.removeBoard" : "assets.characterSheet.remove"),
      destructive: true,
      onConfirm: () => {
        void runRemoveArtifact(style);
      },
    });
  };

  const totalInFlight = Object.values(inFlight).reduce((n, v) => n + (v ?? 0), 0);
  const isAnyGenerating = totalInFlight > 0;

  return (
    <>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <div
        className="relative flex overflow-hidden rounded-none border border-border-subtle bg-card shadow-lg"
        style={{
          maxWidth: "95vw",
          maxHeight: "90vh",
          // Fixed popup height in wide (artifact) layout so switching between
          // 원본/시트/보드 tabs never resizes the window on either axis. The
          // image area (flex-1) absorbs the difference; images center via
          // object-contain.
          height: viewingWide ? "85vh" : undefined,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="relative bg-background flex flex-col"
          style={{
            // 시트 보기일 때는 16:9 시트가 시원하게 보이도록 패널을 가로로 확장
            // (우측 메타 300px 와 합쳐도 컨테이너 maxWidth 95vw 안에 들어옴).
            width: viewingWide ? "min(60vw, 900px)" : imgPanelW,
            minWidth: 240,
          }}
        >
          {/* ── 캐릭터 레퍼런스 탭 (원본/시트/보드) ──
              상단 탭으로 미리보기 이미지를 전환하고, 아티팩트가 있으면 콘티
              레퍼런스(refMode)도 함께 그 항목으로 지정한다. 활성 탭에 작은
              점으로 "콘티에 사용 중"을 표시해 미리보기와 콘티 사용 대상이
              같은지 한눈에 알 수 있게 한다. 미생성 탭은 흐리게 + '+' 로
              생성 가능함을 암시(클릭 시 해당 탭으로 전환되어 아래에 생성
              버튼이 노출된다). */}
          {supportsRef && asset.photo_url && (
            <div className="flex shrink-0 border-b border-border-subtle bg-surface-sidebar">
              {tabModes.map((m) => {
                const exists = m === "original" ? true : m === "sheet" ? hasSheet : hasBoard;
                const active = viewMode === m;
                const isConti = showContiDot && refMode === m;
                return (
                  <button
                    key={m}
                    onClick={() => {
                      setViewMode(m);
                      if (exists && persistRefMode) handleSetRefMode(m);
                    }}
                    className="relative flex-1 flex items-center justify-center gap-1.5 px-2 py-2.5 text-caption font-medium transition-colors"
                    style={{
                      color: active ? "#fff" : exists ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.3)",
                      borderBottom: `2px solid ${active ? KR : "transparent"}`,
                      background: active ? "rgba(255,255,255,0.04)" : "transparent",
                    }}
                  >
                    {!exists && <Plus className="w-3 h-3 opacity-70" />}
                    {t(`assets.characterSheet.ref.${m}`)}
                    {isConti && (
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: KR }}
                        title={t("assets.characterSheet.contiActive")}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <div
            className="relative flex-1 flex items-center justify-center overflow-hidden"
            style={{
              // In wide layout the popup height is fixed on the container, so
              // this flex-1 area just fills the remaining space (no per-tab
              // resize). Non-wide assets keep the legacy min/max sizing.
              minHeight: isChar ? 380 : 280,
              maxHeight: viewingWide ? undefined : "70vh",
            }}
            onWheel={(e) => {
              e.preventDefault();
              zoom(-e.deltaY * 0.001);
            }}
          >
            {/* 줌 바 — 어두운 pill 배경 + blur 로 감싸 흰 배경 이미지 위에서도
                항상 또렷하게(이전엔 흰 글자/반투명 흰 버튼이 흰 배경에 묻혔다). */}
            <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 z-10 bg-black/55 backdrop-blur-sm rounded-full px-1.5 py-1">
              <button
                onClick={() => zoom(-0.25)}
                className="w-7 h-7 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors"
              >
                <ZoomOut className="w-3.5 h-3.5 text-white" />
              </button>
              <span className="text-white text-caption font-medium w-10 text-center">{Math.round(scale * 100)}%</span>
              <button
                onClick={() => zoom(0.25)}
                className="w-7 h-7 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors"
              >
                <ZoomIn className="w-3.5 h-3.5 text-white" />
              </button>
              <button
                onClick={() => {
                  setScale(1);
                  setOffset({ x: 0, y: 0 });
                }}
                className="px-2 h-7 rounded-full bg-white/15 hover:bg-white/25 text-white text-caption transition-colors"
                title={t("assets.actualSizeHint")}
              >
                {t("assets.actualSize")}
              </button>
            </div>
            {effectivePrimaryUrl ? (
              <img
                src={effectivePrimaryUrl}
                alt={asset.tag_name}
                draggable={false}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                // 클릭 동작은 현재 배율에 따라 분기:
                //  · 축소(scale<1): 원본(100%) 크기로 복귀 — 돋보기로 다시 키움.
                //  · 기본(scale===1): 풀스크린으로 크게 보기.
                //  · 확대(scale>1): 드래그-팬 모드라 클릭 무시.
                onClick={() => {
                  if (dragging.current) return;
                  if (scale < 1) {
                    setScale(1);
                    setOffset({ x: 0, y: 0 });
                  } else if (scale === 1) {
                    setFullscreen(true);
                  }
                }}
                style={{
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                  transition: dragging.current ? "none" : "transform 0.15s ease",
                  cursor: scale > 1 ? (dragging.current ? "grabbing" : "grab") : "zoom-in",
                  userSelect: "none",
                  maxWidth: "100%",
                  maxHeight: viewingWide ? "100%" : "62vh",
                  objectFit: "contain",
                }}
                loading="lazy"
                decoding="async"
              />
            ) : artifactMissing ? (
              // Selected 시트/보드 tab but the artifact isn't generated yet —
              // show an explicit empty state instead of the original image.
              <div className="flex flex-col items-center justify-center w-full h-full gap-2 text-white/30 select-none">
                <ImageOff className="w-12 h-12" />
                <span className="text-meta">
                  {t(
                    viewMode === "board"
                      ? "assets.characterSheet.boardNotGenerated"
                      : "assets.characterSheet.sheetNotGenerated",
                  )}
                </span>
              </div>
            ) : (
              <div className="flex items-center justify-center w-full h-full opacity-10">
                {asset.asset_type === "item" ? (
                  <Package className="w-16 h-16 text-white" />
                ) : isBackground ? (
                  <MapPin className="w-16 h-16 text-white" />
                ) : (
                  <Users className="w-16 h-16 text-white" />
                )}
              </div>
            )}
          </div>

          <p className="text-center text-white/25 text-caption py-2 pointer-events-none select-none">
            {scale > 1 ? t("assets.zoomHintDrag") : t("assets.zoomHintClose")}
          </p>

          {/* ── Reference management (characters / items / backgrounds) ──
              The 원본/시트/보드 selection lives in the top tabs. This panel
              shows only the management actions for the currently selected
              tab: original = info note, sheet/board = generate, or
              regenerate + remove. Items/backgrounds use object/environment
              design prompts. For backgrounds the original tab has no panel
              here (the camera-framings panel below is its original-view
              content), so hide it then. Disabled until a source image exists. */}
          {supportsRef && !(isBackground && viewMode === "original") && (
            <div
              className="border-t border-border-subtle bg-surface-sidebar px-3 py-3"
              onClick={(e) => e.stopPropagation()}
            >
              {!asset.photo_url ? (
                <p className="text-white/40 text-caption leading-snug">
                  {t("assets.characterSheet.noPhoto")}
                </p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {/* 생성 중 표시는 별도 박스 대신 각 생성/재생성 버튼 위에
                      인라인으로 노출(아래 contextual 버튼들). 여기선 에러만. */}
                  {!anyArtifactGenerating && sheetSnap.error && (
                    <div
                      className="flex items-start gap-2 px-2 py-2 bg-background/70 border border-orange-500/30"
                      style={{ borderRadius: 0 }}
                    >
                      <AlertCircle className="w-3.5 h-3.5 text-orange-400/90 shrink-0 mt-0.5" />
                      <span className="text-white/75 text-caption leading-snug">
                        {sheetSnap.error}
                      </span>
                    </div>
                  )}

                  {isSheetStale && (
                    <div
                      className="flex items-start gap-2 px-2 py-1.5 bg-orange-500/10 border border-orange-500/30"
                      style={{ borderRadius: 0 }}
                    >
                      <AlertTriangle className="w-3 h-3 text-orange-400/90 shrink-0 mt-0.5" />
                      <div className="flex flex-col gap-0.5">
                        <span className="text-orange-200/90 text-caption font-semibold leading-snug">
                          {t("assets.characterSheet.staleTitle")}
                        </span>
                        <span className="text-orange-200/70 text-caption leading-snug">
                          {t("assets.characterSheet.staleDesc")}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* 선택된 탭(viewMode)의 레퍼런스 관리만 맥락 노출.
                      원본은 항상 존재하므로 안내 문구만, 시트/보드는 생성
                      여부에 따라 생성 또는 재생성·삭제 버튼을 보여준다. */}
                  {viewMode === "original" ? (
                    <p className="text-white/40 text-caption leading-snug">
                      {t("assets.characterSheet.originalAlways")}
                    </p>
                  ) : viewMode === "sheet" ? (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {!hasSheet ? (
                        <button
                          onClick={() => startSheet({ style: "sheet" })}
                          disabled={anyArtifactGenerating}
                          className="flex items-center gap-1 px-2 py-1 text-caption font-medium border text-white disabled:opacity-60 disabled:cursor-not-allowed transition-opacity"
                          style={{ borderRadius: 0, background: KR, borderColor: KR }}
                        >
                          {sheetGenerating ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin" />
                              {t("assets.characterSheet.generating")}
                            </>
                          ) : (
                            <>
                              <Sparkles className="w-3 h-3" />
                              {t("assets.characterSheet.generate")}
                            </>
                          )}
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => startSheet({ style: "sheet", confirm: true })}
                            disabled={anyArtifactGenerating || isRemovingSheet}
                            className="flex items-center gap-1 px-2 py-1 text-caption font-medium border border-border-subtle text-foreground/80 hover:bg-surface-panel disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                            style={{ borderRadius: 0 }}
                          >
                            {sheetGenerating ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin" />
                                {t("assets.characterSheet.generating")}
                              </>
                            ) : (
                              <>
                                <RefreshCw className="w-3 h-3" />
                                {t("assets.characterSheet.regenerate")}
                              </>
                            )}
                          </button>
                          <button
                            onClick={() => handleRemoveArtifact("sheet")}
                            disabled={anyArtifactGenerating || isRemovingSheet}
                            className="flex items-center justify-center w-7 h-7 border border-border-subtle text-foreground/40 hover:text-destructive hover:bg-destructive/10 hover:border-destructive/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            style={{ borderRadius: 0 }}
                            title={t("assets.characterSheet.remove")}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {!hasBoard ? (
                        <>
                          <button
                            onClick={() => startSheet({ style: "board" })}
                            disabled={anyArtifactGenerating}
                            className="flex items-center gap-1 px-2 py-1 text-caption font-medium border text-white disabled:opacity-60 disabled:cursor-not-allowed transition-opacity"
                            style={{ borderRadius: 0, background: KR, borderColor: KR }}
                          >
                            {boardGenerating ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin" />
                                {t("assets.characterSheet.generatingBoard")}
                              </>
                            ) : (
                              <>
                                <Sparkles className="w-3 h-3" />
                                {hasSheet
                                  ? t("assets.characterSheet.generateBoardFromOriginal")
                                  : t("assets.characterSheet.generateBoard")}
                              </>
                            )}
                          </button>
                          {hasSheet && (
                            <button
                              onClick={() => startSheet({ style: "board", develop: true })}
                              disabled={anyArtifactGenerating}
                              className="flex items-center gap-1 px-2 py-1 text-caption font-medium border border-border-subtle text-foreground/80 hover:bg-surface-panel disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                              style={{ borderRadius: 0 }}
                            >
                              <Sparkles className="w-3 h-3" />
                              {t("assets.characterSheet.developBoard")}
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() =>
                              startSheet({ style: "board", develop: hasSheet, confirm: true })
                            }
                            disabled={anyArtifactGenerating || isRemovingSheet}
                            className="flex items-center gap-1 px-2 py-1 text-caption font-medium border border-border-subtle text-foreground/80 hover:bg-surface-panel disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                            style={{ borderRadius: 0 }}
                          >
                            {boardGenerating ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin" />
                                {t("assets.characterSheet.generatingBoard")}
                              </>
                            ) : (
                              <>
                                <RefreshCw className="w-3 h-3" />
                                {t("assets.characterSheet.regenerateBoard")}
                              </>
                            )}
                          </button>
                          <button
                            onClick={() => handleRemoveArtifact("board")}
                            disabled={anyArtifactGenerating || isRemovingSheet}
                            className="flex items-center justify-center w-7 h-7 border border-border-subtle text-foreground/40 hover:text-destructive hover:bg-destructive/10 hover:border-destructive/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            style={{ borderRadius: 0 }}
                            title={t("assets.characterSheet.removeBoard")}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Camera Framings panel (background-only) ──
              Each framing button generates a NEW standalone background
              asset (e.g. `@{parent}_wide`, `@{parent}_wide_2` on the
              next click of the same button). The parent's photo_url is
              never touched. Existing siblings are listed below as chips
              so the user can jump between them without closing the
              modal. Only available while viewing the original — the board
              view doesn't need framing generation. */}
          {isBackground && viewMode === "original" && (
            <div
              className="border-t border-border-subtle bg-surface-sidebar px-3 py-3"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <Camera className="w-3.5 h-3.5 text-white/60" />
                  <span className="text-white/80 text-meta font-semibold tracking-wide">
                    {t("assets.generateCameraFramings")}
                  </span>
                  <HelpTooltip>
                    {t("assets.cameraFramingHelp")}
                  </HelpTooltip>
                  {isMigrating && (
                    <span className="flex items-center gap-1 text-white/50 text-caption">
                      <Loader2 className="w-3 h-3 animate-spin" /> {t("assets.upgradingLegacy")}
                    </span>
                  )}
                </div>
                <button
                  onClick={generateAll}
                  disabled={!effectivePrimaryUrl || isMigrating}
                  className="px-2.5 py-1 text-meta font-medium border border-border-subtle text-foreground/80 hover:bg-surface-panel disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
                  style={{ borderRadius: 0 }}
                  title={t("assets.framing.generateAllTitle")}
                >
                  {isAnyGenerating ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {t("studio.generating")} ({totalInFlight})
                    </>
                  ) : (
                    t("assets.generateAll")
                  )}
                </button>
              </div>

              <div className="grid grid-cols-4 gap-1.5">
                {BACKGROUND_FRAMINGS.map((f) => {
                  const count = inFlight[f.id] ?? 0;
                  const generating = count > 0;
                  const hasError = !!errors[f.id] && !generating;
                  return (
                    <button
                      key={f.id}
                      onClick={() => void generateOne(f.id)}
                      disabled={!effectivePrimaryUrl || isMigrating}
                      className="relative flex flex-col items-center justify-center gap-1 py-2 px-1.5 bg-background/70 border border-border-subtle hover:border-primary/30 hover:bg-surface-panel disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      style={{ borderRadius: 0, minHeight: 62 }}
                      title={t("assets.framing.generateOneTitle", {
                        tag: `${asset.tag_name.replace(/^@/, "")}_${f.id}`,
                        desc: t(`assets.framing.${f.id}.desc`),
                      })}
                    >
                      {generating ? (
                        <Loader2 className="w-3.5 h-3.5 text-white animate-spin" />
                      ) : hasError ? (
                        <AlertCircle className="w-3.5 h-3.5 text-orange-400/80" />
                      ) : (
                        <Plus className="w-3.5 h-3.5 text-white/80" />
                      )}
                      <span className="text-white text-meta font-semibold tracking-wide">
                        {t(`assets.framing.${f.id}.label`)}
                      </span>
                      <span className="text-white/50 text-caption leading-tight text-center line-clamp-1">
                        {t(`assets.framing.${f.id}.desc`)}
                      </span>
                      {count > 1 && (
                        <span
                          className="absolute top-1 right-1 text-caption text-white/90 px-1"
                          style={{
                            background: "hsl(var(--primary) / 0.85)",
                            borderRadius: 0,
                            minWidth: 14,
                            textAlign: "center",
                          }}
                          title={t("assets.framing.queuedCount", { count })}
                        >
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Sibling chips — assets already spawned off this parent.
                  Shows each as `@tag_name`; click opens that asset. */}
              {siblings.length > 0 && (
                <div className="mt-3">
                  <p className="text-white/50 text-caption font-semibold tracking-wide mb-1.5">
                    {t("assets.existingSiblings", { count: siblings.length })}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {siblings.map(({ asset: sib, framing }) => (
                      <button
                        key={sib.id}
                        onClick={() => onSwitchAsset?.(sib)}
                        className="group flex items-center gap-1.5 px-2 py-1 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/25 transition-colors"
                        style={{ borderRadius: 0 }}
                        title={t("assets.framing.openSibling", {
                          tag: sib.tag_name.replace(/^@/, ""),
                          label: t(`assets.framing.${framing}.label`),
                        })}
                      >
                        {sib.photo_url ? (
                          <img
                            src={sib.photo_url}
                            alt={sib.tag_name}
                            className="w-5 h-5 object-cover"
                            style={{ borderRadius: 0 }}
                            loading="lazy"
                            decoding="async"
                          />
                        ) : (
                          <Camera className="w-3 h-3 text-white/60" />
                        )}
                        <span className="text-white/85 text-caption font-medium">
                          @{sib.tag_name.replace(/^@/, "")}
                        </span>
                        <ArrowRight className="w-3 h-3 text-white/40 group-hover:text-white/80 transition-colors" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-muted-foreground text-caption mt-2">
                {t("assets.generatedFramings")}
              </p>
            </div>
          )}
        </div>

        <div
          className="flex flex-col bg-card border-l border-border-subtle p-5 overflow-y-auto"
          style={{ width: 300, minWidth: 240 }}
        >
          {/* 헤더: @태그(좌) + 닫기(우). 이전엔 닫기 버튼이 absolute 라
              긴 태그명일 때 겹칠 수 있어 명시적 flex 헤더로 분리. */}
          <div className="flex items-start justify-between gap-2 mb-4">
            <span className="text-meta font-bold px-2 py-0.5 rounded-none text-primary bg-primary/15 border border-primary/40 break-all">
              @{asset.tag_name}
            </span>
            <button
              onClick={onClose}
              className="shrink-0 w-6 h-6 flex items-center justify-center bg-muted hover:bg-muted/80 transition-colors"
              style={{ borderRadius: 0 }}
              aria-label={t("common.close")}
            >
              <X className="w-3 h-3 text-muted-foreground" />
            </button>
          </div>

          {asset.asset_type === "item" && asset.ai_description && (
            <div className="mb-4">
              <p className="text-meta text-muted-foreground font-medium mb-1.5 flex items-center gap-1.5">
                <Package className="w-3.5 h-3.5" /> {t("assets.itemDescription")}
              </p>
              <p className="text-label text-foreground/80 leading-relaxed">{asset.ai_description}</p>
            </div>
          )}
          {isBackground && asset.space_description && (
            <div className="mb-4">
              <p className="text-meta text-muted-foreground font-medium mb-1.5 flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5" /> {t("assets.locationDescription")}
              </p>
              <p className="text-label text-foreground/80 leading-relaxed">{asset.space_description}</p>
            </div>
          )}
          {isChar && (
            <>
              {asset.ai_description && (
                <div className="mb-4">
                  <p className="text-meta text-muted-foreground font-medium mb-1.5">{t("assets.characterDescription")}</p>
                  <p className="text-label text-foreground/80 leading-relaxed">
                    {asset.ai_description.slice(0, 240)}
                    {asset.ai_description.length > 240 ? "..." : ""}
                  </p>
                </div>
              )}
              {asset.role_description && (
                <div className="mb-3">
                  <p className="text-meta text-muted-foreground font-medium mb-0.5 flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5" /> {t("assets.roleRelationship")}
                  </p>
                  <p className="text-label text-foreground/70">{asset.role_description}</p>
                </div>
              )}
              {asset.outfit_description && (
                <div className="mb-3">
                  <p className="text-meta text-muted-foreground font-medium mb-0.5 flex items-center gap-1.5">
                    <Shirt className="w-3.5 h-3.5" /> {t("assets.outfit")}
                  </p>
                  <p className="text-label text-foreground/70">{asset.outfit_description}</p>
                </div>
              )}
              {!asset.ai_description && !asset.role_description && !asset.outfit_description && (
                <p className="text-meta text-muted-foreground/30">{t("assets.noDescriptionRegistered")}</p>
              )}
            </>
          )}

          <div className="mt-auto pt-3 border-t border-border-subtle">
            <span className="text-meta text-muted-foreground/60">
              {t("assets.usedInScenes", { count: sceneCount, unit: t(sceneCount === 1 ? "assets.scene" : "assets.scenes") })}
            </span>
          </div>
        </div>
      </div>
    </div>

    {/* 풀스크린 라이트박스 — 이미지 클릭 시 화면 가득(우측 패널 없이). 아무 곳
        클릭 또는 Esc 로 닫는다. 시트처럼 큰 자료를 한 번에 크게 확인. */}
    {fullscreen && effectivePrimaryUrl && (
      <div
        className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/80"
        onClick={() => setFullscreen(false)}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            setFullscreen(false);
          }}
          className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center bg-white/10 hover:bg-white/20 transition-colors"
          style={{ borderRadius: 0 }}
          aria-label={t("common.close")}
        >
          <X className="w-4 h-4 text-white" />
        </button>
        <img
          src={effectivePrimaryUrl}
          alt={asset.tag_name}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          className="object-contain"
          // 이전(96vw/92vh) 대비 약 15% 크게 — 힌트를 absolute 로 빼 세로 공간을
          // 이미지에 모두 내주고, 캡을 화면 전체(100vw/100vh)로 올린다. object-contain
          // 이라 비율 유지 + 잘림 없음(fit-to-screen 최대치).
          style={{ maxWidth: "100vw", maxHeight: "100vh" }}
        />
        <p className="absolute bottom-3 left-1/2 -translate-x-1/2 text-center text-white/40 text-meta pointer-events-none select-none">
          {t("assets.fullscreenHintClose")}
        </p>
      </div>
    )}

    {/* 시트/보드 재생성·디벨롭·삭제 확인 — 네이티브 window.confirm 대신
        앱 전용 다이얼로그. onConfirm 실행 후 상태를 비워 닫는다. */}
    <ConfirmDialog
      open={!!confirmState}
      message={confirmState?.message ?? ""}
      confirmLabel={confirmState?.confirmLabel}
      destructive={confirmState?.destructive}
      onConfirm={() => {
        const action = confirmState?.onConfirm;
        setConfirmState(null);
        action?.();
      }}
      onCancel={() => setConfirmState(null)}
    />
    </>
  );
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
