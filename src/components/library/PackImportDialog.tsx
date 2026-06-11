import { useEffect, useMemo, useState } from "react";
import { FolderOpen, FolderTree, Loader2, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { applyPack, previewPack } from "@/lib/preflowPackClient";
import { mergeCanvasLayouts, type CanvasLayout } from "@/lib/canvasLayout";
import type { PackFolderStrategy, PackImportStrategy, PackPreview } from "@/lib/preflowPack";
import { listFolderPaths } from "@/lib/referenceLibrary";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/uiLanguage";

interface PackImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
  /**
   * 외부(Add → Choose Files / 드래그-드랍) 진입점에서 이미 만든 미리보기.
   * 값이 들어오면 다이얼로그가 열릴 때 "Choose Pack..." 단계를 건너뛰고
   * 곧장 import 옵션 화면을 보여 준다.
   */
  initialPreview?: PackPreview | null;
  /**
   * Library UI 의 활성 폴더 경로(`folder:` prefix 없는 normalized path).
   * flatten 모드에서는 destination, recreate 모드에서는 pack 트리의 mount
   * point 로 동시에 작용한다. null 이면 root 컨텍스트.
   */
  destinationFolderPath?: string | null;
  /** 위 경로의 사람-친화 라벨 (마지막 segment) — 컨텍스트 hint 표시용. */
  folderLabel?: string | null;
  /** Favorites quick filter 컨텍스트면 true — imported row 의 is_favorite 강제. */
  forceFavorite?: boolean;
  /** import 결과로 새로 등장한 folder 경로들 (모든 ancestor 포함, prefix 제외).
   *  LibraryPage 가 사용자 폴더 캐시에 등록해 — 수동 폴더처럼 빈 상태에서도
   *  사이드바에 남게 한다. recreate 전략에서만 비어있지 않다. */
  onFoldersCreated?: (paths: string[]) => void;
}

