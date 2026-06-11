import { Library, Loader2 } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { EagleImportResult, EaglePreview } from "@/lib/eagleImport";
import { useT } from "@/lib/uiLanguage";

interface EagleImportDialogProps {
  open: boolean;
  busy: boolean;
  root: string;
  preview: EaglePreview | null;
  result: EagleImportResult | null;
  onOpenChange: (open: boolean) => void;
  onSelectLibrary: () => void;
  onRunImport: () => void;
}

export function EagleImportDialog({
  open,
  busy,
  root,
  preview,
  result,
  onOpenChange,
  onSelectLibrary,
  onRunImport,
}: EagleImportDialogProps) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t("library.eagleImport.title")}</DialogTitle>
          <DialogDescription>
            {t("library.eagleImport.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Button
            variant="outline"
            className="h-9 w-full gap-2 text-meta"
            style={{ borderRadius: 0 }}
            onClick={onSelectLibrary}
            disabled={busy}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Library className="h-3.5 w-3.5" />}
            {t("library.eagleImport.chooseFolder")}
          </Button>

          {preview ? (
            <Alert className="rounded-none border-border-subtle bg-surface-panel">
              <AlertTitle className="text-meta">{preview.libraryName}</AlertTitle>
              <AlertDescription className="mt-2 space-y-2 text-caption">
                <div className="break-all text-muted-foreground">{root}</div>
                <div className="grid grid-cols-2 gap-1 font-mono">
                  <span>{t("library.eagleImport.itemsCount", { n: preview.totalItems })}</span>
                  <span>{Math.round(preview.totalBytes / 1024 / 1024)} MB</span>
                  <span>{t("library.eagleImport.foldersCount", { n: preview.folders })}</span>
                  <span>{t("library.eagleImport.filtersCount", { n: preview.smartFolders })}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(preview.kinds).map(([kind, count]) => (
                    <Badge key={kind} variant="outline" className="text-micro">
                      {kind}: {count}
                    </Badge>
                  ))}
                </div>
                {preview.missingFiles.length > 0 ? (
                  <div className="text-amber-500">
                    {t("library.eagleImport.missingFiles", { n: preview.missingFiles.length })}
                  </div>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          {result ? (
            <div className="border border-border-subtle bg-surface-panel p-3 text-caption text-muted-foreground" style={{ borderRadius: 0 }}>
              <div className="font-semibold text-foreground">{t("library.eagleImport.lastImportHeader")}</div>
              <div>{t("library.eagleImport.resultLine", { imported: result.imported, skipped: result.skipped, meta: result.metadataOnly })}</div>
              {result.skipped > 0 ? (
                <div>{t("library.eagleImport.skippedNote")}</div>
              ) : null}
              {result.missingFiles.length > 0 ? (
                <div className="text-amber-500">{t("library.eagleImport.missingReported", { n: result.missingFiles.length })}</div>
              ) : null}
              {result.failed.length > 0 ? <div className="text-destructive">{t("library.eagleImport.failedCount", { n: result.failed.length })}</div> : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" style={{ borderRadius: 0 }} onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          <Button type="button" style={{ borderRadius: 0 }} onClick={onRunImport} disabled={busy || !root}>
            {busy ? t("library.eagleImport.importing") : t("library.eagleImport.runImport")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
