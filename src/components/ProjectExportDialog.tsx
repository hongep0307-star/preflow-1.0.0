import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { exportProjectPack } from "@/lib/preflowProjClient";
import type { ProjPackScope } from "@/lib/preflowProj";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/uiLanguage";

interface ProjectExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: ProjPackScope;
  /** scope = "single" 인 경우의 프로젝트 ID. selection/workspace 일 때는 null. */
  projectId?: string | null;
  /** scope = "selection" 인 경우 선택된 프로젝트 ID 들. single/workspace 에서
   *  는 무시된다. */
  projectIds?: string[] | null;
  /** scope 에 따라 헤더 제목 + 기본 팩 이름의 역할:
   *  - single  : 프로젝트 제목
   *  - selection: 대표 제목(예: "first-and-N-more")
   *  - workspace: 날짜 스탬프가 박힌 워크스페이스 라벨 */
  scopeLabel: string;
  /** 정보 행에 보여줄 보조 통계 (프로젝트 개수 / 레퍼런스 개수 등). */
  itemSummary?: string;
}

export function ProjectExportDialog({
  open,
  onOpenChange,
  scope,
  projectId,
  projectIds,
  scopeLabel,
  itemSummary,
}: ProjectExportDialogProps) {
  const { toast } = useToast();
  const t = useT();
  const [includeFiles, setIncludeFiles] = useState(true);
  const [includeReferences, setIncludeReferences] = useState(true);
  const [packName, setPackName] = useState(scopeLabel);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setIncludeFiles(true);
      setIncludeReferences(true);
      setPackName(scopeLabel);
    }
  }, [open, scopeLabel]);

  const runExport = async () => {
    setBusy(true);
    try {
      const result = await exportProjectPack({
        scope,
        projectId,
        projectIds: scope === "selection" ? projectIds ?? [] : null,
        includeFiles,
        includeReferences,
        suggestedName: packName,
      });
      if (result.canceled) return;
      toast({
        title: t("projPack.export.savedToast"),
        description: result.saved_path
          ? t("projPack.export.savedDescriptionWithPath", {
              projects: result.project_count,
              refs: result.reference_count,
              path: result.saved_path,
            })
          : t("projPack.export.savedDescription", {
              projects: result.project_count,
              refs: result.reference_count,
            }),
      });
      onOpenChange(false);
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("projPack.export.failedToast"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>
            {scope === "single"
              ? t("projPack.export.singleTitle")
              : scope === "selection"
                ? t("projPack.export.selectionTitle")
                : t("projPack.export.workspaceTitle")}
          </DialogTitle>
          <DialogDescription>
            {itemSummary || scopeLabel}
            {t("projPack.export.descriptionSuffix")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-caption font-mono text-muted-foreground">
              {t("projPack.export.packName")}
            </label>
            <Input
              value={packName}
              onChange={(event) => setPackName(event.target.value)}
              className="h-9 text-meta"
            />
          </div>
          <label className="flex items-center gap-2 text-meta">
            <Checkbox
              checked={includeFiles}
              onCheckedChange={(checked) => setIncludeFiles(checked === true)}
            />
            {t("projPack.export.includeFiles")}
          </label>
          <label className="flex items-center gap-2 text-meta">
            <Checkbox
              checked={includeReferences}
              onCheckedChange={(checked) => setIncludeReferences(checked === true)}
            />
            {t("projPack.export.includeReferences")}
          </label>
          {!includeFiles ? (
            <div
              className="border border-amber-500/40 bg-amber-500/10 p-3 text-caption text-amber-600"
              style={{ borderRadius: 0 }}
            >
              {t("projPack.export.metadataOnlyWarning")}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            style={{ borderRadius: 0 }}
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button style={{ borderRadius: 0 }} onClick={runExport} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("projPack.export.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
