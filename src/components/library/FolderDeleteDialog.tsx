import { useEffect, useState } from "react";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useT } from "@/lib/uiLanguage";

interface FolderDeleteDialogProps {
  open: boolean;
  folderPath: string | null;
  affectedCount: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: (opts: { mode: "removeTagOnly" | "trashItems"; recursive: boolean }) => void;
}

export function FolderDeleteDialog({ open, folderPath, affectedCount, onOpenChange, onConfirm }: FolderDeleteDialogProps) {
  const [mode, setMode] = useState<"removeTagOnly" | "trashItems">("removeTagOnly");
  const [recursive, setRecursive] = useState(true);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    setMode("removeTagOnly");
    setRecursive(true);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("library.folderDelete.title")}</DialogTitle>
          <DialogDescription>
            {folderPath ? t("library.folderDelete.descriptionWithPath", { path: folderPath }) : t("library.folderDelete.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-meta">
          <div className="border border-border-subtle bg-surface-panel p-3" style={{ borderRadius: 0 }}>
            {t("library.folderDelete.affected", { n: affectedCount })}
          </div>
          <RadioGroup value={mode} onValueChange={(value) => setMode(value as "removeTagOnly" | "trashItems")}>
            <label className="flex items-center gap-2">
              <RadioGroupItem value="removeTagOnly" />
              {t("library.folderRemoveTagOnly")}
            </label>
            <label className="flex items-center gap-2">
              <RadioGroupItem value="trashItems" />
              {t("library.folderTrashItems")}
            </label>
          </RadioGroup>
          <label className="flex items-center gap-2">
            <Checkbox checked={recursive} onCheckedChange={(checked) => setRecursive(checked === true)} />
            {t("library.folderIncludeSubfolders")}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" style={{ borderRadius: 0 }} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant={mode === "trashItems" ? "destructive" : "default"}
            style={{ borderRadius: 0 }}
            onClick={() => {
              onConfirm({ mode, recursive });
              onOpenChange(false);
            }}
          >
            {t("library.folderDelete.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
