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
import { exportPack } from "@/lib/preflowPackClient";
import type { PackScope } from "@/lib/preflowPack";
import { getAllCanvasLayouts } from "@/lib/canvasLayout";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/uiLanguage";

interface ExportPackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: PackScope;
  scopeLabel: string;
  ids?: string[];
  folderTag?: string;
  projectId?: string | null;
  itemCount: number;
}

export function ExportPackDialog({
  open,
  onOpenChange,
  scope,
  scopeLabel,
  ids,
  folderTag,
  projectId,
  itemCount,
}: ExportPackDialogProps) {
  const { toast } = useToast();
  const t = useT();
  const [includeFiles, setIncludeFiles] = useState(true);
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [packName, setPackName] = useState(scopeLabel);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setIncludeFiles(true);
      setIncludeSubfolders(true);
      setPackName(scopeLabel);
    }
  }, [open, scopeLabel]);

  const runExport = async () => {
    setBusy(true);
    try {
      // 현재 워크스페이스의 모든 캔버스 레이아웃을 그대로 동봉 — import 측은
      // 동일 contextKey 가 이미 있으면 skip 모드로 사용자의 현재 작업을 보호.
      // 키는 `tag:folder:<path>` 형태라 폴더 트리만 그대로면 자동 매칭된다.
      const canvasLayouts = getAllCanvasLayouts();
      const result = await exportPack({
        scope,
        ids,
        folderTag,
        projectId,
        includeFiles,
        includeSubfolders,
        suggestedName: packName,
        canvasLayouts,
      });
      if (result.canceled) return;
      toast({
        title: t("library.toast.packExported"),
        description: result.saved_path
          ? t("library.toast.packExportedDescPath", { n: result.item_count, path: result.saved_path })
          : t("library.toast.packExportedDesc", { n: result.item_count }),
      });
      if (result.skipped.length > 0) {
        toast({ title: t("library.toast.someFilesSkipped"), description: t("library.toast.missingFilesReported", { n: result.skipped.length }) });
      }
      onOpenChange(false);
    } catch (err) {
      toast({ variant: "destructive", title: t("library.toast.exportFailed"), description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("exportPack.title")}</DialogTitle>
          <DialogDescription>
            {t("exportPack.description", { n: itemCount.toLocaleString(), s: itemCount === 1 ? "" : "s", scope: scopeLabel })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-caption font-mono text-muted-foreground">{t("exportPack.packName")}</label>
            <Input value={packName} onChange={(event) => setPackName(event.target.value)} className="h-9 text-meta" />
          </div>
          <label className="flex items-center gap-2 text-meta">
            <Checkbox checked={includeFiles} onCheckedChange={(checked) => setIncludeFiles(checked === true)} />
            {t("exportPack.includeOriginals")}
          </label>
          {scope === "folder" ? (
            <label className="flex items-center gap-2 text-meta">
              <Checkbox checked={includeSubfolders} onCheckedChange={(checked) => setIncludeSubfolders(checked === true)} />
              {t("exportPack.includeSubfolders")}
            </label>
          ) : null}
          {!includeFiles ? (
            <div className="border border-amber-500/40 bg-amber-500/10 p-3 text-caption text-amber-600" style={{ borderRadius: 0 }}>
              {t("exportPack.metadataNote")}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" style={{ borderRadius: 0 }} onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button style={{ borderRadius: 0 }} onClick={runExport} disabled={busy || itemCount === 0}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("exportPack.saveButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