function formatBytes(value: number): string {
  if (!value || !Number.isFinite(value)) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

/**
 * Backend `buildFolderRemap` 의 클라이언트 미리보기 버전 — 라벨용 chip 에
 * `Sports → Sports (1)` 같은 충돌 회피 결과를 미리 보여 주려고 같은 규칙을
 * 그대로 따라 계산한다. 실제 import 결과는 항상 backend 가 다시 한 번 결정.
 *
 * 비교는 case-insensitive — backend 와 동일하게 `Purple` 과 `purple` 을
 * 같은 폴더로 취급해 chip 미리보기와 실제 결과가 어긋나지 않도록 한다.
 */
function previewRemap(
  packTopLevels: string[],
  destinationPath: string | null,
  existingPaths: Set<string>,
): Map<string, string> {
  const remap = new Map<string, string>();
  const pickedLower = new Set<string>();
  const existingLower = new Set<string>();
  for (const p of existingPaths) existingLower.add(p.toLowerCase());
  const fullPath = (segment: string) => (destinationPath ? `${destinationPath}/${segment}` : segment);
  const isTaken = (segment: string) => {
    const fullLower = fullPath(segment).toLowerCase();
    if (pickedLower.has(fullLower)) return true;
    const prefix = `${fullLower}/`;
    for (const p of existingLower) {
      if (p === fullLower || p.startsWith(prefix)) return true;
    }
    return false;
  };
  for (const top of packTopLevels) {
    let candidate = top;
    let n = 1;
    while (isTaken(candidate)) {
      candidate = `${top} (${n})`;
      n += 1;
      if (n > 999) break;
    }
    remap.set(top, candidate);
    pickedLower.add(fullPath(candidate).toLowerCase());
  }
  return remap;
}

export function PackImportDialog({
  open,
  onOpenChange,
  onComplete,
  initialPreview,
  destinationFolderPath,
  folderLabel,
  forceFavorite,
  onFoldersCreated,
}: PackImportDialogProps) {
  const { toast } = useToast();
  const t = useT();
  const [preview, setPreview] = useState<PackPreview | null>(null);
  const [strategy, setStrategy] = useState<PackImportStrategy>("skip");
  const [folderStrategy, setFolderStrategy] = useState<PackFolderStrategy>("flatten");
  const [busy, setBusy] = useState(false);
  /* 충돌 미리보기용으로 라이브러리의 기존 폴더 경로 목록을 다이얼로그 open
     사이클마다 한 번 가져와 둔다. recreate 라디오 chip 의 ` (1)` suffix
     계산이 이 데이터를 본다 — 부정확해도 안전(backend 가 최종 결정). */
  const [existingFolderPaths, setExistingFolderPaths] = useState<Set<string>>(() => new Set());

  const hasFolderContext = Boolean(folderLabel && destinationFolderPath);
  const hasFavoriteContext = Boolean(forceFavorite);
  const showContextHint = hasFolderContext || hasFavoriteContext;

  /* 외부에서 만든 미리보기를 다이얼로그가 새로 열릴 때 1회 흡수.
     같은 다이얼로그를 닫고 다시 열면 (initialPreview 가 그대로 유지)
     다음 open 사이클에서도 미리보기를 다시 채워 준다. open=false 로
     접히는 순간 preview 를 비워 잔상 방지. 폴더 strategy 의 default 는
     컨텍스트 의존 — destination 이 있으면 flatten("이 폴더에 다 넣음"
     이라는 사용자 의도) , 없으면 recreate(원본 트리 그대로 복원) 를 권장. */
  useEffect(() => {
    if (open && initialPreview) {
      setPreview(initialPreview);
      setStrategy("skip");
      setFolderStrategy(destinationFolderPath ? "flatten" : "recreate");
    }
  }, [open, initialPreview, destinationFolderPath]);

  /* 다이얼로그가 새로 열릴 때만 폴더 경로 목록을 가져옴. import 진행 중에
     사용자가 다른 화면에서 폴더를 추가하는 일은 드물고, 부정확해도 결과
     자체는 backend 가 보장하므로 stale 캐시 위험은 낮다. */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listFolderPaths().then((paths) => {
      if (!cancelled) setExistingFolderPaths(new Set(paths));
    }).catch(() => {
      if (!cancelled) setExistingFolderPaths(new Set());
    });
    return () => { cancelled = true; };
  }, [open]);

  const choosePack = async () => {
    setBusy(true);
    try {
      const result = await previewPack();
      if (result.canceled) return;
      setPreview(result);
      setFolderStrategy(destinationFolderPath ? "flatten" : "recreate");
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.packPreviewFailed", { name: "" }), description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  /* 라디오 그룹 자체는 pack 안에 폴더 태그가 있을 때만 의미가 있다. 그
     외에는 하나의 결정 (destination 이 있으면 그 폴더로, 없으면 root) 만
     남으므로 라디오를 숨기고 hint 만 보여 준다. */
  const showFolderStrategyChoice = Boolean(preview?.has_folder_structure);
  const remapPreview = useMemo(() => {
    if (!preview?.has_folder_structure) return new Map<string, string>();
    return previewRemap(preview.top_level_folders, destinationFolderPath ?? null, existingFolderPaths);
  }, [preview, destinationFolderPath, existingFolderPaths]);

  const runImport = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await applyPack({
        tempPath: preview.tempPath,
        strategy,
        folderStrategy,
        destinationFolderPath: destinationFolderPath || undefined,
        forceFavorite: forceFavorite || undefined,
      });
      toast({
        title: t("library.toast.packImported"),
        description: t("library.toast.packImportedDesc", { inserted: result.inserted, skipped: result.skipped, merged: result.merged }),
      });
      if (onFoldersCreated && result.created_folder_paths?.length) {
        onFoldersCreated(result.created_folder_paths);
      }
      // 캔버스 작업 복원 — pack 에 동봉된 layout 들을 현재 워크스페이스에 병합.
      // folderStrategy + destination + remap (충돌 시 (1) 등) 을 반영해 키를 변환.
      // skip 모드 — 기존 layout 은 절대 덮어쓰지 않음 (사용자 현재 작업 보호).
      const incoming = preview.canvas_layouts;
      if (incoming && typeof incoming === "object" && folderStrategy === "recreate") {
        const remapped: Record<string, CanvasLayout> = {};
        for (const [key, layout] of Object.entries(incoming)) {
          // `tag:folder:<path>` 형태만 remap. q:* / tag:non-folder 는 그대로 두면
          // 충돌 위험 (다른 의미) 이라 v1 에서는 폴더 키만 처리.
          if (!key.startsWith("tag:folder:")) continue;
          const originalPath = key.slice("tag:folder:".length);
          const segments = originalPath.split("/");
          const topLevel = segments[0];
          const restPath = segments.slice(1).join("/");
          const renamedTop = remapPreview.get(topLevel) ?? topLevel;
          const newPath = destinationFolderPath
            ? `${destinationFolderPath}/${renamedTop}${restPath ? `/${restPath}` : ""}`
            : `${renamedTop}${restPath ? `/${restPath}` : ""}`;
          remapped[`tag:folder:${newPath}`] = layout as CanvasLayout;
        }
        if (Object.keys(remapped).length > 0) {
          mergeCanvasLayouts(remapped, { mode: "skip" });
        }
      }
      onComplete();
      onOpenChange(false);
      setPreview(null);
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.importFailed"), description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => {
      onOpenChange(next);
      if (!next) setPreview(null);
    }}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t("packImport.title")}</DialogTitle>
          <DialogDescription>{t("packImport.description")}</DialogDescription>
        </DialogHeader>
        {/* 활성 폴더 / Favorites 같은 Library UI 컨텍스트가 있으면 import
            결과에 자동 반영된다는 사실을 다이얼로그 상단에 작게 표시 — 미디어
            업로드와 동일한 암묵적 동작을 사용자에게 가시화. 컨텍스트가 없으면
            힌트 자체를 렌더하지 않아 기존 UI 와 동일. flatten / recreate 에
            따라 동사 워딩이 달라진다. */}
        {showContextHint ? (
          <div className="flex flex-wrap items-center gap-2 border border-primary/30 bg-primary/[0.06] px-3 py-2 text-meta text-foreground" style={{ borderRadius: 0 }}>
            <span className="text-muted-foreground">{t("packImport.contextNewItemsWillBe")}</span>
            {hasFolderContext ? (
              <span className="inline-flex items-center gap-1 font-medium">
                <FolderOpen className="h-3.5 w-3.5 text-primary" />
                {folderStrategy === "recreate" ? t("packImport.contextMountedUnder") : t("packImport.contextAddedTo")} <span className="font-semibold">{folderLabel}</span>
              </span>
            ) : null}
            {hasFolderContext && hasFavoriteContext ? <span className="text-muted-foreground">{t("packImport.contextAnd")}</span> : null}
            {hasFavoriteContext ? (
              <span className="inline-flex items-center gap-1 font-medium">
                <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                {t("packImport.contextMarkedFavorites")}
              </span>
            ) : null}
            <span className="text-muted-foreground">.</span>
          </div>
        ) : null}
        {!preview ? (
          <div className="border border-border-subtle bg-surface-panel p-4 text-meta text-muted-foreground" style={{ borderRadius: 0 }}>
            {t("packImport.choosePrompt")}
          </div>
        ) : (
          <div className="space-y-4 text-meta">
            <div className="grid grid-cols-3 gap-2">
              <div className="border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
                <div className="font-mono text-micro text-muted-foreground">{t("packImport.kind")}</div>
                <div className="mt-1 font-semibold">{preview.manifest.kind}</div>
              </div>
              <div className="border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
                <div className="font-mono text-micro text-muted-foreground">{t("packImport.items")}</div>
                <div className="mt-1 font-semibold">{preview.item_count}</div>
              </div>
              <div className="border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
                <div className="font-mono text-micro text-muted-foreground">{t("packImport.size")}</div>
                <div className="mt-1 font-semibold">{formatBytes(preview.total_size_bytes)}</div>
              </div>
            </div>
            <div className="border border-border-subtle bg-background p-3" style={{ borderRadius: 0 }}>
              <div className="font-mono text-2xs text-muted-foreground">{t("packImport.kinds")}</div>
              <div className="mt-1 text-foreground">
                {Object.entries(preview.kind_distribution).map(([kind, count]) => `${kind}: ${count}`).join(" / ") || t("packImport.kindsNone")}
              </div>
            </div>
            <div className="border border-border-subtle bg-background p-3" style={{ borderRadius: 0 }}>
              <div className="font-mono text-2xs text-muted-foreground">{t("packImport.duplicates")}</div>
              <div className="mt-1 text-foreground">{t("packImport.duplicatesMatchCount", { count: preview.duplicates.length })}</div>
            </div>
            {preview.missing_files.length > 0 ? (
              <div className="border border-amber-500/40 bg-amber-500/10 p-3 text-amber-600" style={{ borderRadius: 0 }}>
                {t("packImport.missingFiles", { count: preview.missing_files.length })}
              </div>
            ) : null}

            {showFolderStrategyChoice ? (
              <div className="space-y-2 border border-border-subtle bg-background p-3" style={{ borderRadius: 0 }}>
                <div className="flex items-center gap-1.5 font-mono text-2xs text-muted-foreground">
                  <FolderTree className="h-3 w-3" />
                  {t("packImport.folderPlacement")}
                </div>
                <RadioGroup
                  value={folderStrategy}
                  onValueChange={(value) => setFolderStrategy(value as PackFolderStrategy)}
                  className="gap-1.5"
                >
                  <label className="flex items-start gap-2 text-meta leading-snug">
                    <RadioGroupItem value="recreate" className="mt-[2px]" />
                    <span>
                      <span className="font-medium">{t("packImport.recreateFolderStructure")}</span>
                      <span className="ml-1 text-muted-foreground">
                        {destinationFolderPath
                          ? t("packImport.recreateFolderStructureDescUnder", { folder: folderLabel })
                          : t("packImport.recreateFolderStructureDescRoot")}
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-meta leading-snug">
                    <RadioGroupItem value="flatten" className="mt-[2px]" />
                    <span>
                      <span className="font-medium">
                        {destinationFolderPath
                          ? t("packImport.dropEverythingInto", { folder: folderLabel })
                          : t("packImport.dropEverythingAtRoot")}
                      </span>
                      <span className="ml-1 text-muted-foreground">{t("packImport.dropEverythingDesc")}</span>
                    </span>
                  </label>
                </RadioGroup>
                {/* recreate 일 때만 chip 미리보기 — pack 의 top-level 폴더가
                    어떤 이름으로 라이브러리에 등장할지 (충돌 시 (1) 포함)
                    가시화. 길이가 길면 wrap 되도록 flex-wrap. */}
                {folderStrategy === "recreate" && preview.top_level_folders.length > 0 ? (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {preview.top_level_folders.map((top) => {
                      const renamed = remapPreview.get(top) ?? top;
                      const collided = renamed !== top;
                      const display = destinationFolderPath ? `${folderLabel}/${renamed}` : renamed;
                      return (
                        <span
                          key={top}
                          className={`inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-2xs ${collided ? "border-amber-500/50 bg-amber-500/10 text-amber-600" : "border-border-subtle bg-surface-panel text-muted-foreground"}`}
                          style={{ borderRadius: 0 }}
                          title={collided ? t("packImport.collisionTitle", { renamed }) : undefined}
                        >
                          <FolderOpen className="h-2.5 w-2.5" />
                          {display}
                          {collided ? <span className="text-micro">{t("packImport.renamed")}</span> : null}
                        </span>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}

            <RadioGroup value={strategy} onValueChange={(value) => setStrategy(value as PackImportStrategy)}>
              {[
                ["skip", t("packImport.strategySkip")],
                ["keepBoth", t("packImport.strategyKeepBoth")],
                ["mergeMetadata", t("packImport.strategyMergeMetadata")],
              ].map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 text-meta">
                  <RadioGroupItem value={value} />
                  {label}
                </label>
              ))}
            </RadioGroup>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" style={{ borderRadius: 0 }} onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="outline" style={{ borderRadius: 0 }} onClick={choosePack} disabled={busy}>
            {busy && !preview ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("packImport.choosePack")}
          </Button>
          <Button style={{ borderRadius: 0 }} onClick={runImport} disabled={busy || !preview}>
            {busy && preview ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("packImport.import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
