import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { applyProjectPack, previewProjectPack } from "@/lib/preflowProjClient";
import type { ProjPackPreview } from "@/lib/preflowProj";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/uiLanguage";

interface ProjectImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
  /**
   * 외부(드래그-드랍 또는 헤더 메뉴) 진입점에서 미리 만든 미리보기. 값이
   * 들어오면 다이얼로그가 열릴 때 "Choose Pack..." 단계를 건너뛰고 곧장
   * import 옵션 화면을 보여 준다.
   */
  initialPreview?: ProjPackPreview | null;
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

export function ProjectImportDialog({
  open,
  onOpenChange,
  onComplete,
  initialPreview,
}: ProjectImportDialogProps) {
  const { toast } = useToast();
  const t = useT();
  const [preview, setPreview] = useState<ProjPackPreview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && initialPreview) {
      setPreview(initialPreview);
    }
  }, [open, initialPreview]);

  const choosePack = async () => {
    setBusy(true);
    try {
      const result = await previewProjectPack();
      if (result.canceled) return;
      setPreview(result);
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("projPack.import.previewFailed"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await applyProjectPack({ tempPath: preview.tempPath });
      const renamedNote =
        result.renamed_titles.length > 0
          ? t("projPack.import.renamedSuffix", { n: result.renamed_titles.length })
          : "";
      toast({
        title: t("projPack.import.importedToast"),
        description: t("projPack.import.importedDescription", {
          projects: result.imported_projects,
          refs: result.imported_references,
          files: result.copied_files,
          renamed: renamedNote,
        }),
      });
      onComplete();
      onOpenChange(false);
      setPreview(null);
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("projPack.import.failedToast"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setPreview(null);
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t("projPack.import.title")}</DialogTitle>
          <DialogDescription>
            {t("projPack.import.description")}
          </DialogDescription>
        </DialogHeader>
        {!preview ? (
          <div
            className="border border-border-subtle bg-surface-panel p-4 text-meta text-muted-foreground"
            style={{ borderRadius: 0 }}
          >
            {t("projPack.import.choosePrompt")}
          </div>
        ) : (
          <div className="space-y-4 text-meta">
            <div className="grid grid-cols-3 gap-2">
              <div className="border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
                <div className="font-mono text-micro text-muted-foreground">{t("projPack.import.kind.scope")}</div>
                <div className="mt-1 font-semibold">{preview.manifest.scope}</div>
              </div>
              <div className="border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
                <div className="font-mono text-micro text-muted-foreground">{t("projPack.import.kind.projects")}</div>
                <div className="mt-1 font-semibold">{preview.project_count}</div>
              </div>
              <div className="border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
                <div className="font-mono text-micro text-muted-foreground">{t("projPack.import.kind.size")}</div>
                <div className="mt-1 font-semibold">{formatBytes(preview.total_size_bytes)}</div>
              </div>
            </div>
            <div className="border border-border-subtle bg-background p-3" style={{ borderRadius: 0 }}>
              <div className="font-mono text-2xs text-muted-foreground">{t("projPack.import.references")}</div>
              <div className="mt-1 text-foreground">
                {preview.reference_count > 0
                  ? t("projPack.import.referencesEmbedded", { n: preview.reference_count })
                  : t("projPack.import.referencesNone")}
              </div>
            </div>
            {preview.project_titles.length > 0 ? (
              <div className="border border-border-subtle bg-background p-3" style={{ borderRadius: 0 }}>
                <div className="font-mono text-2xs text-muted-foreground">{t("projPack.import.projectTitles")}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {preview.project_titles.map((title) => {
                    const collided = preview.title_collisions.includes(title);
                    return (
                      <span
                        key={title}
                        className={`inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-2xs ${
                          collided
                            ? "border-amber-500/50 bg-amber-500/10 text-amber-600"
                            : "border-border-subtle bg-surface-panel text-muted-foreground"
                        }`}
                        style={{ borderRadius: 0 }}
                        title={collided ? t("projPack.import.collisionTooltip") : undefined}
                      >
                        {title}
                        {collided ? <span className="text-micro">→ (n)</span> : null}
                      </span>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {preview.missing_files.length > 0 ? (
              <div
                className="border border-amber-500/40 bg-amber-500/10 p-3 text-amber-600"
                style={{ borderRadius: 0 }}
              >
                {t("projPack.import.missingFiles", { n: preview.missing_files.length })}
              </div>
            ) : null}
            <div
              className="border border-border-subtle bg-background p-3 text-caption text-muted-foreground"
              style={{ borderRadius: 0 }}
            >
              {t("projPack.import.idDisclaimer.lead")}
              <span className="font-semibold text-foreground"> {t("projPack.import.idDisclaimer.suffix")} </span>
              {t("projPack.import.idDisclaimer.tail")}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            style={{ borderRadius: 0 }}
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button variant="outline" style={{ borderRadius: 0 }} onClick={choosePack} disabled={busy}>
            {busy && !preview ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("projPack.import.choosePack")}
          </Button>
          <Button style={{ borderRadius: 0 }} onClick={runImport} disabled={busy || !preview}>
            {busy && preview ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("projPack.import.import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
