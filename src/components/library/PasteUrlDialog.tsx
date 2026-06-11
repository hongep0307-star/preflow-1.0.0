import type { FormEvent } from "react";
import { Link2 } from "lucide-react";
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
import { useT } from "@/lib/uiLanguage";

interface PasteUrlDialogProps {
  open: boolean;
  value: string;
  onOpenChange: (open: boolean) => void;
  onValueChange: (value: string) => void;
  onSubmit: (event?: FormEvent) => void;
}

export function PasteUrlDialog({
  open,
  value,
  onOpenChange,
  onValueChange,
  onSubmit,
}: PasteUrlDialogProps) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("library.pasteUrl.title")}</DialogTitle>
          <DialogDescription>
            {t("library.pasteUrl.description")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="flex items-center gap-2 border border-border-subtle bg-background px-3" style={{ borderRadius: 0 }}>
            <Link2 className="h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
              placeholder="https://..."
              className="border-0 bg-transparent px-0 focus-visible:ring-0"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" style={{ borderRadius: 0 }} onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" style={{ borderRadius: 0 }} disabled={!value.trim()}>
              {t("library.pasteUrl.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
