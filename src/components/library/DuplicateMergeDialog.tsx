import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ReferenceItem } from "@/lib/referenceLibrary";
import { useT } from "@/lib/uiLanguage";

interface DuplicateMergeDialogProps {
  open: boolean;
  keep: ReferenceItem | null;
  mergeItems: ReferenceItem[];
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

function formatBytes(value?: number | null, unknownLabel = "Unknown"): string {
  if (!value || !Number.isFinite(value)) return unknownLabel;
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function DuplicateMergeDialog({ open, keep, mergeItems, onOpenChange, onConfirm }: DuplicateMergeDialogProps) {
  const t = useT();
  const sameHash = Boolean(keep?.content_hash) && mergeItems.every((item) => item.content_hash === keep?.content_hash);
  const unknownLabel = t("common.unknown");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t("library.duplicateMerge.title")}</DialogTitle>
          <DialogDescription>
            {t("library.duplicateMerge.description")}
          </DialogDescription>
        </DialogHeader>
        {keep ? (
          <div className="space-y-3 text-meta">
            <div className="border border-primary/40 bg-primary/10 p-3" style={{ borderRadius: 0 }}>
              <div className="text-2xs font-semibold text-muted-foreground">{t("library.duplicateMerge.keepLabel")}</div>
              <div className="mt-1 font-semibold">{keep.title}</div>
              <div className="mt-1 text-muted-foreground">{formatBytes(keep.file_size, unknownLabel)} / {keep.kind}</div>
            </div>
            <div className="border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
              <div className="mb-2 text-2xs font-semibold text-muted-foreground">{t("library.duplicateMerge.trashListHeader")}</div>
              <div className="max-h-44 overflow-y-auto">
                {mergeItems.map((item) => (
                  <div key={item.id} className="flex justify-between gap-3 border-b border-border-subtle/60 py-1.5 last:border-0">
                    <span className="truncate">{item.title}</span>
                    <span className="font-mono text-2xs text-muted-foreground">{formatBytes(item.file_size, unknownLabel)}</span>
                  </div>
                ))}
              </div>
            </div>
            {!sameHash ? (
              <div className="border border-destructive/40 bg-destructive/10 p-3 text-destructive" style={{ borderRadius: 0 }}>
                {t("library.duplicateMerge.hashMismatch")}
              </div>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" style={{ borderRadius: 0 }} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            style={{ borderRadius: 0 }}
            disabled={!keep || mergeItems.length === 0 || !sameHash}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {t("library.duplicateMerge.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
