import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ReferenceItem } from "@/lib/referenceLibrary";
import { useT } from "@/lib/uiLanguage";

interface RenameReferenceDialogProps {
  open: boolean;
  reference: ReferenceItem | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (title: string) => void;
}

export function RenameReferenceDialog({ open, reference, onOpenChange, onSubmit }: RenameReferenceDialogProps) {
  const [title, setTitle] = useState("");
  const t = useT();

  useEffect(() => {
    if (open) setTitle(reference?.title ?? "");
  }, [open, reference]);

  const submit = () => {
    const next = title.trim();
    if (!next) return;
    onSubmit(next);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("library.rename.title")}</DialogTitle>
          <DialogDescription>{t("library.rename.description")}</DialogDescription>
        </DialogHeader>
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          className="h-9 text-meta"
        />
        <DialogFooter>
          <Button variant="outline" style={{ borderRadius: 0 }} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button style={{ borderRadius: 0 }} disabled={!title.trim()} onClick={submit}>
            {t("library.rename.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
