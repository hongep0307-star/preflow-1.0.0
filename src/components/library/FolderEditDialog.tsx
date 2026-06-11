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
import { normalizeLibraryFolderPath } from "@/lib/folderCache";
import { useT } from "@/lib/uiLanguage";

interface FolderEditDialogProps {
  open: boolean;
  mode: "create" | "rename";
  parentPath?: string | null;
  initialPath?: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (path: string) => void;
}

export function FolderEditDialog({
  open,
  mode,
  parentPath,
  initialPath,
  onOpenChange,
  onSubmit,
}: FolderEditDialogProps) {
  const t = useT();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  // rename 모드에서는 *선택한 폴더명(마지막 세그먼트)* 만 편집한다. 상위 경로는
  // 보존하고, 제출 시 다시 합쳐 전체 경로를 재구성한다.
  const segments = (initialPath ?? "").split("/").filter(Boolean);
  const renameLeaf = segments.length > 0 ? segments[segments.length - 1] : "";
  const renameParent = segments.slice(0, -1).join("/");

  useEffect(() => {
    if (!open) return;
    if (mode === "rename") {
      setValue(renameLeaf);
    } else {
      setValue("");
    }
    setError(null);
    // renameLeaf 는 initialPath 파생값이라 별도 dep 불필요.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath, mode, open]);

  const submit = () => {
    const raw = value.trim();
    if (raw.includes(":")) {
      setError(t("library.folderDialog.errorColon"));
      return;
    }
    // rename: 선택한 폴더명만 바꾸고 상위 경로는 유지.
    // create(sub): parentPath 아래에 새 폴더.
    const base =
      mode === "rename"
        ? renameParent
          ? `${renameParent}/${raw}`
          : raw
        : parentPath
        ? `${parentPath}/${raw}`
        : raw;
    const normalized = normalizeLibraryFolderPath(base);
    if (!normalized) {
      setError(t("library.folderDialog.errorEmpty"));
      return;
    }
    onSubmit(normalized);
    onOpenChange(false);
  };

  const title =
    mode === "rename"
      ? t("library.folderDialog.titleRename")
      : parentPath
      ? t("library.folderDialog.titleCreateSub")
      : t("library.folderDialog.titleCreate");
  const description =
    mode === "rename"
      ? t("library.folderDialog.descRename")
      : parentPath
      ? t("library.folderDialog.descCreateSub", { parent: parentPath })
      : t("library.folderDialog.descCreate");
  const placeholder =
    mode === "rename"
      ? t("library.folderDialog.placeholderRename")
      : t("library.folderDialog.placeholderCreate");
  const submitLabel =
    mode === "rename"
      ? t("library.folderDialog.submitRename")
      : t("library.folderDialog.submitCreate");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder={placeholder}
            className="h-9 text-meta"
          />
          {error ? <div className="text-caption text-destructive">{error}</div> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" style={{ borderRadius: 0 }} onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button style={{ borderRadius: 0 }} onClick={submit}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
