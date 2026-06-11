import { useEffect, useState } from "react";
import { Folder, Plus } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { useT } from "@/lib/uiLanguage";
import { normalizeLibraryFolderPath } from "@/lib/folderCache";
import type { LibraryFolderRow } from "./LibrarySidebar";

interface FolderPickerDialogProps {
  open: boolean;
  title: string;
  description?: string;
  folders: LibraryFolderRow[];
  onOpenChange: (open: boolean) => void;
  onPick: (path: string) => void;
}

export function FolderPickerDialog({ open, title, description, folders, onOpenChange, onPick }: FolderPickerDialogProps) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState("");

  useEffect(() => {
    if (!open) return;
    setSelected(folders[0]?.tag.replace(/^folder:/, "") ?? null);
    setNewFolder("");
  }, [folders, open]);

  const submit = () => {
    const path = normalizeLibraryFolderPath(newFolder || selected || "");
    if (!path) return;
    onPick(path);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-3">
          <div className="max-h-64 overflow-y-auto border border-border-subtle bg-surface-panel p-1" style={{ borderRadius: 0 }}>
            {folders.length === 0 ? (
              <div className="px-3 py-3 text-meta text-muted-foreground">{t("library.folder.pickerEmpty")}</div>
            ) : (
              folders.map((row) => {
                const path = row.tag.replace(/^folder:/, "");
                return (
                  <button
                    key={row.tag}
                    type="button"
                    onClick={() => {
                      setSelected(path);
                      setNewFolder("");
                    }}
                    className={cn(
                      "flex w-full items-center justify-between py-2 pr-3 text-left text-meta",
                      selected === path ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                    )}
                    style={{ paddingLeft: `${10 + Math.min(row.depth, 4) * 12}px` }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Folder className="h-3.5 w-3.5" />
                      <span className="truncate">{row.label}</span>
                    </span>
                    <span className="font-mono text-2xs">{row.count}</span>
                  </button>
                );
              })
            )}
          </div>
          <div className="flex items-center gap-2">
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={newFolder}
              onChange={(event) => {
                setNewFolder(event.target.value);
                setSelected(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
              placeholder={t("library.folder.pickerCreatePlaceholder")}
              className="h-9 text-meta"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" style={{ borderRadius: 0 }} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button style={{ borderRadius: 0 }} onClick={submit} disabled={!selected && !newFolder.trim()}>
            {t("library.folder.pickerChoose")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
