import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { drainPendingPromotes } from "@/lib/referenceLibrary";
import { removePromotedAssetUsage } from "@/lib/briefRefUsageScan";
import { deleteStoredFiles } from "@/lib/storageUtils";
import { callClaude } from "@/lib/claude";
import { detectMediaType } from "@/lib/detectMediaType";
import { sanitizeImagePrompt } from "@/lib/conti";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Plus,
  Edit2,
  Trash2,
  Camera,
  Sparkles,
  X,
  Loader2,
  RefreshCw,
  Move,
  Wand2,
  Package,
  MapPin,
  User,
  Shirt,
  ArrowRight,
  LayoutGrid,
  AlertCircle,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

import { type Asset, type AssetType, type FocalPoint, type PhotoVariation, KR, KR_BG, KR_BORDER, TYPE_META } from "./assets/types";
import { fileToBase64, urlToBase64 } from "./assets/imageUtils";
import { callVisionAnalyze } from "./assets/vision";
import { AssetDetailModal } from "./assets/AssetDetailModal";
import { FocalEditor } from "./assets/FocalEditor";
import { SquareAvatar } from "./assets/SquareAvatar";
import { UploadZone } from "./assets/UploadZone";
import { useT } from "@/lib/uiLanguage";
import {
  startCharacterSheet,
  subscribeCharacterSheet,
  pickCharacterRefUrl,
  type CharacterSheetSnapshot,
} from "@/lib/characterSheetStore";

/** Character-only "do you want a reference sheet too?" mode for the
 *  registration modal. `fast` keeps the existing flow — just upload &
 *  save. `with-sheet` queues a background NB2 generation right after
 *  insert/update and the modal closes immediately. */
type SheetMode = "fast" | "with-sheet";

interface Props {
  projectId: string;
  /** 초기 활성 하위 탭(캐릭터/아이템/배경). 라이브러리에서 특정 타입으로 승격
   *  후 이동할 때 URL(?assetType=)로 전달되어 해당 탭이 바로 열리게 한다. */
  initialAssetType?: string | null;
  onSwitchToAgent?: () => void;
}

const ASSET_TYPES: ReadonlySet<string> = new Set(["character", "item", "background"]);

/**
 * Tiny floating status badge rendered on character cards. Subscribes
 * to the per-asset character-sheet store so the icon flips between
 * states without a parent re-render storm:
 *   · in-flight  → pulsing spinner ("Generating character sheet…")
 *   · error      → red dot, click to retry
 *   · sheet ready & idle → small grid icon
 *   · idle, no sheet → render nothing (stay invisible)
 */
const CharacterSheetBadge = ({
  assetId,
  hasSheet,
  onRetry,
}: {
  assetId: string;
  hasSheet: boolean;
  onRetry: () => void;
}) => {
  const t = useT();
  const [snap, setSnap] = useState<CharacterSheetSnapshot>({ inFlight: 0, error: null, style: null });
  useEffect(() => subscribeCharacterSheet(assetId, setSnap), [assetId]);

  if (snap.inFlight > 0) {
    return (
      <div
        className="absolute top-1.5 right-1.5 flex items-center justify-center w-6 h-6 z-10"
        style={{
          background: "rgba(0,0,0,0.65)",
          border: `1px solid ${KR_BORDER}`,
          borderRadius: 2,
        }}
        title={t(snap.style === "board"
          ? "assets.characterSheet.generatingBoard"
          : "assets.characterSheet.generating")}
      >
        <Loader2 className="w-3 h-3 animate-spin" style={{ color: "#fca5a5" }} />
      </div>
    );
  }
  if (snap.error) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRetry();
        }}
        className="absolute top-1.5 right-1.5 flex items-center justify-center w-6 h-6 z-10"
        style={{
          background: "rgba(0,0,0,0.65)",
          border: "1px solid rgba(220,38,38,0.45)",
          borderRadius: 2,
        }}
        title={`${t("assets.characterSheet.error")}\n${snap.error}`}
      >
        <AlertCircle className="w-3 h-3" style={{ color: "#fca5a5" }} />
      </button>
    );
  }
  if (hasSheet) {
    return (
      <div
        className="absolute top-1.5 right-1.5 flex items-center justify-center w-6 h-6 z-10"
        style={{
          background: "rgba(0,0,0,0.55)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 2,
        }}
        title={t("assets.characterSheet.done")}
      >
        <LayoutGrid className="w-3 h-3" style={{ color: "rgba(255,255,255,0.75)" }} />
      </div>
    );
  }
  return null;
};

