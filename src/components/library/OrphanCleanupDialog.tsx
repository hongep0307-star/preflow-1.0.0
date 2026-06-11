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
import {
  formatBytes,
  previewOrphanCleanup,
  runOrphanCleanup,
  type OrphanCleanupPreview,
} from "@/lib/storageMaintenance";
import { useT } from "@/lib/uiLanguage";

interface OrphanCleanupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (result: { filesDeleted: number; bytesFreed: number }) => void;
}

export function OrphanCleanupDialog({ open, onOpenChange, onComplete }: OrphanCleanupDialogProps) {
  const t = useT();
  const [preview, setPreview] = useState<OrphanCleanupPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setError(null);
    setBusy(true);
    previewOrphanCleanup()
      .then(setPreview)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }, [open]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await runOrphanCleanup();
      onComplete({ filesDeleted: result.filesDeleted, bytesFreed: result.bytesFreed });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t("library.orphan.title")}</DialogTitle>
          <DialogDescription>{t("library.orphan.description")}</DialogDescription>
        </DialogHeader>
        {busy && !preview ? (
          <div className="flex items-center gap-2 text-meta text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("library.orphan.scanning")}
          </div>
        ) : preview ? (
          <div className="min-w-0 space-y-3 text-meta">
            <div className="grid grid-cols-3 gap-2">
              <div className="border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
                <div className="text-2xs font-semibold text-muted-foreground">{t("library.orphan.statOrphans")}</div>
                <div className="mt-1 text-lg font-semibold">{preview.orphan_files}</div>
              </div>
              <div className="border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
                <div className="text-2xs font-semibold text-muted-foreground">{t("library.orphan.statReclaim")}</div>
                <div className="mt-1 text-lg font-semibold">{formatBytes(preview.bytes_reclaimable)}</div>
              </div>
              <div className="border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
                <div className="text-2xs font-semibold text-muted-foreground">{t("library.orphan.statSkipped")}</div>
                <div className="mt-1 text-lg font-semibold">{preview.skipped_recent}</div>
              </div>
            </div>
            {preview.sample.length > 0 ? (
              <div className="w-full min-w-0 max-h-44 overflow-y-auto overflow-x-hidden border border-border-subtle bg-background p-2 font-mono text-2xs" style={{ borderRadius: 0 }}>
                {preview.sample.map((file) => (
                  <div key={file.key} className="flex items-center justify-between gap-3 border-b border-border-subtle/60 py-1 last:border-0">
                    <span className="min-w-0 flex-1 truncate" title={file.key}>{file.key}</span>
                    <span className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">{formatBytes(file.size)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="border border-border-subtle bg-surface-panel p-3 text-muted-foreground" style={{ borderRadius: 0 }}>
                {t("library.orphan.noneFound")}
              </div>
            )}
          </div>
        ) : null}
        {error ? <div className="text-meta text-destructive">{error}</div> : null}
        <DialogFooter>
          <Button variant="outline" style={{ borderRadius: 0 }} onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            style={{ borderRadius: 0 }}
            onClick={run}
            disabled={busy || !preview || preview.orphan_files === 0}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("library.orphan.deleteAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