/* ????????????????????????????????????????
   Main Component
???????????????????????????????????????? */
export const AssetsTab = ({ projectId, initialAssetType, onSwitchToAgent }: Props) => {
  const { toast } = useToast();
  const t = useT();
  const isMobile = useIsMobile();

  const [assets, setAssets] = useState<Asset[]>([]);
  const [sceneCounts, setSceneCounts] = useState<Record<string, number>>({});
  const [activeType, setActiveType] = useState<AssetType>(
    initialAssetType && ASSET_TYPES.has(initialAssetType) ? (initialAssetType as AssetType) : "character",
  );
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
  const [focalPoints, setFocalPoints] = useState<Record<string, FocalPoint>>({});
  const [editingFocalId, setEditingFocalId] = useState<string | null>(null);

  const [assetType, setAssetType] = useState<AssetType>("character");
  const [tagName, setTagName] = useState("");
  const [sourceMode, setSourceMode] = useState<"upload" | "ai">("upload");
  // Character-only reference-sheet toggle. `initialSheetMode` snapshots
  // what the asset looked like when the modal opened so handleSave can
  // decide whether to actually fire a generation: e.g. opening an asset
  // that already has a sheet should NOT auto-regenerate when the user
  // saves with no other changes — we only re-run when the user toggled
  // the radio on, replaced the photo, or it's a brand-new character.
  // `userTouchedSheetMode` flips the first time the user clicks a sheet
  // radio so the AI-portrait auto-default below stops fighting their
  // explicit choice.
  const [sheetMode, setSheetMode] = useState<SheetMode>("fast");
  const [initialSheetMode, setInitialSheetMode] = useState<SheetMode>("fast");
  const [userTouchedSheetMode, setUserTouchedSheetMode] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [aiInput, setAiInput] = useState("");
  const [aiDescription, setAiDescription] = useState("");
  const [outfitDescription, setOutfitDescription] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [spaceDescription, setSpaceDescription] = useState("");
  const [itemDescription, setItemDescription] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [generatedPortraitUrl, setGeneratedPortraitUrl] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const getFocal = (id: string): FocalPoint => focalPoints[id] ?? { x: 50, y: 25, scale: 1.4 };
  const saveFocal = async (id: string, p: FocalPoint) => {
    // Optimistic local update keeps the UI snappy; the DB write below is awaited
    // only to surface errors (swallowed previously by `.then(() => {})`, which
    // is why users reported the crop reverting to default on refresh).
    const next = { ...focalPoints, [id]: p };
    setFocalPoints(next);
    try {
      const { error } = await supabase.from("assets").update({ photo_crop: p as any }).eq("id", id);
      if (error) {
        console.error("[AssetsTab] saveFocal update failed:", error);
        toast({
          title: t("assets.focalSaveFailed"),
          description: typeof error === "object" && error && "message" in error ? String((error as any).message) : String(error),
          variant: "destructive",
        });
      }
    } catch (e) {
      console.error("[AssetsTab] saveFocal threw:", e);
      toast({
        title: t("assets.focalSaveFailed"),
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  const fetchAssets = useCallback(async () => {
    const { data, error } = await supabase
      .from("assets")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });
    if (error) {
      console.warn("[AssetsTab] fetchAssets skipped after transient read error:", error.message);
      return;
    }
    if (data) {
      setAssets((data as Asset[]).map((a) => ({ ...a, asset_type: a.asset_type ?? "character" })));
      const fp: Record<string, FocalPoint> = {};
      data.forEach((a: any) => {
        if (a.photo_crop && typeof a.photo_crop === "object") fp[a.id] = a.photo_crop as FocalPoint;
      });
      if (Object.keys(fp).length) setFocalPoints((prev) => ({ ...fp, ...prev }));
    }
  }, [projectId]);

  /* ??? ? ??? ? ?? ?? ?? + ?? ?? 1? ??? */
  const fetchSceneCounts = useCallback(async () => {
    // 1. ????? active_version_id ??
    const { data: projectData, error: projectError } = await supabase
      .from("projects")
      .select("active_version_id")
      .eq("id", projectId)
      .single();
    if (projectError) {
      console.warn("[AssetsTab] fetchSceneCounts skipped after project read error:", projectError.message);
      return;
    }

    let rawScenes: Array<{ tagged_assets?: string[] }> = [];

    if (projectData?.active_version_id) {
      // 2. ?? ?? ????? scenes JSONB ??
      const { data: versionData, error: versionError } = await supabase
        .from("scene_versions")
        .select("scenes")
        .eq("id", projectData.active_version_id)
        .single();
      if (versionError) {
        console.warn("[AssetsTab] fetchSceneCounts skipped after version read error:", versionError.message);
        return;
      }
      if (versionData?.scenes && Array.isArray(versionData.scenes)) {
        rawScenes = versionData.scenes as Array<{ tagged_assets?: string[] }>;
      }
    }

    // 3. ??: scenes ??? ?? ?? (?? ?? ??? ??? ?? ?)
    if (rawScenes.length === 0) {
      const { data: scenesData, error: scenesError } = await supabase.from("scenes").select("tagged_assets").eq("project_id", projectId);
      if (scenesError) {
        console.warn("[AssetsTab] fetchSceneCounts skipped after scenes read error:", scenesError.message);
        return;
      }
      rawScenes = scenesData ?? [];
    }

    // 4. ?? ?? ??? ? ? ?? ?? ??? ?? ? ??? 1? ??
    const counts: Record<string, number> = {};
    rawScenes.forEach((scene) => {
      const uniqueTags = new Set<string>(scene.tagged_assets ?? []);
      uniqueTags.forEach((tag) => {
        counts[tag] = (counts[tag] ?? 0) + 1;
      });
    });
    setSceneCounts(counts);
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 라이브러리에서 cross-workspace 로 승격된 에셋은 워크스페이스 전환 직후
      // 이 DB(=프로젝트 워크스페이스)에 아직 insert 되지 않았다. mount 시 큐를
      // drain 해 실제로 row 를 만든 뒤 목록을 읽는다.
      try {
        const n = await drainPendingPromotes(projectId);
        if (!cancelled && n > 0) {
          toast({
            title: t("assets.promotedFromLibrary"),
            description: t("assets.promotedFromLibraryDesc", { n }),
          });
        }
      } catch (err) {
        console.warn("[AssetsTab] drainPendingPromotes failed:", err);
      }
      if (cancelled) return;
      fetchAssets();
      fetchSceneCounts();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchAssets, fetchSceneCounts, projectId, toast, t]);

  // AI-portrait → sheet pre-selection (Phase 3 §1).
  // When a NEW character is being built and the user picks the AI
  // generation path, default the reference-sheet radio to "with-sheet".
  // Rationale:
  //   1. AI portrait flows are already a 30-60s wait, so adding the
  //      sheet's ~1min cost is a small marginal step rather than a
  //      surprise blocker.
  //   2. AI portraits have unstable identity across angles by default,
  //      so the sheet's value-per-second is highest exactly here.
  //   3. We never override the user's explicit choice — the moment
  //      they click either sheet radio button, `userTouchedSheetMode`
  //      flips to true and this effect becomes a no-op.
  // Edits leave the persisted sheet mode untouched; openEditModal sets
  // `userTouchedSheetMode = true` precisely to gate this effect off.
  useEffect(() => {
    if (editingAsset) return;
    if (userTouchedSheetMode) return;
    if (assetType !== "character") return;
    if (sourceMode === "ai" && sheetMode !== "with-sheet") {
      setSheetMode("with-sheet");
    }
  }, [sourceMode, assetType, editingAsset, userTouchedSheetMode, sheetMode]);

  // Live merge of background-variation work that happens out-of-band:
  //   - `preflow:asset-created` fires once per sibling spawned from the
  //     AssetDetailModal's "Generate Camera Framings" buttons (or from
  //     the legacy photo_variations migration). We append the new row
  //     to `assets` so it appears in the grid immediately and so the
  //     modal's sibling chip list reconciles without a refetch.
  //   - `preflow:asset-variations-updated` still fires during legacy
  //     migration to clear a parent's stale `photo_variations` array.
  //     We patch the in-memory cache so the migration banner stops
  //     retriggering.
  useEffect(() => {
    const onAssetCreated = (e: Event) => {
      const ce = e as CustomEvent<Asset>;
      const created = ce.detail;
      if (!created || !created.id) return;
      setAssets((prev) => (prev.some((a) => a.id === created.id) ? prev : [...prev, created]));
    };
    const onVariationsUpdated = (e: Event) => {
      const ce = e as CustomEvent<{ assetId: string; variations: PhotoVariation[] }>;
      const detail = ce.detail;
      if (!detail || !detail.assetId) return;
      setAssets((prev) =>
        prev.map((a) =>
          a.id === detail.assetId ? { ...a, photo_variations: detail.variations } : a,
        ),
      );
      setPreviewAsset((p) =>
        p && p.id === detail.assetId ? { ...p, photo_variations: detail.variations } : p,
      );
    };
    // `preflow:asset-updated` is broadcast by characterSheetStore when a
    // background sheet generation finishes. We patch the in-memory list
    // (and the active preview) so the badge flips to done and the conti
    // pipeline picks up the new URL on next generation without a
    // refetch round-trip.
    const onAssetUpdated = (e: Event) => {
      const ce = e as CustomEvent<Asset>;
      const updated = ce.detail;
      if (!updated || !updated.id) return;
      setAssets((prev) =>
        prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)),
      );
      setPreviewAsset((p) =>
        p && p.id === updated.id ? { ...p, ...updated } : p,
      );
    };
    window.addEventListener("preflow:asset-created", onAssetCreated as EventListener);
    window.addEventListener(
      "preflow:asset-variations-updated",
      onVariationsUpdated as EventListener,
    );
    window.addEventListener("preflow:asset-updated", onAssetUpdated as EventListener);
    return () => {
      window.removeEventListener("preflow:asset-created", onAssetCreated as EventListener);
      window.removeEventListener(
        "preflow:asset-variations-updated",
        onVariationsUpdated as EventListener,
      );
      window.removeEventListener("preflow:asset-updated", onAssetUpdated as EventListener);
    };
  }, []);

  const resetForm = () => {
    setTagName("");
    setSourceMode("upload");
    setPhotoFile(null);
    setPhotoPreview(null);
    setAiInput("");
    setAiDescription("");
    setOutfitDescription("");
    setRoleDescription("");
    setSpaceDescription("");
    setItemDescription("");
    setEditingAsset(null);
    setGeneratedPortraitUrl(null);
    setAssetType(activeType);
    setSheetMode("fast");
    setInitialSheetMode("fast");
    setUserTouchedSheetMode(false);
  };

  const openCreateModal = () => {
    resetForm();
    setAssetType(activeType);
    setModalOpen(true);
  };

  const openEditModal = (asset: Asset) => {
    setEditingAsset(asset);
    setAssetType(asset.asset_type ?? "character");
    setTagName(asset.tag_name);
    setSourceMode(asset.source_type === "ai" ? "ai" : "upload");
    setPhotoPreview(asset.photo_url);
    setAiDescription(asset.ai_description ?? "");
    setOutfitDescription(asset.outfit_description ?? "");
    setRoleDescription(asset.role_description ?? "");
    setSpaceDescription(asset.space_description ?? "");
    setItemDescription(asset.ai_description ?? "");
    setGeneratedPortraitUrl(asset.source_type === "ai" ? asset.photo_url : null);
    // If the asset already has a generated sheet, reflect that in the
    // toggle so the user sees the existing state. handleSave guards
    // against accidental regeneration unless the photo or toggle was
    // explicitly changed.
    const hasSheet = !!asset.character_sheet_url;
    const mode: SheetMode = hasSheet ? "with-sheet" : "fast";
    setSheetMode(mode);
    setInitialSheetMode(mode);
    // Treat the persisted state as the user's explicit choice — the
    // AI-portrait auto-default below should not flip an existing
    // edit's sheet mode just because the source happens to be AI.
    setUserTouchedSheetMode(true);
    setModalOpen(true);
  };

  const handlePhotoFile = (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: t("assets.maxFileSize"), variant: "destructive" });
      return;
    }
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  const handleAutoAnalyze = async (targetUrl: string, file?: File | null) => {
    setIsAnalyzing(true);
    try {
      let base64: string,
        mediaType = "image/jpeg";
      if (file) {
        base64 = await fileToBase64(file);
        mediaType = detectMediaType(base64);
      } else {
        const r = await urlToBase64(targetUrl);
        base64 = r.base64;
        mediaType = r.mediaType;
      }
      const result = await callVisionAnalyze(base64, mediaType, assetType);
      if (assetType === "character" && result.outfit) setOutfitDescription(result.outfit);
      if (assetType === "item" && result.description) setItemDescription(result.description);
      if (assetType === "background" && result.description) setSpaceDescription(result.description);
      if (!result.outfit && !result.description)
        toast({
          title: t("assets.noAnalysisResult"),
          description: t("assets.noAnalysisDesc"),
          variant: "destructive",
        });
    } catch (e: any) {
      toast({ title: t("assets.imageAnalysisFailed"), description: e.message, variant: "destructive" });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleGenerateAiDescription = async () => {
    if (!aiInput.trim()) return;
    setIsGenerating(true);
    try {
      const data = await callClaude({
        model: "claude-sonnet-4-6",
        max_tokens: 512,
        system: "??? ?? ?? ??? ?? ?? ??? ??????.",
        messages: [
          {
            role: "user",
            content: `?? ?? ??? ???? ?? ?? ?? ??? ??? ??? ??? ?? ??? ??? ??????.\n??(???, ???, ?????, ??? ??), ??, ???? ????? ?????. ??? ?? ???? ?????? ?????.\n??? ???? ?????:\n\n[??]: ${aiInput}`,
          },
        ],
      });
      setAiDescription(data.content[0].text);
    } catch (err: any) {
      toast({ title: t("assets.aiDescriptionFailed"), description: err.message, variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGeneratePortrait = async () => {
    if (!aiDescription.trim()) return;
    setIsGeneratingImage(true);
    try {
      const fullDesc = [aiDescription, outfitDescription ? `Outfit: ${outfitDescription}` : ""]
        .filter(Boolean)
        .join("\n");
      const prompt =
        sanitizeImagePrompt(
          `Portrait photo of a person for commercial advertisement.\n${fullDesc}\n\nStyle: Professional casting photo, clean background, soft studio lighting, looking at camera, upper body shot. Photorealistic.\nNo text, no watermarks.`,
        ) + "\n\nSafe for all audiences.";
      const { data, error } = await supabase.functions.invoke("openai-image", {
        body: { prompt, projectId, sceneNumber: `asset-${tagName || "char"}-${Date.now()}`, imageSize: "1024x1024" },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error?.message ?? "Image generation failed");
      setGeneratedPortraitUrl(data.publicUrl);
    } catch (e: any) {
      toast({ title: t("assets.imageGenerationFailed"), description: e.message, variant: "destructive" });
    } finally {
      setIsGeneratingImage(false);
    }
  };

  const handleSave = async () => {
    if (!tagName.trim()) return;
    setIsSaving(true);
    try {
      let photoUrl = editingAsset?.photo_url ?? null;
      if (photoFile && sourceMode === "upload") {
        const safeName = photoFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const fileName = `${projectId}/${Date.now()}-${safeName}`;
        const { error: uploadError } = await supabase.storage
          .from("assets")
          .upload(fileName, photoFile, { contentType: photoFile.type, upsert: true });
        if (uploadError) throw uploadError;
        photoUrl = supabase.storage.from("assets").getPublicUrl(fileName).data.publicUrl;
      }
      if (sourceMode === "ai" && generatedPortraitUrl) photoUrl = generatedPortraitUrl;
      const record = {
        project_id: projectId,
        asset_type: assetType,
        tag_name: tagName.trim(),
        photo_url: photoUrl,
        source_type: assetType === "character" ? sourceMode : "upload",
        ai_description:
          assetType === "character"
            ? sourceMode === "ai"
              ? aiDescription
              : null
            : assetType === "item"
              ? itemDescription.trim() || null
              : null,
        outfit_description: assetType === "character" ? outfitDescription.trim() || null : null,
        role_description: assetType === "character" ? roleDescription.trim() || null : null,
        signature_items: null,
        space_description: assetType === "background" ? spaceDescription.trim() || null : null,
      };
      let savedAsset: Asset | null = null;
      if (editingAsset) {
        const { data: updated } = await supabase
          .from("assets")
          .update(record)
          .eq("id", editingAsset.id)
          .select()
          .single();
        savedAsset = (updated as Asset) ?? null;
      } else {
        const { data: inserted } = await supabase
          .from("assets")
          .insert(record)
          .select()
          .single();
        savedAsset = (inserted as Asset) ?? null;
      }

      // Background reference-sheet generation. Fire only when the user
      // explicitly opted into "with-sheet" AND something material
      // happened that warrants regeneration:
      //   · brand-new asset, OR
      //   · the asset has no sheet yet, OR
      //   · the photo file or AI portrait was just replaced, OR
      //   · the user toggled the radio from "fast" → "with-sheet".
      // We fire-and-forget so the modal can close immediately. The
      // store handles concurrency (short-circuits duplicate starts) and
      // surfaces progress/errors via the per-asset subscription that
      // CharacterSheetBadge renders on the card.
      const sheetTriggerableAsset =
        savedAsset &&
        savedAsset.id &&
        savedAsset.photo_url &&
        (savedAsset.asset_type ?? "character") === "character";
      const photoReplaced = !!photoFile || (sourceMode === "ai" && !!generatedPortraitUrl);
      // Registration only ever auto-generates the turnaround SHEET. The
      // AAA board is a deliberate "develop" step in the detail modal.
      const shouldStartSheet =
        sheetTriggerableAsset &&
        sheetMode === "with-sheet" &&
        (!editingAsset ||
          !editingAsset.character_sheet_url ||
          photoReplaced ||
          initialSheetMode === "fast");
      if (shouldStartSheet && savedAsset) {
        void startCharacterSheet({
          id: savedAsset.id,
          project_id: savedAsset.project_id,
          tag_name: savedAsset.tag_name,
          photo_url: savedAsset.photo_url,
          ai_description: savedAsset.ai_description,
          outfit_description: savedAsset.outfit_description,
          role_description: savedAsset.role_description,
          style: "sheet",
        });
      }

      setModalOpen(false);
      resetForm();
      await fetchAssets();
      toast({ title: editingAsset ? t("assets.updatedToast") : t("assets.registeredToast", { type: t(`assets.${assetType}`) }) });
    } catch (err: any) {
      toast({ title: t("assets.saveFailed"), description: err.message, variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const handleDelete = async (id: string) => {
    const target = assets.find((a) => a.id === id);
    const urls: Array<string | null | undefined> = [];
    if (target) {
      urls.push(target.photo_url);
      if (Array.isArray(target.photo_variations)) {
        for (const v of target.photo_variations) urls.push(v?.url);
      }
      // Generated character sheet lives on its own URL — without this
      // line, deleting the asset would leak the sheet file as orphan
      // storage that orphanSweep would later have to GC.
      urls.push(target.character_sheet_url);
    }
    await supabase.from("assets").delete().eq("id", id);
    await deleteStoredFiles(urls);
    // 라이브러리에서 승격된 에셋이면(source_reference_id 보유) LS 추적에서 이
    // assetId 를 제거 → 그 ref 로 만든 마지막 에셋이면 라이브러리 인스펙터의
    // 에셋 연결/카운트가 자연스럽게 끊긴다(cross-workspace 안전).
    const sourceReferenceId = (target as { source_reference_id?: string | null } | undefined)?.source_reference_id;
    if (sourceReferenceId) removePromotedAssetUsage(projectId, sourceReferenceId, id);
    await fetchAssets();
    toast({ title: t("assets.deleteToast") });
    setDeleteTarget(null);
  };

  const filteredAssets = assets.filter((a) => (a.asset_type ?? "character") === activeType);
  const typeCounts = {
    character: assets.filter((a) => (a.asset_type ?? "character") === "character").length,
    item: assets.filter((a) => a.asset_type === "item").length,
    background: assets.filter((a) => a.asset_type === "background").length,
  };

  /* ?? ?? ?? ?? ?? */
  const renderActions = (asset: Asset) => (
    // Equal top/bottom padding centers the icons between the divider line
    // and the card's bottom edge (containers drop their own bottom padding).
    <div className="flex items-center justify-end gap-0.5 py-2 border-t border-border">
      <button
        onClick={(e) => {
          e.stopPropagation();
          openEditModal(asset);
        }}
        className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        style={{ borderRadius: 3 }}
      >
        <Edit2 className="w-3 h-3" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setDeleteTarget(asset.id);
        }}
        className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
        style={{ borderRadius: 3 }}
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );

  /* ?? ? ??? ?? ?? */
  const SceneCount = ({ tagName }: { tagName: string }) => {
    const count = sceneCounts[tagName] ?? 0;
    return (
      <span className="text-2xs text-muted-foreground/40">
        {count} {t(count === 1 ? "assets.scene" : "assets.scenes")}
      </span>
    );
  };

  /* ?? ?? ?? ?? */
  const renderCard = (asset: Asset) => {
    /* ??? ? ?? ?? ?? ?? */
    if (asset.asset_type === "character" || !asset.asset_type) {
      // Reflect the conti reference mode (원본/시트/보드) in the thumbnail.
      const refUrl = pickCharacterRefUrl(asset) ?? asset.photo_url;
      const isOriginal = refUrl === asset.photo_url;
      return (
        <div
          key={asset.id}
          className="border border-border bg-card overflow-hidden hover:border-primary/30 transition-all group cursor-pointer"
          style={{ borderRadius: 0 }}
          onClick={() => setPreviewAsset(asset)}
        >
          <div className="relative">
            <SquareAvatar
              url={refUrl}
              // Original keeps the round portrait frame (with focal crop);
              // sheet/board fill the whole 16:9 thumbnail area edge-to-edge.
              variant={isOriginal ? "circle" : "fill"}
              focal={isOriginal ? getFocal(asset.id) : { x: 50, y: 50, scale: 1 }}
              name={asset.tag_name}
            />
            <CharacterSheetBadge
              assetId={asset.id}
              hasSheet={!!asset.character_sheet_url}
              onRetry={() => {
                if (!asset.photo_url) return;
                void startCharacterSheet({
                  id: asset.id,
                  project_id: asset.project_id,
                  tag_name: asset.tag_name,
                  photo_url: asset.photo_url,
                  ai_description: asset.ai_description,
                  outfit_description: asset.outfit_description,
                  role_description: asset.role_description,
                  style: "sheet",
                });
              }}
            />
            {/* ?? ?? ?? ? 6? ?? — focal crop only applies to the round original frame */}
            {asset.photo_url && isOriginal && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingFocalId(asset.id);
                }}
                className="absolute bottom-2 left-1/2 -translate-x-1/2 w-5 h-5 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-md z-10"
                style={{ background: KR }}
                title={t("assets.adjustFocalPoint")}
              >
                <Move className="w-2.5 h-2.5 text-white" />
              </button>
            )}
          </div>
          <div className="px-3 pt-4 pb-0 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-caption font-bold" style={{ color: KR }}>
                @{asset.tag_name}
              </span>
              <SceneCount tagName={asset.tag_name} />
            </div>
            {asset.role_description && (
              <div className="flex items-start gap-1.5">
                <User className="w-3 h-3 shrink-0 mt-0.5 text-muted-foreground" />
                <span className="text-caption text-muted-foreground leading-snug line-clamp-1">
                  {asset.role_description}
                </span>
              </div>
            )}
            {asset.outfit_description && (
              <div className="flex items-start gap-1.5">
                <Shirt className="w-3 h-3 shrink-0 mt-0.5 text-muted-foreground" />
                <span className="text-caption text-muted-foreground leading-snug line-clamp-2">
                  {asset.outfit_description}
                </span>
              </div>
            )}
            {!asset.role_description && !asset.outfit_description && (
              <p className="text-caption text-muted-foreground/30">{t("assets.noOutfitInfo")}</p>
            )}
            {renderActions(asset)}
          </div>
        </div>
      );
    }

    /* ??? */
    if (asset.asset_type === "item") {
      // Reflect the conti reference mode (원본/시트/보드) in the thumbnail,
      // same as characters. All of them are shown un-cropped (object-contain)
      // inside the card so the original's aspect ratio isn't clipped.
      const refUrl = pickCharacterRefUrl(asset) ?? asset.photo_url;
      return (
        <div
          key={asset.id}
          className="border border-border bg-card overflow-hidden hover:border-primary/30 transition-all group cursor-pointer"
          style={{ borderRadius: 0 }}
          onClick={() => setPreviewAsset(asset)}
        >
          <div className="relative aspect-video bg-background overflow-hidden">
            {refUrl ? (
              <img
                src={refUrl}
                className="w-full h-full object-contain"
                alt={asset.tag_name}
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <Package className="w-8 h-8 text-muted-foreground/20" />
              </div>
            )}
            <CharacterSheetBadge
              assetId={asset.id}
              hasSheet={!!asset.character_sheet_url}
              onRetry={() => {
                if (!asset.photo_url) return;
                void startCharacterSheet({
                  id: asset.id,
                  project_id: asset.project_id,
                  tag_name: asset.tag_name,
                  photo_url: asset.photo_url,
                  ai_description: asset.ai_description,
                  outfit_description: asset.outfit_description,
                  role_description: asset.role_description,
                  style: "sheet",
                  kind: "item",
                });
              }}
            />
          </div>
          <div className="px-3 pt-4 pb-0 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-caption font-bold" style={{ color: KR }}>
                @{asset.tag_name}
              </span>
              <SceneCount tagName={asset.tag_name} />
            </div>
            {asset.ai_description ? (
              <p className="text-caption text-muted-foreground leading-snug line-clamp-1">{asset.ai_description}</p>
            ) : (
              <p className="text-caption text-muted-foreground/30">{t("assets.noDescription")}</p>
            )}
            {renderActions(asset)}
          </div>
        </div>
      );
    }

    /* Background card */
    {
      // Count sibling background assets spawned off this one via the
      // "Generate Camera Framings" action. Matches `{parent}_{framing}`
      // and `{parent}_{framing}_<n>` against the framing vocabulary.
      const parentTag = asset.tag_name.replace(/^@/, "");
      const siblingPattern = new RegExp(
        `^${parentTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(wide|medium|close|detail)(?:_\\d+)?$`,
      );
      const siblingCount = assets.reduce((n, a) => {
        if (a.id === asset.id) return n;
        if (a.asset_type !== "background") return n;
        return siblingPattern.test(a.tag_name.replace(/^@/, "")) ? n + 1 : n;
      }, 0);
      // Legacy photo_variations (migrated on next modal-open) still count
      // toward the badge so users aren't confused by an empty badge on
      // pre-migration projects.
      const legacyVariationCount = Array.isArray(asset.photo_variations)
        ? asset.photo_variations.length
        : 0;
      const variationCount = siblingCount + legacyVariationCount;
      // Reflect the selected reference (원본/보드) in the thumbnail, like
      // characters/items. Original fills the card; board is shown un-cropped.
      const refUrl = pickCharacterRefUrl(asset) ?? asset.photo_url;
      const isOriginal = refUrl === asset.photo_url;
      return (
        <div
          key={asset.id}
          className="border border-border bg-card overflow-hidden hover:border-primary/30 transition-all group cursor-pointer"
          style={{ borderRadius: 0 }}
          onClick={() => setPreviewAsset(asset)}
        >
          <div className="relative aspect-video bg-background overflow-hidden">
            {refUrl ? (
              <img
                src={refUrl}
                className={`w-full h-full ${isOriginal ? "object-cover" : "object-contain"}`}
                alt={asset.tag_name}
                loading="lazy"
                decoding="async"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <MapPin className="w-8 h-8 text-muted-foreground/20" />
              </div>
            )}
            {/* Board generation status badge (top-right) — mirrors characters/
                items so the user can tell whether a board is generating. */}
            <CharacterSheetBadge
              assetId={asset.id}
              hasSheet={!!asset.character_board_url}
              onRetry={() => {
                if (!asset.photo_url) return;
                void startCharacterSheet({
                  id: asset.id,
                  project_id: asset.project_id,
                  tag_name: asset.tag_name,
                  photo_url: asset.photo_url,
                  ai_description: asset.space_description ?? null,
                  outfit_description: null,
                  role_description: null,
                  style: "board",
                  kind: "background",
                });
              }}
            />
            {/* Camera framings indicator — moved to the TOP-LEFT so it no
                longer collides with the board status badge (top-right).
                Shows the number of sibling framing assets generated off this
                parent. Visible at 0 too so users discover the feature. Hidden
                on siblings themselves (their tag already matches the pattern). */}
            {asset.photo_url && !siblingPattern.test(parentTag) && (
              <div
                className="absolute top-1.5 left-1.5 flex items-center gap-1 px-1.5 py-0.5"
                style={{
                  background: variationCount > 0 ? "rgba(0,0,0,0.65)" : "rgba(0,0,0,0.45)",
                  borderRadius: 0,
                  border: variationCount > 0 ? `1px solid ${KR_BORDER}` : "1px solid rgba(255,255,255,0.12)",
                }}
                title={
                  variationCount === 0
                    ? t("assets.clickGenerateFramings")
                    : t("assets.framingsGenerated", { count: variationCount })
                }
              >
                <Camera
                  className="w-3 h-3"
                  style={{ color: variationCount > 0 ? KR : "rgba(255,255,255,0.55)" }}
                />
                <span
                  className="text-caption font-bold leading-none"
                  style={{ color: variationCount > 0 ? KR : "rgba(255,255,255,0.55)" }}
                >
                  {variationCount}
                </span>
              </div>
            )}
          </div>
        <div className="px-3 pt-4 pb-0 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-caption font-bold" style={{ color: KR }}>
              @{asset.tag_name}
            </span>
            <SceneCount tagName={asset.tag_name} />
          </div>
          {asset.space_description ? (
            <p className="text-caption text-muted-foreground leading-snug line-clamp-1">{asset.space_description}</p>
          ) : (
            <p className="text-caption text-muted-foreground/30">{t("assets.noDescription")}</p>
          )}
          {renderActions(asset)}
        </div>
      </div>
    );
    }
  };

  /* ????????????????????????????????????????
     JSX
  ???????????????????????????????????????? */
  return (
    <div className="h-full overflow-y-auto">
      {/* ?? ?? ?? */}
      <div className="flex items-center justify-between border-b border-white/[0.08] px-5 pt-4">
        {/* ?? ? */}
        <div className="flex items-stretch gap-0">
          {(["character", "item", "background"] as AssetType[]).map((type) => {
            const isActive = activeType === type;
            return (
              <button
                key={type}
                onClick={() => setActiveType(type)}
                className="flex items-center gap-1.5 px-4 py-2 text-caption font-medium tracking-wider transition-colors"
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: isActive ? KR : "rgba(255,255,255,0.3)",
                  boxShadow: isActive ? `inset 0 -2px 0 ${KR}` : "none",
                }}
              >
                {TYPE_META[type].icon}
                {t(`assets.${type}`)}
                <span
                  className="font-mono text-micro px-1.5 py-0.5 ml-0.5"
                  style={{
                    borderRadius: 2,
                    background: isActive ? "rgba(249,66,58,0.15)" : "rgba(255,255,255,0.05)",
                    color: isActive ? KR : "rgba(255,255,255,0.3)",
                  }}
                >
                  {typeCounts[type]}
                </span>
              </button>
            );
          })}
        </div>
        {/* ?? ?? */}
        <div className="flex items-center gap-2 pb-2">
          <Button
            onClick={openCreateModal}
            className="gap-1.5 text-white text-caption font-medium tracking-wider h-8 px-3"
            style={{ background: filteredAssets.length === 0 ? "rgba(255,255,255,0.06)" : KR, color: filteredAssets.length === 0 ? "rgba(255,255,255,0.35)" : "#fff", borderRadius: 0 }}
          >
            <Plus className="w-3.5 h-3.5" />
            {t(activeType === "character" ? "assets.addCharacter" : activeType === "item" ? "assets.addItem" : "assets.addBackground")}
          </Button>
          {onSwitchToAgent && (() => {
            const hasAssets = assets.length > 0;
            return (
              <Button
                onClick={onSwitchToAgent}
                title={
                  hasAssets
                    ? undefined
                    : "?? ??? ???? ?? ??? ??? ? ???"
                }
                className="gap-1.5 text-caption font-medium tracking-wider border-none h-8 px-3"
                style={
                  hasAssets
                    ? { background: "rgba(249,66,58,0.1)", color: KR, borderRadius: 0 }
                    : {
                        background: "hsl(var(--muted))",
                        color: "hsl(var(--muted-foreground))",
                        borderRadius: 0,
                      }
                }
              >
                {t("assets.goToIdeation")}
                <ArrowRight className="w-3 h-3" />
              </Button>
            );
          })()}
        </div>
      </div>

      {/* ?? ??? ?? */}
      <div className="p-6">
        {filteredAssets.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[300px]">
            {TYPE_META[activeType].emptyIcon}
            <p className="text-meta font-bold tracking-wider text-muted-foreground/40 mt-2">
              {t(activeType === "character" ? "assets.noCharacters" : activeType === "item" ? "assets.noItems" : "assets.noBackgrounds")}
            </p>
            <p className="font-mono text-2xs text-muted-foreground/25 mt-1 text-center max-w-[320px]">
              {t(activeType === "character" ? "assets.emptyCharacter" : activeType === "item" ? "assets.emptyItem" : "assets.emptyBackground")}
            </p>
            <Button
              onClick={openCreateModal}
              className="mt-4 gap-1.5 text-white text-caption font-medium tracking-wider h-8 px-3"
              style={{ background: KR, borderRadius: 0 }}
            >
              <Plus className="w-3.5 h-3.5" />
              {t(activeType === "character" ? "assets.addCharacter" : activeType === "item" ? "assets.addItem" : "assets.addBackground")}
            </Button>
          </div>
        ) : (
          <div className={`grid gap-3 ${isMobile ? "grid-cols-2" : TYPE_META[activeType].gridCols}`}>
            {filteredAssets.map(renderCard)}
          </div>
        )}
      </div>

      {/* ?? Focal editor ?? */}
      {editingFocalId &&
        (() => {
          const a = assets.find((x) => x.id === editingFocalId);
          if (!a?.photo_url) return null;
          return (
            <FocalEditor
              url={a.photo_url}
              initial={getFocal(editingFocalId)}
              onSave={(p) => saveFocal(editingFocalId, p)}
              onClose={() => setEditingFocalId(null)}
            />
          );
        })()}

      {/* Asset preview modal */}
      {previewAsset && (
        <AssetDetailModal
          asset={previewAsset}
          sceneCount={sceneCounts[previewAsset.tag_name] ?? 0}
          onClose={() => setPreviewAsset(null)}
          allAssets={assets}
          onAssetCreated={(newAsset) => {
            // Append the freshly inserted background asset so the grid
            // reflects it immediately without a full refetch round-trip.
            // (The `preflow:asset-created` broadcast handler also
            // dedupes by id, so callers that also dispatch the event
            // don't double-add.)
            setAssets((prev) =>
              prev.some((a) => a.id === newAsset.id)
                ? prev
                : [
                    ...prev,
                    { ...newAsset, asset_type: newAsset.asset_type ?? "background" },
                  ],
            );
            // Switch to the Background tab so the user sees the new tile
            // they just created (avoids the "did anything happen?" beat
            // when they were viewing a different asset type's modal).
            setActiveType("background");
          }}
          onSwitchAsset={(nextAsset) => {
            setPreviewAsset(nextAsset);
          }}
        />
      )}

      {/* ?? ??/?? ?? ?? */}
      <Dialog
        open={modalOpen}
        onOpenChange={(open) => {
          if (!open) {
            setModalOpen(false);
            resetForm();
          }
        }}
      >
        <DialogContent
          size="md"
          className="max-h-[90vh] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>
              {editingAsset ? t("assets.editAsset") : t("assets.newAsset")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-5">
            {!editingAsset && (
              <div>
                <label className="label-meta text-muted-foreground mb-1.5 block">{t("assets.type")}</label>
                <div className="flex gap-2">
                  {(["character", "item", "background"] as AssetType[]).map((type) => (
                    <button
                      key={type}
                      onClick={() => setAssetType(type)}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 border text-caption font-medium tracking-wider transition-colors"
                      style={{
                        borderRadius: 0,
                        borderColor: assetType === type ? KR : "rgba(255,255,255,0.07)",
                        background: assetType === type ? "rgba(249,66,58,0.08)" : "transparent",
                        color: assetType === type ? KR : "rgba(255,255,255,0.4)",
                      }}
                    >
                      {TYPE_META[type].icon}
                      {t(`assets.${type}`)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="flex items-baseline gap-2 mb-1.5">
                <label className="label-meta text-muted-foreground block">{t("assets.tag")}</label>
                <span className="text-caption text-muted-foreground/60">
                  {t("assets.tagMention")}
                </span>
              </div>
              <div className="flex items-center">
                <span
                  className="h-10 px-3 flex items-center border border-r-0 border-input text-sm font-semibold"
                  style={{ background: KR_BG, color: KR, borderRadius: 0 }}
                >
                  @
                </span>
                <Input value={tagName} onChange={(e) => setTagName(e.target.value)} className="rounded-l-none" />
              </div>
            </div>

            {assetType === "character" && (
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">{t("assets.visualSource")}</label>
                <div className="flex gap-2">
                  {[
                    {
                      mode: "upload" as const,
                      icon: <Camera className="w-4 h-4 shrink-0" />,
                      label: t("assets.uploadPhoto"),
                    },
                    {
                      mode: "ai" as const,
                      icon: <Sparkles className="w-4 h-4 shrink-0" />,
                      label: t("assets.aiGenerated"),
                    },
                  ].map(({ mode, icon, label }) => (
                    <button
                      key={mode}
                      onClick={() => setSourceMode(mode)}
                      className="flex-1 flex items-center justify-center gap-2 px-3 h-10 border transition-colors"
                      style={{
                        borderRadius: 0,
                        borderColor: sourceMode === mode ? KR : "var(--border)",
                        background: sourceMode === mode ? KR_BG : "transparent",
                      }}
                    >
                      <span style={{ color: sourceMode === mode ? KR : "var(--muted-foreground)" }}>{icon}</span>
                      <span
                        className="text-body font-medium"
                        style={{ color: sourceMode === mode ? KR : "var(--foreground)" }}
                      >
                        {label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(assetType !== "character" || sourceMode === "upload") && (
              <div>
                {photoPreview ? (
                  <div className="space-y-2">
                    <div
                      className="relative w-fit max-w-full mx-auto bg-[#0d0d0d] overflow-hidden flex items-center justify-center"
                      style={{ borderRadius: 0, maxHeight: 320 }}
                    >
                      <img
                        src={photoPreview}
                        className="max-w-full max-h-[320px] object-contain"
                        style={{ display: "block" }} loading="lazy" decoding="async" />
                      <button
                        onClick={() => {
                          setPhotoFile(null);
                          setPhotoPreview(null);
                        }}
                        className="absolute top-2 right-2 w-6 h-6 rounded-none bg-black/60 flex items-center justify-center hover:bg-black/80"
                      >
                        <X className="w-3 h-3 text-white" />
                      </button>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleAutoAnalyze(photoPreview, photoFile)}
                      disabled={isAnalyzing}
                      className="gap-1.5 w-full"
                    >
                      {isAnalyzing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Wand2 className="w-3.5 h-3.5" />
                      )}
                      {isAnalyzing
                        ? t("assets.analyzing")
                        : {
                            character: t("assets.autoAnalyzeOutfit"),
                            item: t("assets.autoAnalyzeItem"),
                            background: t("assets.autoAnalyzeLocation"),
                          }[assetType]}
                    </Button>
                  </div>
                ) : (
                  <UploadZone assetType={assetType} onFile={handlePhotoFile} />
                )}
              </div>
            )}

            {assetType === "character" && sourceMode === "ai" && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block">{t("assets.descriptionInput")}</label>
                  <Textarea
                    value={aiInput}
                    onChange={(e) => setAiInput(e.target.value)}
                    placeholder={t("assets.characterAppearancePlaceholder")}
                    rows={3}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleGenerateAiDescription}
                  disabled={!aiInput.trim() || isGenerating}
                  className="gap-1.5"
                >
                  <Sparkles className="w-4 h-4" />
                  {isGenerating ? t("assets.generatingAiDescription") : t("assets.generateAiDescription")}
                </Button>
                {aiDescription && (
                  <>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1.5 block">
                        {t("assets.appearanceDescription")}
                      </label>
                      <Textarea
                        value={aiDescription}
                        onChange={(e) => setAiDescription(e.target.value)}
                        rows={4}
                        className="text-xs"
                      />
                    </div>
                    <div className="border-t border-border pt-3">
                      <div className="flex items-center gap-3">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleGeneratePortrait}
                          disabled={isGeneratingImage || !aiDescription.trim()}
                          className="gap-1.5"
                        >
                          {isGeneratingImage ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Sparkles className="w-4 h-4" />
                          )}
                          {isGeneratingImage ? t("assets.generatingImage") : t("assets.generateCharacterImage")}
                        </Button>
                        {generatedPortraitUrl && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleGeneratePortrait}
                            disabled={isGeneratingImage}
                            className="gap-1 text-xs"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            {t("studio.regenerate")}
                          </Button>
                        )}
                      </div>
                      {generatedPortraitUrl && (
                        <div className="mt-3 space-y-2">
                          <div
                            className="relative w-fit max-w-full mx-auto bg-[#0d0d0d] overflow-hidden flex items-center justify-center"
                            style={{ borderRadius: 0, maxHeight: 280 }}
                          >
                            <img src={generatedPortraitUrl} className="max-w-full max-h-[280px] object-contain" loading="lazy" decoding="async" />
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleAutoAnalyze(generatedPortraitUrl)}
                            disabled={isAnalyzing}
                            className="gap-1.5 w-full"
                          >
                            {isAnalyzing ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Wand2 className="w-3.5 h-3.5" />
                            )}
                            {isAnalyzing ? t("assets.analyzingOutfit") : t("assets.autoAnalyzeOutfit")}
                          </Button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {assetType === "character" && (
              <label
                className="flex items-start gap-3 px-3 py-3 border cursor-pointer select-none transition-colors"
                style={{
                  borderRadius: 0,
                  borderColor: sheetMode === "with-sheet" ? KR : "var(--border)",
                  background: sheetMode === "with-sheet" ? KR_BG : "transparent",
                }}
              >
                <input
                  type="checkbox"
                  checked={sheetMode === "with-sheet"}
                  onChange={(e) => {
                    setSheetMode(e.target.checked ? "with-sheet" : "fast");
                    // 사용자가 체크박스를 직접 토글한 순간부터 AI 포트레이트
                    // auto-default 가 다시 끼어들지 않도록 잠금. (sourceMode
                    // 토글이 다시 체크 상태를 뒤집어버리는 jolt 방지.)
                    setUserTouchedSheetMode(true);
                  }}
                  className="mt-0.5 w-4 h-4 accent-primary cursor-pointer shrink-0"
                  style={{ borderRadius: 0 }}
                />
                <div className="flex-1 flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="text-body font-semibold"
                      style={{ color: sheetMode === "with-sheet" ? KR : "var(--foreground)" }}
                    >
                      {t("assets.sheetCheckbox.label")}
                    </span>
                    <span
                      className="text-2xs font-mono px-1.5 py-0.5 leading-none"
                      style={{
                        background: "rgba(255,255,255,0.06)",
                        color: "var(--muted-foreground)",
                        borderRadius: 0,
                      }}
                    >
                      {t("assets.sheetCheckbox.duration")}
                    </span>
                  </div>
                  <span className="text-caption text-muted-foreground leading-snug">
                    {t("assets.sheetCheckbox.desc")}
                  </span>
                </div>
              </label>
            )}

            {(assetType === "character" || assetType === "item" || assetType === "background") && (
              <div className="border-t border-border pt-4 space-y-2">
                <label className="text-xs text-muted-foreground block">
                  {t("assets.details")}{" "}
                  <span className="text-muted-foreground/40">({t("assets.optional")})</span>
                </label>
                {assetType === "character" && (
                  <>
                    <Input
                      value={roleDescription}
                      onChange={(e) => setRoleDescription(e.target.value)}
                      placeholder={t("assets.rolePlaceholderInline")}
                    />
                    <Input
                      value={outfitDescription}
                      onChange={(e) => setOutfitDescription(e.target.value)}
                      placeholder={t("assets.outfitPlaceholderInline")}
                    />
                  </>
                )}
                {assetType === "item" && (
                  <Textarea
                    value={itemDescription}
                    onChange={(e) => setItemDescription(e.target.value)}
                    rows={3}
                    placeholder={t("assets.itemPlaceholder")}
                  />
                )}
                {assetType === "background" && (
                  <Textarea
                    value={spaceDescription}
                    onChange={(e) => setSpaceDescription(e.target.value)}
                    rows={3}
                    placeholder={t("assets.locationPlaceholder")}
                  />
                )}
              </div>
            )}
          </div>
          <DialogFooter className="sm:justify-between sm:items-center sm:space-x-0 gap-3">
            {/* 좌측 inline 도움말 — sheet 체크 여부에 따라 다른 동작을 안내한다.
                체크 OFF: Agent 가 디테일을 스토리에 자동 반영한다는 안심 텍스트.
                체크 ON: 시트 생성이 백그라운드로 돈다는 setup 안내. 둘 다 모달
                바닥에서 1줄로만 보여주고 우측 버튼과 같은 row 에 배치. */}
            <span className="flex items-center gap-1.5 text-caption text-muted-foreground/70">
              <Info className="w-3 h-3 shrink-0" />
              {assetType === "character" && sheetMode === "with-sheet"
                ? t("assets.detailsSheetNote")
                : t("assets.detailsAgentNote")}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                className="text-body h-9"
                onClick={() => {
                  setModalOpen(false);
                  resetForm();
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                onClick={handleSave}
                disabled={!tagName.trim() || isSaving}
                className="text-white text-body h-9"
                style={{ background: KR }}
              >
                {isSaving ? t("assets.saving") : t("common.save")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ?? ?? ?? ?? */}
      {deleteTarget && (
        <Dialog open onOpenChange={(o) => !o && setDeleteTarget(null)}>
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>{t("assets.deleteAsset")}</DialogTitle>
            </DialogHeader>
            <p className="text-body text-muted-foreground">
              {t("assets.deleteAssetDesc")}
            </p>
            <DialogFooter className="gap-2">
              <Button variant="ghost" className="text-body h-9" onClick={() => setDeleteTarget(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                className="text-white text-body h-9"
                style={{ background: "#dc2626" }}
                onClick={() => handleDelete(deleteTarget)}
              >
                {t("common.delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};
